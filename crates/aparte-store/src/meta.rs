//! The plaintext entries of the store (spec/FORMAT.md section 11.2): the format marker, the vault id and the keyslot
//! files. They are what unlocking reads, so they are usable while the vault is locked; nothing in them is secret.
//!
//! A vault comes into existence in one step that first checks that none exists: under the `meta` lock, the leftovers
//! of an interrupted creation are removed, `fmt` and the keyslots are written, and `vault` is written last. An
//! interrupted creation therefore reads back as no vault, and a second creation never replaces a first one.

use std::path::{Path, PathBuf};

use aparte_format::names::FMT_BYTES;
use aparte_format::{Error as FormatError, encoding::is_base32_chars};

use crate::error::Result;
use crate::fsx::{self, FileLock};

const FMT: &str = "fmt";
const VAULT: &str = "vault";
const KEYS: &str = "keys";

/// Whether `slot` is the 26-character base32 of a slot id.
fn is_slot(slot: &str) -> bool {
    slot.len() == 26 && is_base32_chars(slot)
}

fn check_slot(slot: &str) -> Result<()> {
    if is_slot(slot) {
        Ok(())
    } else {
        Err(FormatError::InvalidInput("a slot id is 26 base32 characters").into())
    }
}

/// The plaintext part of a store directory.
#[derive(Debug, Clone)]
pub struct Meta {
    root: PathBuf,
}

impl Meta {
    /// The entries of the store at `root`; nothing is read or created yet.
    pub fn new(root: impl Into<PathBuf>) -> Meta {
        Meta { root: root.into() }
    }

    /// The store directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Holds the lock that serializes changes to the entries.
    pub fn lock(&self) -> Result<FileLock> {
        FileLock::acquire(&self.root.join("locks").join("meta"))
    }

    /// The base32 vault id, or `None` when the store holds no vault. A marker of another format is
    /// `unsupported-format`.
    pub fn vault(&self) -> Result<Option<String>> {
        let Some(bytes) = fsx::read_opt(&self.root.join(VAULT))? else {
            return Ok(None);
        };
        match fsx::read_opt(&self.root.join(FMT))? {
            Some(fmt) if fmt == FMT_BYTES => {}
            _ => return Err(FormatError::UnsupportedFormat("the store is not an aparte/1 store").into()),
        }
        let text = String::from_utf8(bytes).map_err(|_| FormatError::Corrupt("the vault id is not text"))?;
        if text.len() != 26 || !is_base32_chars(&text) {
            return Err(FormatError::Corrupt("the vault id is not 26 base32 characters").into());
        }
        Ok(Some(text))
    }

    /// The keyslot files by slot id, sorted by slot.
    pub fn keyslots(&self) -> Result<Vec<(String, Vec<u8>)>> {
        let dir = self.root.join(KEYS);
        let mut out = Vec::new();
        for file in fsx::file_names(&dir)? {
            let Some(slot) = file.strip_suffix(".json").filter(|s| is_slot(s)) else {
                continue;
            };
            if let Some(bytes) = fsx::read_opt(&dir.join(&file))? {
                out.push((slot.to_owned(), bytes));
            }
        }
        Ok(out)
    }

    /// Writes (or replaces) one keyslot file.
    pub fn put_keyslot(&self, slot: &str, bytes: &[u8]) -> Result<()> {
        check_slot(slot)?;
        fsx::atomic_write(&self.root.join(KEYS).join(format!("{slot}.json")), bytes)
    }

    /// Removes one keyslot file.
    pub fn delete_keyslot(&self, slot: &str) -> Result<()> {
        check_slot(slot)?;
        fsx::remove_opt(&self.root.join(KEYS).join(format!("{slot}.json")))?;
        Ok(())
    }

    /// Makes a vault exist (see the module documentation). Returns false, having written nothing, when the store
    /// already holds one.
    pub fn init_vault(&self, vault: &str, keyslots: &[(String, Vec<u8>)]) -> Result<bool> {
        if vault.len() != 26 || !is_base32_chars(vault) {
            return Err(FormatError::InvalidInput("a vault id is 26 base32 characters").into());
        }
        for (slot, _) in keyslots {
            check_slot(slot)?;
        }
        let _lock = self.lock()?;
        if self.root.join(VAULT).exists() {
            return Ok(false);
        }
        self.clear_entries()?;
        fsx::private_dir(&self.root)?;
        fsx::atomic_write(&self.root.join(FMT), FMT_BYTES)?;
        for (slot, bytes) in keyslots {
            fsx::atomic_write(&self.root.join(KEYS).join(format!("{slot}.json")), bytes)?;
        }
        fsx::atomic_write(&self.root.join(VAULT), vault.as_bytes())?;
        Ok(true)
    }

    /// Removes every entry and every encrypted file (the objects, the records, the queue), for a device that
    /// leaves the vault or a creation that restarts.
    fn clear_entries(&self) -> Result<()> {
        // The vault id goes first, so an interrupted clear reads back as no vault.
        fsx::remove_opt(&self.root.join(VAULT))?;
        for dir in [KEYS, "objects", "local", "pending"] {
            fsx::remove_dir_opt(&self.root.join(dir))?;
        }
        fsx::remove_opt(&self.root.join(FMT))?;
        Ok(())
    }

    /// Removes the vault from this device: every entry and every encrypted file.
    pub fn clear(&self) -> Result<()> {
        let _lock = self.lock()?;
        self.clear_entries()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VAULT_ID: &str = "6dy7f47u6x3pp6hz7l57z7p674";
    const SLOT: &str = "ceirceirceirceirceirceirce";

    #[test]
    fn a_vault_is_created_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let meta = Meta::new(dir.path().join("vault"));
        assert_eq!(meta.vault().expect("vault"), None);
        assert!(meta.keyslots().expect("slots").is_empty());
        let slots = vec![(SLOT.to_owned(), b"{}\n".to_vec())];
        assert!(meta.init_vault(VAULT_ID, &slots).expect("init"));
        assert_eq!(meta.vault().expect("vault").as_deref(), Some(VAULT_ID));
        assert_eq!(meta.keyslots().expect("slots"), slots);
        assert!(!meta.init_vault("aaaaaaaaaaaaaaaaaaaaaaaaaa", &[]).expect("refused"));
        assert_eq!(meta.vault().expect("vault").as_deref(), Some(VAULT_ID));
        meta.delete_keyslot(SLOT).expect("delete");
        assert!(meta.keyslots().expect("slots").is_empty());
        meta.clear().expect("clear");
        assert_eq!(meta.vault().expect("vault"), None);
    }

    #[test]
    fn an_interrupted_creation_reads_back_as_absent_and_is_replaced() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("vault");
        fsx::atomic_write(&root.join("keys").join(format!("{SLOT}.json")), b"left over").expect("write");
        let meta = Meta::new(&root);
        assert_eq!(meta.vault().expect("vault"), None);
        assert!(meta.init_vault(VAULT_ID, &[]).expect("init"));
        assert!(meta.keyslots().expect("slots").is_empty(), "leftovers are removed");
    }

    #[test]
    fn another_format_and_bad_ids_are_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("vault");
        let meta = Meta::new(&root);
        assert!(meta.init_vault("not a vault", &[]).is_err());
        assert!(meta.put_keyslot("../escape", b"x").is_err());
        assert!(meta.init_vault(VAULT_ID, &[]).expect("init"));
        fsx::atomic_write(&root.join("fmt"), b"aparte/2\n").expect("write");
        assert_eq!(
            meta.vault().unwrap_err().code().map(|c| c.as_str()),
            Some("unsupported-format")
        );
    }
}
