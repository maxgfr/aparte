//! The sync engine, a port of the web app's (web/src/core/sync/engine.ts) onto the same `aparte/1` store
//! (spec/FORMAT.md): immutable segments per (document, device), checkpoints, content-addressed blobs, keyslots, and
//! the anti-rollback rules of section 10.3.
//!
//! A round with one destination:
//! 1. seals the pending queue of every document into one segment each (persisted in the object mirror first);
//! 2. lists the destination completely and checks it: format marker, another vault, keyslots, forks, rollback, gaps
//!    and unreturned claims;
//! 3. downloads what this device lacks (blobs first, then checkpoints for documents it holds nothing of, then
//!    segments), authenticates every object against its name, stores it in the mirror and applies it to the loaded
//!    documents;
//! 4. writes a checkpoint for a loaded document with many segments since the last one;
//! 5. uploads, in the order of section 10.2, everything the mirror holds that the destination does not list.
//!
//! Invariants:
//! - Nothing is ever deleted locally because a store stopped returning it; an alarm is raised instead.
//! - An object enters the mirror only once it authenticated under its name, and only the format marker and the
//!   keyslots go out in clear.
//! - Rounds are serialized across the processes of this user (the store's `sync` lock), and the sync state is read
//!   afresh at the start of each one.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use aparte_crypto::envelope::{Compression, open_envelope, seal_envelope};
use aparte_crypto::names::{checkpoint_name, chunk_id, device_tag, manifest_id, segment_name};
use aparte_format::envelope::Kind;
use aparte_format::framing::{StreamHeader, StreamKind, encode_stream_payload};
use aparte_format::names::{DocId, FMT_BYTES, FMT_NAME, ParsedName, chunk_name, manifest_name, parse_name};
use aparte_format::{Error as FormatError, ErrorCode};
use aparte_store::{KeyslotFile, RecordStore, Vault};
use futures_util::StreamExt;
use futures_util::stream;
use serde_json::Value;

use crate::error::{Error, RemoteError, RemoteErrorKind, Result};
use crate::remote::{RemoteEntry, RemoteStore};
use crate::state::{DestRecord, SyncAlarm, SyncState, get_seq, raise_seq};
use crate::streams::{DocTags, StreamName, mirrored_updates, open, stream_name};
use crate::workspace::{Clock, Workspace};
use crate::ydoc::{blob_refs_added, merge_updates};

/// Segments since the last checkpoint that make a loaded document worth a new one.
pub const CHECKPOINT_EVERY: usize = 256;
/// How long a gap or an unreturned claim must persist across listings before it raises an alarm (section 10.3).
pub const WITHHOLD_MS: u64 = 10 * 60_000;
/// Failed validations after which an object is no longer fetched.
pub const MAX_BAD: u32 = 3;
/// Downloads in flight at once.
pub const CONCURRENCY: usize = 6;
/// Gaps watched per (document, device): a hostile listing cannot make the state grow without bound.
const MAX_GAPS: u64 = 64;

/// What the engine needs of the vault: its keyslot files, and a way to add the ones another device created.
pub trait KeyslotPort: Send + Sync {
    /// base32 vault id.
    fn vault(&self) -> Result<String>;
    /// This device's keyslot files.
    fn files(&self) -> Result<Vec<KeyslotFile>>;
    /// Adds keyslots another device created; returns the slots added.
    fn import(&self, files: &[KeyslotFile]) -> Result<Vec<String>>;
}

impl KeyslotPort for Vault {
    fn vault(&self) -> Result<String> {
        Ok(Vault::vault(self)?)
    }
    fn files(&self) -> Result<Vec<KeyslotFile>> {
        Ok(self.keyslot_files()?)
    }
    fn import(&self, files: &[KeyslotFile]) -> Result<Vec<String>> {
        Ok(self.import_keyslots(files)?)
    }
}

/// What one round did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoundResult {
    /// Objects downloaded and accepted.
    pub down: usize,
    /// Objects uploaded.
    pub up: usize,
    /// Objects that wait for the next round (a segment whose blob is not confirmed yet).
    pub deferred: usize,
    /// Segments sealed from the pending queues.
    pub sealed: usize,
    /// Every alarm raised and not dismissed, this round's included.
    pub alarms: Vec<SyncAlarm>,
}

struct Me {
    id: [u8; 16],
    dtag: String,
}

/// What the mirror holds, indexed once per round and kept up to date as the round adds objects.
#[derive(Default)]
struct LocalIndex {
    names: HashSet<String>,
    /// stag -> dtag -> seqs of segments.
    segments: HashMap<String, HashMap<String, BTreeSet<u64>>>,
    manifests: HashSet<String>,
}

impl LocalIndex {
    fn add_segment(&mut self, stag: &str, dtag: &str, seq: u64) {
        self.segments
            .entry(stag.to_owned())
            .or_default()
            .entry(dtag.to_owned())
            .or_default()
            .insert(seq);
    }

    fn own_seq(&self, stag: &str, dtag: &str) -> u64 {
        self.segments
            .get(stag)
            .and_then(|d| d.get(dtag))
            .and_then(|s| s.last().copied())
            .unwrap_or(0)
    }
}

/// Highest h with every segment of (floor, h] present.
fn contiguous(seqs: Option<&BTreeSet<u64>>, floor: u64) -> u64 {
    let mut h = floor;
    if let Some(seqs) = seqs {
        while seqs.contains(&(h + 1)) {
            h += 1;
        }
    }
    h
}

/// A complete listing, read once.
struct Listed {
    entries: BTreeMap<String, RemoteEntry>,
    /// stag -> dtag -> seq -> names (segments).
    segments: HashMap<String, HashMap<String, BTreeMap<u64, Vec<String>>>>,
    checkpoints: Vec<(String, StreamName)>,
}

impl Listed {
    fn read(entries: Vec<RemoteEntry>) -> Listed {
        let mut by_name = BTreeMap::new();
        let mut segments: HashMap<String, HashMap<String, BTreeMap<u64, Vec<String>>>> = HashMap::new();
        let mut checkpoints = Vec::new();
        for entry in entries {
            // A name that does not match the grammar exactly (a sync client's "x 2" copy) is ignored, never read.
            if parse_name(&entry.name).is_none() {
                continue;
            }
            if let Some(parsed) = stream_name(&entry.name) {
                if parsed.checkpoint {
                    checkpoints.push((entry.name.clone(), parsed));
                } else {
                    segments
                        .entry(parsed.stag.clone())
                        .or_default()
                        .entry(parsed.dtag.clone())
                        .or_default()
                        .entry(parsed.seq)
                        .or_default()
                        .push(entry.name.clone());
                }
            }
            by_name.insert(entry.name.clone(), entry);
        }
        Listed {
            entries: by_name,
            segments,
            checkpoints,
        }
    }

    fn max(&self, stag: &str, dtag: &str) -> u64 {
        self.segments
            .get(stag)
            .and_then(|d| d.get(dtag))
            .and_then(|s| s.keys().next_back().copied())
            .unwrap_or(0)
    }
}

fn keyslot_id(name: &str) -> Option<&str> {
    match parse_name(name)? {
        ParsedName::Keyslot { .. } => name.strip_prefix("keys/")?.strip_suffix(".json"),
        _ => None,
    }
}

fn tampered(detail: &'static str) -> FormatError {
    FormatError::Tampered(detail)
}

/// An object fetched from a store, or why it could not be.
type Fetched = (String, std::result::Result<Option<Vec<u8>>, RemoteError>);

/// One round's destination, its listing and the documents it applies to.
struct Pass<'a> {
    dest: &'a dyn RemoteStore,
    listed: &'a Listed,
    workspace: Option<&'a Workspace>,
}

/// The engine of one unlocked vault on this device.
pub struct Engine {
    store: Arc<RecordStore>,
    keyslots: Arc<dyn KeyslotPort>,
    clock: Arc<dyn Clock>,
    tags: DocTags,
    /// Segments since the last checkpoint that make a loaded document worth a new one.
    pub checkpoint_every: usize,
    /// How long a gap must persist before it is an alarm.
    pub withhold_ms: u64,
    /// Downloads in flight at once.
    pub concurrency: usize,
    /// Blob ids each stream object references (immutable once read).
    blobs_of: Mutex<HashMap<String, Vec<String>>>,
    /// Chunk ids of each manifest (immutable once read).
    chunks_of: Mutex<HashMap<String, Vec<String>>>,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine").finish_non_exhaustive()
    }
}

impl Engine {
    /// The engine of the vault whose records `store` holds.
    pub fn new(store: Arc<RecordStore>, keyslots: Arc<dyn KeyslotPort>, clock: Arc<dyn Clock>) -> Engine {
        Engine {
            tags: DocTags::new(store.subkeys()),
            store,
            keyslots,
            clock,
            checkpoint_every: CHECKPOINT_EVERY,
            withhold_ms: WITHHOLD_MS,
            concurrency: CONCURRENCY,
            blobs_of: Mutex::new(HashMap::new()),
            chunks_of: Mutex::new(HashMap::new()),
        }
    }

    fn now(&self) -> u64 {
        self.clock.now()
    }

    // Identity

    fn identity(&self) -> Result<Me> {
        let id: [u8; 16] = match self.store.get("device", "id")? {
            Some(v) if v.len() == 16 => {
                let mut id = [0u8; 16];
                id.copy_from_slice(&v);
                id
            }
            _ => {
                let mut id = [0u8; 16];
                self.store.fill_random(&mut id)?;
                self.store.put("device", "id", &id)?;
                id
            }
        };
        Ok(Me {
            dtag: device_tag(self.store.subkeys(), &id),
            id,
        })
    }

    /// A clone of this device wrote under its tag: this device takes a new id (spec/FORMAT.md section 10.3).
    fn rotate(&self) -> Result<Me> {
        let mut id = [0u8; 16];
        self.store.fill_random(&mut id)?;
        self.store.put("device", "id", &id)?;
        Ok(Me {
            dtag: device_tag(self.store.subkeys(), &id),
            id,
        })
    }

    /// The device tag this device writes under.
    pub fn device_tag(&self) -> Result<String> {
        Ok(self.identity()?.dtag)
    }

    // Alarms

    fn raise(&self, state: &mut SyncState, id: String, kind: &str, dest: &str, doc: Option<DocId>, detail: String) {
        if state.dismissed.contains(&id) || state.alarms.iter().any(|a| a.id == id) {
            return;
        }
        state.alarms.push(SyncAlarm {
            id,
            kind: kind.to_owned(),
            dest: dest.to_owned(),
            doc: doc.map(|d| d.as_str().to_owned()),
            detail,
            at: self.now(),
        });
    }

    /// Forgets an alarm the user read; the same finding does not come back.
    pub fn dismiss_alarm(&self, id: &str) -> Result<()> {
        let _lock = self.store.exclusive("sync")?;
        let mut state = SyncState::load(&self.store)?;
        state.alarms.retain(|a| a.id != id);
        if !state.dismissed.iter().any(|d| d == id) {
            state.dismissed.push(id.to_owned());
        }
        state.save(&self.store)
    }

    /// The stored sync state (destinations, alarms).
    pub fn state(&self) -> Result<SyncState> {
        SyncState::load(&self.store)
    }

    // The local mirror

    fn index_local(&self) -> Result<LocalIndex> {
        let mut index = LocalIndex::default();
        for name in self.store.object_names("")? {
            match parse_name(&name) {
                Some(ParsedName::Segment { stag, dtag, seq, .. }) => index.add_segment(&stag, &dtag, seq),
                Some(ParsedName::Manifest { id }) => {
                    index.manifests.insert(id);
                }
                _ => {}
            }
            index.names.insert(name);
        }
        Ok(index)
    }

    /// Per device, the highest seq applied contiguously in a document: mirror segments above checkpoint coverage.
    fn hwm(state: &SyncState, index: &LocalIndex, stag: &str) -> BTreeMap<String, u64> {
        let devices = index.segments.get(stag);
        let floors = state.covered.get(stag);
        let mut dtags: BTreeSet<&String> = devices.map(|d| d.keys().collect()).unwrap_or_default();
        dtags.extend(floors.into_iter().flat_map(|f| f.keys()));
        dtags
            .into_iter()
            .map(|dtag| {
                let floor = floors.and_then(|f| f.get(dtag)).copied().unwrap_or(0);
                (dtag.clone(), contiguous(devices.and_then(|d| d.get(dtag)), floor))
            })
            .collect()
    }

    fn header_for(
        &self,
        state: &SyncState,
        index: &LocalIndex,
        doc: DocId,
        me: &Me,
        seq: u64,
        blobs: Vec<String>,
    ) -> StreamHeader {
        let stag = self.tags.tag(doc);
        let seen = Self::hwm(state, index, stag)
            .into_iter()
            .filter(|(dtag, _)| *dtag != me.dtag)
            .collect();
        StreamHeader {
            doc,
            device: me.dtag.clone(),
            seq,
            time: self.now(),
            seen,
            blobs,
            covers: None,
        }
    }

    // Sealing

    fn seal_doc(&self, state: &mut SyncState, index: &mut LocalIndex, me: &Me, doc: DocId) -> Result<bool> {
        let _lock = self.store.lock_pending(doc)?;
        let queue = self.store.pending(doc)?;
        let Some(last) = queue.last().map(|r| r.n) else {
            return Ok(false);
        };
        let after = state.sealed.get(doc.as_str()).copied().unwrap_or(0);
        // Positions only grow while the queue keeps a record; a queue that restarted below the mark is all new.
        let (fresh, old): (Vec<_>, Vec<_>) = queue.iter().partition(|r| last < after || r.n > after);
        if fresh.is_empty() {
            return Ok(false);
        }
        let updates: Vec<&[u8]> = fresh.iter().map(|r| r.update.as_slice()).collect();
        let update = merge_updates(&updates)?;
        let stag = self.tags.tag(doc).to_owned();
        let seq = index.own_seq(&stag, &me.dtag) + 1;
        let blobs = self.new_blob_refs(
            doc,
            &old.iter().map(|r| r.update.as_slice()).collect::<Vec<_>>(),
            &update,
            index,
        )?;
        let header = self.header_for(state, index, doc, me, seq, blobs);
        let payload = encode_stream_payload(StreamKind::Segment, &header, &update)?;
        let keys = self.store.subkeys();
        let name = segment_name(keys, doc, &me.id, seq, &payload)?;
        let envelope = self.seal_object(Kind::Segment, &name, &payload, Compression::DeflateRaw)?;
        // Persisted locally before any upload: a retry sends these very bytes (spec/FORMAT.md section 10.2).
        self.store.put_object(&name, &envelope)?;
        index.names.insert(name.clone());
        index.add_segment(&stag, &me.dtag, seq);
        self.blobs().insert(name, header.blobs.clone());
        state.sealed.insert(doc.as_str().to_owned(), last);
        state.save(&self.store)?;
        // The last record stays as the position anchor, so positions keep growing; it is marked sealed above.
        self.store.drop_pending(doc, last - 1)?;
        Ok(true)
    }

    fn blobs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<String>>> {
        self.blobs_of.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn chunks(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<String>>> {
        self.chunks_of.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The manifests the update references that this device holds (a reference to a blob not here yet is not
    /// listed: its own segment carried it).
    fn new_blob_refs(&self, doc: DocId, old: &[&[u8]], update: &[u8], index: &LocalIndex) -> Result<Vec<String>> {
        // Every blob reference is a `blob` key, whose bytes a v2 update carries in its string column.
        if !update.windows(4).any(|w| w == b"blob") {
            return Ok(Vec::new());
        }
        let mirror = mirrored_updates(&self.store, &self.tags, doc)?;
        let mut base: Vec<&[u8]> = mirror.iter().map(|u| u.as_slice()).collect();
        base.extend_from_slice(old);
        Ok(blob_refs_added(&base, update)
            .into_iter()
            .filter(|id| index.manifests.contains(id))
            .collect())
    }

    fn seal_object(&self, kind: Kind, name: &str, payload: &[u8], compression: Compression) -> Result<Vec<u8>> {
        let mut rng = StoreRng(&self.store);
        Ok(seal_envelope(
            self.store.subkeys(),
            kind,
            name,
            payload,
            compression,
            &mut rng,
        )?)
    }

    fn seal_all(&self, state: &mut SyncState, index: &mut LocalIndex, me: &Me) -> Result<usize> {
        let mut n = 0;
        for doc in DocId::ALL {
            if self.seal_doc(state, index, me, doc)? {
                n += 1;
            }
        }
        Ok(n)
    }

    /// Seals every document's pending queue into segments now; returns the number of segments written.
    pub fn seal(&self) -> Result<usize> {
        let _lock = self.store.exclusive("sync")?;
        let mut state = SyncState::load(&self.store)?;
        let mut index = self.index_local()?;
        let me = self.identity()?;
        self.seal_all(&mut state, &mut index, &me)
    }

    // Checkpoints

    fn maybe_checkpoint(
        &self,
        state: &mut SyncState,
        index: &mut LocalIndex,
        me: &Me,
        workspace: Option<&Workspace>,
    ) -> Result<()> {
        let Some(ws) = workspace else {
            return Ok(());
        };
        for doc in DocId::ALL {
            if !ws.is_loaded(doc) {
                continue;
            }
            let stag = self.tags.tag(doc).to_owned();
            let seq = index.own_seq(&stag, &me.dtag);
            if seq == 0 || state.own_checkpoint.get(doc.as_str()).copied().unwrap_or(0) >= seq {
                continue;
            }
            let floors = state.covered.get(&stag);
            let uncovered: usize = index.segments.get(&stag).map_or(0, |devices| {
                devices
                    .iter()
                    .map(|(dtag, seqs)| {
                        let floor = floors.and_then(|f| f.get(dtag)).copied().unwrap_or(0);
                        seqs.iter().filter(|&&s| s > floor).count()
                    })
                    .sum()
            });
            if uncovered < self.checkpoint_every {
                continue;
            }
            let update = ws.state(doc)?;
            let mut covers: BTreeMap<String, u64> = Self::hwm(state, index, &stag);
            covers.insert(me.dtag.clone(), seq);
            let mut header = self.header_for(state, index, doc, me, seq, Vec::new());
            let blobs: BTreeSet<String> = {
                let mut refs = BTreeSet::new();
                crate::ydoc::blob_refs_of(&ws.json(doc)?, &mut refs);
                refs
            };
            header.blobs = blobs.into_iter().filter(|b| index.manifests.contains(b)).collect();
            header.covers = Some(covers.clone());
            let payload = encode_stream_payload(StreamKind::Checkpoint, &header, &update)?;
            let name = checkpoint_name(self.store.subkeys(), doc, &me.id, seq, &payload)?;
            let envelope = self.seal_object(Kind::Checkpoint, &name, &payload, Compression::DeflateRaw)?;
            self.store.put_object(&name, &envelope)?;
            index.names.insert(name.clone());
            self.blobs().insert(name, header.blobs.clone());
            state.own_checkpoint.insert(doc.as_str().to_owned(), seq);
            for (dtag, s) in covers {
                raise_seq(&mut state.covered, &stag, &dtag, s);
            }
        }
        Ok(())
    }

    // Checks of a complete listing (spec/FORMAT.md section 10.3)

    fn judge(&self, state: &mut SyncState, rec: &mut DestRecord, dest: &str, listed: &Listed) {
        let now = self.now();
        // Rollback: a device's highest listed segment below what this destination listed before.
        let before: Vec<(String, String, u64)> = rec
            .listed
            .iter()
            .flat_map(|(s, d)| d.iter().map(move |(dt, n)| (s.clone(), dt.clone(), *n)))
            .collect();
        for (stag, dtag, seq) in before {
            let highest = listed.max(&stag, &dtag);
            if highest < seq {
                self.raise(
                    state,
                    format!("rollback:{dest}:{stag}:{dtag}:{seq}"),
                    "rollback",
                    dest,
                    self.tags.doc(&stag),
                    format!("{stag}/{dtag}: highest segment {highest}, {seq} listed before"),
                );
            }
        }
        // Forks, and gaps below listed segments.
        let mut gaps_now = BTreeSet::new();
        for (stag, devices) in &listed.segments {
            for (dtag, seqs) in devices {
                let mut max = 0;
                for (&seq, names) in seqs {
                    max = max.max(seq);
                    if names.len() > 1 {
                        self.raise(
                            state,
                            format!("fork:{stag}:{dtag}:{seq}"),
                            "fork",
                            dest,
                            self.tags.doc(stag),
                            format!("{stag}/{dtag}: {} segments for seq {seq}", names.len()),
                        );
                    }
                }
                raise_seq(&mut rec.listed, stag, dtag, max);
                let floor = get_seq(&state.covered, stag, dtag);
                let mut watched = 0;
                let mut seq = floor + 1;
                while seq < max && watched < MAX_GAPS {
                    if !seqs.contains_key(&seq) {
                        watched += 1;
                        gaps_now.insert(format!("{stag}/{dtag}/{seq}"));
                    }
                    seq += 1;
                }
            }
        }
        rec.gaps.retain(|k, _| gaps_now.contains(k));
        for key in gaps_now {
            match rec.gaps.get(&key).copied() {
                None => {
                    rec.gaps.insert(key, now);
                }
                Some(first) if now.saturating_sub(first) >= self.withhold_ms => {
                    let stag = key.split('/').next().unwrap_or_default().to_owned();
                    self.raise(
                        state,
                        format!("withheld:{dest}:{key}"),
                        "withheld",
                        dest,
                        self.tags.doc(&stag),
                        format!("{key} is missing below a listed segment since {first}"),
                    );
                }
                Some(_) => {}
            }
        }
    }

    /// After the download, with the claims of the headers just read: a header named a segment the store does not
    /// return.
    fn judge_claims(&self, state: &mut SyncState, rec: &mut DestRecord, dest: &str, listed: &Listed) {
        let now = self.now();
        let mut unreturned_now = BTreeSet::new();
        for (stag, devices) in &state.claims {
            for (dtag, &claimed) in devices {
                if claimed > listed.max(stag, dtag) && claimed > get_seq(&state.covered, stag, dtag) {
                    unreturned_now.insert(format!("{stag}/{dtag}/{claimed}"));
                }
            }
        }
        rec.unreturned.retain(|k, _| unreturned_now.contains(k));
        for key in unreturned_now {
            match rec.unreturned.get(&key).copied() {
                None => {
                    rec.unreturned.insert(key, now);
                }
                Some(first) if now.saturating_sub(first) >= self.withhold_ms => {
                    let stag = key.split('/').next().unwrap_or_default().to_owned();
                    self.raise(
                        state,
                        format!("unreturned:{dest}:{key}"),
                        "unreturned",
                        dest,
                        self.tags.doc(&stag),
                        format!("{key} is named by another device but not returned"),
                    );
                }
                Some(_) => {}
            }
        }
    }

    // Keyslots and the format marker

    async fn sync_keyslots(
        &self,
        state: &mut SyncState,
        rec: &mut DestRecord,
        dest: &dyn RemoteStore,
        listed: &Listed,
    ) -> Result<(Vec<KeyslotFile>, bool)> {
        let local = self.keyslots.files()?;
        let vault = self.keyslots.vault()?;
        let local_ids: BTreeSet<String> = local
            .iter()
            .filter_map(|f| keyslot_id(&f.name).map(str::to_owned))
            .collect();
        let known: BTreeSet<String> = state.slots.iter().cloned().collect();
        let mut removed: BTreeSet<String> = state.removed_slots.iter().cloned().collect();
        let mut to_import = Vec::new();
        for (name, entry) in &listed.entries {
            let Some(slot) = keyslot_id(name) else { continue };
            if local_ids.contains(slot) || removed.contains(slot) {
                continue;
            }
            if known.contains(slot) {
                // This device removed the slot: it goes from the destination once, where the store can delete it.
                dest.delete(name).await?;
                removed.insert(slot.to_owned());
                continue;
            }
            let Some(bytes) = dest.get(entry).await? else { continue };
            let Ok(json) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if json.get("vault").and_then(Value::as_str) != Some(vault.as_str()) {
                return Err(
                    RemoteError::new(RemoteErrorKind::Incompatible, "this destination holds another vault").into(),
                );
            }
            to_import.push(KeyslotFile {
                name: name.clone(),
                bytes,
            });
        }
        let added = if to_import.is_empty() {
            Vec::new()
        } else {
            self.keyslots.import(&to_import)?
        };
        let mut slots: BTreeSet<String> = local_ids;
        slots.extend(added);
        slots.extend(known);
        state.slots = slots.into_iter().filter(|s| !removed.contains(s)).collect();
        state.removed_slots = removed.into_iter().collect();

        let mut fmt = false;
        if let Some(marker) = listed.entries.get(FMT_NAME) {
            if rec.fmt_ok == Some(true) {
                fmt = true;
            } else if let Some(bytes) = dest.get(marker).await? {
                if bytes != FMT_BYTES {
                    return Err(RemoteError::new(
                        RemoteErrorKind::Incompatible,
                        "this destination holds another format than aparte/1",
                    )
                    .into());
                }
                fmt = true;
                rec.fmt_ok = Some(true);
            }
        }
        let put = local
            .into_iter()
            .filter(|f| !listed.entries.contains_key(&f.name))
            .collect();
        Ok((put, fmt))
    }

    // Download

    fn bad(&self, state: &mut SyncState, dest: &str, name: &str, error: Error) -> Result<()> {
        // Only an object that fails its checks is counted; a failing disk or store ends the round.
        let Some(code) = error
            .format_code()
            .filter(|_| !matches!(error, Error::Store(aparte_store::Error::Io { .. })))
        else {
            return Err(error);
        };
        let count = state.bad.entry(name.to_owned()).or_insert(0);
        *count += 1;
        if *count >= MAX_BAD {
            self.raise(
                state,
                format!("tampered:{dest}:{name}"),
                "tampered",
                dest,
                None,
                format!("{name}: {}", code.as_str()),
            );
        }
        Ok(())
    }

    async fn download(
        &self,
        state: &mut SyncState,
        dest: &dyn RemoteStore,
        index: &mut LocalIndex,
        listed: &Listed,
        workspace: Option<&Workspace>,
    ) -> Result<(usize, usize)> {
        let dest_id = dest.id().to_owned();
        let mut chunks = Vec::new();
        let mut manifests = Vec::new();
        let mut secrets = Vec::new();
        let mut segments: Vec<(String, StreamName)> = Vec::new();
        for name in listed.entries.keys() {
            if index.names.contains(name) || state.bad.get(name).copied().unwrap_or(0) >= MAX_BAD {
                continue;
            }
            match parse_name(name) {
                Some(ParsedName::Chunk { .. }) => chunks.push(name.clone()),
                Some(ParsedName::Manifest { .. }) => manifests.push(name.clone()),
                Some(ParsedName::Secret { .. }) => secrets.push(name.clone()),
                Some(ParsedName::Segment { .. }) => {
                    if let Some(parsed) = stream_name(name) {
                        segments.push((name.clone(), parsed));
                    }
                }
                _ => {}
            }
        }
        // A document this device holds nothing of starts from its checkpoints, then needs only the segments above
        // them.
        let fresh = |state: &SyncState, stag: &str| -> bool {
            !index.segments.contains_key(stag) && state.covered.get(stag).is_none_or(BTreeMap::is_empty)
        };
        let checkpoints: Vec<(String, StreamName)> = listed
            .checkpoints
            .iter()
            .filter(|(name, parsed)| {
                !index.names.contains(name)
                    && fresh(state, &parsed.stag)
                    && state.bad.get(name).copied().unwrap_or(0) < MAX_BAD
            })
            .cloned()
            .collect();

        let mut down = 0;
        let mut blobs = 0;

        // Blobs first: a message that arrives shows its photo at once.
        let fetched = self.fetch(dest, listed, &manifests).await?;
        for (name, bytes) in fetched {
            let Some(bytes) = bytes else { continue };
            let checked = (|| -> Result<String> {
                let Some(ParsedName::Manifest { id }) = parse_name(&name) else {
                    return Err(tampered("a manifest name").into());
                };
                let payload = open_envelope(self.store.subkeys(), Kind::Manifest, &name, &bytes)?;
                if manifest_id(self.store.subkeys(), &payload) != id {
                    return Err(tampered("a manifest does not match its id").into());
                }
                Ok(id)
            })();
            match checked {
                Ok(id) => {
                    self.keep(state, index, &name, &bytes)?;
                    index.manifests.insert(id);
                    down += 1;
                    blobs += 1;
                }
                Err(e) => self.bad(state, &dest_id, &name, e)?,
            }
        }
        let fetched = self.fetch(dest, listed, &chunks).await?;
        for (name, bytes) in fetched {
            let Some(bytes) = bytes else { continue };
            let checked = (|| -> Result<()> {
                let Some(ParsedName::Chunk { id }) = parse_name(&name) else {
                    return Err(tampered("a chunk name").into());
                };
                let payload = open_envelope(self.store.subkeys(), Kind::Chunk, &name, &bytes)?;
                if chunk_id(self.store.subkeys(), &payload) != id {
                    return Err(tampered("a chunk does not match its id").into());
                }
                Ok(())
            })();
            match checked {
                Ok(()) => {
                    self.keep(state, index, &name, &bytes)?;
                    down += 1;
                    blobs += 1;
                }
                Err(e) => self.bad(state, &dest_id, &name, e)?,
            }
        }
        let fetched = self.fetch(dest, listed, &secrets).await?;
        for (name, bytes) in fetched {
            let Some(bytes) = bytes else { continue };
            // Secret versions are kept and relayed; reading their values is the secrets layer's job.
            match open_envelope(self.store.subkeys(), Kind::SecretVersion, &name, &bytes) {
                Ok(_) => {
                    self.keep(state, index, &name, &bytes)?;
                    down += 1;
                }
                Err(e) => self.bad(state, &dest_id, &name, e.into())?,
            }
        }

        let names: Vec<String> = checkpoints.iter().map(|(n, _)| n.clone()).collect();
        let fetched = self.fetch(dest, listed, &names).await?;
        for ((name, bytes), (_, parsed)) in fetched.into_iter().zip(&checkpoints) {
            let Some(bytes) = bytes else { continue };
            match open(self.store.subkeys(), &name, &bytes) {
                Ok(opened) => {
                    self.keep(state, index, &name, &bytes)?;
                    down += 1;
                    self.blobs().insert(name.clone(), opened.header.blobs.clone());
                    Self::claim(state, &parsed.stag, &opened.header);
                    for (dtag, &seq) in opened.header.covers.iter().flatten() {
                        raise_seq(&mut state.covered, &parsed.stag, dtag, seq);
                    }
                    if let Err(e) = Self::apply(workspace, opened.header.doc, &opened.update) {
                        self.bad(state, &dest_id, &name, e)?;
                    }
                }
                Err(e) => self.bad(state, &dest_id, &name, e)?,
            }
        }

        let mut needed: Vec<(String, StreamName)> = segments
            .into_iter()
            .filter(|(_, p)| p.seq > get_seq(&state.covered, &p.stag, &p.dtag))
            .collect();
        needed.sort_by(|(_, a), (_, b)| a.stag.cmp(&b.stag).then(a.dtag.cmp(&b.dtag)).then(a.seq.cmp(&b.seq)));
        let names: Vec<String> = needed.iter().map(|(n, _)| n.clone()).collect();
        let fetched = self.fetch(dest, listed, &names).await?;
        for ((name, bytes), (_, parsed)) in fetched.into_iter().zip(&needed) {
            let Some(bytes) = bytes else { continue };
            match open(self.store.subkeys(), &name, &bytes) {
                Ok(opened) => {
                    self.keep(state, index, &name, &bytes)?;
                    down += 1;
                    index.add_segment(&parsed.stag, &parsed.dtag, parsed.seq);
                    self.blobs().insert(name.clone(), opened.header.blobs.clone());
                    Self::claim(state, &parsed.stag, &opened.header);
                    if let Err(e) = Self::apply(workspace, opened.header.doc, &opened.update) {
                        self.bad(state, &dest_id, &name, e)?;
                    }
                }
                Err(e) => self.bad(state, &dest_id, &name, e)?,
            }
        }
        Ok((down, blobs))
    }

    /// The bytes of `names`, fetched `concurrency` at a time, in order. A store failure ends the round.
    async fn fetch(
        &self,
        dest: &dyn RemoteStore,
        listed: &Listed,
        names: &[String],
    ) -> Result<Vec<(String, Option<Vec<u8>>)>> {
        let results: Vec<Fetched> = stream::iter(names.iter().cloned())
            .map(|name| async move {
                let bytes = match listed.entries.get(&name) {
                    Some(entry) => dest.get(entry).await,
                    None => Ok(None),
                };
                (name, bytes)
            })
            .buffered(self.concurrency.max(1))
            .collect()
            .await;
        results
            .into_iter()
            .map(|(name, r)| r.map(|b| (name, b)).map_err(Error::from))
            .collect()
    }

    fn keep(&self, state: &mut SyncState, index: &mut LocalIndex, name: &str, bytes: &[u8]) -> Result<()> {
        self.store.put_object(name, bytes)?;
        index.names.insert(name.to_owned());
        state.bad.remove(name);
        Ok(())
    }

    fn claim(state: &mut SyncState, stag: &str, header: &StreamHeader) {
        for map in [Some(&header.seen), header.covers.as_ref()].into_iter().flatten() {
            for (dtag, &seq) in map {
                raise_seq(&mut state.claims, stag, dtag, seq);
            }
        }
    }

    fn apply(workspace: Option<&Workspace>, doc: DocId, update: &[u8]) -> Result<()> {
        match workspace {
            Some(ws) if ws.is_loaded(doc) => ws.apply_remote(doc, update),
            _ => Ok(()),
        }
    }

    // Upload (spec/FORMAT.md section 10.2)

    fn stream_blobs(&self, name: &str, bytes: &[u8]) -> Option<Vec<String>> {
        if let Some(cached) = self.blobs().get(name) {
            return Some(cached.clone());
        }
        let opened = open(self.store.subkeys(), name, bytes).ok()?;
        self.blobs().insert(name.to_owned(), opened.header.blobs.clone());
        Some(opened.header.blobs)
    }

    fn manifest_chunks(&self, name: &str, bytes: &[u8]) -> Option<Vec<String>> {
        if let Some(cached) = self.chunks().get(name) {
            return Some(cached.clone());
        }
        let payload = open_envelope(self.store.subkeys(), Kind::Manifest, name, bytes).ok()?;
        let manifest = aparte_format::framing::Manifest::decode(&payload).ok()?;
        self.chunks().insert(name.to_owned(), manifest.chunks.clone());
        Some(manifest.chunks)
    }

    async fn upload(
        &self,
        pass: &Pass<'_>,
        rec: &mut DestRecord,
        index: &LocalIndex,
        (keyslot_files, has_fmt): (&[KeyslotFile], bool),
        me: &Me,
    ) -> Result<(usize, usize)> {
        let (dest, listed) = (pass.dest, pass.listed);
        let mut remote: HashSet<String> = listed.entries.keys().cloned().collect();
        let mut up = 0;
        let mut missing: Vec<&String> = index.names.iter().filter(|n| !remote.contains(*n)).collect();
        missing.sort_unstable();

        // The marker and the keyslots come first, confirmed by a listing: no object is any use without them.
        if !has_fmt || !keyslot_files.is_empty() {
            if !has_fmt {
                dest.put(FMT_NAME, FMT_BYTES).await?;
                up += 1;
            }
            for file in keyslot_files {
                dest.put(&file.name, &file.bytes).await?;
                up += 1;
            }
            dest.flush().await?;
            let check: HashSet<String> = dest.list().await?.into_iter().map(|e| e.name).collect();
            let confirmed = check.contains(FMT_NAME) && keyslot_files.iter().all(|f| check.contains(&f.name));
            if !confirmed {
                return Err(RemoteError::new(
                    RemoteErrorKind::Network,
                    "the destination does not list the keyslots it was sent",
                )
                .into());
            }
            remote.extend(check);
        }

        let of = |kinds: &[&str]| -> Vec<String> {
            missing
                .iter()
                .filter(|n| {
                    let kind = match parse_name(n) {
                        Some(ParsedName::Chunk { .. }) => "chunk",
                        Some(ParsedName::Manifest { .. }) => "manifest",
                        Some(ParsedName::Secret { .. }) => "secret",
                        Some(ParsedName::Checkpoint { .. }) => "checkpoint",
                        Some(ParsedName::Segment { .. }) => "segment",
                        _ => "",
                    };
                    kinds.contains(&kind)
                })
                .map(|n| (*n).clone())
                .collect()
        };
        let mut deferred = 0;
        let mut streams = of(&["checkpoint"]);
        streams.extend(of(&["segment"]));
        let phases: [(Vec<String>, u8); 4] = [
            (of(&["chunk"]), 0),
            (of(&["manifest"]), 1),
            (of(&["secret"]), 0),
            (streams, 2),
        ];
        for (names, rule) in phases {
            let mut sent = Vec::new();
            for name in names {
                let Some(bytes) = self.store.get_object(&name)? else {
                    continue;
                };
                let ready = match rule {
                    1 => self
                        .manifest_chunks(&name, &bytes)
                        .is_some_and(|ids| ids.iter().all(|id| chunk_name(id).is_ok_and(|c| remote.contains(&c)))),
                    2 => self.stream_blobs(&name, &bytes).is_some_and(|ids| {
                        ids.iter()
                            .all(|id| manifest_name(id).is_ok_and(|m| remote.contains(&m)))
                    }),
                    _ => true,
                };
                if !ready {
                    deferred += 1;
                    continue;
                }
                dest.put(&name, &bytes).await?;
                up += 1;
                sent.push(name);
            }
            if !sent.is_empty() {
                dest.flush().await?;
            }
            remote.extend(sent);
        }
        // Own segments now on the destination count for its rollback mark, as listed ones do.
        for name in &remote {
            if let Some(p) = stream_name(name)
                && !p.checkpoint
                && p.dtag == me.dtag
            {
                raise_seq(&mut rec.listed, &p.stag, &p.dtag, p.seq);
            }
        }
        Ok((up, deferred))
    }

    // Round

    /// One sync round with a destination: seal local changes, list, check, download, apply, upload. A `transient`
    /// destination (an archive being exported or imported) keeps no listing marks. The loaded documents of
    /// `workspace` receive what other devices wrote, and may get a checkpoint.
    pub async fn round(
        &self,
        dest: &dyn RemoteStore,
        transient: bool,
        workspace: Option<&Workspace>,
    ) -> Result<RoundResult> {
        let _lock = self.store.exclusive("sync")?;
        let mut state = SyncState::load(&self.store)?;
        let mut index = self.index_local()?;
        let mut me = self.identity()?;
        let sealed = self.seal_all(&mut state, &mut index, &me)?;

        let listed = Listed::read(dest.list().await?);
        let dest_id = dest.id().to_owned();
        let mut rec = state.dests.remove(&dest_id).unwrap_or_default();
        // A marker that is no longer listed is checked again once it reappears.
        if !listed.entries.contains_key(FMT_NAME) {
            rec.fmt_ok = Some(false);
        }
        let pass = Pass {
            dest,
            listed: &listed,
            workspace,
        };
        let (down, up, deferred) = self
            .round_body(&pass, &mut state, &mut rec, &mut index, &mut me)
            .await?;
        rec.last_ok_at = Some(self.now());
        if !transient {
            state.dests.insert(dest_id, rec);
        }
        state.save(&self.store)?;
        Ok(RoundResult {
            down,
            up,
            deferred,
            sealed,
            alarms: state.alarms.clone(),
        })
    }

    async fn round_body(
        &self,
        pass: &Pass<'_>,
        state: &mut SyncState,
        rec: &mut DestRecord,
        index: &mut LocalIndex,
        me: &mut Me,
    ) -> Result<(usize, usize, usize)> {
        let (dest, listed) = (pass.dest, pass.listed);
        let dest_id = dest.id().to_owned();
        let (keyslot_files, fmt) = self.sync_keyslots(state, rec, dest, listed).await?;

        // A segment or checkpoint under this device's tag that this device never wrote: a clone writes as it.
        let foreign = listed
            .entries
            .keys()
            .filter(|n| stream_name(n).is_some_and(|p| p.dtag == me.dtag) && !index.names.contains(*n))
            .count();
        if foreign > 0 {
            self.raise(
                state,
                format!("fork:{}", me.dtag),
                "fork",
                &dest_id,
                None,
                format!(
                    "{foreign} objects under this device's tag {} were written elsewhere",
                    me.dtag
                ),
            );
            *me = self.rotate()?;
        }

        self.judge(state, rec, &dest_id, listed);
        let (down, _blobs) = self.download(state, dest, index, listed, pass.workspace).await?;
        self.judge_claims(state, rec, &dest_id, listed);
        self.maybe_checkpoint(state, index, me, pass.workspace)?;
        let (up, deferred) = self.upload(pass, rec, index, (&keyslot_files, fmt), me).await?;
        Ok((down, up, deferred))
    }
}

/// The store's generator as an [`aparte_crypto::Rng`].
struct StoreRng<'a>(&'a RecordStore);

impl aparte_crypto::Rng for StoreRng<'_> {
    fn fill(&mut self, dest: &mut [u8]) -> aparte_crypto::Result<()> {
        self.0.fill_random(dest).map_err(aparte_format::Error::from)
    }
}

/// The code of a format error, for reporting.
pub fn code_of(error: &Error) -> &'static str {
    match error.format_code() {
        Some(c) => c.as_str(),
        None => match error.remote_kind() {
            Some(k) => k.as_str(),
            None => "io",
        },
    }
}

/// Whether an error says the vault's secret was wrong.
pub fn is_wrong_secret(error: &Error) -> bool {
    error.format_code() == Some(ErrorCode::WrongSecret)
}
