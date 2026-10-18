//! `aparte key`: stores a provider's API key in the OS keychain (read from stdin, never from the command line),
//! removes it, or says where the key in use comes from (never the key itself).

use std::io::{BufRead, IsTerminal};
use std::process::ExitCode;

use anyhow::Context;
use aparte_llm::ApiKey;
use aparte_llm::providers;

use crate::{Ctx, exit, keychain};

/// Arguments of `aparte key`.
#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    pub action: Action,
}

/// What to do with a key.
#[derive(Debug, clap::Subcommand)]
pub enum Action {
    /// Store a key, read from stdin: `aparte key set anthropic < key.txt`
    Set { provider: String },
    /// Remove a stored key
    Delete { provider: String },
    /// Where each provider's key comes from
    Status,
}

fn read_secret() -> anyhow::Result<String> {
    let stdin = std::io::stdin();
    let tty = stdin.is_terminal();
    if tty {
        eprint!("Paste the key, then Enter (it is not shown): ");
        let _ = std::process::Command::new("stty").arg("-echo").status();
    }
    let mut line = String::new();
    let read = stdin.lock().read_line(&mut line);
    if tty {
        let _ = std::process::Command::new("stty").arg("echo").status();
        eprintln!();
    }
    read.context("cannot read the key")?;
    Ok(line.trim().to_owned())
}

/// Runs a key action.
pub fn run(args: Args, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let known = |id: &str| providers::preset(id).with_context(|| format!("unknown provider {id:?}"));
    match args.action {
        Action::Set { provider } => {
            known(&provider)?;
            let key = ApiKey::new(read_secret()?).context("the key is empty or has spaces or control characters")?;
            keychain::set(&provider, &key)?;
            ctx.ui
                .emit("key", serde_json::json!({"provider": provider, "stored": true}));
            ctx.ui.say(&format!("stored the {provider} key in the OS keychain"));
        }
        Action::Delete { provider } => {
            known(&provider)?;
            let removed = keychain::delete(&provider)?;
            ctx.ui
                .emit("key", serde_json::json!({"provider": provider, "removed": removed}));
            ctx.ui.say(if removed { "removed" } else { "no key was stored" });
        }
        Action::Status => {
            for p in providers::PRESETS.iter().filter(|p| p.needs_key) {
                let source = keychain::resolve(p).map(|(_, s)| s.to_string());
                ctx.ui
                    .emit("key", serde_json::json!({"provider": p.id, "source": source}));
                if !ctx.ui.is_json() {
                    ctx.ui
                        .say(&format!("{:<11} {}", p.id, source.as_deref().unwrap_or("none")));
                }
            }
        }
    }
    Ok(ExitCode::from(exit::OK))
}
