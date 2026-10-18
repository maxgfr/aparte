//! File helpers: private directories (0700), private files (0600), atomic writes (a temporary file in the same
//! directory, synced, renamed over the target, then the directory synced), and exclusive locks shared by the
//! processes of this user.

use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use aparte_crypto::rng::{OsRng, draw};

use crate::error::{IoContext, Result};

/// Permissions of every file the store writes.
pub const FILE_MODE: u32 = 0o600;

/// Creates a directory and its parents; on Unix the directories created are 0700.
pub fn private_dir(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .ctx(|| format!("cannot create {}", dir.display()))
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir).ctx(|| format!("cannot create {}", dir.display()))
    }
}

fn temp_name(target: &Path) -> PathBuf {
    // A failing random source only makes a clash likelier; `create_new` still refuses one.
    let suffix: String = draw::<8>(&mut OsRng)
        .unwrap_or_default()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    target.with_file_name(format!(".{name}.{suffix}.tmp"))
}

fn sync_dir(dir: &Path) {
    // Syncing a directory makes the rename durable on Unix; elsewhere opening a directory may fail, which is fine.
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
}

/// Writes `bytes` to `target` atomically, as a 0600 file, creating its directory (0700) when needed.
pub fn atomic_write(target: &Path, bytes: &[u8]) -> Result<()> {
    let parent = target.parent().unwrap_or(Path::new("."));
    private_dir(parent)?;
    let tmp = temp_name(target);
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(FILE_MODE);
    }
    let result = (|| {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.ctx(|| format!("cannot write {}", target.display()))?;
    sync_dir(parent);
    Ok(())
}

/// The file's bytes, or `None` when it does not exist.
pub fn read_opt(path: &Path) -> Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).ctx(|| format!("cannot read {}", path.display())),
    }
}

/// Removes a file; a missing one is not an error. Returns whether one was removed.
pub fn remove_opt(path: &Path) -> Result<bool> {
    match std::fs::remove_file(path) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                sync_dir(parent);
            }
            Ok(true)
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e).ctx(|| format!("cannot remove {}", path.display())),
    }
}

/// Removes a directory and everything in it; a missing one is not an error.
pub fn remove_dir_opt(path: &Path) -> Result<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).ctx(|| format!("cannot remove {}", path.display())),
    }
}

/// The names of the regular files directly in `dir`, sorted; temporary files of interrupted writes (`.name.tmp`)
/// are left out. A missing directory has none.
pub fn file_names(dir: &Path) -> Result<Vec<String>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).ctx(|| format!("cannot list {}", dir.display())),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.ctx(|| format!("cannot list {}", dir.display()))?;
        let is_file = entry.file_type().is_ok_and(|t| t.is_file());
        if let Some(name) = entry.file_name().to_str()
            && is_file
            && !name.starts_with('.')
        {
            out.push(name.to_owned());
        }
    }
    out.sort_unstable();
    Ok(out)
}

/// Every regular file under `root`, as `/`-separated paths relative to it, sorted bytewise. Hidden files and
/// directories (a leading `.`, such as the temporary files of interrupted writes) are left out; so are symbolic
/// links, which a store never writes.
pub fn walk(root: &Path) -> Result<Vec<String>> {
    fn go(dir: &Path, prefix: &str, out: &mut Vec<String>) -> Result<()> {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e).ctx(|| format!("cannot list {}", dir.display())),
        };
        for entry in entries {
            let entry = entry.ctx(|| format!("cannot list {}", dir.display()))?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if kind.is_dir() {
                go(&entry.path(), &rel, out)?;
            } else if kind.is_file() {
                out.push(rel);
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    go(root, "", &mut out)?;
    out.sort_unstable();
    Ok(out)
}

/// An exclusive lock on a file, released when dropped. Every process of this user that opens the same store takes
/// the same locks, so their read-modify-write sequences never interleave.
#[derive(Debug)]
pub struct FileLock {
    file: File,
}

impl FileLock {
    /// Waits for the lock on `path` (created empty, 0600, when missing).
    pub fn acquire(path: &Path) -> Result<FileLock> {
        if let Some(parent) = path.parent() {
            private_dir(parent)?;
        }
        let mut opts = OpenOptions::new();
        opts.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(FILE_MODE);
        }
        let file = opts
            .open(path)
            .ctx(|| format!("cannot open the lock {}", path.display()))?;
        file.lock().ctx(|| format!("cannot take the lock {}", path.display()))?;
        Ok(FileLock { file })
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_are_atomic_and_private() {
        let dir = tempfile::tempdir().expect("tempdir");
        let f = dir.path().join("a/b/x");
        atomic_write(&f, b"one").expect("write");
        atomic_write(&f, b"two").expect("overwrite");
        assert_eq!(read_opt(&f).expect("read"), Some(b"two".to_vec()));
        assert_eq!(file_names(&dir.path().join("a/b")).expect("names"), vec!["x"]);
        assert_eq!(walk(dir.path()).expect("walk"), vec!["a/b/x"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).expect("meta").permissions().mode() & 0o777;
            assert_eq!(mode(&f), 0o600);
            assert_eq!(mode(&dir.path().join("a/b")), 0o700);
        }
        assert!(remove_opt(&f).expect("remove"));
        assert!(!remove_opt(&f).expect("remove again"));
        assert_eq!(read_opt(&f).expect("read"), None);
    }

    #[test]
    fn locks_exclude_each_other() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("locks/x");
        let first = FileLock::acquire(&path).expect("lock");
        let probe = File::open(&path).expect("open");
        assert!(probe.try_lock().is_err(), "a second lock waits");
        drop(first);
        assert!(probe.try_lock().is_ok(), "released on drop");
    }
}
