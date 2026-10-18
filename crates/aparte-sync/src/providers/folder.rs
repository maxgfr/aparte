//! A folder as a sync store (spec/FORMAT.md section 10.5): every object is a file under its name, in sub-folders
//! following the `/` of the name, holding the object's bytes. The same layout as the web app's folder destination,
//! so a folder that another tool syncs (a network drive, Syncthing) carries a vault between the CLI and the browser.
//!
//! Files whose name starts with `.` (the temporary files of interrupted writes, a sync client's own) and `.crswap`
//! files are not listed. A root that does not exist is `not-found`, never an empty listing: an unmounted drive must
//! not look like a store that lost everything.

use std::path::{Path, PathBuf};

use aparte_format::names::parse_name;
use aparte_store::fsx;
use async_trait::async_trait;

use crate::error::{RemoteError, RemoteErrorKind};
use crate::remote::{DestinationKind, RemoteEntry, RemoteStore};

/// A folder store.
#[derive(Debug, Clone)]
pub struct FolderStore {
    id: String,
    root: PathBuf,
}

fn io_error(what: &str, e: &aparte_store::Error) -> RemoteError {
    RemoteError::new(RemoteErrorKind::Network, format!("folder {what}: {e}"))
}

impl FolderStore {
    /// The store of the folder `root`; its id is `folder:<label>`, as the web app names a folder by its label.
    pub fn new(root: impl Into<PathBuf>, label: &str) -> FolderStore {
        FolderStore {
            id: format!("folder:{label}"),
            root: root.into(),
        }
    }

    /// The folder.
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path_of(&self, name: &str) -> Result<PathBuf, RemoteError> {
        if parse_name(name).is_none() {
            return Err(RemoteError::new(RemoteErrorKind::Incompatible, "not an object name"));
        }
        let mut path = self.root.clone();
        for part in name.split('/') {
            path.push(part);
        }
        Ok(path)
    }
}

#[async_trait]
impl RemoteStore for FolderStore {
    fn id(&self) -> &str {
        &self.id
    }
    fn kind(&self) -> DestinationKind {
        DestinationKind::Folder
    }
    fn keeps_history(&self) -> bool {
        false
    }
    async fn list(&self) -> Result<Vec<RemoteEntry>, RemoteError> {
        if !self.root.is_dir() {
            return Err(RemoteError::new(
                RemoteErrorKind::NotFound,
                format!("the folder {} does not exist", self.root.display()),
            ));
        }
        let names = fsx::walk(&self.root).map_err(|e| io_error("listing", &e))?;
        Ok(names
            .into_iter()
            .filter(|n| !n.ends_with(".crswap"))
            .map(RemoteEntry::named)
            .collect())
    }
    async fn get(&self, entry: &RemoteEntry) -> Result<Option<Vec<u8>>, RemoteError> {
        let path = self.path_of(&entry.name)?;
        fsx::read_opt(&path).map_err(|e| io_error("read", &e))
    }
    async fn put(&self, name: &str, bytes: &[u8]) -> Result<(), RemoteError> {
        let path = self.path_of(name)?;
        // Objects never change: one already there is not written again.
        if path.is_file() {
            return Ok(());
        }
        fsx::atomic_write(&path, bytes).map_err(|e| io_error("write", &e))
    }
    async fn flush(&self) -> Result<(), RemoteError> {
        Ok(())
    }
    async fn delete(&self, name: &str) -> Result<(), RemoteError> {
        let path = self.path_of(name)?;
        fsx::remove_opt(&path).map_err(|e| io_error("delete", &e))?;
        Ok(())
    }
}
