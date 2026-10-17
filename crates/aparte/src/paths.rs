//! Default directories, following the XDG base directory layout on every platform so that paths in docs and
//! scripts are the same on macOS and Linux.

use std::path::PathBuf;

/// Resolves a directory: the explicit value (flag or environment), else `$<xdg>/aparte`, else `~/<fallback>/aparte`.
/// Returns `None` when neither the XDG variable nor `HOME` is set.
fn resolve(explicit: Option<&PathBuf>, xdg: &str, fallback: &str) -> Option<PathBuf> {
    if let Some(p) = explicit {
        return Some(p.clone());
    }
    if let Some(base) = std::env::var_os(xdg).filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(base).join("aparte"));
    }
    let home = std::env::var_os("HOME").filter(|v| !v.is_empty())?;
    Some(PathBuf::from(home).join(fallback).join("aparte"))
}

/// The configuration directory.
pub fn config_dir(explicit: Option<&PathBuf>) -> Option<PathBuf> {
    resolve(explicit, "XDG_CONFIG_HOME", ".config")
}

/// The data directory, where encrypted vaults live.
pub fn data_dir(explicit: Option<&PathBuf>) -> Option<PathBuf> {
    resolve(explicit, "XDG_DATA_HOME", ".local/share")
}

#[cfg(test)]
mod tests {
    use super::resolve;
    use std::path::PathBuf;

    #[test]
    fn an_explicit_directory_wins() {
        let p = PathBuf::from("/tmp/x");
        assert_eq!(resolve(Some(&p), "APARTE_TEST_UNSET_VAR", ".config"), Some(p));
    }
}
