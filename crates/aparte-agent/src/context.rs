//! The system prompt: a short base, the tools offered, and, for a trusted project only, the `AGENTS.md` files from
//! the project directory up to the filesystem root (the nearest last, so it reads as the most specific). An
//! untrusted project's files are never put in the prompt: they could carry instructions aimed at the model.

use std::path::{Path, PathBuf};

/// Files read as project context, in each directory.
pub const CONTEXT_FILES: &[&str] = &["AGENTS.md"];

/// Largest context file read; a larger one is skipped.
const MAX_CONTEXT_BYTES: u64 = 256 * 1024;

/// The context files that apply to `cwd`, outermost first.
pub fn project_context(cwd: &Path) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    for dir in cwd.ancestors() {
        for name in CONTEXT_FILES {
            let p = dir.join(name);
            let small = std::fs::metadata(&p).is_ok_and(|m| m.is_file() && m.len() <= MAX_CONTEXT_BYTES);
            if small && let Ok(text) = std::fs::read_to_string(&p) {
                found.push((p, text));
            }
        }
    }
    found.reverse();
    found
}

/// The default system prompt for a coding agent working in `cwd` with these tools.
pub fn system_prompt(cwd: &Path, tools: &[(String, String)], context: &[(PathBuf, String)], date: &str) -> String {
    let mut s = String::from(
        "You are a coding assistant working in the user's project from a terminal. Use the tools to read, search \
         and change files and to run commands; read before you edit, keep changes minimal, and say briefly what \
         you did. Paths are relative to the working directory unless absolute.\n",
    );
    if !tools.is_empty() {
        s.push_str("\nTools:\n");
        for (name, description) in tools {
            let first = description.lines().next().unwrap_or_default();
            s.push_str(&format!("- {name}: {first}\n"));
        }
    }
    for (path, text) in context {
        s.push_str(&format!(
            "\n<project-context path=\"{}\">\n{}\n</project-context>\n",
            path.display(),
            text.trim()
        ));
    }
    s.push_str(&format!("\nWorking directory: {}\nDate: {date}\n", cwd.display()));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_files_are_found_outermost_first() {
        let root = tempfile::tempdir().expect("dir");
        let sub = root.path().join("a");
        std::fs::create_dir_all(&sub).expect("mkdir");
        std::fs::write(root.path().join("AGENTS.md"), "outer").expect("write");
        std::fs::write(sub.join("AGENTS.md"), "inner").expect("write");
        let ctx = project_context(&sub);
        let texts: Vec<_> = ctx
            .iter()
            .map(|(_, t)| t.as_str())
            .filter(|t| ["outer", "inner"].contains(t))
            .collect();
        assert_eq!(texts, ["outer", "inner"]);
        let prompt = system_prompt(
            &sub,
            &[("read".into(), "Reads a file.\nMore.".into())],
            &ctx,
            "2026-10-18",
        );
        assert!(prompt.contains("- read: Reads a file.\n"));
        assert!(prompt.find("outer") < prompt.find("inner"));
    }
}
