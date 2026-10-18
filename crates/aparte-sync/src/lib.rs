//! End-to-end-encrypted sync of the aparte CLI, over the `aparte/1` format the web app writes (spec/FORMAT.md,
//! spec/DATA-MODEL.md):
//!
//! - [`ydoc`]: Yjs through `yrs` (`OffsetKind::Utf16`, v2 updates), `Any` values and JSON.
//! - [`workspace`]: the vault's 17 documents on this device (the index and 16 conversation shards), their
//!   conversations and append-only message trees, persisted as the encrypted pending queue.
//! - [`streams`]: segments and checkpoints as objects, and the updates the object mirror holds of a document.
//! - [`blobs`]: content-addressed blobs (chunks and manifests).
//! - [`engine`]: the sync round: seal, list and check (anti-rollback), download, checkpoint, upload.
//! - [`state`]: what the engine keeps between rounds (high-water marks, alarms).
//! - [`remote`] and [`providers`]: the sync stores: a folder, Git through the `git` binary, the GitHub API, S3.
//! - [`join`]: joining a vault from a store's plaintext (the format marker and the keyslots).

#![forbid(unsafe_code)]

pub mod blobs;
pub mod engine;
pub mod error;
pub mod join;
pub mod providers;
pub mod remote;
pub mod state;
pub mod streams;
pub mod workspace;
pub mod ydoc;

pub use engine::{Engine, KeyslotPort, RoundResult};
pub use error::{Error, RemoteError, RemoteErrorKind, Result};
pub use remote::{DestinationKind, RemoteEntry, RemoteStore};
pub use state::{SyncAlarm, SyncState};
pub use workspace::{Clock, Conversation, Message, ModelRef, NewConversation, NewMessage, SystemClock, Workspace};
