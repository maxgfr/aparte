//! `read`, `write` and `edit`.

use aparte_agent::{Annotations, BoxFuture, ToolContext, ToolError, ToolOutput, TypedTool, fsx};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use crate::output::{Keep, MAX_BYTES, MAX_LINES, truncate};
use crate::paths;

fn io(path: &std::path::Path, e: &std::io::Error) -> ToolError {
    ToolError::Failed(format!("{}: {e}", path.display()))
}

/// Input of `read`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadInput {
    /// The file to read, relative to the working directory or absolute.
    pub path: String,
    /// First line to show, 1-based (default 1).
    pub offset: Option<usize>,
    /// Most lines to show (default and maximum 2000).
    pub limit: Option<usize>,
}

/// Reads a text file, a window of lines at a time.
#[derive(Debug, Clone, Default)]
pub struct Read;

impl TypedTool for Read {
    type Input = ReadInput;
    fn name(&self) -> &str {
        "read"
    }
    fn description(&self) -> &str {
        "Reads a text file. Output is cut at 2000 lines or 50 KiB; use offset and limit to read further."
    }
    fn annotations(&self) -> Annotations {
        Annotations::READ_ONLY
    }
    fn run<'a>(&'a self, ctx: &'a ToolContext, input: ReadInput) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            let path = paths::resolve(&ctx.cwd, &input.path);
            let bytes = tokio::fs::read(&path).await.map_err(|e| io(&path, &e))?;
            if bytes.iter().take(8192).any(|&b| b == 0) {
                return Err(ToolError::Failed(format!("{} is a binary file", path.display())));
            }
            let text = String::from_utf8_lossy(&bytes);
            let lines: Vec<&str> = text.split_inclusive('\n').collect();
            let total = lines.len();
            let start = input.offset.unwrap_or(1).max(1) - 1;
            if start >= total && total > 0 {
                return Err(ToolError::InvalidInput(format!(
                    "offset {} is past the end ({total} lines)",
                    start + 1
                )));
            }
            let limit = input.limit.unwrap_or(MAX_LINES).clamp(1, MAX_LINES);
            let window: String = lines.iter().skip(start).take(limit).copied().collect();
            let t = truncate(&window, Keep::Head, limit, MAX_BYTES);
            let shown_end = start + t.kept_lines;
            let mut content = t.text;
            if shown_end < total {
                content.push_str(&format!(
                    "\n[lines {}-{shown_end} of {total}; use offset={} to continue]",
                    start + 1,
                    shown_end + 1
                ));
            }
            Ok(ToolOutput::text(content).with_details(json!({
                "path": paths::display(&ctx.cwd, &path),
                "lines": total,
                "from": start + 1,
                "to": shown_end,
            })))
        })
    }
}

/// Input of `write`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct WriteInput {
    /// The file to write, created with its parent directories if needed.
    pub path: String,
    /// The whole new content.
    pub content: String,
}

/// Writes a whole file, atomically.
#[derive(Debug, Clone, Default)]
pub struct Write;

impl TypedTool for Write {
    type Input = WriteInput;
    fn name(&self) -> &str {
        "write"
    }
    fn description(&self) -> &str {
        "Writes a whole file (created or overwritten), inside the project directory. Prefer edit for changes."
    }
    fn annotations(&self) -> Annotations {
        Annotations {
            read_only: false,
            destructive: true,
            idempotent: true,
            open_world: false,
        }
    }
    fn run<'a>(&'a self, ctx: &'a ToolContext, input: WriteInput) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            let path = paths::resolve(&ctx.cwd, &input.path);
            paths::check_writable(&ctx.cwd, &path)?;
            let created = !path.exists();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| io(parent, &e))?;
            }
            fsx::atomic_write(&path, input.content.as_bytes(), 0o644).map_err(|e| io(&path, &e))?;
            let shown = paths::display(&ctx.cwd, &path);
            let verb = if created { "Created" } else { "Wrote" };
            Ok(
                ToolOutput::text(format!("{verb} {shown} ({} bytes)", input.content.len())).with_details(json!({
                    "path": shown,
                    "bytes": input.content.len(),
                    "created": created,
                })),
            )
        })
    }
}

/// One replacement of `edit`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Replacement {
    /// Text to find: it must occur exactly once in the file, whitespace included.
    pub old_text: String,
    /// What replaces it.
    pub new_text: String,
}

/// Input of `edit`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditInput {
    /// The file to change.
    pub path: String,
    /// Replacements, all matched against the original file; they must not overlap. All apply or none.
    pub edits: Vec<Replacement>,
}

/// Applies exact-text replacements to a file.
#[derive(Debug, Clone, Default)]
pub struct Edit;

/// Applies the replacements to `original`, all or none.
pub fn apply_edits(original: &str, edits: &[Replacement]) -> Result<String, ToolError> {
    if edits.is_empty() {
        return Err(ToolError::InvalidInput("no edits given".into()));
    }
    let crlf = original.contains("\r\n");
    let mut spans: Vec<(usize, usize, String)> = Vec::new();
    for (i, e) in edits.iter().enumerate() {
        let (old, new) = if crlf && !e.old_text.contains("\r\n") {
            (e.old_text.replace('\n', "\r\n"), e.new_text.replace('\n', "\r\n"))
        } else {
            (e.old_text.clone(), e.new_text.clone())
        };
        if old.is_empty() {
            return Err(ToolError::InvalidInput(format!("edit {}: old_text is empty", i + 1)));
        }
        let mut found = original.match_indices(&old);
        let Some((at, _)) = found.next() else {
            return Err(ToolError::Failed(format!(
                "edit {}: old_text was not found; read the file again and copy the text exactly",
                i + 1
            )));
        };
        if found.next().is_some() {
            return Err(ToolError::Failed(format!(
                "edit {}: old_text occurs more than once; include more surrounding lines",
                i + 1
            )));
        }
        spans.push((at, at + old.len(), new));
    }
    spans.sort_by_key(|s| s.0);
    if spans.windows(2).any(|w| w[0].1 > w[1].0) {
        return Err(ToolError::InvalidInput("edits overlap".into()));
    }
    let mut out = String::with_capacity(original.len());
    let mut last = 0;
    for (start, end, new) in spans {
        out.push_str(&original[last..start]);
        out.push_str(&new);
        last = end;
    }
    out.push_str(&original[last..]);
    Ok(out)
}

impl TypedTool for Edit {
    type Input = EditInput;
    fn name(&self) -> &str {
        "edit"
    }
    fn description(&self) -> &str {
        "Edits a file by exact replacements: each old_text must occur once in the file. Several edits apply together."
    }
    fn annotations(&self) -> Annotations {
        Annotations {
            read_only: false,
            destructive: false,
            idempotent: false,
            open_world: false,
        }
    }
    fn run<'a>(&'a self, ctx: &'a ToolContext, input: EditInput) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            let path = paths::resolve(&ctx.cwd, &input.path);
            paths::check_writable(&ctx.cwd, &path)?;
            let original = tokio::fs::read_to_string(&path).await.map_err(|e| io(&path, &e))?;
            let updated = apply_edits(&original, &input.edits)?;
            fsx::atomic_write(&path, updated.as_bytes(), 0o644).map_err(|e| io(&path, &e))?;
            let shown = paths::display(&ctx.cwd, &path);
            let diff = similar::TextDiff::from_lines(&original, &updated)
                .unified_diff()
                .context_radius(3)
                .header(&shown, &shown)
                .to_string();
            Ok(
                ToolOutput::text(format!("Applied {} edit(s) to {shown}", input.edits.len()))
                    .with_details(json!({ "path": shown, "diff": diff })),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(old: &str, new: &str) -> Replacement {
        Replacement {
            old_text: old.into(),
            new_text: new.into(),
        }
    }

    #[test]
    fn edits_apply_together_against_the_original() {
        let out = apply_edits("a b c", &[r("c", "C"), r("a", "A")]).expect("ok");
        assert_eq!(out, "A b C");
    }

    #[test]
    fn missing_ambiguous_and_overlapping_edits_fail_whole() {
        assert!(apply_edits("a a", &[r("a", "b")]).is_err());
        assert!(apply_edits("abc", &[r("x", "y")]).is_err());
        assert!(apply_edits("abcd", &[r("abc", "1"), r("cd", "2")]).is_err());
        assert!(apply_edits("abc", &[]).is_err());
    }

    #[test]
    fn crlf_files_match_lf_edits() {
        let out = apply_edits("one\r\ntwo\r\n", &[r("one\ntwo", "1\n2")]).expect("ok");
        assert_eq!(out, "1\r\n2\r\n");
    }
}
