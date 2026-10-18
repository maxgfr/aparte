//! `aparte`: the command-line companion of the Aparté web app, and a coding agent in the terminal.
//!
//! It reads and writes the same `aparte/1` format as the browser. Without a verb it opens the terminal interface;
//! `-p` answers one prompt, `rpc` serves the agent over JSON lines. Every other verb is offline unless it says
//! otherwise, and with `--json` it prints one JSON object per line on stdout while human text goes to stderr.

mod cmd {
    pub mod chat;
    pub mod completions;
    pub mod doctor;
    pub mod key;
    pub mod mcp;
    pub mod models;
    pub mod rpc;
    pub mod selftest;
    pub mod skills;
    pub mod trust;
}
mod keychain;
mod paths;
mod setup;
mod ui;

use std::io::IsTerminal;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{CommandFactory, Parser, Subcommand};

use crate::ui::Ui;

/// Stable exit codes. Scripts depend on them, so a code is never renumbered or reused for another meaning.
pub mod exit {
    /// Success.
    pub const OK: u8 = 0;
    /// Any other error.
    pub const ERROR: u8 = 1;
    /// Bad command line (clap uses the same code for its own parse errors).
    pub const USAGE: u8 = 2;
    /// A provider, sync peer or download was unreachable.
    pub const NETWORK: u8 = 3;
    /// Integrity failure: a hash, MAC or decryption did not verify.
    pub const INTEGRITY: u8 = 4;
    /// Wrong passphrase or key: no keyslot opened.
    pub const LOCKED: u8 = 5;
    /// Data in a format version this build does not read.
    pub const FORMAT: u8 = 6;
    /// Cancelled or interrupted.
    pub const CANCELLED: u8 = 7;
    /// No API key, or the provider refused it.
    pub const AUTH: u8 = 8;
    /// The model declined to answer (a refusal).
    pub const REFUSED: u8 = 9;
}

const AFTER_HELP: &str = "\
Exit codes:
  0  ok
  1  error
  2  usage (bad arguments)
  3  network unreachable
  4  integrity failure (hash, MAC or decryption)
  5  locked (wrong passphrase or key)
  6  unsupported format version
  7  cancelled or interrupted
  8  no API key, or the key was refused
  9  the model declined to answer

Environment:
  APARTE_CONFIG_DIR  configuration directory (default $XDG_CONFIG_HOME/aparte or ~/.config/aparte)
  APARTE_DATA_DIR    data directory (default $XDG_DATA_HOME/aparte or ~/.local/share/aparte)
  APARTE_LOG         log filter, in tracing's EnvFilter syntax (overrides -v)
  APARTE_PROVIDER    default provider (anthropic)
  APARTE_MODEL       default model
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY ...  provider keys (else the OS keychain)
  APARTE_NO_KEYCHAIN set to 1 to never read the OS keychain
  NO_COLOR           disable colors";

#[derive(Debug, Parser)]
#[command(
    name = "aparte",
    version,
    about = "Private AI chat, end-to-end encrypted: the command-line companion of the Aparté web app",
    after_long_help = AFTER_HELP
)]
struct Cli {
    #[command(flatten)]
    global: Global,
    /// Answer one prompt on stdout and exit ("-" reads it from stdin)
    #[arg(short, long, value_name = "PROMPT")]
    print: Option<String>,
    #[command(flatten)]
    agent: setup::AgentArgs,
    #[command(subcommand)]
    command: Option<Command>,
}

/// Flags shared by every verb.
#[derive(Debug, Clone, clap::Args)]
pub struct Global {
    /// Print one JSON object per line on stdout (human text goes to stderr)
    #[arg(long, global = true)]
    pub json: bool,
    /// Configuration directory
    #[arg(long, global = true, value_name = "DIR", env = "APARTE_CONFIG_DIR")]
    pub config_dir: Option<PathBuf>,
    /// Data directory (encrypted vaults)
    #[arg(long, global = true, value_name = "DIR", env = "APARTE_DATA_DIR")]
    pub data_dir: Option<PathBuf>,
    /// More logs (repeat for more)
    #[arg(short, long, global = true, action = clap::ArgAction::Count)]
    pub verbose: u8,
    /// Less output
    #[arg(short, long, global = true)]
    pub quiet: bool,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve the agent over stdin and stdout, one JSON object per line
    Rpc(cmd::rpc::Args),
    /// List providers and models
    Models(cmd::models::Args),
    /// Trust a project directory, revoke it, or list decisions
    Trust(cmd::trust::Args),
    /// List and show skills (SKILL.md), and where they are looked for
    Skills(cmd::skills::Args),
    /// Add, list, remove MCP servers, list their tools, sign in
    Mcp(cmd::mcp::Args),
    /// Store, remove or locate provider API keys
    Key(cmd::key::Args),
    /// Offline self-check (no key, no network, no files)
    Selftest(cmd::selftest::Args),
    /// Print facts about this machine and the directories in use
    Doctor(cmd::doctor::Args),
    /// Print shell completions
    Completions(cmd::completions::Args),
}

/// What every verb receives.
pub struct Ctx {
    pub global: Global,
    pub ui: Ui,
}

/// The clap command, for completions.
pub fn command() -> clap::Command {
    Cli::command()
}

/// The log filter for a verbosity level when `APARTE_LOG` is unset.
fn default_log_filter(verbose: u8) -> &'static str {
    match verbose {
        0 => "warn",
        1 => "info,aparte=debug",
        _ => "debug,aparte=trace",
    }
}

/// Sends logs to stderr so that stdout stays parseable with `--json`.
fn init_logs(verbose: u8) {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_env("APARTE_LOG").unwrap_or_else(|_| EnvFilter::new(default_log_filter(verbose)));
    let res = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none())
        .try_init();
    if let Err(e) = res {
        eprintln!("cannot set up logging: {e}");
    }
}

fn dispatch(cli: Cli, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let Some(command) = cli.command else {
        return match &cli.print {
            Some(prompt) => cmd::chat::print(&cli.agent, prompt, ctx),
            None => cmd::chat::interactive(&cli.agent, ctx),
        };
    };
    match command {
        Command::Rpc(args) => cmd::rpc::run(args, ctx),
        Command::Models(args) => cmd::models::run(args, ctx),
        Command::Trust(args) => cmd::trust::run(args, ctx),
        Command::Skills(args) => cmd::skills::run(args, ctx),
        Command::Mcp(args) => cmd::mcp::run(args, ctx),
        Command::Key(args) => cmd::key::run(args, ctx),
        Command::Selftest(args) => cmd::selftest::run(args, ctx),
        Command::Doctor(args) => cmd::doctor::run(args, ctx),
        Command::Completions(args) => cmd::completions::run(args, ctx),
    }
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(c) => c,
        Err(e) => e.exit(),
    };
    init_logs(cli.global.verbose);
    let ui = Ui::new(cli.global.json, cli.global.quiet);
    let ctx = Ctx {
        global: cli.global.clone(),
        ui,
    };
    match dispatch(cli, &ctx) {
        Ok(code) => code,
        Err(e) => {
            let code = if e.downcast_ref::<setup::MissingKey>().is_some() {
                exit::AUTH
            } else if e.downcast_ref::<aparte_llm::LlmError>().is_some() {
                exit::USAGE
            } else {
                exit::ERROR
            };
            ctx.ui.error(code, &format!("{e:#}"));
            ExitCode::from(code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Cli, default_log_filter, exit};

    #[test]
    fn the_command_line_definition_is_consistent() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }

    #[test]
    fn default_log_filters_parse() {
        for v in 0..4 {
            assert!(tracing_subscriber::EnvFilter::try_new(default_log_filter(v)).is_ok());
        }
    }

    #[test]
    fn exit_codes_are_distinct() {
        let codes = [
            exit::OK,
            exit::ERROR,
            exit::USAGE,
            exit::NETWORK,
            exit::INTEGRITY,
            exit::LOCKED,
            exit::FORMAT,
            exit::CANCELLED,
            exit::AUTH,
            exit::REFUSED,
        ];
        let mut sorted = codes.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), codes.len());
    }
}
