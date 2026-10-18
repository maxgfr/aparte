//! The default mode: the terminal interface, or with `-p` one prompt answered on stdout (text, or with `--json`
//! one event per line). Without a person to ask, tool calls that need approval are denied unless `--yes`.

use std::io::{IsTerminal, Read, Write};
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::Context;
use aparte_agent::{AgentEvent, ApprovalMode, EndReason, EventSink, RunOutcome};
use aparte_llm::{ChatModel, ErrorCode};
use serde_json::Value;

use crate::setup::{self, AgentArgs};
use crate::{Ctx, exit};

/// An agent event as a `--json` line: `{"event": "<type>", ...fields}`, like every other verb's output.
pub fn event_json(ev: &AgentEvent) -> Value {
    let mut v = serde_json::to_value(ev).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut v
        && let Some(kind) = map.remove("type")
    {
        map.insert("event".into(), kind);
    }
    v
}

/// The exit code of a run.
pub fn exit_for(out: &RunOutcome) -> u8 {
    match out.reason {
        EndReason::Done | EndReason::Stopped => exit::OK,
        EndReason::Aborted => exit::CANCELLED,
        EndReason::Refusal => exit::REFUSED,
        EndReason::MaxTurns => exit::ERROR,
        EndReason::Error => match out.error.as_ref().map(|e| e.code) {
            Some(ErrorCode::Auth) => exit::AUTH,
            Some(
                ErrorCode::Network
                | ErrorCode::Overloaded
                | ErrorCode::RateLimit
                | ErrorCode::Server
                | ErrorCode::Truncated,
            ) => exit::NETWORK,
            _ => exit::ERROR,
        },
    }
}

fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("cannot start the async runtime")
}

fn print_sink(json: bool, quiet: bool) -> EventSink {
    Arc::new(move |ev: &AgentEvent| {
        if json {
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{}", event_json(ev));
            return;
        }
        match ev {
            AgentEvent::TextDelta { text } => {
                let mut out = std::io::stdout().lock();
                let _ = out.write_all(aparte_tui::markdown::sanitize(text).as_bytes());
                let _ = out.flush();
            }
            AgentEvent::MessageEnd { message } if !message.text().is_empty() => println!(),
            AgentEvent::ToolStart { name, input, .. } if !quiet => {
                eprintln!("▸ {name} {}", aparte_tui::app::summarize_input(name, input));
            }
            AgentEvent::ToolEnd { name, output, .. } if output.is_error && !quiet => {
                let first = output.content.lines().next().unwrap_or_default();
                eprintln!("  {name} failed: {}", aparte_tui::markdown::sanitize(first));
            }
            AgentEvent::Refusal { category, explanation } => eprintln!(
                "aparte: the model declined (category {}){}",
                category.as_deref().unwrap_or("unspecified"),
                explanation.as_deref().map(|e| format!(": {e}")).unwrap_or_default()
            ),
            AgentEvent::Error { error } => eprintln!("aparte: {error}"),
            _ => {}
        }
    })
}

/// `aparte -p "prompt"`: one prompt, answered on stdout.
pub fn print(args: &AgentArgs, prompt: &str, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let prompt = if prompt == "-" {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .context("cannot read the prompt from stdin")?;
        s
    } else {
        prompt.to_owned()
    };
    if prompt.trim().is_empty() {
        anyhow::bail!("the prompt is empty");
    }
    let (client, preset) = setup::client(args)?;
    let model: Arc<dyn ChatModel> = Arc::new(client);
    print_with(args, &prompt, ctx, model, preset)
}

/// Print mode with a given model (the tests and examples pass a scripted one).
pub fn print_with(
    args: &AgentArgs,
    prompt: &str,
    ctx: &Ctx,
    model: Arc<dyn ChatModel>,
    preset: &'static aparte_llm::providers::Preset,
) -> anyhow::Result<ExitCode> {
    let rt = runtime()?;
    rt.block_on(async {
        let cwd = setup::cwd()?;
        let sink = print_sink(ctx.ui.is_json(), ctx.global.quiet);
        let wiring = setup::Wiring {
            approval: ApprovalMode::Deny,
            sink,
            approver: None,
        };
        let mut built = setup::build(ctx, args, model, preset, &cwd, wiring)?;
        let handle = built.agent.handle();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                handle.abort();
            }
        });
        let out = built.agent.prompt(prompt).await;
        setup::export(args, &built)?;
        Ok(ExitCode::from(exit_for(&out)))
    })
}

/// `aparte`: the terminal interface.
pub fn interactive(args: &AgentArgs, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        anyhow::bail!("no terminal: use `aparte -p \"prompt\"` (print mode) or `aparte rpc`");
    }
    let (client, preset) = setup::client(args)?;
    let model: Arc<dyn ChatModel> = Arc::new(client);
    let rt = runtime()?;
    rt.block_on(async {
        let cwd = setup::cwd()?;
        let (sink, approver, channels) = aparte_tui::channels();
        let wiring = setup::Wiring {
            approval: ApprovalMode::Ask,
            sink,
            approver: Some(approver),
        };
        let built = setup::build(ctx, args, model, preset, &cwd, wiring)?;
        let opts = aparte_tui::Options {
            provider: preset.id.to_owned(),
            palette: aparte_tui::Palette {
                color: std::env::var_os("NO_COLOR").is_none(),
            },
            height: 12,
        };
        let setup::Built { agent, preset, blobs } = built;
        let agent = aparte_tui::run(agent, channels, opts).await?;
        let built = setup::Built { agent, preset, blobs };
        setup::export(args, &built)?;
        Ok(ExitCode::from(exit::OK))
    })
}
