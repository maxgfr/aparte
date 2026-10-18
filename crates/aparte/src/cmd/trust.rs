//! `aparte trust`: marks a project directory trusted (its `AGENTS.md` is read and non-destructive writes run
//! without asking), revokes it, or lists the decisions.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Context;
use aparte_agent::trust::TrustStore;

use crate::{Ctx, exit, paths};

/// Arguments of `aparte trust`.
#[derive(Debug, clap::Args)]
pub struct Args {
    /// The project directory (default: the working directory)
    pub path: Option<PathBuf>,
    /// Mark it untrusted instead
    #[arg(long, conflicts_with = "list")]
    pub revoke: bool,
    /// List every decision
    #[arg(long)]
    pub list: bool,
}

/// Records or lists trust decisions.
pub fn run(args: Args, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let dir = paths::config_dir(ctx.global.config_dir.as_ref())
        .context("no configuration directory: set HOME or --config-dir")?;
    let mut store = TrustStore::load(&dir)?;
    if args.list {
        for (path, trusted) in store.entries() {
            ctx.ui
                .emit("trust", serde_json::json!({"path": path, "trusted": trusted}));
            if !ctx.ui.is_json() {
                ctx.ui
                    .say(&format!("{}  {path}", if trusted { "trusted  " } else { "untrusted" }));
            }
        }
        return Ok(ExitCode::from(exit::OK));
    }
    let path = match args.path {
        Some(p) => p,
        None => std::env::current_dir().context("no working directory")?,
    };
    let path = path
        .canonicalize()
        .with_context(|| format!("{} does not exist", path.display()))?;
    store.set(&path, !args.revoke)?;
    ctx.ui.emit(
        "trust",
        serde_json::json!({"path": path.display().to_string(), "trusted": !args.revoke}),
    );
    let verb = if args.revoke { "untrusted" } else { "trusted" };
    ctx.ui.say(&format!("{verb}: {}", path.display()));
    Ok(ExitCode::from(exit::OK))
}
