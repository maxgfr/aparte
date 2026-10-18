//! Path resolution: relative paths are taken from the project directory and `~` from `HOME`. Reads may go anywhere
//! the user can read; writes are confined to the project directory and the system temporary directory.

use std::path::{Component, Path, PathBuf};

use aparte_agent::ToolError;

/// Resolves a path as given by the model.
pub fn resolve(cwd: &Path, raw: &str) -> PathBuf {
    let raw = raw.trim();
    let p = if raw == "~" {
        home().unwrap_or_else(|| PathBuf::from(raw))
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home().map_or_else(|| PathBuf::from(raw), |h| h.join(rest))
    } else {
        PathBuf::from(raw)
    };
    normalize(&if p.is_absolute() { p } else { cwd.join(p) })
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// Removes `.` and folds `..` lexically, without touching the filesystem.
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The canonical form of a path that may not exist yet: its nearest existing ancestor canonicalized, plus the rest.
pub fn canonical_lenient(p: &Path) -> PathBuf {
    let mut existing = p.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name().map(ToOwned::to_owned), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut out = existing.canonicalize().unwrap_or(existing);
    for name in rest.into_iter().rev() {
        out.push(name);
    }
    out
}

/// Refuses a write outside the project directory and the temporary directory.
pub fn check_writable(cwd: &Path, target: &Path) -> Result<(), ToolError> {
    let target = canonical_lenient(target);
    let roots = [canonical_lenient(cwd), canonical_lenient(&std::env::temp_dir())];
    if roots.iter().any(|r| target.starts_with(r)) {
        Ok(())
    } else {
        Err(ToolError::Failed(format!(
            "{} is outside the project directory {}: writes are confined to the project",
            target.display(),
            cwd.display()
        )))
    }
}

/// A path for display: relative to the project when inside it.
pub fn display(cwd: &Path, p: &Path) -> String {
    p.strip_prefix(cwd)
        .map_or_else(|_| p.display().to_string(), |r| r.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_and_dotted_paths_resolve_in_the_project() {
        let cwd = Path::new("/p/q");
        assert_eq!(resolve(cwd, "a/./b/../c"), PathBuf::from("/p/q/a/c"));
        assert_eq!(resolve(cwd, "/etc/hosts"), PathBuf::from("/etc/hosts"));
        assert_eq!(resolve(cwd, "../x"), PathBuf::from("/p/x"));
    }

    #[test]
    fn writes_outside_the_project_are_refused() {
        let proj = tempfile::tempdir().expect("dir");
        assert!(check_writable(proj.path(), &proj.path().join("new/file.txt")).is_ok());
        assert!(check_writable(proj.path(), Path::new("/etc/aparte-test")).is_err());
        let escape = resolve(proj.path(), "../../../../../../etc/x");
        assert!(check_writable(proj.path(), &escape).is_err());
    }
}
