//! `aparte models`: the built-in providers and their models, with the effort levels each model takes; with
//! `--remote`, the provider's own list (free: no generation).

use std::process::ExitCode;

use aparte_llm::caps;
use aparte_llm::providers::{self, PRESETS};

use crate::setup::{self, AgentArgs};
use crate::{Ctx, exit};

/// Arguments of `aparte models`.
#[derive(Debug, clap::Args)]
pub struct Args {
    /// Ask the provider for its models (needs its key)
    #[arg(long)]
    pub remote: bool,
    /// Only this provider
    #[arg(long, value_name = "ID")]
    pub provider: Option<String>,
    /// Another base URL for the provider (with --remote)
    #[arg(long, value_name = "URL")]
    pub base_url: Option<String>,
}

fn levels(maker: caps::Maker, model: &str) -> Vec<&'static str> {
    caps::effort_levels(maker, model).iter().map(|e| e.as_str()).collect()
}

/// Prints the table, or the provider's list.
pub fn run(args: Args, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    if args.remote {
        let id = args.provider.clone().unwrap_or_else(|| "anthropic".into());
        let agent_args = AgentArgs {
            provider: id,
            model: None,
            base_url: args.base_url.clone(),
            effort: None,
            max_turns: 1,
            max_output_tokens: None,
            system: None,
            append_system: None,
            tools: None,
            no_tools: true,
            no_skills: true,
            no_mcp: true,
            yes: false,
            no_sandbox: false,
            allow_net: false,
            resume: None,
            export: None,
        };
        let (client, preset) = setup::client(&agent_args)?;
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        return match rt.block_on(client.list_models()) {
            Ok(ids) => {
                for id in &ids {
                    ctx.ui.emit(
                        "model",
                        serde_json::json!({"provider": preset.id, "id": id, "effort": levels(preset.maker, id)}),
                    );
                    if !ctx.ui.is_json() {
                        ctx.ui.say(id);
                    }
                }
                Ok(ExitCode::from(exit::OK))
            }
            Err(e) => {
                let code = if e.code == aparte_llm::ErrorCode::Auth {
                    exit::AUTH
                } else {
                    exit::NETWORK
                };
                ctx.ui
                    .error(code, &format!("cannot list the models of {}: {e}", preset.label));
                Ok(ExitCode::from(code))
            }
        };
    }
    if let Some(id) = &args.provider
        && providers::preset(id).is_none()
    {
        anyhow::bail!("unknown provider {id:?}");
    }
    for p in PRESETS
        .iter()
        .filter(|p| args.provider.as_deref().is_none_or(|id| id == p.id))
    {
        let key = if p.needs_key {
            p.env.join(" or ")
        } else {
            "no key (local server)".into()
        };
        ctx.ui.emit(
            "provider",
            serde_json::json!({
                "id": p.id, "label": p.label, "protocol": p.protocol.to_string(), "baseUrl": p.base_url,
                "keyEnv": p.env, "defaultModel": p.default_model,
            }),
        );
        if !ctx.ui.is_json() {
            ctx.ui
                .say(&format!("{} ({}) · {} · key: {key}", p.id, p.label, p.base_url));
        }
        for m in p.models {
            let effort = levels(p.maker, m);
            ctx.ui.emit(
                "model",
                serde_json::json!({"provider": p.id, "id": m, "effort": effort, "default": *m == p.default_model}),
            );
            if !ctx.ui.is_json() {
                let star = if *m == p.default_model { " (default)" } else { "" };
                let eff = if effort.is_empty() {
                    String::new()
                } else {
                    format!("  effort: {}", effort.join(" "))
                };
                ctx.ui.say(&format!("  {m}{star}{eff}"));
            }
        }
    }
    Ok(ExitCode::from(exit::OK))
}
