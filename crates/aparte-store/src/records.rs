//! The encrypted record store of one unlocked vault (the web app's `LocalStore`, web/src/core/store/localStore.ts):
//!
//! - local records (spec/FORMAT.md sections 9.6 and 11.3): kind-6 envelopes under `local/<localName>`, whose name is
//!   an HMAC of the purpose and id, so neither appears in clear; listing a purpose decrypts the records;
//! - the object mirror (section 11.1): the envelopes of kinds 1 to 5 exactly as on the remote, under
//!   `objects/<name>`; a value that is not an envelope of the kind its name implies is refused, so plaintext cannot
//!   land there by mistake;
//! - the pending queue (spec/DATA-MODEL.md section 4.5): one kind-6 record of purpose `pending` and id
//!   `<docId>|<n>` per local Yjs update not sealed into a segment yet, under `pending/<localName>`.
//!
//! Read-modify-write sequences (a queue append, sealing a queue) are serialized across the processes of this user by
//! [`RecordStore::exclusive`].

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use aparte_crypto::Subkeys;
use aparte_crypto::names::local_name;
use aparte_crypto::records::{open_local_record, seal_local_record};
use aparte_crypto::rng::Rng;
use aparte_format::envelope::{Kind, MIN_ENVELOPE_LEN, parse_header};
use aparte_format::names::{DocId, ParsedName, parse_name};
use aparte_format::{Error as FormatError, ErrorCode};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::fsx::{self, FileLock};

/// The purposes of local records a caller may write (spec/FORMAT.md section 11.3); `pending` is the queue's own.
pub const PURPOSES: [&str; 6] = [
    "device",
    "sync-credential",
    "oauth-token",
    "provider-key",
    "hwm",
    "draft",
];

const PENDING: &str = "pending";

/// One update of a document's pending queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingUpdate {
    /// Its position in the queue, from 1, increasing.
    pub n: u64,
    /// The Yjs v2 update, zeroed on drop.
    pub update: Zeroizing<Vec<u8>>,
}

/// One record found by a scan: its file name, purpose, id and value.
struct Scanned {
    name: String,
    purpose: String,
    id: String,
    value: Zeroizing<Vec<u8>>,
}

/// One pending record: its file name, position and update.
struct Queued {
    name: String,
    n: u64,
    update: Zeroizing<Vec<u8>>,
}

/// The encrypted records of one unlocked vault, bound to its subkeys.
pub struct RecordStore {
    root: PathBuf,
    subkeys: Arc<Subkeys>,
    rng: Mutex<Box<dyn Rng + Send>>,
}

impl std::fmt::Debug for RecordStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecordStore")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

fn check_purpose(purpose: &str) -> Result<()> {
    if PURPOSES.contains(&purpose) {
        Ok(())
    } else {
        Err(FormatError::InvalidInput("unknown local record purpose").into())
    }
}

/// The envelope kind of a remote object name; `invalid-input` for a name that does not hold an envelope.
fn object_kind(name: &str) -> Result<Kind> {
    match parse_name(name) {
        Some(ParsedName::Segment { .. }) => Ok(Kind::Segment),
        Some(ParsedName::Checkpoint { .. }) => Ok(Kind::Checkpoint),
        Some(ParsedName::Chunk { .. }) => Ok(Kind::Chunk),
        Some(ParsedName::Manifest { .. }) => Ok(Kind::Manifest),
        Some(ParsedName::Secret { .. }) => Ok(Kind::SecretVersion),
        _ => Err(FormatError::InvalidInput("not the name of a remote envelope").into()),
    }
}

/// `(docId, n)` of a pending record id `<docId>|<n>`, `n` from 1 with at most 16 digits and no leading zero.
fn parse_pending_id(id: &str) -> Option<(DocId, u64)> {
    let (doc, n) = id.split_once('|')?;
    let doc = DocId::parse(doc)?;
    let valid = (1..=16).contains(&n.len()) && !n.starts_with('0') && n.bytes().all(|c| c.is_ascii_digit());
    valid.then(|| n.parse().ok().map(|n| (doc, n))).flatten()
}

impl RecordStore {
    /// The record store of the store directory `root`, bound to `subkeys`; `rng` draws the envelope IVs.
    pub fn new(root: impl Into<PathBuf>, subkeys: Arc<Subkeys>, rng: Box<dyn Rng + Send>) -> RecordStore {
        RecordStore {
            root: root.into(),
            subkeys,
            rng: Mutex::new(rng),
        }
    }

    /// The store directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The subkeys the store is bound to.
    pub fn subkeys(&self) -> &Arc<Subkeys> {
        &self.subkeys
    }

    /// Draws `dest.len()` random bytes from the store's generator (ids, IVs).
    pub fn fill_random(&self, dest: &mut [u8]) -> Result<()> {
        let mut rng = self.rng.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        rng.fill(dest)?;
        Ok(())
    }

    /// Holds the lock `name` (`[a-z0-9-]+`) shared by every process that opens this store.
    pub fn exclusive(&self, name: &str) -> Result<FileLock> {
        if name.is_empty()
            || !name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err(FormatError::InvalidInput("a lock name is [a-z0-9-]+").into());
        }
        FileLock::acquire(&self.root.join("locks").join(name))
    }

    fn seal(&self, purpose: &str, id: &str, value: &[u8]) -> Result<(String, Vec<u8>)> {
        let mut rng = self.rng.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(seal_local_record(&self.subkeys, purpose, id, value, rng.as_mut())?)
    }

    // Local records

    /// Seals `value` under the record's local name, replacing any previous value.
    pub fn put(&self, purpose: &str, id: &str, value: &[u8]) -> Result<()> {
        check_purpose(purpose)?;
        let (name, bytes) = self.seal(purpose, id, value)?;
        fsx::atomic_write(&self.root.join("local").join(name), &bytes)
    }

    /// The record's value, or `None` when absent; `tampered` when the stored envelope does not authenticate.
    pub fn get(&self, purpose: &str, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        check_purpose(purpose)?;
        let name = local_name(&self.subkeys, purpose, id)?;
        let Some(bytes) = fsx::read_opt(&self.root.join("local").join(&name))? else {
            return Ok(None);
        };
        let record = open_local_record(&self.subkeys, &name, &bytes)?;
        if record.purpose != purpose || record.id != id {
            return Err(FormatError::Corrupt("a local record does not match its name").into());
        }
        Ok(Some(record.value))
    }

    /// Removes a record; a missing one is not an error.
    pub fn delete(&self, purpose: &str, id: &str) -> Result<()> {
        check_purpose(purpose)?;
        let name = local_name(&self.subkeys, purpose, id)?;
        fsx::remove_opt(&self.root.join("local").join(name))?;
        Ok(())
    }

    /// Every record of a directory that opens under these keys, as `(file name, purpose, id, value)`. A record
    /// that does not authenticate belongs to another vault (or was damaged) and is skipped: there is no plaintext
    /// index to tell them apart.
    fn scan(&self, dir: &str) -> Result<Vec<Scanned>> {
        let path = self.root.join(dir);
        let mut out = Vec::new();
        for name in fsx::file_names(&path)? {
            let Some(bytes) = fsx::read_opt(&path.join(&name))? else {
                continue;
            };
            match open_local_record(&self.subkeys, &name, &bytes) {
                Ok(r) => out.push(Scanned {
                    name,
                    purpose: r.purpose,
                    id: r.id,
                    value: r.value,
                }),
                Err(e) if e.code() == ErrorCode::Tampered => {}
                // A file name that is not a record name (no key derives for it) is not ours either.
                Err(e) if e.code() == ErrorCode::InvalidInput => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(out)
    }

    /// The ids of the records of one purpose, sorted.
    pub fn list(&self, purpose: &str) -> Result<Vec<String>> {
        check_purpose(purpose)?;
        let mut ids: Vec<String> = self
            .scan("local")?
            .into_iter()
            .filter(|r| r.purpose == purpose)
            .map(|r| r.id)
            .collect();
        ids.sort_unstable();
        Ok(ids)
    }

    // The object mirror

    fn object_path(&self, name: &str) -> Result<PathBuf> {
        object_kind(name)?;
        let mut path = self.root.join("objects");
        for part in name.split('/') {
            path.push(part);
        }
        Ok(path)
    }

    /// Stores an object as it is. `invalid-input`, with nothing stored, unless `envelope` is at least 100 bytes with
    /// an `aparte/1` header of the kind the name implies.
    pub fn put_object(&self, name: &str, envelope: &[u8]) -> Result<()> {
        let kind = object_kind(name)?;
        if envelope.len() < MIN_ENVELOPE_LEN {
            return Err(FormatError::InvalidInput("not an aparte/1 envelope").into());
        }
        parse_header(envelope, Some(kind)).map_err(|_| FormatError::InvalidInput("not an envelope of its kind"))?;
        fsx::atomic_write(&self.object_path(name)?, envelope)
    }

    /// An object's bytes, or `None`.
    pub fn get_object(&self, name: &str) -> Result<Option<Vec<u8>>> {
        fsx::read_opt(&self.object_path(name)?)
    }

    /// Whether the mirror holds an object.
    pub fn has_object(&self, name: &str) -> Result<bool> {
        Ok(self.object_path(name)?.is_file())
    }

    /// Removes an object; a missing one is not an error.
    pub fn delete_object(&self, name: &str) -> Result<()> {
        fsx::remove_opt(&self.object_path(name)?)?;
        Ok(())
    }

    /// The names of the objects starting with `prefix` (all for `""`), sorted. A file whose path is not an object
    /// name is ignored.
    pub fn object_names(&self, prefix: &str) -> Result<Vec<String>> {
        Ok(fsx::walk(&self.root.join("objects"))?
            .into_iter()
            .filter(|n| n.starts_with(prefix) && object_kind(n).is_ok())
            .collect())
    }

    // The pending queue

    fn pending_of(&self, doc: DocId) -> Result<Vec<Queued>> {
        let mut out = Vec::new();
        for r in self.scan(PENDING)? {
            let parsed = (r.purpose == PENDING).then(|| parse_pending_id(&r.id)).flatten();
            let Some((d, n)) = parsed else {
                return Err(FormatError::Corrupt("a pending record has a malformed id").into());
            };
            if d == doc {
                out.push(Queued {
                    name: r.name,
                    n,
                    update: r.value,
                });
            }
        }
        out.sort_by_key(|q| q.n);
        Ok(out)
    }

    fn pending_lock(&self, doc: DocId) -> Result<FileLock> {
        self.exclusive(&format!("pending-{}", doc.as_str()))
    }

    /// Appends an update to the document's queue and returns its position.
    pub fn append_pending(&self, doc: DocId, update: &[u8]) -> Result<u64> {
        let _lock = self.pending_lock(doc)?;
        self.append_pending_locked(doc, update)
    }

    /// [`RecordStore::append_pending`] for a caller that already holds the document's pending lock
    /// ([`RecordStore::lock_pending`]).
    pub fn append_pending_locked(&self, doc: DocId, update: &[u8]) -> Result<u64> {
        let n = self.pending_of(doc)?.last().map_or(0, |q| q.n) + 1;
        let (name, bytes) = self.seal(PENDING, &format!("{}|{n}", doc.as_str()), update)?;
        fsx::atomic_write(&self.root.join(PENDING).join(name), &bytes)?;
        Ok(n)
    }

    /// The lock of one document's queue, for a sequence that reads, seals and drops it.
    pub fn lock_pending(&self, doc: DocId) -> Result<FileLock> {
        self.pending_lock(doc)
    }

    /// The document's pending updates, in order.
    pub fn pending(&self, doc: DocId) -> Result<Vec<PendingUpdate>> {
        Ok(self
            .pending_of(doc)?
            .into_iter()
            .map(|q| PendingUpdate {
                n: q.n,
                update: q.update,
            })
            .collect())
    }

    /// Removes the document's updates up to and including position `through`.
    pub fn drop_pending(&self, doc: DocId, through: u64) -> Result<()> {
        for q in self.pending_of(doc)? {
            if q.n <= through {
                fsx::remove_opt(&self.root.join(PENDING).join(q.name))?;
            }
        }
        Ok(())
    }
}

impl From<Error> for FormatError {
    /// The format error inside, or `invalid-state` for a file system failure (whose detail is in the logs).
    fn from(e: Error) -> FormatError {
        match e {
            Error::Format(f) => f,
            Error::Io { .. } => FormatError::InvalidState("the device store could not be read or written"),
        }
    }
}

#[cfg(test)]
mod tests {
    use aparte_crypto::rng::{OsRng, QueueRng};
    use proptest::prelude::*;

    use super::*;

    fn store(dir: &Path) -> RecordStore {
        let subkeys = Arc::new(Subkeys::derive(&[7u8; 32], &[0xf0; 16]));
        RecordStore::new(dir, subkeys, Box::new(OsRng))
    }

    #[test]
    fn records_are_sealed_under_opaque_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let s = store(dir.path());
        s.put("device", "id", b"sixteen bytes!!!").expect("put");
        s.put("draft", "conv one", b"hello").expect("put");
        assert_eq!(
            s.get("device", "id").expect("get").as_deref().map(Vec::as_slice),
            Some(&b"sixteen bytes!!!"[..])
        );
        assert_eq!(s.get("device", "other").expect("get"), None);
        assert_eq!(s.list("draft").expect("list"), vec!["conv one"]);
        let files = fsx::walk(dir.path()).expect("walk");
        assert_eq!(files.len(), 2);
        for f in &files {
            assert!(
                !f.contains("device") && !f.contains("draft") && !f.contains("conv"),
                "{f}"
            );
            let bytes = std::fs::read(dir.path().join(f)).expect("read");
            assert!(!bytes.windows(5).any(|w| w == b"hello"), "ciphertext only");
        }
        s.delete("draft", "conv one").expect("delete");
        assert!(s.list("draft").expect("list").is_empty());
        assert!(
            s.put("pending", "index|1", b"x").is_err(),
            "the queue's purpose is reserved"
        );
        assert!(s.put("unknown", "x", b"x").is_err());
    }

    #[test]
    fn a_record_of_another_vault_is_skipped_and_a_damaged_one_is_tampered() {
        let dir = tempfile::tempdir().expect("tempdir");
        let s = store(dir.path());
        s.put("hwm", "sync", b"{}").expect("put");
        let other = RecordStore::new(
            dir.path(),
            Arc::new(Subkeys::derive(&[8u8; 32], &[0xf0; 16])),
            Box::new(OsRng),
        );
        other.put("hwm", "mine", b"{}").expect("put");
        assert_eq!(s.list("hwm").expect("list"), vec!["sync"]);
        let name = local_name(s.subkeys(), "hwm", "sync").expect("name");
        let path = dir.path().join("local").join(name);
        let mut bytes = std::fs::read(&path).expect("read");
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        std::fs::write(&path, bytes).expect("write");
        assert_eq!(
            s.get("hwm", "sync").unwrap_err().code().map(|c| c.as_str()),
            Some("tampered")
        );
    }

    #[test]
    fn the_mirror_takes_only_envelopes_of_their_kind() {
        let dir = tempfile::tempdir().expect("tempdir");
        let s = store(dir.path());
        let name = "b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa";
        let mut rng = QueueRng::new([vec![1u8; 12]]);
        let chunk = aparte_crypto::seal_envelope(
            s.subkeys(),
            Kind::Chunk,
            name,
            b"chunk",
            aparte_crypto::Compression::None,
            &mut rng,
        )
        .expect("seal");
        assert!(s.put_object(name, b"plaintext that is not an envelope").is_err());
        assert!(s.put_object("d/x", &chunk).is_err(), "not an object name");
        assert!(
            s.put_object("m/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa", &chunk).is_err(),
            "kind mismatch"
        );
        s.put_object(name, &chunk).expect("put");
        assert_eq!(s.get_object(name).expect("get"), Some(chunk));
        assert!(s.has_object(name).expect("has"));
        assert_eq!(s.object_names("").expect("names"), vec![name]);
        assert_eq!(s.object_names("b/aa/").expect("names"), vec![name]);
        assert!(s.object_names("m/").expect("names").is_empty());
        std::fs::write(dir.path().join("objects/b/aa/stray"), b"x").expect("stray");
        assert_eq!(
            s.object_names("").expect("names"),
            vec![name],
            "a stray file is no object"
        );
        s.delete_object(name).expect("delete");
        assert!(s.object_names("").expect("names").is_empty());
    }

    #[test]
    fn the_pending_queue_keeps_order_per_document() {
        let dir = tempfile::tempdir().expect("tempdir");
        let s = store(dir.path());
        let shard = DocId::shard(3).expect("shard");
        assert_eq!(s.append_pending(DocId::INDEX, b"a").expect("append"), 1);
        assert_eq!(s.append_pending(shard, b"x").expect("append"), 1);
        assert_eq!(s.append_pending(DocId::INDEX, b"b").expect("append"), 2);
        assert_eq!(s.append_pending(DocId::INDEX, b"c").expect("append"), 3);
        let q = s.pending(DocId::INDEX).expect("list");
        assert_eq!(q.iter().map(|u| u.n).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(q[1].update.as_slice(), b"b");
        s.drop_pending(DocId::INDEX, 2).expect("drop");
        assert_eq!(s.pending(DocId::INDEX).expect("list").len(), 1);
        assert_eq!(
            s.append_pending(DocId::INDEX, b"d").expect("append"),
            4,
            "positions keep growing"
        );
        assert_eq!(s.pending(shard).expect("list").len(), 1);
    }

    #[test]
    fn pending_ids_are_strict() {
        assert_eq!(parse_pending_id("index|1"), Some((DocId::INDEX, 1)));
        assert_eq!(parse_pending_id("c15|42"), Some((DocId::shard(15).expect("shard"), 42)));
        for bad in [
            "index|0",
            "index|01",
            "c16|1",
            "index|",
            "index",
            "index|1a",
            "index|12345678901234567",
        ] {
            assert_eq!(parse_pending_id(bad), None, "{bad}");
        }
    }

    proptest! {
        #[test]
        fn records_round_trip(purpose in proptest::sample::select(PURPOSES.to_vec()), id in ".{0,40}", value in proptest::collection::vec(any::<u8>(), 0..200)) {
            let dir = tempfile::tempdir().expect("tempdir");
            let s = store(dir.path());
            s.put(purpose, &id, &value).expect("put");
            let got = s.get(purpose, &id).expect("get").expect("present");
            prop_assert_eq!(got.as_slice(), value.as_slice());
            prop_assert_eq!(s.list(purpose).expect("list"), vec![id]);
        }
    }
}
