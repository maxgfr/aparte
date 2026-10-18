//! `aparte mcp`: the MCP servers of `<config>/mcp.json` and of the project's `.aparte/mcp.json` (read only when the
//! project is trusted).
//!
//! - `add <name> <command> [args...]` or `add <name> <url>`: adds a stdio or Streamable HTTP server.
//! - `list`: the configured servers (offline).
//! - `remove <name>`: removes one, with its pinned tools and OAuth tokens.
//! - `tools [name] [--approve]`: starts the servers, lists their tools with their approval state, and with
//!   `--approve` approves the current definitions (after a server changed a tool).
//! - `login <name>` / `logout <name>`: OAuth for an HTTP server (browser, loopback redirect), tokens kept encrypted
//!   under a key in the OS keychain.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, bail};
use aparte_mcp::auth::{Login, SecretVault, TokenStore};
use aparte_mcp::client::check_pins;
use aparte_mcp::config::{self, ConfigFile, ServerConfig, Source, Transport};
use aparte_mcp::{PinStatus, PinStore};
use serde_json::{Value, json};

use crate::{Ctx, exit, keychain, paths, setup};

/// Arguments of `aparte mcp`.
#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    pub action: Action,
}

/// What to do with MCP servers.
#[derive(Debug, clap::Subcommand)]
pub enum Action {
    /// Add a server: `aparte mcp add files -- npx -y @modelcontextprotocol/server-filesystem .`, or a URL
    Add(AddArgs),
    /// List the configured servers
    List,
    /// Remove a server, its pinned tools and its tokens
    Remove {
        name: String,
        /// Remove it from the project's .aparte/mcp.json
        #[arg(long)]
        project: bool,
    },
    /// Start the servers and list their tools; --approve accepts changed definitions
    Tools {
        /// Only this server
        name: Option<String>,
        /// Approve the tools as they are now
        #[arg(long)]
        approve: bool,
    },
    /// Sign in to an HTTP server with OAuth
    Login {
        name: String,
        /// Print the address to open instead of starting the browser
        #[arg(long)]
        no_browser: bool,
    },
    /// Forget the OAuth tokens of a server
    Logout { name: String },
}

/// Arguments of `aparte mcp add`.
#[derive(Debug, clap::Args)]
pub struct AddArgs {
    /// The server's name (letters, digits, `-` and `_`)
    name: String,
    /// The command and its arguments (stdio), or the server's URL (Streamable HTTP)
    #[arg(
        required = true,
        trailing_var_arg = true,
        allow_hyphen_values = true,
        value_name = "COMMAND|URL"
    )]
    target: Vec<String>,
    /// An environment variable of a stdio server, KEY=VALUE (repeatable; VALUE may be ${VAR})
    #[arg(short, long = "env", value_name = "KEY=VALUE")]
    env: Vec<String>,
    /// A header of an HTTP server, "Name: value" (repeatable; the value may be ${VAR})
    #[arg(short = 'H', long = "header", value_name = "HEADER")]
    header: Vec<String>,
    /// A preset OAuth client id of an HTTP server
    #[arg(long, value_name = "ID")]
    client_id: Option<String>,
    /// OAuth scopes to ask for, comma-separated
    #[arg(long, value_delimiter = ',', value_name = "LIST")]
    scopes: Vec<String>,
    /// Write to the project's .aparte/mcp.json instead of the user file
    #[arg(long)]
    project: bool,
    /// Replace a server of the same name
    #[arg(long)]
    force: bool,
}

fn config_dir(ctx: &Ctx) -> anyhow::Result<PathBuf> {
    paths::config_dir(ctx.global.config_dir.as_ref()).context("no configuration directory: set HOME or --config-dir")
}

fn vault() -> Option<Arc<dyn SecretVault>> {
    keychain::KeychainVault::available().map(|v| Arc::new(v) as Arc<dyn SecretVault>)
}

fn looks_secret(key: &str, value: &str) -> bool {
    let k = key.to_ascii_uppercase();
    !value.contains("${")
        && ["KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH"]
            .iter()
            .any(|w| k.contains(w))
}

fn describe(s: &ServerConfig) -> (String, String) {
    match &s.transport {
        Transport::Stdio { command, args, .. } => (
            "stdio".into(),
            format!("{command} {}", args.join(" ")).trim().to_owned(),
        ),
        Transport::Http { url, .. } => ("http".into(), url.clone()),
    }
}

/// The servers `mcp tools` and `login` act on (the same as the agent's).
fn servers(ctx: &Ctx) -> anyhow::Result<(Vec<ServerConfig>, bool)> {
    let cwd = setup::cwd()?;
    let trusted = setup::trusted(ctx, &cwd)?;
    let dir = paths::config_dir(ctx.global.config_dir.as_ref());
    let (servers, errors) = config::load(dir.as_deref(), &cwd, trusted);
    for e in errors {
        eprintln!("aparte: MCP configuration: {e}");
    }
    Ok((servers, trusted))
}

fn find(ctx: &Ctx, name: &str) -> anyhow::Result<ServerConfig> {
    let (servers, trusted) = servers(ctx)?;
    if let Some(s) = servers.into_iter().find(|s| s.name == name) {
        return Ok(s);
    }
    let project = config::project_file(&setup::cwd()?);
    let in_project = ConfigFile::load(&project, Source::Project).is_ok_and(|f| f.contains(name));
    if in_project && !trusted {
        bail!(
            "{name} is configured in {} but the project is not trusted (`aparte trust`)",
            project.display()
        );
    }
    bail!("no MCP server named {name:?}; `aparte mcp list` lists them")
}

/// Runs an MCP action.
pub fn run(args: Args, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    match args.action {
        Action::Add(a) => add(ctx, a),
        Action::List => list(ctx),
        Action::Remove { name, project } => remove(ctx, &name, project),
        Action::Tools { name, approve } => tools(ctx, name.as_deref(), approve),
        Action::Login { name, no_browser } => login(ctx, &name, no_browser),
        Action::Logout { name } => {
            let dir = config_dir(ctx)?;
            let vault = vault().context("the OS keychain is turned off (APARTE_NO_KEYCHAIN)")?;
            let removed = TokenStore::new(&dir, &name, vault).remove()?;
            ctx.ui.emit("mcp-logout", json!({"name": name, "removed": removed}));
            ctx.ui.say(&if removed {
                format!("forgot the tokens of {name}")
            } else {
                format!("{name} had no stored tokens")
            });
            Ok(ExitCode::from(exit::OK))
        }
    }
}

fn add(ctx: &Ctx, a: AddArgs) -> anyhow::Result<ExitCode> {
    let AddArgs {
        name,
        target,
        env,
        header,
        client_id,
        scopes,
        project,
        force,
    } = a;
    let name = name.as_str();
    let cwd = setup::cwd()?;
    let path = if project {
        config::project_file(&cwd)
    } else {
        config::user_file(&config_dir(ctx)?)
    };
    let source = if project { Source::Project } else { Source::User };
    let mut file = ConfigFile::load(&path, source)?;
    if file.contains(name) && !force {
        bail!("{name} is already in {}; pass --force to replace it", path.display());
    }
    let first = target.first().context("a command or a URL is needed")?;
    let is_url = first.starts_with("https://") || first.starts_with("http://");
    let mut warnings = Vec::new();
    let entry = if is_url {
        if target.len() > 1 {
            bail!("an HTTP server takes only its URL");
        }
        if !env.is_empty() {
            bail!("--env is for stdio servers; an HTTP server takes --header");
        }
        aparte_mcp::client::check_url(first).map_err(anyhow::Error::msg)?;
        let mut headers = serde_json::Map::new();
        for h in header {
            let (k, v) = h
                .split_once(':')
                .with_context(|| format!("{h:?} is not \"Name: value\""))?;
            let (k, v) = (k.trim(), v.trim());
            if looks_secret(k, v) || k.eq_ignore_ascii_case("authorization") && !v.contains("${") {
                warnings.push(format!(
                    "the header {k} is stored as written in {}; ${{VAR}} keeps it in the environment",
                    path.display()
                ));
            }
            headers.insert(k.to_owned(), json!(v));
        }
        let mut e = json!({"type": "http", "url": first});
        if !headers.is_empty() {
            e["headers"] = Value::Object(headers);
        }
        if client_id.is_some() || !scopes.is_empty() {
            let mut o = json!({});
            if let Some(id) = &client_id {
                o["clientId"] = json!(id);
            }
            if !scopes.is_empty() {
                o["scopes"] = json!(scopes);
            }
            e["oauth"] = o;
        }
        e
    } else {
        if !header.is_empty() || client_id.is_some() || !scopes.is_empty() {
            bail!("--header, --client-id and --scopes are for HTTP servers");
        }
        let mut vars = serde_json::Map::new();
        for kv in env {
            let (k, v) = kv.split_once('=').with_context(|| format!("{kv:?} is not KEY=VALUE"))?;
            if looks_secret(k, v) {
                warnings.push(format!(
                    "{k} is stored as written in {}; ${{VAR}} keeps it in the environment",
                    path.display()
                ));
            }
            vars.insert(k.to_owned(), json!(v));
        }
        let mut e = json!({"command": first, "args": target[1..]});
        if !vars.is_empty() {
            e["env"] = Value::Object(vars);
        }
        e
    };
    file.upsert(name, entry.clone())?;
    file.save()?;
    ctx.ui.emit(
        "mcp-server",
        json!({"name": name, "file": path.display().to_string(), "added": true, "entry": entry}),
    );
    ctx.ui.say(&format!("added {name} to {}", path.display()));
    for w in warnings {
        eprintln!("aparte: note: {w}");
    }
    if project && !setup::trusted(ctx, &cwd)? {
        eprintln!("aparte: note: project servers start only in a trusted project (`aparte trust`)");
    }
    Ok(ExitCode::from(exit::OK))
}

fn list(ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let cwd = setup::cwd()?;
    let trusted = setup::trusted(ctx, &cwd)?;
    let dir = paths::config_dir(ctx.global.config_dir.as_ref());
    let mut rows: Vec<(ServerConfig, bool)> = Vec::new();
    if let Some(d) = &dir {
        for s in ConfigFile::load(&config::user_file(d), Source::User)?.servers()? {
            rows.push((s, true));
        }
    }
    let project = config::project_file(&cwd);
    if project.is_file() {
        for s in ConfigFile::load(&project, Source::Project)?.servers()? {
            rows.retain(|(r, _)| !(trusted && r.name == s.name));
            rows.push((s, trusted));
        }
    }
    if rows.is_empty() && !ctx.ui.is_json() {
        ctx.ui
            .say("no MCP servers; add one with `aparte mcp add <name> <command|url>`");
    }
    let vault = vault();
    for (s, loaded) in rows {
        let (kind, target) = describe(&s);
        let logged_in = match (&dir, &vault, kind.as_str()) {
            (Some(d), Some(v), "http") => Some(TokenStore::new(d, &s.name, v.clone()).exists()),
            _ => None,
        };
        ctx.ui.emit(
            "mcp-server",
            json!({
                "name": s.name, "source": s.source, "transport": kind, "target": target,
                "disabled": s.disabled, "loaded": loaded, "loggedIn": logged_in,
                "file": s.file.display().to_string(),
            }),
        );
        if !ctx.ui.is_json() {
            let mut notes = Vec::new();
            if s.disabled {
                notes.push("disabled".to_owned());
            }
            if !loaded {
                notes.push("not loaded: untrusted project".to_owned());
            }
            if logged_in == Some(true) {
                notes.push("signed in".to_owned());
            }
            let notes = if notes.is_empty() {
                String::new()
            } else {
                format!("  ({})", notes.join(", "))
            };
            ctx.ui.say(&format!(
                "{:<20} {:<7} {:<5} {target}{notes}",
                s.name,
                s.source.name(),
                kind
            ));
        }
    }
    Ok(ExitCode::from(exit::OK))
}

fn remove(ctx: &Ctx, name: &str, project: bool) -> anyhow::Result<ExitCode> {
    let cwd = setup::cwd()?;
    let dir = config_dir(ctx)?;
    let path = if project {
        config::project_file(&cwd)
    } else {
        config::user_file(&dir)
    };
    let source = if project { Source::Project } else { Source::User };
    let mut file = ConfigFile::load(&path, source)?;
    if !file.remove(name) {
        bail!("no MCP server named {name:?} in {}", path.display());
    }
    file.save()?;
    let mut pins = PinStore::load(&dir)?;
    if pins.forget(name) {
        pins.save()?;
    }
    let tokens = match vault() {
        Some(v) => TokenStore::new(&dir, name, v).remove().unwrap_or(false),
        None => false,
    };
    ctx.ui.emit(
        "mcp-server",
        json!({"name": name, "file": path.display().to_string(), "removed": true, "tokensRemoved": tokens}),
    );
    ctx.ui.say(&format!("removed {name} from {}", path.display()));
    Ok(ExitCode::from(exit::OK))
}

fn short(s: &str, n: usize) -> String {
    let first = s.lines().next().unwrap_or_default();
    if first.chars().count() > n {
        format!("{}…", first.chars().take(n).collect::<String>())
    } else {
        first.to_owned()
    }
}

fn tools(ctx: &Ctx, only: Option<&str>, approve: bool) -> anyhow::Result<ExitCode> {
    let selected: Vec<ServerConfig> = match only {
        Some(n) => vec![find(ctx, n)?],
        None => servers(ctx)?.0.into_iter().filter(|s| !s.disabled).collect(),
    };
    if selected.is_empty() {
        ctx.ui
            .say("no MCP servers; add one with `aparte mcp add <name> <command|url>`");
        return Ok(ExitCode::from(exit::OK));
    }
    let cwd = setup::cwd()?;
    let opts = setup::mcp_options(ctx, &cwd);
    let dir = paths::config_dir(ctx.global.config_dir.as_ref());
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let mut failed = false;
    rt.block_on(async {
        let mut pins = match &dir {
            Some(d) => PinStore::load(d)?,
            None => PinStore::in_memory(),
        };
        let mut changed_pins = false;
        for server in &selected {
            let conn = match aparte_mcp::connect(server, &opts).await {
                Ok(c) => c,
                Err(e) => {
                    failed = true;
                    ctx.ui
                        .emit("mcp-server", json!({"name": server.name, "error": e.to_string()}));
                    eprintln!("aparte: {e}");
                    continue;
                }
            };
            let first_use = !pins.knows(&server.name);
            let checked = check_pins(&mut pins, &server.name, &conn.tools);
            changed_pins |= first_use;
            let mut approved: BTreeMap<String, String> = BTreeMap::new();
            if !ctx.ui.is_json() {
                ctx.ui.say(&format!(
                    "{}{}",
                    server.name,
                    conn.server_info
                        .as_deref()
                        .map(|i| format!(" ({i})"))
                        .unwrap_or_default()
                ));
            }
            for (def, (tool, fp, status)) in conn.tools.iter().zip(&checked) {
                let a = aparte_mcp::client::annotations(def);
                let asks = aparte_agent::approval::needs_approval(a, false);
                let shown_status = if approve { PinStatus::Pinned } else { *status };
                approved.insert(tool.clone(), fp.clone());
                let description = def.get("description").and_then(Value::as_str).unwrap_or_default();
                ctx.ui.emit(
                    "mcp-tool",
                    json!({
                        "server": server.name,
                        "name": tool,
                        "exposedAs": aparte_mcp::client::exposed_name(&server.name, tool),
                        "description": description,
                        "fingerprint": fp,
                        "status": shown_status,
                        "previous": status,
                        "annotations": a,
                        "asks": asks,
                    }),
                );
                if !ctx.ui.is_json() {
                    let state = match (approve, status) {
                        (true, PinStatus::Pinned) | (false, PinStatus::Pinned) => "approved".to_owned(),
                        (true, s) => format!("approved now (was {})", s.name()),
                        (false, s) => format!("held back: {}", s.name()),
                    };
                    let kind = if a.read_only && !a.open_world {
                        "read-only"
                    } else if a.destructive {
                        "asks: destructive"
                    } else {
                        "asks"
                    };
                    ctx.ui.say(&format!(
                        "  {:<28} {:<26} {:<18} {}",
                        tool,
                        state,
                        kind,
                        aparte_tui::markdown::sanitize(&short(description, 60))
                    ));
                }
            }
            let held = checked.iter().filter(|(_, _, s)| !s.allowed()).count();
            if approve {
                pins.approve(&server.name, approved);
                changed_pins = true;
            } else if held > 0 && !ctx.ui.is_json() {
                ctx.ui.say(&format!(
                    "  {held} tool(s) held back; review them, then `aparte mcp tools {} --approve`",
                    server.name
                ));
            }
            conn.shutdown().await;
        }
        if changed_pins {
            pins.save()?;
        }
        anyhow::Ok(())
    })?;
    Ok(ExitCode::from(if failed { exit::NETWORK } else { exit::OK }))
}

fn open_browser(url: &str) -> bool {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return false;
    }
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
}

fn login(ctx: &Ctx, name: &str, no_browser: bool) -> anyhow::Result<ExitCode> {
    let server = find(ctx, name)?;
    let Transport::Http { url, oauth, .. } = &server.transport else {
        bail!("{name} is a stdio server: OAuth is for HTTP servers");
    };
    let url = config::expand_env(url).map_err(anyhow::Error::msg)?;
    aparte_mcp::client::check_url(&url).map_err(anyhow::Error::msg)?;
    let dir = config_dir(ctx)?;
    let vault = vault().context("the OS keychain is turned off (APARTE_NO_KEYCHAIN): tokens could not be kept")?;
    let store = TokenStore::new(&dir, name, vault);
    let oauth = oauth.clone().unwrap_or_default();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    rt.block_on(async {
        let open = move |auth_url: &str| {
            eprintln!("Open this address to sign in to {name}:\n  {auth_url}");
            if !no_browser && open_browser(auth_url) {
                eprintln!("(the browser was started; waiting for it to come back)");
            }
        };
        aparte_mcp::auth::login(
            &url,
            store,
            aparte_mcp::client::http_client()?,
            Login {
                client_id: oauth.client_id.clone(),
                scopes: oauth.scopes.clone(),
                open: &open,
                timeout: aparte_mcp::auth::LOGIN_TIMEOUT,
            },
        )
        .await?;
        anyhow::Ok(())
    })?;
    ctx.ui.emit("mcp-login", json!({"name": name, "ok": true}));
    ctx.ui.say(&format!(
        "signed in to {name}; the tokens are kept encrypted, their key in the OS keychain"
    ));
    Ok(ExitCode::from(exit::OK))
}
