//! The `aparte/1` sync format, as specified in `spec/FORMAT.md` at the repository root.
//!
//! TypeScript (`web/src/core`) is the reference implementation: this crate reads and writes the same bytes and is
//! checked against the shared vectors and fixtures in `spec/`. A released format is frozen, so any change to its
//! encoding needs a new version string and new fixtures, never edited ones.

#![forbid(unsafe_code)]

/// The format marker written at the start of every stored or synced object.
pub const FORMAT: &str = "aparte/1";

#[cfg(test)]
mod tests {
    use super::FORMAT;

    #[test]
    fn format_marker_is_frozen() {
        // Changing this string makes every existing vault unreadable: a new format gets a new marker.
        assert_eq!(FORMAT, "aparte/1");
    }
}
