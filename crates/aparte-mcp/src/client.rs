//! Connections to MCP servers, and their tools as agent tools.
//!
//! - stdio: the server runs as a child process in its own process group, with an environment rebuilt from an
//!   allowlist plus the entry's `env` (the CLI's own keys never reach it). Its stderr goes to the debug log. On
//!   shutdown its stdin is closed, then the whole group is killed, so the helpers it started go too; a connection
//!   dropped without a shutdown kills the group as well.
//! - Streamable HTTP: https, or http on the loopback only, over the workspace's rustls client, without redirects.
//!   Stored OAuth tokens are attached and refreshed; a server that asks for authorization without them is reported
//!   as needing `aparte mcp login`.
//!
//! Each tool is offered to the model as `mcp__<server>__<tool>`. Its MCP annotations drive approvals: only a tool
//! that declares itself read-only and closed-world (`readOnlyHint: true`, `openWorldHint: false`) runs without
//! asking; the MCP defaults (destructive, open world) apply to every hint left out.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use aparte_agent::{Annotations, BoxFuture, Tool, ToolContext, ToolError, ToolOutput};
use rmcp::ServiceExt;
use rmcp::model::{CallToolRequestParams, CallToolResponse, ClientCapabilities, ClientConfig, Implementation};
use rmcp::service::{Peer, RoleClient, RunningService};
use rmcp::transport::auth::AuthClient;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncBufReadExt;

use crate::McpError;
use crate::auth::{SecretVault, TokenStore, authorized_manager};
use crate::config::{ServerConfig, Transport, expand_env};
use crate::pins::{PinStatus, PinStore, fingerprint};

/// Environment variables a stdio server inherits; everything else comes from its `env`.
pub const ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TERM",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "SYSTEMROOT",
    "SystemRoot",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "PATHEXT",
    "ComSpec",
];

/// Largest tool result kept; the agent cuts further for the model.
const MAX_RESULT: usize = 256 * 1024;

/// How servers are reached.
#[derive(Clone)]
pub struct ConnectOptions {
    /// Where OAuth tokens are kept (`<config>/mcp-auth`); `None` uses no stored tokens.
    pub config_dir: Option<PathBuf>,
    /// Holds the token keys; `None` uses no stored tokens.
    pub vault: Option<Arc<dyn SecretVault>>,
    /// The working directory of stdio servers without a `cwd`.
    pub cwd: PathBuf,
    /// How long a server has to start and list its tools.
    pub connect_timeout: Duration,
    /// How long a tool call may take.
    pub call_timeout: Duration,
}

impl ConnectOptions {
    /// Options for servers started in `cwd`, without stored tokens.
    pub fn new(cwd: impl Into<PathBuf>) -> ConnectOptions {
        ConnectOptions {
            config_dir: None,
            vault: None,
            cwd: cwd.into(),
            connect_timeout: Duration::from_secs(30),
            call_timeout: Duration::from_secs(300),
        }
    }

    fn token_store(&self, server: &str) -> Option<TokenStore> {
        Some(TokenStore::new(self.config_dir.as_ref()?, server, self.vault.clone()?))
    }
}

/// The HTTP client of MCP servers: rustls over ring, no redirects, bounded connects.
pub fn http_client() -> Result<reqwest::Client, McpError> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .user_agent(concat!("aparte/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            McpError::Config(crate::config::ConfigError::Invalid(format!(
                "cannot build the HTTP client: {e}"
            )))
        })
}

/// Refuses a URL that is neither https nor http on the loopback.
pub fn check_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    if let Some(rest) = lower.strip_prefix("http://") {
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
        let host = if host.starts_with('[') {
            host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default()
        } else {
            host.split(':').next().unwrap_or_default().to_owned()
        };
        let v4_loopback = host.parse::<std::net::Ipv4Addr>().is_ok_and(|a| a.is_loopback());
        if matches!(host.as_str(), "localhost" | "[::1]") || v4_loopback {
            return Ok(());
        }
    }
    Err(format!("{url} is neither https nor http on the loopback"))
}

fn client_info() -> ClientConfig {
    ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("aparte", env!("CARGO_PKG_VERSION")),
    )
}

type Service = RunningService<RoleClient, ClientConfig>;

/// A live connection to one server.
pub struct Connection {
    pub name: String,
    service: Option<Service>,
    /// The tools as the server listed them (MCP JSON).
    pub tools: Vec<Value>,
    /// The server's name and version, if it said.
    pub server_info: Option<String>,
    /// The process group of a stdio server.
    pgid: Option<u32>,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection")
            .field("name", &self.name)
            .field("tools", &self.tools.len())
            .field("pgid", &self.pgid)
            .finish_non_exhaustive()
    }
}

/// Kills a process group; quiet when it is already gone.
pub fn kill_group(pgid: u32) {
    if cfg!(unix) && pgid > 1 {
        let _ = std::process::Command::new("kill")
            .arg("-KILL")
            .arg(format!("-{pgid}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

impl Connection {
    /// The peer, for calls.
    pub fn peer(&self) -> Option<Peer<RoleClient>> {
        self.service.as_ref().map(|s| s.peer().clone())
    }

    /// Closes the connection: the server's stdin is closed (or its HTTP session ended), then its process group is
    /// killed.
    pub async fn shutdown(mut self) {
        if let Some(service) = self.service.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), service.cancel()).await;
        }
        if let Some(pgid) = self.pgid.take() {
            kill_group(pgid);
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(pgid) = self.pgid.take() {
            kill_group(pgid);
        }
    }
}

fn server_err(server: &str, message: impl std::fmt::Display) -> McpError {
    McpError::Server {
        server: server.to_owned(),
        message: message.to_string(),
    }
}

fn is_auth_required(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("auth required") || m.contains("authorization required") || m.contains("401")
}

/// Connects to a server and lists its tools.
pub async fn connect(server: &ServerConfig, opts: &ConnectOptions) -> Result<Connection, McpError> {
    let name = server.name.as_str();
    let fail = |m: String| server_err(name, m);
    let (service, pgid) = match &server.transport {
        Transport::Stdio {
            command,
            args,
            env,
            cwd,
        } => {
            let command = expand_env(command).map_err(fail)?;
            let args: Vec<String> = args
                .iter()
                .map(|a| expand_env(a))
                .collect::<Result<_, _>>()
                .map_err(fail)?;
            let mut cmd = tokio::process::Command::new(&command);
            cmd.args(&args).env_clear();
            for key in ENV_ALLOWLIST {
                if let Some(v) = std::env::var_os(key) {
                    cmd.env(key, v);
                }
            }
            for (k, v) in env {
                cmd.env(k, expand_env(v).map_err(fail)?);
            }
            cmd.current_dir(cwd.clone().unwrap_or_else(|| opts.cwd.clone()));
            let mut wrap = process_wrap::tokio::CommandWrap::from(cmd);
            #[cfg(unix)]
            wrap.wrap(process_wrap::tokio::ProcessGroup::leader());
            wrap.wrap(process_wrap::tokio::KillOnDrop);
            let (transport, stderr) = TokioChildProcess::builder(wrap)
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| fail(format!("cannot start {command:?}: {e}")))?;
            let pgid = if cfg!(unix) { transport.id() } else { None };
            if let Some(stderr) = stderr {
                let label = name.to_owned();
                tokio::spawn(async move {
                    let mut lines = tokio::io::BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        tracing::debug!(server = %label, "stderr: {}", line.chars().take(2000).collect::<String>());
                    }
                });
            }
            let started = tokio::time::timeout(opts.connect_timeout, client_info().serve(transport)).await;
            let service = match started {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => {
                    if let Some(p) = pgid {
                        kill_group(p);
                    }
                    return Err(fail(format!("the server did not start: {e}")));
                }
                Err(_) => {
                    if let Some(p) = pgid {
                        kill_group(p);
                    }
                    return Err(fail(format!("no answer within {}s", opts.connect_timeout.as_secs())));
                }
            };
            (service, pgid)
        }
        Transport::Http { url, headers, .. } => {
            let url = expand_env(url).map_err(fail)?;
            check_url(&url).map_err(fail)?;
            let mut custom = std::collections::HashMap::new();
            let mut bearer = None;
            for (k, v) in headers {
                let v = expand_env(v).map_err(fail)?;
                if k.eq_ignore_ascii_case("authorization") {
                    bearer = Some(v.strip_prefix("Bearer ").unwrap_or(&v).to_owned());
                    continue;
                }
                let hn = reqwest::header::HeaderName::from_bytes(k.as_bytes())
                    .map_err(|_| fail(format!("{k:?} is not a valid header name")))?;
                let mut hv = reqwest::header::HeaderValue::from_str(&v)
                    .map_err(|_| fail(format!("the value of the header {k} is not valid")))?;
                hv.set_sensitive(true);
                custom.insert(hn, hv);
            }
            let mut config = StreamableHttpClientTransportConfig::with_uri(url.clone()).custom_headers(custom);
            if let Some(b) = bearer {
                config = config.auth_header(b);
            }
            let http = http_client()?;
            let manager = match opts.token_store(name) {
                Some(store) => authorized_manager(&url, store, http.clone()).await?,
                None => None,
            };
            let started = match manager {
                Some(m) => {
                    let transport = StreamableHttpClientTransport::with_client(AuthClient::new(http, m), config);
                    tokio::time::timeout(opts.connect_timeout, client_info().serve(transport)).await
                }
                None => {
                    let transport = StreamableHttpClientTransport::with_client(http, config);
                    tokio::time::timeout(opts.connect_timeout, client_info().serve(transport)).await
                }
            };
            match started {
                Ok(Ok(s)) => (s, None),
                Ok(Err(e)) => {
                    let msg = format!("{e:#}");
                    let chain = error_chain(&e);
                    if is_auth_required(&msg) || is_auth_required(&chain) {
                        return Err(McpError::NeedsLogin {
                            server: name.to_owned(),
                        });
                    }
                    return Err(fail(format!("cannot connect: {chain}")));
                }
                Err(_) => return Err(fail(format!("no answer within {}s", opts.connect_timeout.as_secs()))),
            }
        }
    };
    let mut conn = Connection {
        name: name.to_owned(),
        server_info: service
            .peer_info()
            .and_then(|i| i.server_info.as_ref().map(|s| format!("{} {}", s.name, s.version))),
        service: Some(service),
        tools: Vec::new(),
        pgid,
    };
    let peer = conn.peer().ok_or_else(|| fail("the connection closed".into()))?;
    let listed = tokio::time::timeout(opts.connect_timeout, peer.list_all_tools()).await;
    let tools = match listed {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => {
            conn.shutdown().await;
            return Err(fail(format!("cannot list the tools: {e}")));
        }
        Err(_) => {
            conn.shutdown().await;
            return Err(fail("the tool list timed out".into()));
        }
    };
    conn.tools = tools.iter().filter_map(|t| serde_json::to_value(t).ok()).collect();
    Ok(conn)
}

fn error_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(c) = cur {
        s.push_str(": ");
        s.push_str(&c.to_string());
        cur = c.source();
    }
    s
}

fn sanitize(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// The name a server's tool is offered under: `mcp__<server>__<tool>`, `[a-z0-9_]`, at most 64 characters (a hash
/// suffix keeps long names distinct).
pub fn exposed_name(server: &str, tool: &str) -> String {
    let full = format!("mcp__{}__{}", sanitize(server), sanitize(tool));
    if full.len() <= 64 {
        return full;
    }
    let digest = Sha256::digest(format!("{server}\0{tool}").as_bytes());
    let suffix: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{}_{suffix}", &full[..55])
}

/// The approval annotations of an MCP tool, from its hints and the MCP defaults.
pub fn annotations(tool: &Value) -> Annotations {
    let a = tool.get("annotations");
    let hint = |k: &str| a.and_then(|a| a.get(k)).and_then(Value::as_bool);
    let read_only = hint("readOnlyHint").unwrap_or(false);
    Annotations {
        read_only,
        destructive: !read_only && hint("destructiveHint").unwrap_or(true),
        idempotent: read_only || hint("idempotentHint").unwrap_or(false),
        open_world: hint("openWorldHint").unwrap_or(true),
    }
}

/// An MCP tool as an agent tool.
pub struct McpTool {
    exposed: String,
    server: String,
    tool: String,
    description: String,
    schema: Value,
    annotations: Annotations,
    peer: Peer<RoleClient>,
    timeout: Duration,
}

impl McpTool {
    /// The tool `def` (MCP JSON) of `server`, called through `peer`.
    pub fn new(server: &str, def: &Value, exposed: String, peer: Peer<RoleClient>, timeout: Duration) -> McpTool {
        let tool = def.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
        let title = def
            .get("title")
            .or_else(|| def.get("annotations").and_then(|a| a.get("title")))
            .and_then(Value::as_str);
        let text = def.get("description").and_then(Value::as_str).unwrap_or_default();
        let mut description = format!("[MCP server {server}, tool {tool}]");
        if let Some(t) = title {
            description.push(' ');
            description.push_str(t);
            description.push('.');
        }
        if !text.trim().is_empty() {
            description.push(' ');
            description.push_str(text.trim());
        }
        let mut schema = def
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({"type": "object"}));
        if let Some(obj) = schema.as_object_mut() {
            obj.remove("$schema");
            obj.entry("type").or_insert_with(|| json!("object"));
        }
        McpTool {
            exposed,
            server: server.to_owned(),
            tool,
            description,
            schema,
            annotations: annotations(def),
            peer,
            timeout,
        }
    }
}

/// The text of a `tools/call` result for the model.
pub fn result_text(result: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    for c in result.get("content").and_then(Value::as_array).into_iter().flatten() {
        let kind = c.get("type").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "text" => parts.push(c.get("text").and_then(Value::as_str).unwrap_or_default().to_owned()),
            "image" | "audio" => {
                let mime = c.get("mimeType").and_then(Value::as_str).unwrap_or("unknown type");
                let len = c.get("data").and_then(Value::as_str).map_or(0, |d| d.len() * 3 / 4);
                parts.push(format!("[{kind} {mime}, about {len} bytes, not shown]"));
            }
            "resource" => {
                let r = c.get("resource");
                let uri = r.and_then(|r| r.get("uri")).and_then(Value::as_str).unwrap_or_default();
                match r.and_then(|r| r.get("text")).and_then(Value::as_str) {
                    Some(t) => parts.push(format!("[resource {uri}]\n{t}")),
                    None => parts.push(format!("[binary resource {uri}, not shown]")),
                }
            }
            "resource_link" => {
                let uri = c.get("uri").and_then(Value::as_str).unwrap_or_default();
                let name = c.get("name").and_then(Value::as_str).unwrap_or_default();
                parts.push(format!("[resource link {uri}] {name}"));
            }
            other => parts.push(format!("[{other} content, not shown]")),
        }
    }
    if parts.is_empty()
        && let Some(s) = result.get("structuredContent").filter(|s| !s.is_null())
    {
        parts.push(serde_json::to_string_pretty(s).unwrap_or_default());
    }
    let mut text = parts.join("\n");
    if text.len() > MAX_RESULT {
        let mut at = MAX_RESULT;
        while !text.is_char_boundary(at) {
            at -= 1;
        }
        text.truncate(at);
        text.push_str("\n[output truncated]");
    }
    if text.is_empty() {
        text.push_str("(no output)");
    }
    text
}

impl Tool for McpTool {
    fn name(&self) -> &str {
        &self.exposed
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn input_schema(&self) -> Value {
        self.schema.clone()
    }
    fn annotations(&self) -> Annotations {
        self.annotations
    }
    fn execute<'a>(&'a self, ctx: &'a ToolContext, input: Value) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            let args = match input {
                Value::Object(m) => m,
                Value::Null => serde_json::Map::new(),
                _ => return Err(ToolError::InvalidInput("the input must be a JSON object".into())),
            };
            let params = CallToolRequestParams::new(self.tool.clone()).with_arguments(args);
            let call = self.peer.call_tool_once(params);
            let response = tokio::select! {
                r = tokio::time::timeout(self.timeout, call) => r,
                () = ctx.cancel.cancelled() => return Err(ToolError::Cancelled),
            };
            let response = response
                .map_err(|_| {
                    ToolError::Failed(format!(
                        "{} did not answer within {}s",
                        self.server,
                        self.timeout.as_secs()
                    ))
                })?
                .map_err(|e| ToolError::Failed(format!("{}: {e}", self.server)))?;
            let result = match response {
                CallToolResponse::Complete(r) => r,
                CallToolResponse::InputRequired(_) => {
                    return Err(ToolError::Failed(format!(
                        "{} asked for more input during the call, which aparte does not support",
                        self.server
                    )));
                }
                _ => {
                    return Err(ToolError::Failed(format!(
                        "{} answered with a background task, which aparte does not support",
                        self.server
                    )));
                }
            };
            let v = serde_json::to_value(&result).unwrap_or(Value::Null);
            let is_error = v.get("isError").and_then(Value::as_bool).unwrap_or(false);
            Ok(ToolOutput {
                content: result_text(&v),
                details: Some(json!({
                    "server": self.server,
                    "tool": self.tool,
                    "structured": v.get("structuredContent"),
                })),
                is_error,
            })
        })
    }
}

/// What became of a server at startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ServerState {
    Connected {
        /// Tools offered to the model.
        tools: Vec<String>,
        /// Tools held back until approved again, with why.
        blocked: Vec<(String, PinStatus)>,
        server_info: Option<String>,
    },
    /// An HTTP server that wants an OAuth login first.
    NeedsLogin,
    Disabled,
    Failed {
        error: String,
    },
}

/// A server and its state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServerStatus {
    pub name: String,
    #[serde(flatten)]
    pub state: ServerState,
}

/// Compares a server's tools with their pins. A server never approved is approved as it is now (first use); the
/// result says, for each tool, its fingerprint and status.
pub fn check_pins(pins: &mut PinStore, server: &str, tools: &[Value]) -> Vec<(String, String, PinStatus)> {
    let listed: Vec<(String, String)> = tools
        .iter()
        .map(|t| {
            (
                t.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                fingerprint(t),
            )
        })
        .collect();
    if !pins.knows(server) {
        pins.approve(server, listed.iter().cloned());
    }
    listed
        .into_iter()
        .map(|(n, f)| {
            let s = pins.status(server, &n, &f);
            (n, f, s)
        })
        .collect()
}

/// The running servers of a session and their tools.
#[derive(Default)]
pub struct McpManager {
    conns: Vec<Connection>,
    statuses: Vec<ServerStatus>,
    tools: Vec<Arc<dyn Tool>>,
}

impl std::fmt::Debug for McpManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpManager")
            .field("servers", &self.statuses)
            .finish_non_exhaustive()
    }
}

impl McpManager {
    /// Starts every enabled server at once, checks its tools against `pins` (saving the pins of servers seen for
    /// the first time), and keeps the tools that may be offered. A server that fails is reported, not fatal.
    pub async fn start(servers: &[ServerConfig], opts: &ConnectOptions, pins: &mut PinStore) -> McpManager {
        let futures = servers.iter().map(|s| async move {
            if s.disabled {
                return (s, Err(None));
            }
            (s, connect(s, opts).await.map_err(Some))
        });
        let results = futures_util::future::join_all(futures).await;
        let mut m = McpManager::default();
        let mut used: HashSet<String> = HashSet::new();
        let mut first_seen = false;
        for (server, result) in results {
            let state = match result {
                Err(None) => ServerState::Disabled,
                Err(Some(McpError::NeedsLogin { .. })) => ServerState::NeedsLogin,
                Err(Some(e)) => ServerState::Failed { error: e.to_string() },
                Ok(conn) => {
                    first_seen |= !pins.knows(&server.name);
                    let checked = check_pins(pins, &server.name, &conn.tools);
                    let peer = conn.peer();
                    let mut offered = Vec::new();
                    let mut blocked = Vec::new();
                    for (def, (tool, _, status)) in conn.tools.iter().zip(checked) {
                        if !status.allowed() {
                            tracing::warn!(server = %server.name, %tool, status = status.name(), "MCP tool held back");
                            blocked.push((tool, status));
                            continue;
                        }
                        let mut exposed = exposed_name(&server.name, &tool);
                        if !used.insert(exposed.clone()) {
                            let digest = Sha256::digest(format!("{}\0{tool}\0dup", server.name).as_bytes());
                            let suffix: String = digest.iter().take(3).map(|b| format!("{b:02x}")).collect();
                            exposed = format!("{}_{suffix}", &exposed[..exposed.len().min(57)]);
                            used.insert(exposed.clone());
                        }
                        if let Some(p) = &peer {
                            m.tools.push(Arc::new(McpTool::new(
                                &server.name,
                                def,
                                exposed,
                                p.clone(),
                                opts.call_timeout,
                            )));
                        }
                        offered.push(tool);
                    }
                    let server_info = conn.server_info.clone();
                    m.conns.push(conn);
                    ServerState::Connected {
                        tools: offered,
                        blocked,
                        server_info,
                    }
                }
            };
            m.statuses.push(ServerStatus {
                name: server.name.clone(),
                state,
            });
        }
        if first_seen && let Err(e) = pins.save() {
            tracing::warn!("cannot save the MCP tool pins: {e}");
        }
        m
    }

    /// The tools to give the agent.
    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.tools.clone()
    }

    /// What became of each server.
    pub fn statuses(&self) -> &[ServerStatus] {
        &self.statuses
    }

    /// One line per server, for people.
    pub fn summary(&self) -> Vec<String> {
        self.statuses
            .iter()
            .map(|s| match &s.state {
                ServerState::Connected { tools, blocked, .. } => {
                    let mut line = format!("{}: {} tools", s.name, tools.len());
                    if !blocked.is_empty() {
                        let names: Vec<String> = blocked.iter().map(|(t, st)| format!("{t} ({})", st.name())).collect();
                        line.push_str(&format!(
                            "; held back until `aparte mcp tools {} --approve`: {}",
                            s.name,
                            names.join(", ")
                        ));
                    }
                    line
                }
                ServerState::NeedsLogin => format!("{}: needs a login (`aparte mcp login {}`)", s.name, s.name),
                ServerState::Disabled => format!("{}: disabled", s.name),
                ServerState::Failed { error } => format!("{}: failed: {error}", s.name),
            })
            .collect()
    }

    /// Closes every connection (process groups killed).
    pub async fn shutdown(mut self) {
        self.tools.clear();
        let conns = std::mem::take(&mut self.conns);
        futures_util::future::join_all(conns.into_iter().map(Connection::shutdown)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe_and_short() {
        assert_eq!(exposed_name("My-Server", "get.Thing"), "mcp__my_server__get_thing");
        let long = exposed_name("server", &"t".repeat(80));
        assert!(long.len() <= 64 && long.starts_with("mcp__server__t"));
        assert_ne!(long, exposed_name("server", &"t".repeat(81)));
    }

    #[test]
    fn hints_left_out_mean_destructive_and_open_world() {
        let none = annotations(&json!({"name": "x"}));
        assert!(!none.read_only && none.destructive && none.open_world);
        assert!(aparte_agent::approval::needs_approval(none, true));
        let ro = annotations(&json!({"annotations": {"readOnlyHint": true, "openWorldHint": false}}));
        assert!(ro.read_only && !ro.destructive && !ro.open_world);
        assert!(!aparte_agent::approval::needs_approval(ro, false));
        let ro_net = annotations(&json!({"annotations": {"readOnlyHint": true}}));
        assert!(aparte_agent::approval::needs_approval(ro_net, false));
        let additive = annotations(&json!({"annotations": {"destructiveHint": false, "openWorldHint": false}}));
        assert!(!additive.destructive && aparte_agent::approval::needs_approval(additive, false));
    }

    #[test]
    fn loopback_http_only() {
        assert!(check_url("https://example.com/mcp").is_ok());
        assert!(check_url("http://127.0.0.1:8080/mcp").is_ok());
        assert!(check_url("http://localhost/mcp").is_ok());
        assert!(check_url("http://[::1]:9/mcp").is_ok());
        assert!(check_url("http://example.com/mcp").is_err());
        assert!(check_url("http://127.0.0.1.evil.com/mcp").is_err());
        assert!(check_url("http://localhost@evil.com/mcp").is_err());
        assert!(check_url("ftp://x").is_err());
    }

    #[test]
    fn results_become_text() {
        let r = json!({"content": [
            {"type": "text", "text": "hello"},
            {"type": "image", "data": "AAAA", "mimeType": "image/png"},
            {"type": "resource", "resource": {"uri": "file:///a", "text": "body"}}
        ]});
        let t = result_text(&r);
        assert!(t.starts_with("hello\n[image image/png"));
        assert!(t.ends_with("[resource file:///a]\nbody"));
        assert_eq!(
            result_text(&json!({"content": [], "structuredContent": {"a": 1}})),
            "{\n  \"a\": 1\n}"
        );
        assert_eq!(result_text(&json!({})), "(no output)");
    }
}
