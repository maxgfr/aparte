//! What the agent modes (interface, print, JSON, RPC) share: the flags that pick a provider, a model and tools, and
//! the construction of the agent from them.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, bail};
use aparte_agent::session;
use aparte_agent::trust::TrustStore;
use aparte_agent::{Agent, AgentConfig, ApprovalMode, Approver, EventSink};
use aparte_llm::providers::{self, Preset};
use aparte_llm::{ChatModel, Client, Effort, Message, ProviderConfig};
use aparte_tools::{BlobStore, SandboxPolicy, ToolsConfig};

use crate::{Ctx, keychain, paths};

/// Flags of the agent modes.
#[derive(Debug, Clone, clap::Args)]
pub struct AgentArgs {
    /// Provider: anthropic, openai, google, groq, deepseek, xai, mistral, openrouter, ollama, lmstudio
    #[arg(long, env = "APARTE_PROVIDER", default_value = "anthropic", value_name = "ID")]
    pub provider: String,
    /// Model id (default: the provider's default model)
    #[arg(short, long, env = "APARTE_MODEL", value_name = "ID")]
    pub model: Option<String>,
    /// Another base URL for the provider (https, or http on the loopback)
    #[arg(long, env = "APARTE_BASE_URL", value_name = "URL")]
    pub base_url: Option<String>,
    /// Reasoning effort: none, minimal, low, medium, high, xhigh, max (what the model takes)
    #[arg(long, value_name = "LEVEL", value_parser = parse_effort)]
    pub effort: Option<Effort>,
    /// Most model calls per prompt
    #[arg(long, default_value_t = 50, value_name = "N")]
    pub max_turns: u32,
    /// Most output tokens per model call
    #[arg(long, value_name = "N")]
    pub max_output_tokens: Option<u32>,
    /// Replace the system prompt
    #[arg(long, value_name = "TEXT")]
    pub system: Option<String>,
    /// Add to the system prompt
    #[arg(long, value_name = "TEXT")]
    pub append_system: Option<String>,
    /// Only these tools, comma-separated (read,write,edit,bash,grep,find,ls,git,web_fetch)
    #[arg(long, value_delimiter = ',', value_name = "LIST", conflicts_with = "no_tools")]
    pub tools: Option<Vec<String>>,
    /// No tools at all
    #[arg(long)]
    pub no_tools: bool,
    /// Approve every tool call without asking
    #[arg(short = 'y', long)]
    pub yes: bool,
    /// Run bash commands without the OS sandbox (when none is available)
    #[arg(long)]
    pub no_sandbox: bool,
    /// Let bash commands use the network
    #[arg(long)]
    pub allow_net: bool,
    /// Continue a session exported with --export
    #[arg(long, value_name = "FILE")]
    pub resume: Option<PathBuf>,
    /// Write the conversation as JSONL when done
    #[arg(long, value_name = "FILE")]
    pub export: Option<PathBuf>,
}

fn parse_effort(s: &str) -> Result<Effort, String> {
    Effort::parse(s).ok_or_else(|| "expected none, minimal, low, medium, high, xhigh or max".into())
}

/// A ready agent and what it was built from.
pub struct Built {
    pub agent: Agent,
    pub preset: &'static Preset,
    /// Kept alive for the tools; its directory is removed on drop.
    pub blobs: Arc<BlobStore>,
}

/// Finds the preset of `--provider`.
pub fn preset(args: &AgentArgs) -> anyhow::Result<&'static Preset> {
    providers::preset(&args.provider).with_context(|| {
        let ids: Vec<_> = providers::PRESETS.iter().map(|p| p.id).collect();
        format!("unknown provider {:?}; one of: {}", args.provider, ids.join(", "))
    })
}

/// Raised when no key is found: the binary maps it to the `auth` exit code.
#[derive(Debug)]
pub struct MissingKey(pub String);

impl std::fmt::Display for MissingKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MissingKey {}

/// The provider client of the flags.
pub fn client(args: &AgentArgs) -> anyhow::Result<(Client, &'static Preset)> {
    let preset = preset(args)?;
    let key = keychain::resolve(preset);
    if preset.needs_key && key.is_none() && args.base_url.is_none() {
        let env = preset.env.join(" or ");
        return Err(MissingKey(format!(
            "no API key for {}: set {env}, or store one with `aparte key set {}`",
            preset.label, preset.id
        ))
        .into());
    }
    if let Some((_, source)) = &key {
        tracing::debug!(provider = preset.id, %source, "API key found");
    }
    let mut cfg = ProviderConfig::from_preset(preset, key.map(|(k, _)| k));
    if let Some(url) = &args.base_url {
        cfg.base_url.clone_from(url);
    }
    Ok((Client::new(cfg)?, preset))
}

/// How a mode connects to its agent.
pub struct Wiring {
    /// What happens to calls that need approval (`--yes` overrides it).
    pub approval: ApprovalMode,
    pub sink: EventSink,
    /// Who answers approvals in `Ask` mode.
    pub approver: Option<Arc<dyn Approver>>,
}

/// Builds the agent of the flags in `cwd`.
pub fn build(
    ctx: &Ctx,
    args: &AgentArgs,
    model: Arc<dyn ChatModel>,
    preset: &'static Preset,
    cwd: &Path,
    wiring: Wiring,
) -> anyhow::Result<Built> {
    let Wiring {
        approval,
        sink,
        approver,
    } = wiring;
    let trusted = match paths::config_dir(ctx.global.config_dir.as_ref()) {
        Some(dir) => TrustStore::load(&dir)?.is_trusted(cwd),
        None => false,
    };
    let blobs = Arc::new(BlobStore::new().context("cannot create the output directory")?);
    let tools = if args.no_tools {
        Vec::new()
    } else {
        if let Some(only) = &args.tools {
            for name in only {
                if !aparte_tools::NAMES.contains(&name.as_str()) {
                    bail!("unknown tool {name:?}; one of: {}", aparte_tools::NAMES.join(", "));
                }
            }
        }
        let cfg = ToolsConfig {
            sandbox: SandboxPolicy {
                required: !args.no_sandbox,
                network: args.allow_net,
                writable: Vec::new(),
            },
            only: args.tools.clone(),
        };
        aparte_tools::builtin(&cfg, blobs.clone()).context("cannot set up the tools")?
    };
    let described: Vec<(String, String)> = tools
        .iter()
        .map(|t| (t.name().to_owned(), t.description().to_owned()))
        .collect();
    let context = if trusted {
        aparte_agent::context::project_context(cwd)
    } else {
        Vec::new()
    };
    let today = session::now_rfc3339().chars().take(10).collect::<String>();
    let mut system = match &args.system {
        Some(s) => s.clone(),
        None => aparte_agent::context::system_prompt(cwd, &described, &context, &today),
    };
    if let Some(extra) = &args.append_system {
        system.push('\n');
        system.push_str(extra);
    }
    let mut cfg = AgentConfig::new(
        args.model.clone().unwrap_or_else(|| preset.default_model.to_owned()),
        cwd,
    );
    cfg.system = system;
    cfg.effort = args.effort;
    cfg.max_output_tokens = args.max_output_tokens;
    cfg.max_turns = args.max_turns.max(1);
    cfg.trusted = trusted;
    cfg.approval = if args.yes { ApprovalMode::Auto } else { approval };
    let mut agent = Agent::new(model, cfg).with_tools(tools).on_event(sink);
    if let Some(a) = approver {
        agent = agent.with_approver(a);
    }
    if let Some(file) = &args.resume {
        let text = std::fs::read_to_string(file).with_context(|| format!("cannot read {}", file.display()))?;
        let (_, messages): (_, Vec<Message>) = session::import(&text)?;
        agent.set_messages(messages);
    }
    Ok(Built { agent, preset, blobs })
}

/// Writes `--export` when asked.
pub fn export(args: &AgentArgs, built: &Built) -> anyhow::Result<()> {
    let Some(path) = &args.export else {
        return Ok(());
    };
    let header = session::SessionHeader {
        kind: "session".into(),
        version: session::SESSION_VERSION,
        id: session::new_id(),
        timestamp: session::now_rfc3339(),
        cwd: built.agent.config().cwd.display().to_string(),
        provider: Some(built.preset.id.to_owned()),
        model: Some(built.agent.config().model.clone()),
    };
    session::export(path, &header, built.agent.messages()).with_context(|| format!("cannot write {}", path.display()))
}

/// The working directory, canonical.
pub fn cwd() -> anyhow::Result<PathBuf> {
    let dir = std::env::current_dir().context("no working directory")?;
    Ok(dir.canonicalize().unwrap_or(dir))
}
