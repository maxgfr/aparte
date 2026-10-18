//! Per-project trust, kept in `<config>/trust.json` (0600). A trusted project loads its `AGENTS.md` into the system
//! prompt and runs non-destructive writes without asking ([`crate::approval`]). A directory is trusted when it or
//! one of its ancestors was marked trusted; paths are compared canonicalized.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fsx;

/// Why the trust file could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum TrustError {
    #[error("cannot read or write {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{path} is not a valid trust file: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    version: u32,
    /// Canonical directory path to whether it is trusted.
    projects: BTreeMap<String, bool>,
}

/// The trust decisions of this machine.
#[derive(Debug)]
pub struct TrustStore {
    path: PathBuf,
    file: File,
}

fn canonical(dir: &Path) -> PathBuf {
    dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf())
}

impl TrustStore {
    /// Loads `<config_dir>/trust.json`; a missing file trusts nothing.
    pub fn load(config_dir: &Path) -> Result<TrustStore, TrustError> {
        let path = config_dir.join("trust.json");
        let file = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|source| TrustError::Parse {
                path: path.clone(),
                source,
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => File {
                version: 1,
                projects: BTreeMap::new(),
            },
            Err(source) => return Err(TrustError::Io { path, source }),
        };
        Ok(TrustStore { path, file })
    }

    /// Whether `dir` is trusted: the nearest ancestor (itself included) with a decision decides.
    pub fn is_trusted(&self, dir: &Path) -> bool {
        let dir = canonical(dir);
        dir.ancestors()
            .find_map(|a| self.file.projects.get(&a.to_string_lossy().into_owned()).copied())
            .unwrap_or(false)
    }

    /// Records a decision for `dir` and saves the file atomically.
    pub fn set(&mut self, dir: &Path, trusted: bool) -> Result<(), TrustError> {
        let key = canonical(dir).to_string_lossy().into_owned();
        self.file.projects.insert(key, trusted);
        self.file.version = 1;
        let io = |source| TrustError::Io {
            path: self.path.clone(),
            source,
        };
        if let Some(parent) = self.path.parent() {
            fsx::private_dir(parent).map_err(io)?;
        }
        let bytes = serde_json::to_vec_pretty(&self.file).map_err(|source| TrustError::Parse {
            path: self.path.clone(),
            source,
        })?;
        fsx::atomic_write(&self.path, &bytes, 0o600).map_err(io)
    }

    /// Every decision, by canonical path.
    pub fn entries(&self) -> impl Iterator<Item = (&str, bool)> {
        self.file.projects.iter().map(|(k, v)| (k.as_str(), *v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_is_inherited_and_persisted() {
        let cfg = tempfile::tempdir().expect("cfg");
        let proj = tempfile::tempdir().expect("proj");
        let sub = proj.path().join("src");
        std::fs::create_dir_all(&sub).expect("sub");
        let mut store = TrustStore::load(cfg.path()).expect("load");
        assert!(!store.is_trusted(&sub));
        store.set(proj.path(), true).expect("set");
        let store = TrustStore::load(cfg.path()).expect("reload");
        assert!(store.is_trusted(&sub));
        let mut store = store;
        store.set(&sub, false).expect("revoke");
        assert!(!store.is_trusted(&sub));
        assert!(store.is_trusted(proj.path()));
    }
}
