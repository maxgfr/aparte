//! `git`: read-only git commands, run with the `git` binary (no shell). Only inspection subcommands are allowed;
//! external diff drivers, text conversion, pagers and fsmonitor hooks are turned off so that a repository's own
//! configuration cannot make a read run a program. Changes to a repository go through `bash`, under the sandbox.

use std::process::Stdio;
use std::sync::Arc;

use aparte_agent::{Annotations, BoxFuture, ToolContext, ToolError, ToolOutput, TypedTool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use crate::output::{BlobStore, Keep};

/// Subcommands that only read.
pub const ALLOWED: &[&str] = &[
    "status",
    "diff",
    "log",
    "show",
    "blame",
    "branch",
    "rev-parse",
    "ls-files",
    "shortlog",
    "describe",
];

/// Options that write files or run programs, refused anywhere in the arguments.
const REFUSED: &[&str] = &[
    "--output",
    "-o",
    "--ext-diff",
    "--textconv",
    "--exec",
    "-c",
    "--config",
    "--open-files-in-pager",
];

/// Options of `branch` that only list.
const BRANCH_LIST: &[&str] = &[
    "--list",
    "-l",
    "-a",
    "--all",
    "-r",
    "--remotes",
    "-v",
    "-vv",
    "--verbose",
    "--show-current",
    "--merged",
    "--no-merged",
    "--contains",
];

/// Input of `git`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct GitInput {
    /// Arguments after `git`, the subcommand first: `["log", "--oneline", "-n", "20"]`.
    pub args: Vec<String>,
}

/// Checks the arguments against the read-only allowlist.
pub fn check_args(args: &[String]) -> Result<(), ToolError> {
    let Some(sub) = args.first() else {
        return Err(ToolError::InvalidInput("give a subcommand, like [\"status\"]".into()));
    };
    if !ALLOWED.contains(&sub.as_str()) {
        return Err(ToolError::InvalidInput(format!(
            "git {sub} is not allowed here (read-only: {}); use bash for other commands",
            ALLOWED.join(", ")
        )));
    }
    for a in &args[1..] {
        let name = a.split('=').next().unwrap_or_default();
        if REFUSED.contains(&name) {
            return Err(ToolError::InvalidInput(format!("the option {name} is not allowed")));
        }
    }
    if sub == "branch"
        && args[1..]
            .iter()
            .any(|a| !BRANCH_LIST.contains(&a.as_str()) && a.starts_with('-'))
    {
        return Err(ToolError::InvalidInput(
            "git branch is allowed only to list branches".into(),
        ));
    }
    if sub == "branch"
        && args[1..].iter().any(|a| !a.starts_with('-'))
        && !args.iter().any(|a| {
            a == "--list" || a == "-l" || a == "--contains" || a.starts_with("--merged") || a.starts_with("--no-merged")
        })
    {
        return Err(ToolError::InvalidInput(
            "git branch with a name creates a branch; use --list <pattern>".into(),
        ));
    }
    Ok(())
}

/// Runs read-only git commands.
#[derive(Debug, Clone)]
pub struct Git {
    pub blobs: Arc<BlobStore>,
}

impl TypedTool for Git {
    type Input = GitInput;
    fn name(&self) -> &str {
        "git"
    }
    fn description(&self) -> &str {
        "Runs a read-only git command (status, diff, log, show, blame, branch, rev-parse, ls-files, shortlog, describe)."
    }
    fn annotations(&self) -> Annotations {
        Annotations::READ_ONLY
    }
    fn run<'a>(&'a self, ctx: &'a ToolContext, input: GitInput) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            check_args(&input.args)?;
            let mut cmd = tokio::process::Command::new("git");
            cmd.current_dir(&ctx.cwd)
                .args(["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.pager=cat"])
                .arg(&input.args[0]);
            if matches!(input.args[0].as_str(), "diff" | "show" | "log") {
                cmd.args(["--no-ext-diff", "--no-textconv"]);
            }
            cmd.args(&input.args[1..])
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GIT_PAGER", "cat")
                .env("GIT_OPTIONAL_LOCKS", "0")
                .env_remove("GIT_EXTERNAL_DIFF")
                .stdin(Stdio::null())
                .kill_on_drop(true);
            let out = cmd
                .output()
                .await
                .map_err(|e| ToolError::Failed(format!("cannot run git: {e}")))?;
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.trim().is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(err.trim_end());
            }
            let (mut shown, saved) = self.blobs.fit("git", &text, Keep::Head);
            if shown.is_empty() {
                shown.push_str("(no output)");
            }
            Ok(ToolOutput {
                content: shown,
                details: Some(json!({ "exitCode": out.status.code(), "saved": saved })),
                is_error: !out.status.success(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::check_args;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn only_reads_are_allowed() {
        assert!(check_args(&args(&["status", "--short"])).is_ok());
        assert!(check_args(&args(&["log", "--oneline", "-n", "5"])).is_ok());
        assert!(check_args(&args(&["branch", "-a"])).is_ok());
        assert!(check_args(&args(&["branch", "--list", "feat*"])).is_ok());
        assert!(check_args(&args(&["commit", "-m", "x"])).is_err());
        assert!(check_args(&args(&["-c", "x=y", "status"])).is_err());
        assert!(check_args(&args(&["diff", "--output=/tmp/x"])).is_err());
        assert!(check_args(&args(&["diff", "--ext-diff"])).is_err());
        assert!(check_args(&args(&["branch", "new-branch"])).is_err());
        assert!(check_args(&args(&["branch", "-D", "main"])).is_err());
        assert!(check_args(&[]).is_err());
    }
}
