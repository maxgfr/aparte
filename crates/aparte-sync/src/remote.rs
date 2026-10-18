//! The sync store contract (the web app's `RemoteStore`, web/src/core/contracts/sync.ts, contract F8):
//!
//! - A store only ever holds `aparte/1` objects under their exact names (spec/FORMAT.md section 8.8): the format
//!   marker and the keyslots in clear, everything else as envelopes.
//! - Objects are immutable: `put` of a name that exists writes nothing new. The only deletion is a keyslot the vault
//!   replaced (section 10.1).
//! - A listing is complete: every object of the store, or an error. A partial answer is never returned as a listing,
//!   so the anti-rollback checks of section 10.3 only judge complete listings.
//! - Credentials (a token, S3 keys) are device-only local records of purpose `sync-credential`.

use async_trait::async_trait;

use crate::error::RemoteError;

/// One object of a listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEntry {
    /// The object name relative to the store's root.
    pub name: String,
    /// Its size, when the store says.
    pub size: Option<u64>,
    /// A store-specific handle that reads this exact object (a Git blob id).
    pub handle: Option<String>,
}

impl RemoteEntry {
    /// An entry with a name only.
    pub fn named(name: impl Into<String>) -> RemoteEntry {
        RemoteEntry {
            name: name.into(),
            size: None,
            handle: None,
        }
    }
}

/// What a destination is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DestinationKind {
    /// A Git repository through the GitHub API.
    Github,
    /// A Git repository through the `git` binary (any remote).
    Git,
    /// An S3-compatible bucket.
    S3,
    /// A folder.
    Folder,
    /// In memory (tests).
    Memory,
}

impl DestinationKind {
    /// The kind's name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Git => "git",
            Self::S3 => "s3",
            Self::Folder => "folder",
            Self::Memory => "memory",
        }
    }
}

/// A sync destination: a Git repository, a bucket, a folder.
#[async_trait]
pub trait RemoteStore: Send + Sync {
    /// Same destination, same id, on every device (derived from what identifies it, never from a secret).
    fn id(&self) -> &str;
    /// What it is.
    fn kind(&self) -> DestinationKind;
    /// Whether the store keeps every version forever (Git history): a deletion there removes nothing for good.
    fn keeps_history(&self) -> bool;
    /// Every object of the store, sorted by name. Complete or an error.
    async fn list(&self) -> Result<Vec<RemoteEntry>, RemoteError>;
    /// The object's bytes, or `None` only when the store says for sure it does not exist.
    async fn get(&self, entry: &RemoteEntry) -> Result<Option<Vec<u8>>, RemoteError>;
    /// Stores an object, idempotently. A batching store (Git) may only stage it: `flush` writes what is staged, and
    /// nothing staged counts as stored before `flush` returns.
    async fn put(&self, name: &str, bytes: &[u8]) -> Result<(), RemoteError>;
    /// Writes what `put` staged.
    async fn flush(&self) -> Result<(), RemoteError>;
    /// Removes an object; used only for a keyslot the vault replaced.
    async fn delete(&self, name: &str) -> Result<(), RemoteError>;
}
