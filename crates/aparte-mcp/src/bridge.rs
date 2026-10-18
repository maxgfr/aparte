//! `aparte mcp bridge`: MCP servers configured for the CLI, relayed to the web app, which cannot start a stdio
//! server or reach an HTTP server that does not answer CORS. Each bridged server gets one Streamable HTTP endpoint,
//! `/mcp/<name>`, on the guarded loopback server of [`crate::loopback`] (`spec/MCP-BRIDGE.md`).
//!
//! - stdio: `initialize` starts a new copy of the server (environment from the allowlist, its own process group,
//!   killed with its helpers when the session ends) and opens a session named by `Mcp-Session-Id`. Requests are
//!   written to its stdin and answered with the response of the same id; notifications and responses get 202.
//!   Requests the server sends itself are answered with an error (`ping` with an empty result); its notifications
//!   are dropped.
//! - HTTP: each message is posted to the configured URL with the configured headers and the stored OAuth token, the
//!   session id and protocol version passed through. A JSON answer is relayed; an SSE answer is read until the
//!   response of the request's id, which is relayed as JSON.
//! - The bridge answers in JSON only: `GET` (the server-to-client stream) is 405. Batches are refused.

use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::{Duration, Instant};

use aparte_agent::BoxFuture;
use hyper::header::HeaderValue;
use hyper::{Method, Response, StatusCode};
use process_wrap::tokio::ChildWrapper;
use rmcp::transport::auth::AuthorizationManager;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::McpError;
use crate::auth::authorized_manager;
use crate::client::{ConnectOptions, check_url, http_client, kill_group, log_stderr, stdio_command};
use crate::config::{ServerConfig, Transport, expand_env};
use crate::loopback::{
    Body, Handler, Inbound, Message, classify, empty, json_response, method_not_allowed, new_session_id, refusal,
    rpc_error,
};

/// The endpoints: `/mcp/<name>`.
pub const PREFIX: &str = "/mcp/";
/// The port listened on unless another is given (below every OS's ephemeral range).
pub const DEFAULT_PORT: u16 = 27_181;
/// Copies of one stdio server running at once; the least recently used goes first.
pub const MAX_STDIO_SESSIONS: usize = 4;
/// A stdio session unused this long is ended when another starts.
pub const SESSION_IDLE: Duration = Duration::from_secs(60 * 60);
/// Longest message read from a server (a stdio line, an HTTP body or SSE stream).
pub const MAX_MESSAGE: usize = 16 * 1024 * 1024;

/// One relayed message, as logged (never its contents beyond the method and the tool name).
#[derive(Debug, Clone)]
pub struct BridgeRecord {
    pub server: String,
    /// The JSON-RPC method, or `response` / `delete`.
    pub method: String,
    /// The tool of a `tools/call`.
    pub tool: Option<String>,
    /// The HTTP status answered.
    pub status: u16,
}

/// Where relayed messages are reported.
pub type BridgeLog = Arc<dyn Fn(&BridgeRecord) + Send + Sync>;

struct StdioSession {
    id: String,
    server: String,
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    closed: AtomicBool,
    last_used: Mutex<Instant>,
    pgid: Option<u32>,
    child: Mutex<Option<Box<dyn ChildWrapper>>>,
}

impl StdioSession {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<Value>>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap_or_else(PoisonError::into_inner) = Instant::now();
    }

    fn idle(&self) -> Duration {
        self.last_used.lock().unwrap_or_else(PoisonError::into_inner).elapsed()
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    async fn write(&self, msg: &Value) -> std::io::Result<()> {
        if self.is_closed() {
            return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the server exited"));
        }
        let mut line = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&line).await?;
        stdin.flush().await
    }

    /// Marks the session closed and fails the requests waiting for an answer.
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.pending().clear();
    }

    /// Ends the server: its process group is killed.
    fn kill(&self) {
        self.close();
        if let Some(p) = self.pgid {
            kill_group(p);
        }
        drop(self.child.lock().unwrap_or_else(PoisonError::into_inner).take());
    }

    async fn dispatch(&self, msg: Value) {
        let id = msg.get("id").filter(|i| !i.is_null()).cloned();
        let method = msg.get("method").and_then(Value::as_str).map(str::to_owned);
        match (method, id) {
            (None, Some(id)) => {
                if let Some(tx) = self.pending().remove(&id.to_string()) {
                    let _ = tx.send(msg);
                }
            }
            (Some(method), Some(id)) => {
                let reply = if method == "ping" {
                    json!({"jsonrpc": "2.0", "id": id, "result": {}})
                } else {
                    json!({"jsonrpc": "2.0", "id": id, "error": {
                        "code": -32601,
                        "message": "aparte mcp bridge does not relay requests from the server"
                    }})
                };
                tracing::debug!(server = %self.server, %method, "server request answered by the bridge");
                let _ = self.write(&reply).await;
            }
            _ => tracing::debug!(server = %self.server, "server notification dropped"),
        }
    }
}

impl Drop for StdioSession {
    fn drop(&mut self) {
        if let Some(p) = self.pgid.take() {
            kill_group(p);
        }
    }
}

/// Reads one line of at most `max` bytes into `buf` (a longer line is skipped and leaves `buf` empty); 0 at the end.
async fn read_line_limited<R: AsyncBufRead + Unpin>(
    r: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
) -> std::io::Result<usize> {
    let mut total = 0;
    let mut too_long = false;
    loop {
        let available = r.fill_buf().await?;
        if available.is_empty() {
            return Ok(total);
        }
        let (used, done) = match available.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (available.len(), false),
        };
        if !too_long {
            if buf.len() + used > max {
                too_long = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&available[..used]);
            }
        }
        r.consume(used);
        total += used;
        if done {
            if too_long {
                buf.clear();
            }
            return Ok(total);
        }
    }
}

async fn read_loop(session: Weak<StdioSession>, stdout: tokio::process::ChildStdout) {
    let mut reader = tokio::io::BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match read_line_limited(&mut reader, &mut buf, MAX_MESSAGE).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Some(s) = session.upgrade() else {
            return;
        };
        if buf.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice::<Value>(&buf) {
            Ok(msg) => s.dispatch(msg).await,
            Err(_) => tracing::debug!(server = %s.server, "a line that is not JSON was skipped"),
        }
    }
    if let Some(s) = session.upgrade() {
        s.close();
    }
}

struct StdioUpstream {
    config: ServerConfig,
    sessions: tokio::sync::Mutex<Vec<Arc<StdioSession>>>,
}

struct HttpUpstream {
    url: String,
    headers: reqwest::header::HeaderMap,
    bearer: Option<String>,
    http: reqwest::Client,
    /// The OAuth manager with the stored tokens: looked up on first use.
    oauth: tokio::sync::Mutex<Option<Option<AuthorizationManager>>>,
}

enum Upstream {
    Stdio(Box<StdioUpstream>),
    Http(Box<HttpUpstream>),
}

/// The relay of a set of configured servers.
pub struct Bridge {
    upstreams: BTreeMap<String, Upstream>,
    opts: ConnectOptions,
    log: BridgeLog,
}

impl std::fmt::Debug for Bridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bridge")
            .field("servers", &self.names())
            .finish_non_exhaustive()
    }
}

fn server_err(server: &str, message: impl std::fmt::Display) -> McpError {
    McpError::Server {
        server: server.to_owned(),
        message: message.to_string(),
    }
}

fn http_upstream(s: &ServerConfig) -> Result<HttpUpstream, McpError> {
    let Transport::Http { url, headers, .. } = &s.transport else {
        return Err(server_err(&s.name, "not an HTTP server"));
    };
    let fail = |m: String| server_err(&s.name, m);
    let url = expand_env(url).map_err(fail)?;
    check_url(&url).map_err(fail)?;
    let mut map = reqwest::header::HeaderMap::new();
    let mut bearer = None;
    for (k, v) in headers {
        let v = expand_env(v).map_err(fail)?;
        if k.eq_ignore_ascii_case("authorization") {
            bearer = Some(v.strip_prefix("Bearer ").unwrap_or(&v).to_owned());
            continue;
        }
        let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| fail(format!("{k:?} is not a valid header name")))?;
        let mut value = reqwest::header::HeaderValue::from_str(&v)
            .map_err(|_| fail(format!("the value of the header {k} is not valid")))?;
        value.set_sensitive(true);
        map.insert(name, value);
    }
    Ok(HttpUpstream {
        url,
        headers: map,
        bearer,
        http: http_client()?,
        oauth: tokio::sync::Mutex::new(None),
    })
}

fn with_session(mut resp: Response<Body>, session: Option<&str>) -> Response<Body> {
    if let Some(v) = session.and_then(|s| HeaderValue::from_str(s).ok()) {
        resp.headers_mut().insert("mcp-session-id", v);
    }
    resp
}

impl Bridge {
    /// A bridge of `servers` (each enabled; HTTP URLs and headers expanded and checked now).
    pub fn new(servers: Vec<ServerConfig>, opts: ConnectOptions, log: BridgeLog) -> Result<Bridge, McpError> {
        let mut upstreams = BTreeMap::new();
        for s in servers {
            if s.disabled {
                return Err(server_err(&s.name, "is disabled in its configuration"));
            }
            let up = match &s.transport {
                Transport::Stdio { .. } => Upstream::Stdio(Box::new(StdioUpstream {
                    config: s.clone(),
                    sessions: tokio::sync::Mutex::new(Vec::new()),
                })),
                Transport::Http { .. } => Upstream::Http(Box::new(http_upstream(&s)?)),
            };
            if upstreams.insert(s.name.clone(), up).is_some() {
                return Err(server_err(&s.name, "is named twice"));
            }
        }
        Ok(Bridge { upstreams, opts, log })
    }

    /// The bridged servers, in name order.
    pub fn names(&self) -> Vec<String> {
        self.upstreams.keys().cloned().collect()
    }

    /// Ends every stdio session (process groups killed).
    pub async fn shutdown(&self) {
        for up in self.upstreams.values() {
            if let Upstream::Stdio(s) = up {
                for session in s.sessions.lock().await.drain(..) {
                    session.kill();
                }
            }
        }
    }

    fn record(&self, server: &str, msg: &Value, kind: &Message, status: StatusCode) {
        let method = match kind {
            Message::Request { method, .. } | Message::Notification { method } => method.clone(),
            Message::Response { .. } => "response".into(),
        };
        let tool = (method == "tools/call")
            .then(|| {
                msg.pointer("/params/name")
                    .and_then(Value::as_str)
                    .map(crate::serve::terminal_safe)
            })
            .flatten();
        (self.log)(&BridgeRecord {
            server: server.to_owned(),
            method: crate::serve::terminal_safe(&method),
            tool,
            status: status.as_u16(),
        });
    }

    async fn spawn(&self, up: &StdioUpstream) -> Result<Arc<StdioSession>, String> {
        let name = up.config.name.as_str();
        let (mut wrap, command) = stdio_command(&up.config, &self.opts).map_err(|e| e.to_string())?;
        wrap.command_mut()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = wrap.spawn().map_err(|e| format!("cannot start {command:?}: {e}"))?;
        let pgid = if cfg!(unix) { child.id() } else { None };
        let (Some(stdin), Some(stdout)) = (child.stdin().take(), child.stdout().take()) else {
            if let Some(p) = pgid {
                kill_group(p);
            }
            return Err(format!("{command:?} started without pipes"));
        };
        if let Some(stderr) = child.stderr().take() {
            log_stderr(name, stderr);
        }
        let session = Arc::new(StdioSession {
            id: new_session_id(),
            server: name.to_owned(),
            stdin: tokio::sync::Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            last_used: Mutex::new(Instant::now()),
            pgid,
            child: Mutex::new(Some(child)),
        });
        tokio::spawn(read_loop(Arc::downgrade(&session), stdout));
        Ok(session)
    }

    /// Room for one more session: closed and idle ones end, then the least recently used while there are too many.
    async fn make_room(up: &StdioUpstream) {
        let mut sessions = up.sessions.lock().await;
        sessions.retain(|s| {
            let keep = !s.is_closed() && s.idle() < SESSION_IDLE;
            if !keep {
                s.kill();
            }
            keep
        });
        while sessions.len() >= MAX_STDIO_SESSIONS {
            let oldest = sessions
                .iter()
                .enumerate()
                .max_by_key(|(_, s)| s.idle())
                .map(|(i, _)| i)
                .unwrap_or(0);
            sessions.remove(oldest).kill();
        }
    }

    async fn stdio_post(&self, up: &StdioUpstream, req: &Inbound, msg: &Value, kind: &Message) -> Response<Body> {
        let is_init = matches!(kind, Message::Request { method, .. } if method == "initialize");
        let session = if is_init {
            Bridge::make_room(up).await;
            match self.spawn(up).await {
                Ok(s) => s,
                Err(e) => return rpc_error(StatusCode::BAD_GATEWAY, request_id(kind), -32603, &e),
            }
        } else {
            let Some(wanted) = req.header("mcp-session-id") else {
                return refusal(StatusCode::BAD_REQUEST, "Mcp-Session-Id is required after initialize");
            };
            let found = up.sessions.lock().await.iter().find(|s| s.id == wanted).cloned();
            match found {
                Some(s) if !s.is_closed() => s,
                _ => return refusal(StatusCode::NOT_FOUND, "unknown or expired session; initialize again"),
            }
        };
        session.touch();
        let Message::Request { id, .. } = kind else {
            return match session.write(msg).await {
                Ok(()) => empty(StatusCode::ACCEPTED),
                Err(_) => refusal(StatusCode::BAD_GATEWAY, "the server exited"),
            };
        };
        let key = id.to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = session.pending();
            if pending.contains_key(&key) {
                return rpc_error(
                    StatusCode::BAD_REQUEST,
                    Some(id),
                    -32600,
                    "a request with this id is pending",
                );
            }
            pending.insert(key.clone(), tx);
        }
        let failed = |status, message: &str| {
            if is_init {
                session.kill();
            }
            rpc_error(status, Some(id), -32603, message)
        };
        if session.write(msg).await.is_err() {
            return failed(StatusCode::BAD_GATEWAY, "the server exited");
        }
        let wait = if is_init {
            self.opts.connect_timeout
        } else {
            self.opts.call_timeout
        };
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(answer)) => {
                if !is_init {
                    return json_response(StatusCode::OK, &answer);
                }
                up.sessions.lock().await.push(session.clone());
                with_session(json_response(StatusCode::OK, &answer), Some(&session.id))
            }
            Ok(Err(_)) => failed(StatusCode::BAD_GATEWAY, "the server exited before answering"),
            Err(_) => {
                session.pending().remove(&key);
                let cancel = json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
                    "params": {"requestId": id, "reason": "timed out in the bridge"}});
                let _ = session.write(&cancel).await;
                failed(StatusCode::GATEWAY_TIMEOUT, "the server did not answer in time")
            }
        }
    }

    async fn stdio_delete(up: &StdioUpstream, req: &Inbound) -> Response<Body> {
        let Some(wanted) = req.header("mcp-session-id") else {
            return refusal(StatusCode::BAD_REQUEST, "Mcp-Session-Id is required");
        };
        let mut sessions = up.sessions.lock().await;
        match sessions.iter().position(|s| s.id == wanted) {
            Some(i) => {
                sessions.remove(i).kill();
                empty(StatusCode::NO_CONTENT)
            }
            None => refusal(StatusCode::NOT_FOUND, "unknown session"),
        }
    }

    async fn bearer(&self, name: &str, up: &HttpUpstream) -> Option<String> {
        if let Some(b) = &up.bearer {
            return Some(b.clone());
        }
        let mut oauth = up.oauth.lock().await;
        if oauth.is_none() {
            let manager = match self.opts.token_store(name) {
                Some(store) => authorized_manager(&up.url, store, up.http.clone()).await.ok().flatten(),
                None => None,
            };
            *oauth = Some(manager);
        }
        match oauth.as_ref().and_then(Option::as_ref) {
            Some(m) => m.get_access_token().await.ok(),
            None => None,
        }
    }

    fn upstream_request(
        &self,
        up: &HttpUpstream,
        method: reqwest::Method,
        req: &Inbound,
        bearer: Option<&str>,
    ) -> reqwest::RequestBuilder {
        let mut rb = up
            .http
            .request(method, &up.url)
            .headers(up.headers.clone())
            .timeout(self.opts.call_timeout);
        for name in ["mcp-session-id", "mcp-protocol-version"] {
            if let Some(v) = req.header(name) {
                rb = rb.header(name, v);
            }
        }
        if let Some(b) = bearer {
            rb = rb.bearer_auth(b);
        }
        rb
    }

    async fn http_post(
        &self,
        name: &str,
        up: &HttpUpstream,
        req: &Inbound,
        msg: &Value,
        kind: &Message,
    ) -> Response<Body> {
        let id = request_id(kind);
        let bearer = self.bearer(name, up).await;
        let sent = self
            .upstream_request(up, reqwest::Method::POST, req, bearer.as_deref())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
            .body(msg.to_string())
            .send()
            .await;
        let resp = match sent {
            Ok(r) => r,
            Err(e) if e.is_timeout() => {
                return rpc_error(
                    StatusCode::GATEWAY_TIMEOUT,
                    id,
                    -32603,
                    "the server did not answer in time",
                );
            }
            Err(_) => return rpc_error(StatusCode::BAD_GATEWAY, id, -32603, "the server cannot be reached"),
        };
        let status = resp.status();
        let session = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let session = session.as_deref();
        if matches!(status.as_u16(), 202 | 204) {
            return with_session(empty(StatusCode::ACCEPTED), session);
        }
        if matches!(status.as_u16(), 401 | 403) {
            let m = format!("{name} asks for authorization: run `aparte mcp login {name}`, then restart the bridge");
            return rpc_error(StatusCode::BAD_GATEWAY, id, -32001, &m);
        }
        if status == reqwest::StatusCode::NOT_FOUND && req.header("mcp-session-id").is_some() {
            return refusal(StatusCode::NOT_FOUND, "the server's session expired; initialize again");
        }
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if status.is_success() && ctype.starts_with("text/event-stream") {
            let Some(id) = id else {
                return with_session(empty(StatusCode::ACCEPTED), session);
            };
            return match self.sse_answer(up, req, bearer.as_deref(), resp, id).await {
                Ok(v) => with_session(json_response(StatusCode::OK, &v), session),
                Err(e) => rpc_error(StatusCode::BAD_GATEWAY, Some(id), -32603, &e),
            };
        }
        if ctype.starts_with("application/json") && (status.is_success() || status.is_client_error()) {
            return match read_limited(resp)
                .await
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            {
                Some(v) => {
                    let out = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                    with_session(json_response(out, &v), session)
                }
                None => rpc_error(StatusCode::BAD_GATEWAY, id, -32603, "the server's answer is not JSON"),
            };
        }
        rpc_error(
            StatusCode::BAD_GATEWAY,
            id,
            -32603,
            &format!("the server answered HTTP {}", status.as_u16()),
        )
    }

    /// Reads an SSE answer until the response of `id`; requests of the server on the way are answered with an
    /// error (or an empty result for `ping`).
    async fn sse_answer(
        &self,
        up: &HttpUpstream,
        req: &Inbound,
        bearer: Option<&str>,
        mut resp: reqwest::Response,
        id: &Value,
    ) -> Result<Value, String> {
        let mut buf: Vec<u8> = Vec::new();
        let mut data = String::new();
        let mut total = 0usize;
        loop {
            let chunk = resp.chunk().await.map_err(|_| "the server's stream broke".to_owned())?;
            let Some(chunk) = chunk else {
                break;
            };
            total += chunk.len();
            if total > MAX_MESSAGE {
                return Err("the server's answer is too large".into());
            }
            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let raw: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&raw);
                let line = line.trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    if let Some(v) = self.sse_event(up, req, bearer, &data, id).await {
                        return Ok(v);
                    }
                    data.clear();
                } else if let Some(d) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(d.strip_prefix(' ').unwrap_or(d));
                }
            }
        }
        if let Some(v) = self.sse_event(up, req, bearer, &data, id).await {
            return Ok(v);
        }
        Err("the server closed its stream without answering".into())
    }

    async fn sse_event(
        &self,
        up: &HttpUpstream,
        req: &Inbound,
        bearer: Option<&str>,
        data: &str,
        id: &Value,
    ) -> Option<Value> {
        if data.trim().is_empty() {
            return None;
        }
        let v: Value = serde_json::from_str(data).ok()?;
        let method = v.get("method").and_then(Value::as_str);
        let their_id = v.get("id").filter(|i| !i.is_null());
        match (method, their_id) {
            (None, Some(i)) if i == id => Some(v),
            (Some(m), Some(i)) => {
                let reply = if m == "ping" {
                    json!({"jsonrpc": "2.0", "id": i, "result": {}})
                } else {
                    json!({"jsonrpc": "2.0", "id": i, "error": {
                        "code": -32601,
                        "message": "aparte mcp bridge does not relay requests from the server"
                    }})
                };
                let _ = self
                    .upstream_request(up, reqwest::Method::POST, req, bearer)
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
                    .body(reply.to_string())
                    .send()
                    .await;
                None
            }
            _ => None,
        }
    }

    async fn http_delete(&self, name: &str, up: &HttpUpstream, req: &Inbound) -> Response<Body> {
        if req.header("mcp-session-id").is_none() {
            return refusal(StatusCode::BAD_REQUEST, "Mcp-Session-Id is required");
        }
        let bearer = self.bearer(name, up).await;
        match self
            .upstream_request(up, reqwest::Method::DELETE, req, bearer.as_deref())
            .send()
            .await
        {
            Ok(r) if r.status().is_success() || r.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED => {
                empty(StatusCode::NO_CONTENT)
            }
            Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => refusal(StatusCode::NOT_FOUND, "unknown session"),
            _ => refusal(StatusCode::BAD_GATEWAY, "the server did not end the session"),
        }
    }

    /// Relays a POST. The protocol version is the server's business: `MCP-Protocol-Version` is passed through
    /// unchecked.
    async fn post(&self, name: &str, up: &Upstream, req: Inbound) -> Response<Body> {
        let (msg, kind) = match classify(&req.body) {
            Ok(m) => m,
            Err(e) => return rpc_error(StatusCode::BAD_REQUEST, None, -32600, e),
        };
        let resp = match up {
            Upstream::Stdio(s) => self.stdio_post(s, &req, &msg, &kind).await,
            Upstream::Http(h) => self.http_post(name, h, &req, &msg, &kind).await,
        };
        self.record(name, &msg, &kind, resp.status());
        resp
    }
}

fn request_id(kind: &Message) -> Option<&Value> {
    match kind {
        Message::Request { id, .. } => Some(id),
        _ => None,
    }
}

async fn read_limited(mut resp: reqwest::Response) -> Result<Vec<u8>, ()> {
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| ())? {
        if out.len() + chunk.len() > MAX_MESSAGE {
            return Err(());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

impl Handler for Bridge {
    fn handle(&self, req: Inbound) -> BoxFuture<'_, Response<Body>> {
        Box::pin(async move {
            let Some((name, up)) = req
                .path
                .strip_prefix(PREFIX)
                .and_then(|n| self.upstreams.get_key_value(n))
            else {
                return refusal(StatusCode::NOT_FOUND, "no bridged server at this path");
            };
            match (&req.method, up) {
                (&Method::POST, _) => self.post(name, up, req).await,
                (&Method::DELETE, Upstream::Stdio(s)) => {
                    let r = Bridge::stdio_delete(s, &req).await;
                    (self.log)(&BridgeRecord {
                        server: name.clone(),
                        method: "delete".into(),
                        tool: None,
                        status: r.status().as_u16(),
                    });
                    r
                }
                (&Method::DELETE, Upstream::Http(h)) => self.http_delete(name, h, &req).await,
                _ => method_not_allowed("POST, DELETE, OPTIONS"),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn long_lines_are_skipped() {
        let input = format!("{}\nshort\n", "x".repeat(100));
        let mut r = tokio::io::BufReader::with_capacity(16, input.as_bytes());
        let mut buf = Vec::new();
        assert_eq!(read_line_limited(&mut r, &mut buf, 50).await.expect("read"), 101);
        assert!(buf.is_empty());
        buf.clear();
        read_line_limited(&mut r, &mut buf, 50).await.expect("read");
        assert_eq!(buf, b"short\n");
        buf.clear();
        assert_eq!(read_line_limited(&mut r, &mut buf, 50).await.expect("read"), 0);
    }
}
