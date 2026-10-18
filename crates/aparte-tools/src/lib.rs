//! `aparte-tools`: the developer tools of the `aparte` agent, each an [`aparte_agent::Tool`]:
//!
//! | Tool | Does | Annotations |
//! |---|---|---|
//! | `read` | reads a text file, a window of lines at a time | read-only |
//! | `write` | writes a whole file inside the project | destructive |
//! | `edit` | exact-text replacements, several at once | writes |
//! | `bash` | a command under the OS sandbox | destructive |
//! | `grep` | searches contents (ripgrep's searcher) | read-only |
//! | `find` | finds files by glob | read-only |
//! | `ls` | lists a directory | read-only |
//! | `git` | read-only git commands | read-only |
//! | `web_fetch` | fetches a page as text | read-only, network |
//!
//! Large outputs are cut for the model and kept whole in a private blob directory ([`output`]).

pub mod bash;
pub mod files;
pub mod git;
pub mod output;
pub mod paths;
pub mod sandbox;
pub mod search;
pub mod web;

use std::sync::Arc;

use aparte_agent::{Tool, typed};

pub use output::BlobStore;
pub use sandbox::{Sandbox, SandboxPolicy};

/// Names of the built-in tools, in the order they are offered.
pub const NAMES: &[&str] = &[
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "find",
    "ls",
    "git",
    "web_fetch",
];

/// How the built-in tools are set up.
#[derive(Debug, Clone, Default)]
pub struct ToolsConfig {
    pub sandbox: SandboxPolicy,
    /// Only these tools (by name); `None` is all of them.
    pub only: Option<Vec<String>>,
}

/// The built-in tools, sharing one blob store.
pub fn builtin(cfg: &ToolsConfig, blobs: Arc<BlobStore>) -> std::io::Result<Vec<Arc<dyn Tool>>> {
    let wanted = |name: &str| cfg.only.as_ref().is_none_or(|o| o.iter().any(|n| n == name));
    let mut tools: Vec<Arc<dyn Tool>> = Vec::new();
    for name in NAMES.iter().copied().filter(|n| wanted(n)) {
        let tool = match name {
            "read" => typed(files::Read),
            "write" => typed(files::Write),
            "edit" => typed(files::Edit),
            "bash" => typed(bash::Bash::new(cfg.sandbox.clone(), blobs.clone())?),
            "grep" => typed(search::Grep { blobs: blobs.clone() }),
            "find" => typed(search::Find),
            "ls" => typed(search::Ls),
            "git" => typed(git::Git { blobs: blobs.clone() }),
            "web_fetch" => typed(web::WebFetch::new(blobs.clone()).map_err(std::io::Error::other)?),
            _ => continue,
        };
        tools.push(tool);
    }
    Ok(tools)
}
