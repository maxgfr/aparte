//! The vault over the keyslots of spec/FORMAT.md section 6 and the store of section 11, with the semantics of the web
//! app's vault (web/src/core/vault/vault.ts): creating, joining from a sync store, unlocking, adding and removing
//! slots, changing the passphrase, recovering.
//!
//! Invariants:
//! - The master key exists in clear only inside one operation and is zeroed before it returns ([`MasterKey`] zeroes
//!   itself); the subkeys live in the [`Unlocked`] handle, which zeroes them when dropped.
//! - Every operation that opens a slot reads the keyslots from disk first, so a slot another process added or removed
//!   is seen at once.
//! - A new slot is persisted before any slot is removed, so an interruption never leaves a vault without a slot, and
//!   a vault always keeps a slot that is not a recovery slot.
//! - The Secret Key is never written to the store: the caller keeps it (the CLI in the OS keychain, when asked).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use aparte_crypto::keys::MasterKey;
use aparte_crypto::keyslot::{NewKeyslot, SlotSecret, create_keyslot, open_keyslot};
use aparte_crypto::rng::{Rng, draw};
use aparte_crypto::text::{format_recovery_key, format_secret_key, generate_recovery_key, generate_secret_key};
use aparte_crypto::{Subkeys, keyslot::normalize_passphrase};
use aparte_format::encoding::{base32_decode_array, base32_encode};
use aparte_format::keyslot::{Argon2Params, DEFAULT_ARGON2, Kdf, Keyslot, KeyslotKind};
use aparte_format::{Error as FormatError, ErrorCode};
use zeroize::Zeroizing;

use crate::error::Result;
use crate::meta::Meta;
use crate::records::RecordStore;

/// Whether this device holds a vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultState {
    /// No vault on this device: one can be created or joined.
    Absent,
    /// A vault, locked: unlocking needs a passphrase (and the Secret Key) or the recovery key.
    Locked,
}

/// A keyslot as the status shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotInfo {
    /// base32 slot id.
    pub slot: String,
    /// What opens it.
    pub kind: KeyslotKind,
    /// Whether a passphrase slot also needs the Secret Key.
    pub secret_key: bool,
}

/// A keyslot file as a sync store holds it: `keys/<slot>.json` and its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyslotFile {
    /// `keys/<slot>.json`.
    pub name: String,
    /// The file bytes, the writer serialization and a line feed.
    pub bytes: Vec<u8>,
}

/// What a secret that opens a slot is.
#[derive(Clone, Copy)]
pub enum Credential<'a> {
    /// A passphrase, and the Secret Key when this device has it.
    Passphrase {
        /// As typed; normalized to NFKC.
        passphrase: &'a str,
        /// The 16-byte Secret Key.
        secret_key: Option<&'a [u8; 16]>,
    },
    /// The 32-byte recovery key.
    Recovery {
        /// The recovery key.
        key: &'a [u8; 32],
    },
}

impl Credential<'_> {
    const fn kind(&self) -> KeyslotKind {
        match self {
            Self::Passphrase { .. } => KeyslotKind::Passphrase,
            Self::Recovery { .. } => KeyslotKind::Recovery,
        }
    }

    const fn secret(&self) -> SlotSecret<'_> {
        match *self {
            Self::Passphrase { passphrase, secret_key } => SlotSecret::Passphrase { passphrase, secret_key },
            Self::Recovery { key } => SlotSecret::Recovery { key },
        }
    }
}

/// How a new vault is made.
#[derive(Debug, Clone, Copy)]
pub struct CreateOptions {
    /// Combine the passphrase with a new Secret Key (two-secret key derivation).
    pub secret_key: bool,
    /// Also create a recovery slot.
    pub recovery_key: bool,
}

impl Default for CreateOptions {
    fn default() -> Self {
        CreateOptions {
            secret_key: true,
            recovery_key: true,
        }
    }
}

/// An unlocked vault: its subkeys and its record store. Dropping it drops (and zeroes) the keys.
#[derive(Debug)]
pub struct Unlocked {
    /// base32 vault id.
    pub vault: String,
    /// The 16 vault id bytes.
    pub vault_id: [u8; 16],
    /// The six subkeys.
    pub subkeys: Arc<Subkeys>,
    /// The encrypted records, bound to the subkeys.
    pub store: Arc<RecordStore>,
    /// The slot that opened.
    pub slot: String,
    /// The Secret Key the opened slot combined with the passphrase, if any.
    pub secret_key: Option<Zeroizing<[u8; 16]>>,
}

/// What creating a vault returns; the texts are shown to the user once.
#[derive(Debug)]
pub struct Created {
    /// The Emergency Kit text of the Secret Key, or `None` without one.
    pub secret_key: Option<String>,
    /// The recovery key text, or `None` without a recovery slot.
    pub recovery_key: Option<String>,
    /// The vault, unlocked.
    pub unlocked: Unlocked,
}

/// A passphrase change: the slot added and the slot it replaced (removed locally once the new one is written).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Changed {
    /// The new passphrase slot.
    pub added: String,
    /// The slot opened with the current passphrase, now removed.
    pub previous: String,
}

/// A recovery: the passphrase slot added, the slots removed, and a new Secret Key when one was generated.
#[derive(Debug)]
pub struct Recovered {
    /// The new passphrase slot.
    pub added: String,
    /// The passphrase slots removed (with `replace`).
    pub removed: Vec<String>,
    /// The Emergency Kit text of a new Secret Key, when this device had none to pair the new slot with.
    pub secret_key: Option<String>,
    /// The vault, unlocked.
    pub unlocked: Unlocked,
}

/// The vault of one store directory.
#[derive(Debug, Clone)]
pub struct Vault {
    meta: Meta,
    argon2: Argon2Params,
}

/// The slot a master key was recovered from.
struct Opened {
    mk: MasterKey,
    slot: Keyslot,
}

fn invalid(detail: &'static str) -> crate::Error {
    FormatError::InvalidInput(detail).into()
}

impl Vault {
    /// The vault of the store directory `root`.
    pub fn new(root: impl Into<PathBuf>) -> Vault {
        Vault {
            meta: Meta::new(root),
            argon2: DEFAULT_ARGON2,
        }
    }

    /// The same vault, writing new passphrase slots with other Argon2id costs (within the bounds of spec/FORMAT.md
    /// section 6.3). Writers use [`DEFAULT_ARGON2`]; tests pass the small costs of the vectors.
    pub fn with_argon2(mut self, params: Argon2Params) -> Vault {
        self.argon2 = params;
        self
    }

    /// The store directory.
    pub fn root(&self) -> &Path {
        self.meta.root()
    }

    /// The plaintext entries.
    pub fn meta(&self) -> &Meta {
        &self.meta
    }

    /// Whether this device holds a vault.
    pub fn state(&self) -> Result<VaultState> {
        Ok(match self.meta.vault()? {
            Some(_) => VaultState::Locked,
            None => VaultState::Absent,
        })
    }

    /// The base32 vault id; `invalid-state` without a vault.
    pub fn vault(&self) -> Result<String> {
        self.meta
            .vault()?
            .ok_or_else(|| FormatError::InvalidState("no vault on this device").into())
    }

    fn vault_id(&self) -> Result<(String, [u8; 16])> {
        let text = self.vault()?;
        let id = base32_decode_array(&text)?;
        Ok((text, id))
    }

    /// The keyslots of this vault, read afresh; a file that does not parse, or of another vault, is skipped (a slot
    /// this build cannot read opens nothing here).
    fn slots(&self) -> Result<Vec<Keyslot>> {
        let (_, vault_id) = self.vault_id()?;
        let mut out = Vec::new();
        for (slot, bytes) in self.meta.keyslots()? {
            let name = format!("keys/{slot}.json");
            if let Ok(parsed) = Keyslot::parse(&bytes, Some(&name))
                && parsed.vault_id == vault_id
            {
                out.push(parsed);
            }
        }
        Ok(out)
    }

    /// The keyslots as the status shows them.
    pub fn slot_infos(&self) -> Result<Vec<SlotInfo>> {
        Ok(self
            .slots()?
            .iter()
            .map(|s| SlotInfo {
                slot: s.slot(),
                kind: s.kind(),
                secret_key: matches!(s.kdf, Kdf::Passphrase { secret_key: true, .. }),
            })
            .collect())
    }

    /// The keyslot files, as the sync layer uploads them, sorted by name.
    pub fn keyslot_files(&self) -> Result<Vec<KeyslotFile>> {
        Ok(self
            .slots()?
            .iter()
            .map(|s| KeyslotFile {
                name: s.name(),
                bytes: s.serialize(),
            })
            .collect())
    }

    fn unlocked(
        &self,
        mk: &[u8; 32],
        slot: String,
        secret_key: Option<&[u8; 16]>,
        rng: Box<dyn Rng + Send>,
    ) -> Result<Unlocked> {
        let (vault, vault_id) = self.vault_id()?;
        let subkeys = Arc::new(Subkeys::derive(mk, &vault_id));
        let store = Arc::new(RecordStore::new(self.meta.root(), subkeys.clone(), rng));
        Ok(Unlocked {
            vault,
            vault_id,
            subkeys,
            store,
            slot,
            secret_key: secret_key.map(|k| Zeroizing::new(*k)),
        })
    }

    /// Creates a vault: a master key, a vault id, a device id, a passphrase slot (with a new Secret Key unless
    /// `secret_key` is off) and a recovery slot. `invalid-state`, with nothing written, when the device holds a vault.
    /// Randomness is drawn in the web app's order: master key, vault id, device id, Secret Key, recovery key, then
    /// each slot's.
    pub fn create(
        &self,
        passphrase: &str,
        options: CreateOptions,
        rng: &mut dyn Rng,
        store_rng: Box<dyn Rng + Send>,
    ) -> Result<Created> {
        normalize_passphrase(passphrase)?;
        if self.meta.vault()?.is_some() {
            return Err(FormatError::InvalidState("a vault already exists on this device").into());
        }
        let mk = MasterKey::new(draw::<32>(rng)?);
        let vault_id = draw::<16>(rng)?;
        let device_id = Zeroizing::new(draw::<16>(rng)?);
        let sk = if options.secret_key {
            Some(generate_secret_key(rng)?)
        } else {
            None
        };
        let rk = if options.recovery_key {
            Some(generate_recovery_key(rng)?)
        } else {
            None
        };
        let mut slots = vec![create_keyslot(
            &mk,
            &vault_id,
            &NewKeyslot::Passphrase {
                passphrase,
                secret_key: sk.as_deref(),
                params: self.argon2,
            },
            rng,
            None,
        )?];
        if let Some(rk) = &rk {
            slots.push(create_keyslot(
                &mk,
                &vault_id,
                &NewKeyslot::Recovery { key: rk },
                rng,
                None,
            )?);
        }
        let vault = base32_encode(&vault_id);
        let files: Vec<(String, Vec<u8>)> = slots.iter().map(|s| (s.slot(), s.serialize())).collect();
        if !self.meta.init_vault(&vault, &files)? {
            return Err(FormatError::InvalidState("a vault already exists on this device").into());
        }
        let unlocked = self.unlocked(&mk, slots[0].slot(), sk.as_deref(), store_rng)?;
        unlocked.store.put("device", "id", device_id.as_ref())?;
        Ok(Created {
            secret_key: sk.as_deref().map(format_secret_key),
            recovery_key: rk.as_deref().map(format_recovery_key),
            unlocked,
        })
    }

    /// Takes a vault that exists elsewhere from the keyslot files of its sync store (spec/FORMAT.md section 10.4):
    /// every file must parse, carry its own name and belong to `vault`, and one at least must not be a recovery slot.
    /// Only `fmt`, `vault` and the keyslots are written; `invalid-state` when the device holds a vault.
    pub fn join(&self, vault: &str, files: &[KeyslotFile]) -> Result<()> {
        let vault_id: [u8; 16] = base32_decode_array(vault).map_err(|_| invalid("not a vault id"))?;
        let mut slots: Vec<(String, Vec<u8>)> = Vec::new();
        let mut usable = false;
        for file in files {
            let slot = Keyslot::parse(&file.bytes, Some(&file.name))?;
            if slot.vault_id != vault_id {
                return Err(invalid("a keyslot belongs to another vault"));
            }
            if slots.iter().any(|(s, _)| *s == slot.slot()) {
                continue;
            }
            usable |= slot.kind() != KeyslotKind::Recovery;
            slots.push((slot.slot(), slot.serialize()));
        }
        if !usable {
            return Err(invalid("the vault has no slot that a passphrase opens"));
        }
        if !self.meta.init_vault(vault, &slots)? {
            return Err(FormatError::InvalidState("a vault already exists on this device").into());
        }
        Ok(())
    }

    /// Adds the keyslot files of this vault that another device created and this device does not have; files of
    /// another vault or that do not parse are skipped. Returns the slots added.
    pub fn import_keyslots(&self, files: &[KeyslotFile]) -> Result<Vec<String>> {
        let (_, vault_id) = self.vault_id()?;
        let _lock = self.meta.lock()?;
        let known: Vec<String> = self.meta.keyslots()?.into_iter().map(|(s, _)| s).collect();
        let mut added = Vec::new();
        for file in files {
            let Ok(slot) = Keyslot::parse(&file.bytes, Some(&file.name)) else {
                continue;
            };
            let id = slot.slot();
            if slot.vault_id != vault_id || known.contains(&id) || added.contains(&id) {
                continue;
            }
            self.meta.put_keyslot(&id, &slot.serialize())?;
            added.push(id);
        }
        Ok(added)
    }

    /// Opens the first slot of the credential's kind that `credential` opens (spec/FORMAT.md section 6.7). A slot
    /// that needs the Secret Key is tried only with one; `wrong-secret` when none opens, `invalid-input` when the only
    /// slots that could need a Secret Key that was not given.
    fn open_with(&self, credential: &Credential<'_>) -> Result<Opened> {
        let (_, vault_id) = self.vault_id()?;
        let candidates: Vec<Keyslot> = self
            .slots()?
            .into_iter()
            .filter(|s| s.kind() == credential.kind())
            .collect();
        let mut needs_secret_key = false;
        for slot in candidates {
            match open_keyslot(&slot, &credential.secret(), &vault_id, None) {
                Ok(mk) => return Ok(Opened { mk, slot }),
                Err(e) if e.code() == ErrorCode::WrongSecret => {}
                Err(e)
                    if e.code() == ErrorCode::InvalidInput
                        && matches!(credential, Credential::Passphrase { secret_key: None, .. }) =>
                {
                    needs_secret_key = true;
                }
                Err(e) => return Err(e.into()),
            }
        }
        if needs_secret_key {
            return Err(invalid("this vault needs the Secret Key of the Emergency Kit"));
        }
        Err(FormatError::WrongSecret("no keyslot of this vault opens with this secret").into())
    }

    /// Unlocks: opens a slot and returns the subkeys and the record store (whose envelopes draw IVs from `store_rng`).
    pub fn unlock(&self, credential: &Credential<'_>, store_rng: Box<dyn Rng + Send>) -> Result<Unlocked> {
        let opened = self.open_with(credential)?;
        let sk = match credential {
            Credential::Passphrase { secret_key, .. }
                if matches!(opened.slot.kdf, Kdf::Passphrase { secret_key: true, .. }) =>
            {
                *secret_key
            }
            _ => None,
        };
        self.unlocked(&opened.mk, opened.slot.slot(), sk, store_rng)
    }

    /// Adds a passphrase slot for `next` with the same Secret Key after opening a slot with `current`, then removes
    /// the slot `current` opened (spec/FORMAT.md section 6.10): locally at once, on the sync stores at the next round.
    pub fn change_passphrase(&self, current: &Credential<'_>, next: &str, rng: &mut dyn Rng) -> Result<Changed> {
        if !matches!(current, Credential::Passphrase { .. }) {
            return Err(invalid("changing the passphrase needs the current passphrase"));
        }
        normalize_passphrase(next)?;
        let opened = self.open_with(current)?;
        let secret_key = match (&opened.slot.kdf, current) {
            (Kdf::Passphrase { secret_key: true, .. }, Credential::Passphrase { secret_key, .. }) => *secret_key,
            _ => None,
        };
        let added = self.add_slot(
            &opened.mk,
            &NewKeyslot::Passphrase {
                passphrase: next,
                secret_key,
                params: self.argon2,
            },
            rng,
        )?;
        let previous = opened.slot.slot();
        self.meta.delete_keyslot(&previous)?;
        Ok(Changed { added, previous })
    }

    /// Adds a recovery slot after opening a slot with `current`; returns the slot and the text, shown once.
    pub fn add_recovery_key(&self, current: &Credential<'_>, rng: &mut dyn Rng) -> Result<(String, String)> {
        let opened = self.open_with(current)?;
        let rk = generate_recovery_key(rng)?;
        let slot = self.add_slot(&opened.mk, &NewKeyslot::Recovery { key: &rk }, rng)?;
        Ok((slot, format_recovery_key(&rk)))
    }

    /// Opens a recovery slot and adds a passphrase slot for `next`. The new slot pairs with `secret_key` when this
    /// device knows the Secret Key, else with a new one (returned as a new Emergency Kit). With `replace`, every other
    /// passphrase slot is removed once the new one is persisted: the forgotten passphrase stops opening the vault.
    pub fn recover(
        &self,
        recovery_key: &[u8; 32],
        next: &str,
        secret_key: Option<&[u8; 16]>,
        replace: bool,
        rng: &mut dyn Rng,
        store_rng: Box<dyn Rng + Send>,
    ) -> Result<Recovered> {
        normalize_passphrase(next)?;
        let opened = self.open_with(&Credential::Recovery { key: recovery_key })?;
        let generated = match secret_key {
            Some(_) => None,
            None => Some(generate_secret_key(rng)?),
        };
        let sk: &[u8; 16] = generated
            .as_deref()
            .or(secret_key)
            .ok_or(FormatError::InvalidState("no Secret Key to pair the new slot with"))?;
        let added = self.add_slot(
            &opened.mk,
            &NewKeyslot::Passphrase {
                passphrase: next,
                secret_key: Some(sk),
                params: self.argon2,
            },
            rng,
        )?;
        let mut removed = Vec::new();
        if replace {
            for slot in self.slots()? {
                if slot.kind() == KeyslotKind::Passphrase && slot.slot() != added {
                    self.meta.delete_keyslot(&slot.slot())?;
                    removed.push(slot.slot());
                }
            }
        }
        let unlocked = self.unlocked(&opened.mk, added.clone(), Some(sk), store_rng)?;
        Ok(Recovered {
            added,
            removed,
            secret_key: generated.as_deref().map(format_secret_key),
            unlocked,
        })
    }

    /// Creates and persists one slot for the master key.
    fn add_slot(&self, mk: &[u8; 32], new: &NewKeyslot<'_>, rng: &mut dyn Rng) -> Result<String> {
        let (_, vault_id) = self.vault_id()?;
        let slot = create_keyslot(mk, &vault_id, new, rng, None)?;
        let _lock = self.meta.lock()?;
        self.meta.put_keyslot(&slot.slot(), &slot.serialize())?;
        Ok(slot.slot())
    }

    /// Removes a slot; `invalid-state` when the vault would keep no slot other than recovery slots, `invalid-input`
    /// for a slot it does not have.
    pub fn remove_slot(&self, slot: &str) -> Result<()> {
        let _lock = self.meta.lock()?;
        let slots = self.slots()?;
        if !slots.iter().any(|s| s.slot() == slot) {
            return Err(invalid("no such keyslot"));
        }
        if !slots
            .iter()
            .any(|s| s.slot() != slot && s.kind() != KeyslotKind::Recovery)
        {
            return Err(FormatError::InvalidState("the vault would keep no slot that a passphrase opens").into());
        }
        self.meta.delete_keyslot(slot)
    }

    /// Removes the vault from this device (every file of the store). The sync stores keep it.
    pub fn leave(&self) -> Result<()> {
        self.meta.clear()
    }
}

#[cfg(test)]
mod tests {
    use aparte_crypto::rng::OsRng;
    use aparte_crypto::text::{parse_recovery_key, parse_secret_key};

    use super::*;

    const SMALL: Argon2Params = Argon2Params { m: 19456, t: 2, p: 1 };

    fn options() -> CreateOptions {
        CreateOptions::default()
    }

    fn vault_at(path: &Path) -> Vault {
        Vault::new(path).with_argon2(SMALL)
    }

    fn code(e: &crate::Error) -> &'static str {
        e.code().map_or("io", |c| c.as_str())
    }

    #[test]
    fn create_unlock_and_lock_out() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = vault_at(&dir.path().join("vault"));
        assert_eq!(vault.state().expect("state"), VaultState::Absent);
        let created = vault
            .create("correct horse", options(), &mut OsRng, Box::new(OsRng))
            .expect("create");
        let sk = parse_secret_key(created.secret_key.as_deref().expect("kit")).expect("parse");
        let rk = parse_recovery_key(created.recovery_key.as_deref().expect("recovery")).expect("parse");
        assert_eq!(vault.state().expect("state"), VaultState::Locked);
        let device = created
            .unlocked
            .store
            .get("device", "id")
            .expect("device")
            .expect("present");
        assert_eq!(device.len(), 16);
        let infos = vault.slot_infos().expect("slots");
        assert_eq!(infos.len(), 2);
        assert!(infos.iter().any(|s| s.kind == KeyslotKind::Passphrase && s.secret_key));

        let ok = vault
            .unlock(
                &Credential::Passphrase {
                    passphrase: "correct horse",
                    secret_key: Some(&sk),
                },
                Box::new(OsRng),
            )
            .expect("unlock");
        assert_eq!(ok.vault, created.unlocked.vault);
        assert_eq!(ok.store.get("device", "id").expect("get").expect("present"), device);
        let wrong = vault
            .unlock(
                &Credential::Passphrase {
                    passphrase: "wrong",
                    secret_key: Some(&sk),
                },
                Box::new(OsRng),
            )
            .unwrap_err();
        assert_eq!(code(&wrong), "wrong-secret");
        let missing = vault
            .unlock(
                &Credential::Passphrase {
                    passphrase: "correct horse",
                    secret_key: None,
                },
                Box::new(OsRng),
            )
            .unwrap_err();
        assert_eq!(code(&missing), "invalid-input");
        vault
            .unlock(&Credential::Recovery { key: &rk }, Box::new(OsRng))
            .expect("recovery unlock");
        assert_eq!(
            code(
                &vault
                    .create("again", options(), &mut OsRng, Box::new(OsRng))
                    .unwrap_err()
            ),
            "invalid-state"
        );
    }

    #[test]
    fn join_takes_the_slots_of_a_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = vault_at(&dir.path().join("a"));
        let created = first
            .create("pass phrase", options(), &mut OsRng, Box::new(OsRng))
            .expect("create");
        let files = first.keyslot_files().expect("files");
        let second = vault_at(&dir.path().join("b"));
        let recovery_only: Vec<KeyslotFile> = files
            .iter()
            .filter(|f| Keyslot::parse(&f.bytes, Some(&f.name)).expect("parse").kind() == KeyslotKind::Recovery)
            .cloned()
            .collect();
        assert_eq!(
            code(&second.join(&created.unlocked.vault, &recovery_only).unwrap_err()),
            "invalid-input"
        );
        assert_eq!(
            code(&second.join("aaaaaaaaaaaaaaaaaaaaaaaaaa", &files).unwrap_err()),
            "invalid-input"
        );
        second.join(&created.unlocked.vault, &files).expect("join");
        assert_eq!(second.keyslot_files().expect("files"), files);
        let sk = parse_secret_key(created.secret_key.as_deref().expect("kit")).expect("parse");
        second
            .unlock(
                &Credential::Passphrase {
                    passphrase: "pass phrase",
                    secret_key: Some(&sk),
                },
                Box::new(OsRng),
            )
            .expect("unlock");
        assert_eq!(second.import_keyslots(&files).expect("import"), Vec::<String>::new());
    }

    #[test]
    fn changing_the_passphrase_replaces_the_slot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = vault_at(&dir.path().join("vault"));
        let created = vault
            .create("old one", options(), &mut OsRng, Box::new(OsRng))
            .expect("create");
        let sk = parse_secret_key(created.secret_key.as_deref().expect("kit")).expect("parse");
        let changed = vault
            .change_passphrase(
                &Credential::Passphrase {
                    passphrase: "old one",
                    secret_key: Some(&sk),
                },
                "new one",
                &mut OsRng,
            )
            .expect("change");
        assert_ne!(changed.added, changed.previous);
        let old = vault.unlock(
            &Credential::Passphrase {
                passphrase: "old one",
                secret_key: Some(&sk),
            },
            Box::new(OsRng),
        );
        assert_eq!(code(&old.unwrap_err()), "wrong-secret");
        let new = vault
            .unlock(
                &Credential::Passphrase {
                    passphrase: "new one",
                    secret_key: Some(&sk),
                },
                Box::new(OsRng),
            )
            .expect("unlock");
        assert_eq!(new.slot, changed.added);
        let recovery = vault
            .slot_infos()
            .expect("slots")
            .into_iter()
            .find(|s| s.kind == KeyslotKind::Recovery)
            .expect("recovery");
        let only_pass = vault
            .slot_infos()
            .expect("slots")
            .into_iter()
            .find(|s| s.kind == KeyslotKind::Passphrase)
            .expect("pass");
        assert_eq!(code(&vault.remove_slot(&only_pass.slot).unwrap_err()), "invalid-state");
        vault.remove_slot(&recovery.slot).expect("a recovery slot can go");
    }

    #[test]
    fn recovery_sets_a_new_passphrase_and_a_new_secret_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = vault_at(&dir.path().join("vault"));
        let created = vault
            .create("forgotten", options(), &mut OsRng, Box::new(OsRng))
            .expect("create");
        let rk = parse_recovery_key(created.recovery_key.as_deref().expect("recovery")).expect("parse");
        let recovered = vault
            .recover(&rk, "remembered", None, true, &mut OsRng, Box::new(OsRng))
            .expect("recover");
        assert_eq!(recovered.removed.len(), 1);
        let sk = parse_secret_key(recovered.secret_key.as_deref().expect("new kit")).expect("parse");
        vault
            .unlock(
                &Credential::Passphrase {
                    passphrase: "remembered",
                    secret_key: Some(&sk),
                },
                Box::new(OsRng),
            )
            .expect("unlock");
        assert_eq!(recovered.unlocked.vault, created.unlocked.vault);
    }
}
