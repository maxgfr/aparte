//! `aparte doctor`: prints facts about this machine and the directories the CLI would use. It changes nothing and
//! reports a missing directory as a fact, not a failure, since nothing is created before the first vault.

use std::path::Path;
use std::process::ExitCode;

use crate::{Ctx, exit, paths};

/// Arguments of `aparte doctor`.
#[derive(Debug, clap::Args)]
pub struct Args {}

fn describe(dir: Option<&Path>) -> (String, bool) {
    match dir {
        Some(p) if p.is_dir() => (p.display().to_string(), true),
        Some(p) => (format!("{} (not created yet)", p.display()), false),
        None => ("unknown (set HOME or the flag)".into(), false),
    }
}

/// Prints the facts, always exiting 0.
pub fn run(_args: Args, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let config = paths::config_dir(ctx.global.config_dir.as_ref());
    let data = paths::data_dir(ctx.global.data_dir.as_ref());
    let (config_text, config_exists) = describe(config.as_deref());
    let (data_text, data_exists) = describe(data.as_deref());
    let log = std::env::var("APARTE_LOG").ok();

    ctx.ui.emit(
        "doctor",
        serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "format": aparte_format::FORMAT,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "config_dir": config.as_ref().map(|p| p.display().to_string()),
            "config_dir_exists": config_exists,
            "data_dir": data.as_ref().map(|p| p.display().to_string()),
            "data_dir_exists": data_exists,
            "log_filter": log,
        }),
    );
    if !ctx.ui.is_json() {
        ctx.ui.say(&format!("aparte {}", env!("CARGO_PKG_VERSION")));
        ctx.ui.say(&format!("  format      {}", aparte_format::FORMAT));
        ctx.ui.say(&format!(
            "  platform    {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
        ctx.ui.say(&format!("  config dir  {config_text}"));
        ctx.ui.say(&format!("  data dir    {data_text}"));
        ctx.ui
            .say(&format!("  APARTE_LOG  {}", log.as_deref().unwrap_or("unset")));
    }
    Ok(ExitCode::from(exit::OK))
}
