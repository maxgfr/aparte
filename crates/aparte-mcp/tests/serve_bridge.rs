//! `aparte mcp serve` and `aparte mcp bridge` end to end, on a real loopback socket: the CLI's tools to the MCP
//! client of this crate and to raw JSON-RPC, read-only by default and approvals for the others; the stdio and HTTP
//! mocks relayed to a browser-like client with the web app's Origin; the guard rules on the wire.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aparte_agent::{Approval, ApprovalRequest, Approver, BoxFuture, CancelToken, DenyAll, Tool, ToolContext};
use aparte_mcp::bridge::{Bridge, BridgeLog, BridgeRecord};
use aparte_mcp::config::{ServerConfig, Source, Transport};
use aparte_mcp::loopback::{APP_ORIGIN, Handler, LoopbackServer, Token};
use aparte_mcp::serve::{AllowAll, CallLog, CallRecord, Outcome, ToolServer, offered};
use aparte_mcp::{ConnectOptions, McpTool, connect};
use serde_json::{Value, json};

/// The stdio example, built by `cargo test` with the other targets (built here if it is missing).
fn mock_stdio() -> PathBuf {
    let exe = std::env::current_exe().expect("exe");
    let profile = exe.parent().and_then(Path::parent).expect("target/<profile>");
    let bin = profile
        .join("examples")
        .join(format!("mcp_mock_stdio{}", std::env::consts::EXE_SUFFIX));
    if !bin.is_file() {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = std::process::Command::new(cargo)
            .args(["build", "-p", "aparte-mcp", "--example", "mcp_mock_stdio"])
            .status()
            .expect("cargo build");
        assert!(status.success(), "the mock builds");
    }
    bin
}

fn stdio(name: &str, env: &[(&str, &str)]) -> ServerConfig {
    ServerConfig {
        name: name.into(),
        transport: Transport::Stdio {
            command: mock_stdio().display().to_string(),
            args: Vec::new(),
            env: env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
            cwd: None,
        },
        disabled: false,
        source: Source::User,
        file: PathBuf::from("mcp.json"),
    }
}

fn http_config(name: &str, url: &str, bearer: Option<&str>) -> ServerConfig {
    ServerConfig {
        name: name.into(),
        transport: Transport::Http {
            url: url.into(),
            headers: bearer
                .map(|b| {
                    [("Authorization".to_owned(), format!("Bearer {b}"))]
                        .into_iter()
                        .collect()
                })
                .unwrap_or_default(),
            oauth: None,
        },
        disabled: false,
        source: Source::User,
        file: PathBuf::from("mcp.json"),
    }
}

/// A running loopback server; stops when dropped.
struct Running {
    base: String,
    token: Arc<Token>,
    _stop: tokio::sync::oneshot::Sender<()>,
}

impl Running {
    fn bearer(&self) -> String {
        format!("Bearer {}", self.token.display().as_str())
    }
}

async fn start(handler: Arc<dyn Handler>) -> Running {
    let server = LoopbackServer::bind_port(0).await.expect("bind");
    let addr = server.local_addr();
    assert_eq!(addr.ip(), std::net::Ipv4Addr::LOCALHOST, "the IPv4 loopback only");
    let token = Arc::new(Token::generate().expect("token"));
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let t = token.clone();
    tokio::spawn(async move {
        let _ = server
            .serve(t, handler, async {
                let _ = stopped.await;
            })
            .await;
    });
    Running {
        base: format!("http://{addr}"),
        token,
        _stop: stop,
    }
}

fn client() -> reqwest::Client {
    aparte_mcp::client::http_client().expect("client")
}

/// Posts one JSON-RPC message the way a browser page of the web app would.
async fn post(
    url: &str,
    auth: Option<&str>,
    origin: Option<&str>,
    session: Option<&str>,
    body: &Value,
) -> reqwest::Response {
    let mut rb = client()
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(body.to_string());
    if let Some(a) = auth {
        rb = rb.header("authorization", a);
    }
    if let Some(o) = origin {
        rb = rb.header("origin", o);
    }
    if let Some(s) = session {
        rb = rb.header("mcp-session-id", s);
    }
    rb.send().await.expect("send")
}

fn init() -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}
    }})
}

fn call(id: u32, name: &str, args: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": name, "arguments": args}})
}

fn builtin_tools() -> Vec<Arc<dyn Tool>> {
    let blobs = Arc::new(aparte_tools::BlobStore::new().expect("blobs"));
    aparte_tools::builtin(&aparte_tools::ToolsConfig::default(), blobs).expect("tools")
}

fn recorder() -> (CallLog, Arc<Mutex<Vec<CallRecord>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let log: CallLog = Arc::new(move |r: &CallRecord| s.lock().expect("lock").push(r.clone()));
    (log, seen)
}

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("dir");
    std::fs::write(dir.path().join("notes.txt"), "first line\nsecond line\n").expect("write");
    std::fs::create_dir(dir.path().join("src")).expect("mkdir");
    dir
}

#[tokio::test]
async fn serve_offers_the_read_only_tools_to_an_mcp_client() {
    let dir = project();
    let (log, seen) = recorder();
    let tools = offered(builtin_tools(), false);
    let server = ToolServer::new(tools, dir.path().to_path_buf(), Arc::new(DenyAll), log);
    let names = server.tool_names();
    assert_eq!(
        names,
        ["read", "grep", "find", "ls", "git"],
        "read-only and closed world"
    );
    let running = start(Arc::new(server)).await;

    let config = http_config(
        "aparte",
        &format!("{}/mcp", running.base),
        Some(running.token.display().as_str()),
    );
    let conn = connect(&config, &ConnectOptions::new(dir.path()))
        .await
        .expect("the MCP client connects");
    let listed: Vec<&str> = conn
        .tools
        .iter()
        .filter_map(|t| t.get("name").and_then(Value::as_str))
        .collect();
    assert_eq!(listed, names);
    let ls_def = conn.tools.iter().find(|t| t["name"] == "ls").expect("ls").clone();
    assert_eq!(ls_def["annotations"]["readOnlyHint"], true);
    assert_eq!(ls_def["annotations"]["openWorldHint"], false);
    let peer = conn.peer().expect("peer");
    let ctx = ToolContext {
        cwd: std::env::temp_dir(),
        call_id: "c".into(),
        cancel: CancelToken::new(),
    };
    let ls = McpTool::new("aparte", &ls_def, "ls".into(), peer.clone(), Duration::from_secs(30));
    let out = ls.execute(&ctx, json!({})).await.expect("ls");
    assert!(
        !out.is_error && out.content.contains("notes.txt") && out.content.contains("src/"),
        "{}",
        out.content
    );
    let read_def = conn.tools.iter().find(|t| t["name"] == "read").expect("read").clone();
    let read = McpTool::new("aparte", &read_def, "read".into(), peer, Duration::from_secs(30));
    let out = read.execute(&ctx, json!({"path": "notes.txt"})).await.expect("read");
    assert!(out.content.contains("second line"), "{}", out.content);
    let outside = read
        .execute(&ctx, json!({"path": "../../etc/passwd"}))
        .await
        .expect("read");
    assert!(
        outside.is_error && outside.content.contains("outside"),
        "{}",
        outside.content
    );
    let home = read
        .execute(&ctx, json!({"path": "~/.ssh/config"}))
        .await
        .expect("read");
    assert!(home.is_error);
    conn.shutdown().await;

    let log = seen.lock().expect("lock").clone();
    let outcomes: Vec<(&str, Outcome)> = log.iter().map(|r| (r.tool.as_str(), r.outcome)).collect();
    assert_eq!(
        outcomes,
        [
            ("ls", Outcome::Ok),
            ("read", Outcome::Ok),
            ("read", Outcome::OutsideRoot),
            ("read", Outcome::OutsideRoot)
        ]
    );
    assert!(log[1].summary.contains("notes.txt"));
}

#[tokio::test]
async fn serve_speaks_json_rpc_and_keeps_its_rules() {
    let dir = project();
    let (log, _) = recorder();
    let server = ToolServer::new(
        offered(builtin_tools(), false),
        dir.path().to_path_buf(),
        Arc::new(DenyAll),
        log,
    );
    let running = start(Arc::new(server)).await;
    let url = format!("{}/mcp", running.base);
    let bearer = running.bearer();

    let r = post(&url, None, None, None, &init()).await;
    assert_eq!(r.status(), 401, "no token");
    assert!(r.headers().get("www-authenticate").is_some());
    let r = post(&url, Some("Bearer not-the-token"), None, None, &init()).await;
    assert_eq!(r.status(), 401, "a wrong token");
    let in_query = format!("{url}?token={}", running.token.display().as_str());
    let r = post(&in_query, None, None, None, &init()).await;
    assert_eq!(r.status(), 400, "a token in the URL is refused");
    let r = post(&url, Some(&bearer), Some("https://evil.example"), None, &init()).await;
    assert_eq!(r.status(), 403, "a foreign origin");
    let rebound = client()
        .post(&url)
        .header("host", "attacker.example:80")
        .header("authorization", &bearer)
        .header("content-type", "application/json")
        .body(init().to_string())
        .send()
        .await
        .expect("send");
    assert_eq!(rebound.status(), 421, "DNS rebinding: a foreign Host");
    let r = client()
        .post(&url)
        .header("authorization", &bearer)
        .header("content-type", "text/plain")
        .body(init().to_string())
        .send()
        .await
        .expect("send");
    assert_eq!(r.status(), 415);
    let r = client()
        .post(&url)
        .header("authorization", &bearer)
        .header("content-type", "application/json")
        .body(vec![b' '; 5 * 1024 * 1024])
        .send()
        .await
        .expect("send");
    assert_eq!(r.status(), 413);

    let r = post(&url, Some(&bearer), None, None, &init()).await;
    assert_eq!(r.status(), 200);
    let session = r
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .expect("a session")
        .to_owned();
    let body: Value = r.json().await.expect("json");
    assert_eq!(body["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(body["result"]["serverInfo"]["name"], "aparte");
    let s = Some(session.as_str());
    let r = post(
        &url,
        Some(&bearer),
        None,
        None,
        &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
    )
    .await;
    assert_eq!(r.status(), 400, "the session id is required");
    let r = post(
        &url,
        Some(&bearer),
        None,
        Some("nope"),
        &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
    )
    .await;
    assert_eq!(r.status(), 404, "an unknown session");
    let r = post(
        &url,
        Some(&bearer),
        None,
        s,
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    )
    .await;
    assert_eq!(r.status(), 202);
    let r = post(
        &url,
        Some(&bearer),
        Some(APP_ORIGIN),
        s,
        &json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}),
    )
    .await;
    assert_eq!(r.status(), 200);
    assert_eq!(
        r.headers()
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some(APP_ORIGIN)
    );
    let body: Value = r.json().await.expect("json");
    let names: Vec<&str> = body["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(!names.contains(&"write") && !names.contains(&"bash") && !names.contains(&"web_fetch"));
    let r = post(
        &url,
        Some(&bearer),
        None,
        s,
        &call(4, "write", json!({"path": "x", "content": "y"})),
    )
    .await;
    let body: Value = r.json().await.expect("json");
    assert_eq!(body["error"]["code"], -32602, "a tool that is not offered: {body}");
    assert!(!dir.path().join("x").exists());
    let r = post(
        &url,
        Some(&bearer),
        None,
        s,
        &json!([{"jsonrpc": "2.0", "id": 5, "method": "ping"}]),
    )
    .await;
    assert_eq!(r.status(), 400, "no batches");
    let r = post(
        &url,
        Some(&bearer),
        None,
        s,
        &json!({"jsonrpc": "2.0", "id": 6, "method": "resources/list"}),
    )
    .await;
    let body: Value = r.json().await.expect("json");
    assert_eq!(body["error"]["code"], -32601);
    let r = client()
        .get(&url)
        .header("authorization", &bearer)
        .header("mcp-session-id", &session)
        .send()
        .await
        .expect("get");
    assert_eq!(r.status(), 405, "no server-to-client stream");
    let r = client()
        .request(reqwest::Method::OPTIONS, &url)
        .header("origin", "http://localhost:5173")
        .header("access-control-request-method", "POST")
        .header("access-control-request-private-network", "true")
        .send()
        .await
        .expect("preflight");
    assert_eq!(r.status(), 204);
    assert_eq!(r.headers()["access-control-allow-private-network"], "true");
    assert_eq!(r.headers()["access-control-allow-origin"], "http://localhost:5173");
    let r = client()
        .delete(&url)
        .header("authorization", &bearer)
        .header("mcp-session-id", &session)
        .send()
        .await
        .expect("delete");
    assert_eq!(r.status(), 204);
    let r = post(
        &url,
        Some(&bearer),
        None,
        s,
        &json!({"jsonrpc": "2.0", "id": 7, "method": "ping"}),
    )
    .await;
    assert_eq!(r.status(), 404, "the session ended");
}

/// Approves or denies, and remembers what it was asked.
struct Scripted {
    allow: bool,
    asked: Mutex<Vec<String>>,
}

impl Approver for Scripted {
    fn approve<'a>(&'a self, req: &'a ApprovalRequest) -> BoxFuture<'a, Approval> {
        self.asked.lock().expect("lock").push(req.tool.clone());
        let allow = self.allow;
        Box::pin(async move {
            if allow {
                Approval::Allow
            } else {
                Approval::Deny { reason: None }
            }
        })
    }
}

async fn session(url: &str, bearer: &str) -> String {
    let r = post(url, Some(bearer), None, None, &init()).await;
    assert_eq!(r.status(), 200);
    r.headers()["mcp-session-id"].to_str().expect("ascii").to_owned()
}

#[tokio::test]
async fn tools_that_write_ask_for_approval_each_call() {
    for allow in [false, true] {
        let dir = project();
        let (log, seen) = recorder();
        let approver = Arc::new(Scripted {
            allow,
            asked: Mutex::new(Vec::new()),
        });
        let server = ToolServer::new(
            offered(builtin_tools(), true),
            dir.path().to_path_buf(),
            approver.clone(),
            log,
        );
        assert!(server.tool_names().iter().any(|n| n == "write"));
        let running = start(Arc::new(server)).await;
        let url = format!("{}/mcp", running.base);
        let bearer = running.bearer();
        let s = session(&url, &bearer).await;
        let r = post(
            &url,
            Some(&bearer),
            None,
            Some(&s),
            &call(2, "write", json!({"path": "new.txt", "content": "hello"})),
        )
        .await;
        let body: Value = r.json().await.expect("json");
        assert_eq!(body["result"]["isError"], !allow, "{body}");
        assert_eq!(dir.path().join("new.txt").exists(), allow);
        let r = post(&url, Some(&bearer), None, Some(&s), &call(3, "ls", json!({}))).await;
        let body: Value = r.json().await.expect("json");
        assert_eq!(body["result"]["isError"], false);
        assert_eq!(
            *approver.asked.lock().expect("lock"),
            ["write"],
            "read-only tools are not asked about"
        );
        let outcome = seen.lock().expect("lock")[0].outcome;
        assert_eq!(outcome, if allow { Outcome::Ok } else { Outcome::Denied });
    }
    // With no one to ask, a write is denied; --yes approves it.
    for (approver, created) in [
        (Arc::new(DenyAll) as Arc<dyn Approver>, false),
        (Arc::new(AllowAll), true),
    ] {
        let dir = project();
        let (log, _) = recorder();
        let server = ToolServer::new(offered(builtin_tools(), true), dir.path().to_path_buf(), approver, log);
        let running = start(Arc::new(server)).await;
        let url = format!("{}/mcp", running.base);
        let bearer = running.bearer();
        let s = session(&url, &bearer).await;
        let _ = post(
            &url,
            Some(&bearer),
            None,
            Some(&s),
            &call(2, "write", json!({"path": "y.txt", "content": "z"})),
        )
        .await;
        assert_eq!(dir.path().join("y.txt").exists(), created);
    }
}

fn bridge_log() -> (BridgeLog, Arc<Mutex<Vec<BridgeRecord>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let log: BridgeLog = Arc::new(move |r: &BridgeRecord| s.lock().expect("lock").push(r.clone()));
    (log, seen)
}

fn alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[tokio::test]
async fn the_bridge_relays_a_stdio_server_to_the_web_app() {
    let dir = tempfile::tempdir().expect("dir");
    let pid_file = dir.path().join("helper.pid");
    let (log, seen) = bridge_log();
    let bridge = Arc::new(
        Bridge::new(
            vec![stdio(
                "mock",
                &[("APARTE_MOCK_CHILD_PID_FILE", &pid_file.display().to_string())],
            )],
            ConnectOptions::new(dir.path()),
            log,
        )
        .expect("bridge"),
    );
    assert_eq!(bridge.names(), ["mock"]);
    let running = start(bridge.clone()).await;
    let url = format!("{}/mcp/mock", running.base);
    let bearer = running.bearer();
    let app = Some(APP_ORIGIN);

    let r = post(&url, Some(&bearer), Some("https://evil.example"), None, &init()).await;
    assert_eq!(r.status(), 403, "a foreign origin is refused before anything runs");
    assert!(!pid_file.exists(), "no server was started for it");
    let r = post(&url, None, app, None, &init()).await;
    assert_eq!(r.status(), 401);
    assert_eq!(r.headers()["access-control-allow-origin"], APP_ORIGIN);
    assert!(!pid_file.exists());
    let r = post(
        &format!("{}/mcp/other", running.base),
        Some(&bearer),
        app,
        None,
        &init(),
    )
    .await;
    assert_eq!(r.status(), 404, "only the servers named are bridged");

    let r = post(&url, Some(&bearer), app, None, &init()).await;
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["access-control-allow-origin"], APP_ORIGIN);
    assert_eq!(r.headers()["access-control-expose-headers"], "mcp-session-id");
    let session = r.headers()["mcp-session-id"].to_str().expect("ascii").to_owned();
    let body: Value = r.json().await.expect("json");
    assert_eq!(body["id"], 1);
    assert_eq!(body["result"]["serverInfo"]["name"], "aparte-mock");
    let s = Some(session.as_str());
    let r = post(
        &url,
        Some(&bearer),
        app,
        s,
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    )
    .await;
    assert_eq!(r.status(), 202);
    let r = post(
        &url,
        Some(&bearer),
        app,
        s,
        &json!({"jsonrpc": "2.0", "id": "two", "method": "tools/list"}),
    )
    .await;
    let body: Value = r.json().await.expect("json");
    assert_eq!(body["id"], "two");
    assert_eq!(body["result"]["tools"].as_array().map(Vec::len), Some(4));
    let r = post(
        &url,
        Some(&bearer),
        app,
        s,
        &call(3, "echo", json!({"text": "through the bridge"})),
    )
    .await;
    let body: Value = r.json().await.expect("json");
    assert_eq!(body["result"]["content"][0]["text"], "through the bridge");
    let r = post(&url, Some(&bearer), app, None, &call(4, "echo", json!({"text": "x"}))).await;
    assert_eq!(r.status(), 400, "the session id is required");
    let r = client()
        .get(&url)
        .header("authorization", &bearer)
        .header("mcp-session-id", &session)
        .send()
        .await
        .expect("get");
    assert_eq!(r.status(), 405);

    let helper = std::fs::read_to_string(&pid_file).expect("the server started a helper");
    assert!(alive(&helper));
    let r = client()
        .delete(&url)
        .header("authorization", &bearer)
        .header("origin", APP_ORIGIN)
        .header("mcp-session-id", &session)
        .send()
        .await
        .expect("delete");
    assert_eq!(r.status(), 204);
    let mut gone = false;
    for _ in 0..50 {
        if !alive(&helper) {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(gone, "ending the session kills the server's process group");
    let r = post(
        &url,
        Some(&bearer),
        app,
        s,
        &json!({"jsonrpc": "2.0", "id": 5, "method": "ping"}),
    )
    .await;
    assert_eq!(r.status(), 404);

    let log = seen.lock().expect("lock").clone();
    let methods: Vec<&str> = log.iter().map(|r| r.method.as_str()).collect();
    assert!(
        methods.starts_with(&["initialize", "notifications/initialized", "tools/list", "tools/call"]),
        "{methods:?}"
    );
    assert_eq!(log[3].tool.as_deref(), Some("echo"));

    // The MCP client of this crate goes through the bridge as well.
    let config = http_config("bridged", &url, Some(running.token.display().as_str()));
    let conn = connect(&config, &ConnectOptions::new(dir.path()))
        .await
        .expect("connect");
    assert_eq!(conn.tools.len(), 4);
    conn.shutdown().await;
    bridge.shutdown().await;
}

#[tokio::test]
async fn the_bridge_relays_an_http_server_without_cors() {
    let mock = aparte_mcp::mock::serve_http(aparte_mcp::mock::MockOptions::default())
        .await
        .expect("mock");
    let dir = tempfile::tempdir().expect("dir");
    let (log, _) = bridge_log();
    let bridge = Bridge::new(
        vec![http_config("remote", &mock.url(), None)],
        ConnectOptions::new(dir.path()),
        log,
    )
    .expect("bridge");
    let running = start(Arc::new(bridge)).await;
    let url = format!("{}/mcp/remote", running.base);
    let bearer = running.bearer();
    let app = Some("http://127.0.0.1:4173");
    let r = post(&url, Some(&bearer), app, None, &init()).await;
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["access-control-allow-origin"], "http://127.0.0.1:4173");
    assert_eq!(
        r.headers()["mcp-session-id"],
        "mock-session",
        "the server's session id is passed through"
    );
    let r = post(
        &url,
        Some(&bearer),
        app,
        Some("mock-session"),
        &call(2, "add", json!({"a": 1, "b": 2})),
    )
    .await;
    let body: Value = r.json().await.expect("json");
    assert_eq!(body["result"]["content"][0]["text"], "3");
    let r = post(
        &url,
        Some(&bearer),
        app,
        Some("mock-session"),
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    )
    .await;
    assert_eq!(r.status(), 202);
    let seen = mock.seen();
    assert!(seen.iter().all(|l| l == "POST /mcp"), "{seen:?}");

    // An upstream that wants a login is not reported as a wrong bridge token.
    let guarded = aparte_mcp::mock::serve_http(aparte_mcp::mock::MockOptions {
        variant: 1,
        oauth: true,
    })
    .await
    .expect("mock");
    let (log, _) = bridge_log();
    let bridge = Bridge::new(
        vec![http_config("locked", &guarded.url(), None)],
        ConnectOptions::new(dir.path()),
        log,
    )
    .expect("bridge");
    let running = start(Arc::new(bridge)).await;
    let r = post(
        &format!("{}/mcp/locked", running.base),
        Some(&running.bearer()),
        app,
        None,
        &init(),
    )
    .await;
    assert_eq!(r.status(), 502);
    let body: Value = r.json().await.expect("json");
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("aparte mcp login locked")),
        "{body}"
    );
}

#[tokio::test]
async fn the_bridge_refuses_disabled_and_misconfigured_servers() {
    let dir = tempfile::tempdir().expect("dir");
    let (log, _) = bridge_log();
    let mut disabled = stdio("off", &[]);
    disabled.disabled = true;
    assert!(Bridge::new(vec![disabled], ConnectOptions::new(dir.path()), log.clone()).is_err());
    let plain = http_config("plain", "http://example.com/mcp", None);
    assert!(
        Bridge::new(vec![plain], ConnectOptions::new(dir.path()), log).is_err(),
        "http is for the loopback only"
    );
}
