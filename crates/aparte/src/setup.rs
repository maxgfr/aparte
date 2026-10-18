//! What the agent modes (interface, print, JSON, RPC) share: the flags that pick a provider, a model and tools, and
//! the construction of the agent from them, with the skills found from the working directory and the configured MCP
//! servers.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, bail};
use aparte_agent::session;
use aparte_agent::trust::TrustStore;
use aparte_agent::{Agent, AgentConfig, ApprovalMode, Approver, EventSink};
use aparte_llm::providers::{self, Preset};
use aparte_llm::{ChatModel, Client, Effort, Message, ProviderConfig};
use aparte_mcp::{ConnectOptions, McpManager, PinStore};
use aparte_skills::Catalog;
use aparte_tools::{BlobStore, SandboxPolicy, ToolsConfig};

use crate::{Ctx, device, keychain, paths, session as vault_session};

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
    /// Only these built-in tools, comma-separated (read,write,edit,bash,grep,find,ls,git,web_fetch,skill)
    #[arg(long, value_delimiter = ',', value_name = "LIST", conflicts_with = "no_tools")]
    pub tools: Option<Vec<String>>,
    /// No tools at all (no skills, no MCP servers)
    #[arg(long)]
    pub no_tools: bool,
    /// Do not offer skills
    #[arg(long)]
    pub no_skills: bool,
    /// Do not start MCP servers
    #[arg(long)]
    pub no_mcp: bool,
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
    /// Continue a conversation of the vault (`aparte sessions list`), the CLI's or the web app's
    #[arg(long, value_name = "ID", conflicts_with = "resume")]
    pub session: Option<String>,
    /// With --session: continue from this message; the new messages become a branch beside the old ones
    #[arg(long, value_name = "MESSAGE", requires = "session")]
    pub branch_from: Option<String>,
    /// Do not record the conversation in the vault
    #[arg(long, conflicts_with = "session")]
    pub no_save: bool,
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
    /// The skills found (offered or not).
    pub skills: Arc<Catalog>,
    /// The MCP servers started; shut down by [`finish`].
    pub mcp: McpManager,
    /// The vault conversation the session is recorded in, when there is one.
    pub recorder: Option<Recording>,
}

/// An unlocked vault and the conversation a session is recorded in.
pub struct Recording {
    pub open: device::Open,
    pub recorder: vault_session::Recorder,
    /// The system prompt and tool snapshot a new conversation is created with.
    pub system: String,
    pub tools: serde_json::Value,
}

/// Opens the vault for recording, as the flags ask: `None` with `--no-save`, without a vault, or (with a warning)
/// when the passphrase cannot be asked for.
fn open_recording(ctx: &Ctx, args: &AgentArgs) -> anyhow::Result<Option<device::Open>> {
    if args.no_save {
        return Ok(None);
    }
    let vault = device::vault(ctx)?;
    if vault.state()? == aparte_store::VaultState::Absent {
        if args.session.is_some() {
            bail!("no vault on this device: `aparte vault create` or `aparte vault join`");
        }
        return Ok(None);
    }
    match device::open(ctx) {
        Ok(open) => Ok(Some(open)),
        Err(e) if args.session.is_none() && e.downcast_ref::<device::NoPassphrase>().is_some() => {
            if !ctx.global.quiet {
                eprintln!("aparte: this conversation is not saved in the vault: {e} (or pass --no-save)");
            }
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// Every tool name `--tools` takes.
pub fn tool_names() -> Vec<&'static str> {
    let mut v = aparte_tools::NAMES.to_vec();
    v.push("skill");
    v
}

/// The skills that apply to `cwd`.
pub fn skills(cwd: &Path) -> Catalog {
    aparte_skills::discover(cwd, aparte_skills::home_dir().as_deref())
}

/// Whether `cwd` is trusted.
pub fn trusted(ctx: &Ctx, cwd: &Path) -> anyhow::Result<bool> {
    Ok(match paths::config_dir(ctx.global.config_dir.as_ref()) {
        Some(dir) => TrustStore::load(&dir)?.is_trusted(cwd),
        None => false,
    })
}

/// How MCP servers are reached from this machine.
pub fn mcp_options(ctx: &Ctx, cwd: &Path) -> ConnectOptions {
    let mut o = ConnectOptions::new(cwd);
    o.config_dir = paths::config_dir(ctx.global.config_dir.as_ref());
    o.vault = keychain::KeychainVault::available().map(|v| Arc::new(v) as Arc<dyn aparte_mcp::auth::SecretVault>);
    o
}

/// Starts the configured MCP servers; configuration errors are logged, not fatal.
pub async fn start_mcp(ctx: &Ctx, cwd: &Path, trusted: bool) -> anyhow::Result<McpManager> {
    let config_dir = paths::config_dir(ctx.global.config_dir.as_ref());
    let (servers, errors) = aparte_mcp::config::load(config_dir.as_deref(), cwd, trusted);
    for e in &errors {
        tracing::warn!("MCP configuration: {e}");
        if !ctx.global.quiet {
            eprintln!("aparte: MCP configuration: {e}");
        }
    }
    if servers.is_empty() {
        return Ok(McpManager::default());
    }
    let mut pins = match &config_dir {
        Some(dir) => PinStore::load(dir)?,
        None => PinStore::in_memory(),
    };
    Ok(McpManager::start(&servers, &mcp_options(ctx, cwd), &mut pins).await)
}

/// Expands a `/skill:<name> ...` prompt; other prompts pass through.
pub fn expand_prompt(skills: &Catalog, text: &str) -> anyhow::Result<String> {
    match aparte_skills::expand_invocation(skills, text) {
        Some(r) => Ok(r?),
        None => Ok(text.to_owned()),
    }
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
pub async fn build(
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
    let trusted = trusted(ctx, cwd)?;
    let blobs = Arc::new(BlobStore::new().context("cannot create the output directory")?);
    let skills = Arc::new(skills(cwd));
    let wants_skill =
        !args.no_tools && !args.no_skills && args.tools.as_ref().is_none_or(|o| o.iter().any(|n| n == "skill"));
    let mut tools = if args.no_tools {
        Vec::new()
    } else {
        if let Some(only) = &args.tools {
            let known = tool_names();
            for name in only {
                if !known.contains(&name.as_str()) {
                    bail!("unknown tool {name:?}; one of: {}", known.join(", "));
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
    let offer_skills = wants_skill && skills.offered(trusted).next().is_some();
    if offer_skills {
        tools.push(aparte_skills::skill_tool(skills.clone(), trusted));
    }
    let mcp = if args.no_tools || args.no_mcp {
        McpManager::default()
    } else {
        start_mcp(ctx, cwd, trusted).await?
    };
    tools.extend(mcp.tools());
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
    if offer_skills {
        system.push_str(&aparte_skills::prompt_block(&skills, trusted));
    }
    if let Some(extra) = &args.append_system {
        system.push('\n');
        system.push_str(extra);
    }
    let model_id = args.model.clone().unwrap_or_else(|| preset.default_model.to_owned());
    let mut recording = None;
    let mut history = Vec::new();
    let mut sink = sink;
    if let Some(open) = open_recording(ctx, args)? {
        let provider = vault_session::ensure_provider(&open.workspace, preset, args.base_url.as_deref())?;
        let (recorder, past, frozen) = vault_session::Recorder::start(
            &open.workspace,
            args.session.as_deref(),
            args.branch_from.as_deref(),
            provider,
            model_id.clone(),
            args.effort,
        )?;
        // A continued conversation keeps the system prompt it was signed over (spec/DATA-MODEL.md section 5).
        if let Some(frozen) = frozen {
            system = frozen;
        }
        sink = recorder.sink(sink);
        history = past;
        recording = Some(Recording {
            open,
            recorder,
            system: system.clone(),
            tools: vault_session::tool_snapshot(&tools),
        });
    }
    let mut cfg = AgentConfig::new(model_id, cwd);
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
    } else if !history.is_empty() {
        agent.set_messages(history);
    }
    Ok(Built {
        agent,
        preset,
        blobs,
        skills,
        mcp,
        recorder: recording,
    })
}

/// Commits what the agent added to the vault conversation, when the session is recorded.
pub fn record(built: &mut Built, outcome: Option<&aparte_agent::RunOutcome>) -> anyhow::Result<()> {
    let Some(r) = built.recorder.as_mut() else {
        return Ok(());
    };
    r.recorder
        .commit(&r.open.workspace, &r.system, &r.tools, built.agent.messages(), outcome)
        .context("cannot save the conversation in the vault")?;
    Ok(())
}

/// Ends a session: records it in the vault, writes `--export` when asked, then stops the MCP servers.
pub async fn finish(args: &AgentArgs, mut built: Built) -> anyhow::Result<()> {
    let recorded = record(&mut built, None);
    if let Some(r) = &built.recorder
        && !r.recorder.conversation().is_empty()
        && !args.no_save
    {
        tracing::info!(conversation = r.recorder.conversation(), "saved in the vault");
    }
    let exported = export(args, &built);
    built.mcp.shutdown().await;
    recorded.and(exported)
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
