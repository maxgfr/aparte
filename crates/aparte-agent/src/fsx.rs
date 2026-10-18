//! File helpers shared by the agent and the tools: private directories (0700), private files (0600) and atomic
//! writes (a temporary file in the same directory, flushed, then renamed over the target).

use std::io::Write;
use std::path::{Path, PathBuf};

/// Creates a directory and its parents; on Unix the directories created are 0700.
pub fn private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

fn temp_name(target: &Path) -> PathBuf {
    let mut rnd = [0u8; 8];
    // A failing random source only makes a name collision likelier; create_new below still refuses a clash.
    let _ = getrandom::fill(&mut rnd);
    let suffix: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    target.with_file_name(format!(".{name}.{suffix}.tmp"))
}

/// Writes `bytes` to `target` atomically. `mode` is the Unix permission of a new file (0600 for private data);
/// an existing file keeps its permissions.
pub fn atomic_write(target: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    let tmp = temp_name(target);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mode = std::fs::metadata(target).map_or(mode, |m| m.permissions().mode() & 0o7777);
        opts.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
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
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_are_atomic_and_private() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sub = dir.path().join("a/b");
        private_dir(&sub).expect("dir");
        let f = sub.join("x.json");
        atomic_write(&f, b"one", 0o600).expect("write");
        atomic_write(&f, b"two", 0o600).expect("overwrite");
        assert_eq!(std::fs::read(&f).expect("read"), b"two");
        let left: Vec<_> = std::fs::read_dir(&sub).expect("list").collect();
        assert_eq!(left.len(), 1, "no temporary file is left");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).expect("meta").permissions().mode() & 0o777;
            assert_eq!(mode(&f), 0o600);
            assert_eq!(mode(&sub), 0o700);
        }
    }
}
