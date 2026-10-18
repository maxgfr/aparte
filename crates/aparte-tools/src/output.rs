//! Large outputs: what the model gets is cut to a size it can read (2000 lines or 50 KiB, like pi), and the full
//! text is kept in a private blob file whose path the model is told, so it can `read` the rest. Blobs live in a
//! directory of this process under the system temporary directory (0700, files 0600), removed when the store is
//! dropped.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use aparte_agent::fsx;

/// Most lines the model gets from one result.
pub const MAX_LINES: usize = 2000;
/// Most bytes the model gets from one result.
pub const MAX_BYTES: usize = 50 * 1024;

/// Which end of an output is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keep {
    /// The beginning (files, searches).
    Head,
    /// The end (command output, where errors are).
    Tail,
}

/// A cut output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Truncated {
    pub text: String,
    pub truncated: bool,
    pub total_lines: usize,
    pub kept_lines: usize,
}

fn floor_char(s: &str, mut at: usize) -> usize {
    while at > 0 && !s.is_char_boundary(at) {
        at -= 1;
    }
    at
}

fn ceil_char(s: &str, mut at: usize) -> usize {
    while at < s.len() && !s.is_char_boundary(at) {
        at += 1;
    }
    at
}

/// Cuts `text` to `max_lines` and `max_bytes`, keeping whole lines (unless a single line is too long).
pub fn truncate(text: &str, keep: Keep, max_lines: usize, max_bytes: usize) -> Truncated {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let total_lines = lines.len();
    if total_lines <= max_lines && text.len() <= max_bytes {
        return Truncated {
            text: text.to_owned(),
            truncated: false,
            total_lines,
            kept_lines: total_lines,
        };
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut bytes = 0;
    let iter: Box<dyn Iterator<Item = &&str>> = match keep {
        Keep::Head => Box::new(lines.iter()),
        Keep::Tail => Box::new(lines.iter().rev()),
    };
    for line in iter {
        if kept.len() >= max_lines || bytes + line.len() > max_bytes {
            break;
        }
        bytes += line.len();
        kept.push(line);
    }
    if keep == Keep::Tail {
        kept.reverse();
    }
    let mut out: String = kept.concat();
    if kept.is_empty() {
        // One line longer than the budget: cut inside it.
        out = match keep {
            Keep::Head => text[..floor_char(text, max_bytes)].to_owned(),
            Keep::Tail => text[ceil_char(text, text.len().saturating_sub(max_bytes))..].to_owned(),
        };
    }
    Truncated {
        kept_lines: out.split_inclusive('\n').count(),
        text: out,
        truncated: true,
        total_lines,
    }
}

/// Where full outputs are kept.
#[derive(Debug)]
pub struct BlobStore {
    dir: PathBuf,
    next: AtomicU64,
}

impl BlobStore {
    /// A store in a new private directory under the system temporary directory.
    pub fn new() -> std::io::Result<BlobStore> {
        let mut rnd = [0u8; 6];
        let _ = getrandom::fill(&mut rnd);
        let tag: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("aparte-{}-{tag}", std::process::id()));
        BlobStore::in_dir(dir)
    }

    /// A store in a given directory (created 0700).
    pub fn in_dir(dir: PathBuf) -> std::io::Result<BlobStore> {
        fsx::private_dir(&dir)?;
        let dir = dir.canonicalize()?;
        Ok(BlobStore {
            dir,
            next: AtomicU64::new(1),
        })
    }

    /// The directory of the blobs.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Saves a full output and returns its path.
    pub fn save(&self, label: &str, text: &str) -> std::io::Result<PathBuf> {
        let n = self.next.fetch_add(1, Ordering::SeqCst);
        let safe: String = label
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .take(32)
            .collect();
        let path = self.dir.join(format!("{n:04}-{safe}.txt"));
        fsx::atomic_write(&path, text.as_bytes(), 0o600)?;
        Ok(path)
    }

    /// Cuts an output for the model; when cut, saves the whole and says where it is.
    pub fn fit(&self, label: &str, text: &str, keep: Keep) -> (String, Option<PathBuf>) {
        let t = truncate(text, keep, MAX_LINES, MAX_BYTES);
        if !t.truncated {
            return (t.text, None);
        }
        let saved = self.save(label, text).ok();
        let where_ = saved.as_ref().map_or_else(
            || String::from("not saved"),
            |p| format!("full output in {}", p.display()),
        );
        let which = match keep {
            Keep::Head => "first",
            Keep::Tail => "last",
        };
        let note = format!(
            "\n[output truncated: {which} {} of {} lines shown; {where_}]",
            t.kept_lines, t.total_lines
        );
        (format!("{}{note}", t.text), saved)
    }
}

impl Drop for BlobStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_untouched() {
        let t = truncate("a\nb\n", Keep::Head, 10, 100);
        assert!(!t.truncated);
        assert_eq!(t.text, "a\nb\n");
    }

    #[test]
    fn head_and_tail_keep_whole_lines() {
        let text: String = (0..10).map(|i| format!("line {i}\n")).collect();
        let h = truncate(&text, Keep::Head, 3, 1000);
        assert_eq!(h.text, "line 0\nline 1\nline 2\n");
        let t = truncate(&text, Keep::Tail, 2, 1000);
        assert_eq!(t.text, "line 8\nline 9\n");
        assert_eq!(t.total_lines, 10);
        let b = truncate(&text, Keep::Head, 100, 15);
        assert_eq!(b.text, "line 0\nline 1\n");
    }

    #[test]
    fn one_huge_line_is_cut_on_a_char_boundary() {
        let text = "é".repeat(100);
        let h = truncate(&text, Keep::Head, 10, 11);
        assert!(h.text.len() <= 11 && h.truncated);
        let t = truncate(&text, Keep::Tail, 10, 11);
        assert!(t.text.len() <= 11 && t.text.chars().all(|c| c == 'é'));
    }

    #[test]
    fn a_cut_output_is_saved_whole_and_the_store_cleans_up() {
        let dir;
        {
            let store = BlobStore::new().expect("store");
            dir = store.dir().to_path_buf();
            let text = "x\n".repeat(MAX_LINES + 5);
            let (shown, saved) = store.fit("bash", &text, Keep::Tail);
            let saved = saved.expect("saved");
            assert!(shown.contains("output truncated"));
            assert_eq!(std::fs::read_to_string(&saved).expect("blob"), text);
        }
        assert!(!dir.exists());
    }
}
