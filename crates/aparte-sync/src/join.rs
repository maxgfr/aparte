//! Joining a vault from its sync store (spec/FORMAT.md section 10.4): a new device reads the format marker and the
//! keyslots, the only plaintext a store holds, and hands them to [`aparte_store::Vault::join`]. It then unlocks with
//! the passphrase and the Secret Key of the Emergency Kit, and its first round downloads everything else, trusting
//! what it lists first.

use std::collections::BTreeSet;

use aparte_format::names::{FMT_BYTES, FMT_NAME, ParsedName, parse_name};
use aparte_store::KeyslotFile;
use serde_json::Value;

use crate::error::{RemoteError, RemoteErrorKind};
use crate::remote::RemoteStore;

/// The vault a store holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredVault {
    /// base32 vault id.
    pub vault: String,
    /// Its keyslot files.
    pub keyslots: Vec<KeyslotFile>,
}

/// The vault a store holds: `not-found` for a store with no vault yet, `incompatible` for another format or for
/// keyslots of more than one vault (the store is shared with something else: never guess which).
pub async fn read_stored_vault(store: &dyn RemoteStore) -> Result<StoredVault, RemoteError> {
    let entries = store.list().await?;
    let Some(marker) = entries.iter().find(|e| e.name == FMT_NAME) else {
        let kind = if entries.is_empty() {
            RemoteErrorKind::NotFound
        } else {
            RemoteErrorKind::Incompatible
        };
        let message = if entries.is_empty() {
            "this destination holds no vault yet"
        } else {
            "this destination holds something other than an aparte/1 vault"
        };
        return Err(RemoteError::new(kind, message));
    };
    match store.get(marker).await? {
        Some(bytes) if bytes == FMT_BYTES => {}
        _ => {
            return Err(RemoteError::new(
                RemoteErrorKind::Incompatible,
                "this destination holds another format than aparte/1",
            ));
        }
    }
    let mut keyslots = Vec::new();
    let mut vaults = BTreeSet::new();
    for entry in &entries {
        if !matches!(parse_name(&entry.name), Some(ParsedName::Keyslot { .. })) {
            continue;
        }
        let Some(bytes) = store.get(entry).await? else { continue };
        let Some(vault) = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("vault").and_then(Value::as_str).map(str::to_owned))
        else {
            continue;
        };
        vaults.insert(vault);
        keyslots.push(KeyslotFile {
            name: entry.name.clone(),
            bytes,
        });
    }
    let mut vaults = vaults.into_iter();
    match (vaults.next(), vaults.next()) {
        (Some(vault), None) => Ok(StoredVault { vault, keyslots }),
        (None, _) => Err(RemoteError::new(
            RemoteErrorKind::NotFound,
            "this destination holds no keyslot",
        )),
        (Some(_), Some(_)) => Err(RemoteError::new(
            RemoteErrorKind::Incompatible,
            "this destination holds keyslots of several vaults",
        )),
    }
}
