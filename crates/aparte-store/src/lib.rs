//! The device store of the aparte CLI, the counterpart of the web app's IndexedDB database `aparte-v1`
//! (spec/FORMAT.md section 11), and the vault built on it.
//!
//! The store is a directory, private to the user (directories 0700, files 0600, every write atomic):
//!
//! | Path | Content | Plaintext? |
//! |---|---|---|
//! | `fmt` | `aparte/1\n` | yes |
//! | `vault` | base32 `vaultId`, written last when a vault is created or joined | yes |
//! | `keys/<slot>.json` | the keyslot files (spec/FORMAT.md section 6.1) | yes, by design |
//! | `objects/<name>` | envelopes of kinds 1 to 5, exactly as on the remote, in sub-directories following the `/` of the name | ciphertext |
//! | `local/<localName>` | local records, kind-6 envelopes under HMAC-derived names (section 11.3) | ciphertext |
//! | `pending/<localName>` | the pending queue: local Yjs updates not sealed into a segment yet (purpose `pending`) | ciphertext |
//! | `locks/` | empty lock files serializing writers across processes | empty |
//!
//! No file name or content carries a purpose, an id, a timestamp or any content in clear. The Secret Key is never
//! stored here: the CLI keeps it in the OS keychain when the user asks it to, and asks for it otherwise.
//!
//! - [`meta`]: the plaintext entries, usable while the vault is locked.
//! - [`records`]: the encrypted record store of one unlocked vault: local records, the object mirror and the
//!   pending queue.
//! - [`vault`]: creating, joining, unlocking, changing the passphrase, recovering, over the keyslots.

#![forbid(unsafe_code)]

pub mod error;
pub mod fsx;
pub mod meta;
pub mod records;
pub mod vault;

pub use error::{Error, Result};
pub use meta::Meta;
pub use records::{PendingUpdate, RecordStore};
pub use vault::{CreateOptions, Created, Credential, KeyslotFile, SlotInfo, Unlocked, Vault, VaultState};
