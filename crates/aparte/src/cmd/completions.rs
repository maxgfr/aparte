//! `aparte completions <shell>`: shell completion scripts.

use std::process::ExitCode;

use clap_complete::Shell;

use crate::Ctx;

/// Arguments of `aparte completions`.
#[derive(Debug, clap::Args)]
pub struct Args {
    /// Shell: bash, zsh, fish, powershell or elvish
    #[arg(value_enum)]
    pub shell: Shell,
}

/// Prints the completion script on stdout.
pub fn run(args: Args, _ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let mut cmd = crate::command();
    clap_complete::generate(args.shell, &mut cmd, "aparte", &mut std::io::stdout());
    Ok(ExitCode::SUCCESS)
}
