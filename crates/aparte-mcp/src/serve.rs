//! `aparte mcp serve`: the CLI's own tools offered to MCP clients over Streamable HTTP, on the guarded loopback
//! server of [`crate::loopback`].
//!
//! - One endpoint, `/mcp`: `POST` takes one JSON-RPC message and answers with JSON (no SSE stream); `GET` is 405
//!   (no server-initiated messages); `DELETE` ends the session.
//! - Methods: `initialize` (which opens a session, named by `Mcp-Session-Id`), `ping`, `tools/list` and
//!   `tools/call`; notifications and responses are accepted with 202.
//! - Only read-only, closed-world tools are offered by default. With `allow_write`, the others are offered too, and
//!   each of their calls goes to the [`Approver`] first (the terminal, see [`TerminalApprover`]).
//! - A `path` argument must stay inside the served directory (symbolic links followed); `~` is refused.
//! - Each call is reported to a [`CallLog`] (tool, short summary of the input, outcome).

use std::collections::VecDeque;
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use aparte_agent::{Annotations, Approval, ApprovalRequest, Approver, BoxFuture, CancelToken, Tool, ToolContext};
use hyper::header::HeaderValue;
use hyper::{Method, Response, StatusCode};
use serde_json::{Value, json};

use crate::loopback::{
    Body, Handler, Inbound, Message, PROTOCOL_VERSIONS, check_protocol_header, classify, empty, json_response,
    method_not_allowed, new_session_id, refusal, rpc_error,
};

/// The endpoint.
pub const ENDPOINT: &str = "/mcp";
/// The port listened on unless another is given (below every OS's ephemeral range).
pub const DEFAULT_PORT: u16 = 27_182;
/// Sessions kept at once; the oldest goes first.
pub const MAX_SESSIONS: usize = 32;
/// The revision answered when a client asks for one this server does not know: the latest it speaks.
pub const FALLBACK_PROTOCOL: &str = PROTOCOL_VERSIONS[0];

/// Whether a tool is offered by default: read-only and closed-world.
pub fn is_read_only(a: Annotations) -> bool {
    a.read_only && !a.open_world
}

/// The tools to offer: the read-only ones, or all of them with `allow_write`.
pub fn offered(tools: Vec<Arc<dyn Tool>>, allow_write: bool) -> Vec<Arc<dyn Tool>> {
    tools
        .into_iter()
        .filter(|t| allow_write || is_read_only(t.annotations()))
        .collect()
}

/// What became of a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// It ran and succeeded.
    Ok,
    /// It ran and failed, or its input was invalid.
    Error,
    /// The approver said no.
    Denied,
    /// A path argument was outside the served directory.
    OutsideRoot,
}

impl Outcome {
    /// A name for logs.
    pub fn name(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Error => "error",
            Outcome::Denied => "denied",
            Outcome::OutsideRoot => "refused: outside the directory",
        }
    }
}

/// One call, as logged.
#[derive(Debug, Clone)]
pub struct CallRecord {
    pub tool: String,
    /// The input, compact and cut to [`SUMMARY_CHARS`], control characters replaced.
    pub summary: String,
    pub outcome: Outcome,
    pub elapsed: Duration,
}

/// Where calls are reported.
pub type CallLog = Arc<dyn Fn(&CallRecord) + Send + Sync>;

/// Longest input summary in a log line.
pub const SUMMARY_CHARS: usize = 120;

/// Replaces control and bidirectional-override characters, so that text from a client cannot drive the terminal.
pub fn terminal_safe(s: &str) -> String {
    s.chars()
        .map(|c| {
            let bidi = matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}');
            if (c.is_control() && c != '\n') || bidi {
                '\u{fffd}'
            } else {
                c
            }
        })
        .collect()
}

/// A one-line summary of a tool input.
pub fn summary(input: &Value) -> String {
    let compact = terminal_safe(&input.to_string()).replace('\n', " ");
    if compact.chars().count() > SUMMARY_CHARS {
        format!("{}…", compact.chars().take(SUMMARY_CHARS).collect::<String>())
    } else {
        compact
    }
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether `raw` (as a tool would take it, relative to `root`) stays inside `root`, which must be canonical.
/// Symbolic links of the part that exists are followed; `~` is refused.
pub fn inside(root: &Path, raw: &str) -> bool {
    let raw = raw.trim();
    if raw.starts_with('~') {
        return false;
    }
    let p = Path::new(raw);
    let full = normalize(&if p.is_absolute() { p.to_path_buf() } else { root.join(p) });
    if !full.starts_with(root) {
        return false;
    }
    let mut existing = full.as_path();
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if let Ok(real) = existing.canonicalize() {
            let mut real = real;
            for part in rest.iter().rev() {
                real.push(part);
            }
            return real.starts_with(root);
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return false,
        }
    }
}

/// Approves every call (`--yes`).
#[derive(Debug, Clone, Copy, Default)]
pub struct AllowAll;

impl Approver for AllowAll {
    fn approve<'a>(&'a self, _req: &'a ApprovalRequest) -> BoxFuture<'a, Approval> {
        Box::pin(async { Approval::Allow })
    }
}

/// Asks one question on `output` and reads the answer from `input`: `y` or `yes` allows, anything else denies.
pub fn ask(input: &mut dyn BufRead, output: &mut dyn Write, req: &ApprovalRequest) -> Approval {
    let kind = if req.annotations.destructive {
        "may overwrite, delete or run commands"
    } else if req.annotations.open_world {
        "reaches the network"
    } else {
        "writes"
    };
    let mut shown = terminal_safe(&serde_json::to_string_pretty(&req.input).unwrap_or_default());
    if shown.chars().count() > 2000 {
        shown = format!("{}\n…", shown.chars().take(2000).collect::<String>());
    }
    let indented: String = shown.lines().map(|l| format!("    {l}\n")).collect();
    let tool = terminal_safe(&req.tool);
    let _ = write!(
        output,
        "\naparte mcp serve: a client asks to run `{tool}` ({kind}):\n{indented}Allow this call? [y/N] "
    );
    let _ = output.flush();
    let mut line = String::new();
    match input.read_line(&mut line) {
        Ok(n) if n > 0 && matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") => Approval::Allow,
        _ => Approval::Deny {
            reason: Some("the user denied this call".into()),
        },
    }
}

/// Asks in the terminal, one question at a time: the question on `/dev/tty` (or stderr), the answer from stdin.
/// Available only when stdin is a terminal.
#[derive(Debug, Clone)]
pub struct TerminalApprover {
    lock: Arc<Mutex<()>>,
}

impl TerminalApprover {
    /// The terminal approver, when stdin is a terminal.
    pub fn open() -> Option<TerminalApprover> {
        std::io::stdin().is_terminal().then(|| TerminalApprover {
            lock: Arc::new(Mutex::new(())),
        })
    }
}

fn tty_writer() -> Box<dyn Write> {
    #[cfg(unix)]
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open("/dev/tty") {
        return Box::new(f);
    }
    Box::new(std::io::stderr())
}

impl Approver for TerminalApprover {
    fn approve<'a>(&'a self, req: &'a ApprovalRequest) -> BoxFuture<'a, Approval> {
        let lock = self.lock.clone();
        let req = req.clone();
        Box::pin(async move {
            let asked = tokio::task::spawn_blocking(move || {
                let _one_at_a_time = lock.lock().unwrap_or_else(PoisonError::into_inner);
                let mut out = tty_writer();
                ask(&mut std::io::stdin().lock(), &mut out, &req)
            })
            .await;
            asked.unwrap_or(Approval::Deny {
                reason: Some("the question could not be asked".into()),
            })
        })
    }
}

/// The MCP server of a set of tools.
pub struct ToolServer {
    tools: Vec<Arc<dyn Tool>>,
    root: PathBuf,
    approver: Arc<dyn Approver>,
    log: CallLog,
    sessions: Mutex<VecDeque<String>>,
    calls: AtomicU64,
}

impl std::fmt::Debug for ToolServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolServer")
            .field("tools", &self.tool_names())
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

type RpcResult = Result<Value, (i64, String)>;

impl ToolServer {
    /// A server of `tools` (already filtered by [`offered`]) run in `root` (made canonical).
    pub fn new(tools: Vec<Arc<dyn Tool>>, root: PathBuf, approver: Arc<dyn Approver>, log: CallLog) -> ToolServer {
        let root = root.canonicalize().unwrap_or(root);
        ToolServer {
            tools,
            root,
            approver,
            log,
            sessions: Mutex::new(VecDeque::new()),
            calls: AtomicU64::new(1),
        }
    }

    /// The names of the tools offered.
    pub fn tool_names(&self) -> Vec<String> {
        self.tools.iter().map(|t| t.name().to_owned()).collect()
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, VecDeque<String>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn open_session(&self) -> String {
        let id = new_session_id();
        let mut s = self.sessions();
        while s.len() >= MAX_SESSIONS {
            s.pop_front();
        }
        s.push_back(id.clone());
        id
    }

    fn known_session(&self, id: &str) -> bool {
        self.sessions().iter().any(|s| s == id)
    }

    fn descriptor(t: &dyn Tool) -> Value {
        let a = t.annotations();
        let mut schema = t.input_schema();
        if let Some(obj) = schema.as_object_mut() {
            obj.entry("type").or_insert_with(|| json!("object"));
        }
        json!({
            "name": t.name(),
            "description": t.description(),
            "inputSchema": schema,
            "annotations": {
                "readOnlyHint": a.read_only,
                "destructiveHint": a.destructive,
                "idempotentHint": a.idempotent,
                "openWorldHint": a.open_world,
            },
        })
    }

    async fn post(&self, req: Inbound) -> Response<Body> {
        if let Some(r) = check_protocol_header(&req) {
            return r;
        }
        let (msg, kind) = match classify(&req.body) {
            Ok(m) => m,
            Err(e) => return rpc_error(StatusCode::BAD_REQUEST, None, -32600, e),
        };
        let is_initialize = matches!(&kind, Message::Request { method, .. } if method == "initialize");
        if !is_initialize {
            match req.header("mcp-session-id") {
                None => return refusal(StatusCode::BAD_REQUEST, "Mcp-Session-Id is required after initialize"),
                Some(s) if !self.known_session(s) => {
                    return refusal(StatusCode::NOT_FOUND, "unknown or expired session; initialize again");
                }
                Some(_) => {}
            }
        }
        let (id, method) = match kind {
            Message::Request { id, method } => (id, method),
            Message::Notification { .. } | Message::Response { .. } => return empty(StatusCode::ACCEPTED),
        };
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        let result = self.request(&method, &params).await;
        let body = match result {
            Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
            Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
        };
        let mut resp = json_response(StatusCode::OK, &body);
        if is_initialize {
            let session = self.open_session();
            if let Ok(v) = HeaderValue::from_str(&session) {
                resp.headers_mut().insert("mcp-session-id", v);
            }
        }
        resp
    }

    async fn request(&self, method: &str, params: &Value) -> RpcResult {
        match method {
            "initialize" => {
                let asked = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let version = if PROTOCOL_VERSIONS.contains(&asked) {
                    asked
                } else {
                    FALLBACK_PROTOCOL
                };
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "aparte", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": format!(
                        "Tools of the aparte CLI, run in {}. Paths are relative to it and stay inside it.",
                        self.root.display()
                    ),
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({
                "tools": self.tools.iter().map(|t| ToolServer::descriptor(t.as_ref())).collect::<Vec<_>>()
            })),
            "tools/call" => self.call(params).await,
            other => Err((-32601, format!("method not found: {other}"))),
        }
    }

    async fn call(&self, params: &Value) -> RpcResult {
        let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
        let Some(tool) = self.tools.iter().find(|t| t.name() == name) else {
            return Err((-32602, format!("unknown tool {:?}", terminal_safe(name))));
        };
        let input = match params.get("arguments") {
            None | Some(Value::Null) => json!({}),
            Some(v @ Value::Object(_)) => v.clone(),
            Some(_) => return Err((-32602, "`arguments` must be an object".into())),
        };
        let started = Instant::now();
        let record = |outcome: Outcome| {
            (self.log)(&CallRecord {
                tool: name.to_owned(),
                summary: summary(&input),
                outcome,
                elapsed: started.elapsed(),
            });
        };
        let text = |t: &str, is_error: bool| json!({"content": [{"type": "text", "text": t}], "isError": is_error});
        let outside = input
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|p| !inside(&self.root, p));
        if outside {
            record(Outcome::OutsideRoot);
            return Ok(text(
                &format!("the path is outside the served directory {}", self.root.display()),
                true,
            ));
        }
        let call_id = format!("mcp-{}", self.calls.fetch_add(1, Ordering::Relaxed));
        let annotations = tool.annotations();
        if !is_read_only(annotations) {
            let req = ApprovalRequest {
                call_id: call_id.clone(),
                tool: name.to_owned(),
                input: input.clone(),
                annotations,
            };
            if let Approval::Deny { reason } = self.approver.approve(&req).await {
                record(Outcome::Denied);
                let why = reason.unwrap_or_else(|| "the user denied this call".into());
                return Ok(text(&format!("not run: {why}"), true));
            }
        }
        let ctx = ToolContext {
            cwd: self.root.clone(),
            call_id,
            cancel: CancelToken::new(),
        };
        match tool.execute(&ctx, input.clone()).await {
            Ok(out) => {
                record(if out.is_error { Outcome::Error } else { Outcome::Ok });
                Ok(text(&out.content, out.is_error))
            }
            Err(e) => {
                record(Outcome::Error);
                Ok(text(&e.to_string(), true))
            }
        }
    }
}

impl Handler for ToolServer {
    fn handle(&self, req: Inbound) -> BoxFuture<'_, Response<Body>> {
        Box::pin(async move {
            if req.path != ENDPOINT {
                return refusal(StatusCode::NOT_FOUND, "the endpoint is /mcp");
            }
            match req.method {
                Method::POST => self.post(req).await,
                Method::DELETE => {
                    let Some(id) = req.header("mcp-session-id") else {
                        return refusal(StatusCode::BAD_REQUEST, "Mcp-Session-Id is required");
                    };
                    let mut s = self.sessions();
                    let before = s.len();
                    s.retain(|x| x != id);
                    if s.len() == before {
                        refusal(StatusCode::NOT_FOUND, "unknown session")
                    } else {
                        empty(StatusCode::NO_CONTENT)
                    }
                }
                _ => method_not_allowed("POST, DELETE, OPTIONS"),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_the_root() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path().canonicalize().expect("canonical");
        std::fs::create_dir_all(root.join("src")).expect("mkdir");
        assert!(inside(&root, "src"));
        assert!(inside(&root, "src/new/file.txt"));
        assert!(inside(&root, "."));
        assert!(inside(&root, &root.join("src").display().to_string()));
        assert!(!inside(&root, ".."));
        assert!(!inside(&root, "src/../../x"));
        assert!(!inside(&root, "/etc/passwd"));
        assert!(!inside(&root, "~/.ssh/id_ed25519"));
        assert!(!inside(&root, "~"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/", root.join("escape")).expect("symlink");
            assert!(!inside(&root, "escape/etc/passwd"));
            assert!(!inside(&root, "escape"));
        }
    }

    #[test]
    fn summaries_are_short_and_safe() {
        assert_eq!(summary(&json!({"path": "a"})), r#"{"path":"a"}"#);
        let long = summary(&json!({"text": "x".repeat(500)}));
        assert!(long.chars().count() <= SUMMARY_CHARS + 1 && long.ends_with('…'));
        let s = summary(&json!({"t": "\u{1b}[2J\u{202e}"}));
        assert!(!s.contains('\u{1b}') && !s.contains('\u{202e}'));
        assert!(terminal_safe("a\u{7}b\nc").contains('\n'));
    }

    #[test]
    fn the_terminal_question_takes_yes_only() {
        let req = ApprovalRequest {
            call_id: "c".into(),
            tool: "write".into(),
            input: json!({"path": "x", "content": "\u{1b}]0;title\u{7}"}),
            annotations: Annotations {
                read_only: false,
                destructive: true,
                idempotent: false,
                open_world: false,
            },
        };
        for (answer, allowed) in [
            ("y\n", true),
            ("YES\n", true),
            ("n\n", false),
            ("\n", false),
            ("", false),
        ] {
            let mut out = Vec::new();
            let got = ask(&mut answer.as_bytes(), &mut out, &req);
            assert_eq!(matches!(got, Approval::Allow), allowed, "{answer:?}");
            let shown = String::from_utf8(out).expect("utf-8");
            assert!(shown.contains("`write`") && shown.contains("[y/N]"));
            assert!(
                !shown.contains('\u{1b}'),
                "escape sequences are not passed to the terminal"
            );
        }
    }
}
