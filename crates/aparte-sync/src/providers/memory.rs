//! A store in memory, for tests and for in-process copies of a store (the fixture is read through one).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use crate::error::RemoteError;
use crate::remote::{DestinationKind, RemoteEntry, RemoteStore};

/// The objects of a memory store, shareable between stores (two devices syncing through one bucket).
#[derive(Debug, Clone, Default)]
pub struct MemoryBucket {
    objects: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
}

impl MemoryBucket {
    /// An empty bucket.
    pub fn new() -> MemoryBucket {
        MemoryBucket::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Vec<u8>>> {
        self.objects.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Writes an object directly (a test's hand, an adversary).
    pub fn write(&self, name: &str, bytes: &[u8]) {
        self.lock().insert(name.to_owned(), bytes.to_vec());
    }

    /// Reads an object directly.
    pub fn read(&self, name: &str) -> Option<Vec<u8>> {
        self.lock().get(name).cloned()
    }

    /// Removes an object directly.
    pub fn remove(&self, name: &str) -> Option<Vec<u8>> {
        self.lock().remove(name)
    }

    /// The names starting with `prefix`, sorted.
    pub fn names(&self, prefix: &str) -> Vec<String> {
        self.lock().keys().filter(|n| n.starts_with(prefix)).cloned().collect()
    }
}

/// A store over a [`MemoryBucket`].
#[derive(Debug, Clone)]
pub struct MemoryStore {
    id: String,
    bucket: MemoryBucket,
}

impl MemoryStore {
    /// A store of `bucket` with the destination id `id`.
    pub fn new(bucket: MemoryBucket, id: &str) -> MemoryStore {
        MemoryStore {
            id: id.to_owned(),
            bucket,
        }
    }

    /// The bucket.
    pub fn bucket(&self) -> &MemoryBucket {
        &self.bucket
    }
}

#[async_trait]
impl RemoteStore for MemoryStore {
    fn id(&self) -> &str {
        &self.id
    }
    fn kind(&self) -> DestinationKind {
        DestinationKind::Memory
    }
    fn keeps_history(&self) -> bool {
        false
    }
    async fn list(&self) -> Result<Vec<RemoteEntry>, RemoteError> {
        Ok(self
            .bucket
            .lock()
            .iter()
            .map(|(name, bytes)| RemoteEntry {
                name: name.clone(),
                size: Some(bytes.len() as u64),
                handle: None,
            })
            .collect())
    }
    async fn get(&self, entry: &RemoteEntry) -> Result<Option<Vec<u8>>, RemoteError> {
        Ok(self.bucket.read(&entry.name))
    }
    async fn put(&self, name: &str, bytes: &[u8]) -> Result<(), RemoteError> {
        self.bucket
            .lock()
            .entry(name.to_owned())
            .or_insert_with(|| bytes.to_vec());
        Ok(())
    }
    async fn flush(&self) -> Result<(), RemoteError> {
        Ok(())
    }
    async fn delete(&self, name: &str) -> Result<(), RemoteError> {
        self.bucket.remove(name);
        Ok(())
    }
}
