//! `ls`, `find` and `grep`, over ripgrep's walker (`.gitignore`, `.ignore` and hidden files respected) and
//! searcher. They run on the blocking pool.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use aparte_agent::{Annotations, BoxFuture, ToolContext, ToolError, ToolOutput, TypedTool};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use crate::output::{BlobStore, Keep};
use crate::paths;

const MAX_LINE: usize = 500;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, ToolError> + Send + 'static,
) -> Result<T, ToolError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ToolError::Failed(format!("the search task failed: {e}")))?
}

fn clip(line: &str) -> String {
    let line = line.trim_end_matches(['\n', '\r']);
    if line.chars().count() > MAX_LINE {
        format!("{}…", line.chars().take(MAX_LINE).collect::<String>())
    } else {
        line.to_owned()
    }
}

/// Input of `ls`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct LsInput {
    /// Directory to list (default: the working directory).
    pub path: Option<String>,
    /// Most entries (default 500).
    pub limit: Option<usize>,
}

/// Lists a directory, dotfiles included, directories marked with `/`.
#[derive(Debug, Clone, Default)]
pub struct Ls;

impl TypedTool for Ls {
    type Input = LsInput;
    fn name(&self) -> &str {
        "ls"
    }
    fn description(&self) -> &str {
        "Lists a directory: names sorted, directories ending with /."
    }
    fn annotations(&self) -> Annotations {
        Annotations::READ_ONLY
    }
    fn run<'a>(&'a self, ctx: &'a ToolContext, input: LsInput) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        let dir = paths::resolve(&ctx.cwd, input.path.as_deref().unwrap_or("."));
        let limit = input.limit.unwrap_or(500).max(1);
        Box::pin(blocking(move || {
            let rd = std::fs::read_dir(&dir).map_err(|e| ToolError::Failed(format!("{}: {e}", dir.display())))?;
            let mut names: Vec<String> = rd
                .filter_map(Result::ok)
                .map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if e.file_type().is_ok_and(|t| t.is_dir()) {
                        format!("{name}/")
                    } else {
                        name
                    }
                })
                .collect();
            names.sort_by_key(|n| n.to_lowercase());
            let total = names.len();
            names.truncate(limit);
            let mut text = if names.is_empty() {
                "(empty directory)".to_owned()
            } else {
                names.join("\n")
            };
            if total > limit {
                text.push_str(&format!("\n[{limit} of {total} entries shown]"));
            }
            Ok(ToolOutput::text(text).with_details(json!({ "entries": total })))
        }))
    }
}

fn walker(root: &Path, glob: Option<&str>) -> Result<ignore::Walk, ToolError> {
    let mut b = ignore::WalkBuilder::new(root);
    b.require_git(false);
    if let Some(g) = glob {
        let mut o = ignore::overrides::OverrideBuilder::new(root);
        o.add(g)
            .map_err(|e| ToolError::InvalidInput(format!("glob {g:?}: {e}")))?;
        b.overrides(o.build().map_err(|e| ToolError::InvalidInput(e.to_string()))?);
    }
    Ok(b.build())
}

/// Input of `find`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct FindInput {
    /// Glob, like `*.rs` (file names) or `src/**/*.ts` (paths).
    pub pattern: String,
    /// Directory to search (default: the working directory).
    pub path: Option<String>,
    /// Most results (default 1000).
    pub limit: Option<usize>,
}

/// Finds files by glob.
#[derive(Debug, Clone, Default)]
pub struct Find;

impl TypedTool for Find {
    type Input = FindInput;
    fn name(&self) -> &str {
        "find"
    }
    fn description(&self) -> &str {
        "Finds files by glob (*.rs matches names, src/**/*.ts matches paths), respecting .gitignore."
    }
    fn annotations(&self) -> Annotations {
        Annotations::READ_ONLY
    }
    fn run<'a>(&'a self, ctx: &'a ToolContext, input: FindInput) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        let root = paths::resolve(&ctx.cwd, input.path.as_deref().unwrap_or("."));
        let limit = input.limit.unwrap_or(1000).max(1);
        Box::pin(blocking(move || {
            let by_name = !input.pattern.contains('/');
            let glob = globset::GlobBuilder::new(&input.pattern)
                .literal_separator(!by_name)
                .build()
                .map_err(|e| ToolError::InvalidInput(format!("glob: {e}")))?
                .compile_matcher();
            let mut found: Vec<String> = Vec::new();
            let mut total = 0usize;
            for entry in walker(&root, None)?.filter_map(Result::ok) {
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    continue;
                }
                let rel = entry.path().strip_prefix(&root).unwrap_or(entry.path());
                let hit = if by_name {
                    entry.path().file_name().is_some_and(|n| glob.is_match(n))
                } else {
                    glob.is_match(rel)
                };
                if hit {
                    total += 1;
                    if found.len() < limit {
                        found.push(rel.display().to_string());
                    }
                }
            }
            found.sort();
            let mut text = if found.is_empty() {
                "no files found".to_owned()
            } else {
                found.join("\n")
            };
            if total > limit {
                text.push_str(&format!("\n[{limit} of {total} files shown]"));
            }
            Ok(ToolOutput::text(text).with_details(json!({ "matches": total })))
        }))
    }
}

/// Input of `grep`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct GrepInput {
    /// Regular expression (Rust syntax), or a literal string with `literal`.
    pub pattern: String,
    /// File or directory to search (default: the working directory).
    pub path: Option<String>,
    /// Only files matching this glob, like `*.rs`.
    pub glob: Option<String>,
    #[serde(default)]
    pub ignore_case: bool,
    #[serde(default)]
    pub literal: bool,
    /// Lines of context around each match (default 0).
    pub context: Option<usize>,
    /// Most matching lines (default 100).
    pub limit: Option<usize>,
}

struct Collect<'a> {
    label: String,
    out: &'a mut Vec<String>,
    matches: &'a mut usize,
    limit: usize,
}

impl Sink for Collect<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _s: &Searcher, m: &SinkMatch<'_>) -> Result<bool, std::io::Error> {
        *self.matches += 1;
        let line = String::from_utf8_lossy(m.bytes());
        let n = m.line_number().unwrap_or(0);
        self.out.push(format!("{}:{n}: {}", self.label, clip(&line)));
        Ok(*self.matches < self.limit)
    }

    fn context(&mut self, _s: &Searcher, c: &SinkContext<'_>) -> Result<bool, std::io::Error> {
        let line = String::from_utf8_lossy(c.bytes());
        let n = c.line_number().unwrap_or(0);
        self.out.push(format!("{}-{n}- {}", self.label, clip(&line)));
        Ok(true)
    }

    fn context_break(&mut self, _s: &Searcher) -> Result<bool, std::io::Error> {
        self.out.push("--".into());
        Ok(true)
    }
}

/// Searches file contents.
#[derive(Debug, Clone)]
pub struct Grep {
    pub blobs: Arc<BlobStore>,
}

impl TypedTool for Grep {
    type Input = GrepInput;
    fn name(&self) -> &str {
        "grep"
    }
    fn description(&self) -> &str {
        "Searches file contents for a regular expression, respecting .gitignore; prints path:line: text."
    }
    fn annotations(&self) -> Annotations {
        Annotations::READ_ONLY
    }
    fn run<'a>(&'a self, ctx: &'a ToolContext, input: GrepInput) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        let root: PathBuf = paths::resolve(&ctx.cwd, input.path.as_deref().unwrap_or("."));
        let cwd = ctx.cwd.clone();
        let blobs = self.blobs.clone();
        Box::pin(async move {
            let limit = input.limit.unwrap_or(100).max(1);
            let context = input.context.unwrap_or(0).min(20);
            let (lines, matches) = blocking(move || {
                let matcher = RegexMatcherBuilder::new()
                    .case_insensitive(input.ignore_case)
                    .fixed_strings(input.literal)
                    .build(&input.pattern)
                    .map_err(|e| ToolError::InvalidInput(format!("pattern: {e}")))?;
                let mut searcher = SearcherBuilder::new()
                    .binary_detection(BinaryDetection::quit(0))
                    .line_number(true)
                    .before_context(context)
                    .after_context(context)
                    .build();
                let mut out = Vec::new();
                let mut matches = 0usize;
                for entry in walker(&root, input.glob.as_deref())?.filter_map(Result::ok) {
                    if matches >= limit {
                        break;
                    }
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        continue;
                    }
                    let label = paths::display(&cwd, entry.path());
                    let sink = Collect {
                        label,
                        out: &mut out,
                        matches: &mut matches,
                        limit,
                    };
                    // An unreadable file is skipped, as ripgrep does.
                    let _ = searcher.search_path(&matcher, entry.path(), sink);
                }
                Ok((out, matches))
            })
            .await?;
            if lines.is_empty() {
                return Ok(ToolOutput::text("no matches").with_details(json!({ "matches": 0 })));
            }
            let mut text = lines.join("\n");
            if matches >= limit {
                text.push_str(&format!(
                    "\n[stopped at {limit} matches; narrow the pattern or raise limit]"
                ));
            }
            let (text, saved) = blobs.fit("grep", &text, Keep::Head);
            Ok(ToolOutput::text(text).with_details(json!({ "matches": matches, "saved": saved })))
        })
    }
}
