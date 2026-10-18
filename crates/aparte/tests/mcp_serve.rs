//! `aparte mcp serve`, `aparte mcp bridge` and `aparte mcp token` through the binary: the flags, the token shown
//! once on stderr and never on stdout, the read-only default, writes denied without a terminal, `--token-file`, and
//! the bridge relaying the stdio mock of `aparte-mcp` to the web app's origin only.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use assert_cmd::Command;
use serde_json::{Value, json};

struct Env {
    home: tempfile::TempDir,
    project: tempfile::TempDir,
}

impl Env {
    fn new() -> Env {
        let env = Env {
            home: tempfile::tempdir().expect("home"),
            project: tempfile::tempdir().expect("project"),
        };
        std::fs::write(env.project.path().join("notes.txt"), "a line\n").expect("write");
        env
    }

    fn apply<'a>(&self, c: &'a mut StdCommand) -> &'a mut StdCommand {
        c.current_dir(self.project.path())
            .env("HOME", self.home.path())
            .env("APARTE_CONFIG_DIR", self.home.path().join("config"))
            .env("APARTE_DATA_DIR", self.home.path().join("data"))
            .env("APARTE_NO_KEYCHAIN", "1")
            .env("NO_COLOR", "1")
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("XDG_DATA_HOME")
            .env_remove("APARTE_LOG")
            .env_remove("APARTE_MCP_TOKEN")
    }

    fn cmd(&self) -> Command {
        let mut c = StdCommand::new(env!("CARGO_BIN_EXE_aparte"));
        self.apply(&mut c);
        Command::from_std(c)
    }

    /// Starts a long-running verb with stdin closed (no terminal) and its output read line by line.
    fn spawn(&self, args: &[&str]) -> Running {
        let mut c = StdCommand::new(env!("CARGO_BIN_EXE_aparte"));
        self.apply(&mut c)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = c.spawn().expect("spawn");
        let stdout = lines(child.stdout.take().expect("stdout"));
        let stderr = lines(child.stderr.take().expect("stderr"));
        Running {
            child,
            stdout,
            stderr,
            out_seen: Vec::new(),
            err_seen: Vec::new(),
        }
    }
}

fn lines(r: impl Read + Send + 'static) -> Receiver<String> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for line in BufReader::new(r).lines() {
            let Ok(line) = line else {
                break;
            };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

struct Running {
    child: Child,
    stdout: Receiver<String>,
    stderr: Receiver<String>,
    out_seen: Vec<String>,
    err_seen: Vec<String>,
}

fn is_token(line: &str) -> bool {
    let t = line.trim();
    t.len() == 64
        && t.split('-').count() == 13
        && t.split('-')
            .all(|g| g.len() == 4 && g.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)))
}

impl Running {
    /// The first JSON event on stdout.
    fn event(&mut self) -> Value {
        let line = self
            .stdout
            .recv_timeout(Duration::from_secs(60))
            .unwrap_or_else(|_| panic!("no event; stderr: {:?}", self.drain_err()));
        self.out_seen.push(line.clone());
        serde_json::from_str(&line).expect("a JSON event")
    }

    /// Reads stderr until a token line.
    fn token(&mut self) -> String {
        loop {
            let line = self
                .stderr
                .recv_timeout(Duration::from_secs(30))
                .unwrap_or_else(|_| panic!("no token; stderr: {:?}", self.err_seen));
            self.err_seen.push(line.clone());
            if is_token(&line) {
                return line.trim().to_owned();
            }
        }
    }

    fn drain_err(&mut self) -> Vec<String> {
        while let Ok(l) = self.stderr.recv_timeout(Duration::from_millis(200)) {
            self.err_seen.push(l);
        }
        self.err_seen.clone()
    }

    /// Stops the process and returns everything it wrote on stdout and stderr.
    fn stop(mut self) -> (Vec<String>, Vec<String>) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        while let Ok(l) = self.stdout.recv_timeout(Duration::from_millis(500)) {
            self.out_seen.push(l);
        }
        self.drain_err();
        (self.out_seen, self.err_seen)
    }
}

/// One HTTP/1.1 request over a fresh connection; returns the status, the headers (lowercase names) and the body.
fn http(
    addr: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, Vec<(String, String)>, String) {
    let mut s = TcpStream::connect(addr).expect("connect");
    s.set_read_timeout(Some(Duration::from_secs(30))).expect("timeout");
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nhost: {addr}\r\nconnection: close\r\ncontent-length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).expect("write");
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).expect("read");
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|c| c.parse().ok())
        .expect("a status");
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    (status, headers, body.to_owned())
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

fn rpc(id: u32, method: &str, params: Value) -> String {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
}

fn addr_of(url: &str) -> (String, String) {
    let rest = url.strip_prefix("http://").expect("http");
    let (addr, path) = rest.split_once('/').expect("path");
    (addr.to_owned(), format!("/{path}"))
}

const JSON: (&str, &str) = ("content-type", "application/json");

/// Initializes a session and returns its id.
fn initialize(addr: &str, path: &str, bearer: &str, origin: Option<&str>) -> String {
    let mut h = vec![JSON, ("authorization", bearer)];
    if let Some(o) = origin {
        h.push(("origin", o));
    }
    let (status, headers, body) = http(
        addr,
        "POST",
        path,
        &h,
        &rpc(1, "initialize", json!({"protocolVersion": "2025-06-18"})),
    );
    assert_eq!(status, 200, "{body}");
    header(&headers, "mcp-session-id").expect("a session").to_owned()
}

#[test]
fn the_verbs_and_their_flags() {
    let env = Env::new();
    let help = env.cmd().args(["mcp", "serve", "--help"]).output().expect("run");
    let text = String::from_utf8_lossy(&help.stdout);
    for flag in ["--port", "--allow-write", "--yes", "--token-file"] {
        assert!(text.contains(flag), "{flag} in {text}");
    }
    env.cmd().args(["mcp", "bridge"]).assert().code(2);
    env.cmd().args(["mcp", "serve", "--yes"]).assert().code(2);
    env.cmd()
        .args(["mcp", "bridge", "nothing-here", "--port", "0"])
        .assert()
        .code(1)
        .stderr(predicates::str::contains("no MCP server named"));
    let out = env.cmd().args(["mcp", "token"]).output().expect("run");
    let a = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let out = env.cmd().args(["mcp", "token"]).output().expect("run");
    let b = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    assert!(is_token(&a) && is_token(&b) && a != b);
}

#[test]
fn serve_shows_the_token_once_on_stderr_and_offers_read_only_tools() {
    let env = Env::new();
    let mut run = env.spawn(&["--json", "mcp", "serve", "--port", "0"]);
    let event = run.event();
    assert_eq!(event["event"], "mcp-serve");
    let url = event["url"].as_str().expect("url").to_owned();
    assert!(url.starts_with("http://127.0.0.1:") && url.ends_with("/mcp"), "{url}");
    assert_eq!(event["tools"], json!(["read", "grep", "find", "ls", "git"]));
    let token = run.token();
    assert!(!url.contains(&token));
    let (addr, path) = addr_of(&url);
    let bearer = format!("Bearer {token}");

    let (status, _, _) = http(&addr, "POST", &path, &[JSON], &rpc(1, "initialize", json!({})));
    assert_eq!(status, 401);
    let in_query = format!("{path}?token={token}");
    let (status, _, _) = http(&addr, "POST", &in_query, &[JSON], &rpc(1, "initialize", json!({})));
    assert_eq!(status, 400, "a token in the URL is refused");
    let session = initialize(&addr, &path, &bearer, None);
    let auth = [
        JSON,
        ("authorization", bearer.as_str()),
        ("mcp-session-id", session.as_str()),
    ];
    let (_, _, body) = http(
        &addr,
        "POST",
        &path,
        &auth,
        &rpc(2, "tools/call", json!({"name": "ls", "arguments": {}})),
    );
    let v: Value = serde_json::from_str(&body).expect("json");
    assert!(
        v["result"]["content"][0]["text"]
            .as_str()
            .is_some_and(|t| t.contains("notes.txt")),
        "{v}"
    );
    let (_, _, body) = http(
        &addr,
        "POST",
        &path,
        &auth,
        &rpc(
            3,
            "tools/call",
            json!({"name": "write", "arguments": {"path": "x", "content": "y"}}),
        ),
    );
    assert!(body.contains("unknown tool"), "{body}");

    let (out, err) = run.stop();
    assert!(out.iter().all(|l| !l.contains(&token)), "the token is never on stdout");
    assert!(
        out.iter().all(|l| serde_json::from_str::<Value>(l).is_ok()),
        "stdout is JSON only: {out:?}"
    );
    assert!(out.iter().any(|l| l.contains("\"mcp-call\"") && l.contains("\"ls\"")));
    assert_eq!(
        err.iter().filter(|l| l.contains(&token)).count(),
        1,
        "shown once: {err:?}"
    );
    assert!(
        err.iter().any(|l| l.contains("call ls")),
        "calls are logged on stderr: {err:?}"
    );
}

#[test]
fn without_a_terminal_writes_are_denied_and_a_token_file_is_used() {
    let env = Env::new();
    let out = env.cmd().args(["mcp", "token"]).output().expect("run");
    let token = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let file = env.home.path().join("token");
    std::fs::write(&file, format!("{token}\n")).expect("write");
    let bad = env.home.path().join("bad");
    std::fs::write(&bad, "short").expect("write");
    env.cmd()
        .args(["mcp", "serve", "--port", "0", "--token-file"])
        .arg(&bad)
        .assert()
        .code(1)
        .stderr(predicates::str::contains("does not hold a token"));

    let file_arg = file.display().to_string();
    let mut run = env.spawn(&[
        "--json",
        "mcp",
        "serve",
        "--port",
        "0",
        "--allow-write",
        "--token-file",
        &file_arg,
    ]);
    let event = run.event();
    let names: Vec<&str> = event["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(names.contains(&"write") && names.contains(&"bash"));
    assert!(event["approvals"].as_str().is_some_and(|a| a.starts_with("denied")));
    let (addr, path) = addr_of(event["url"].as_str().expect("url"));
    let bearer = format!("Bearer {token}");
    let session = initialize(&addr, &path, &bearer, None);
    let auth = [
        JSON,
        ("authorization", bearer.as_str()),
        ("mcp-session-id", session.as_str()),
    ];
    let (_, _, body) = http(
        &addr,
        "POST",
        &path,
        &auth,
        &rpc(
            2,
            "tools/call",
            json!({"name": "write", "arguments": {"path": "new.txt", "content": "y"}}),
        ),
    );
    let v: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(v["result"]["isError"], true, "{v}");
    assert!(!env.project.path().join("new.txt").exists(), "no one approved it");
    let (out, err) = run.stop();
    assert!(
        err.iter().all(|l| !l.contains(&token)),
        "a token from a file is not shown: {err:?}"
    );
    assert!(out.iter().all(|l| !l.contains(&token)));
    assert!(
        err.iter().any(|l| l.contains("call write") && l.contains("denied")),
        "{err:?}"
    );
}

/// The stdio mock of `aparte-mcp`, built with the workspace's examples (built here if missing).
fn mock_server() -> PathBuf {
    let exe = std::env::current_exe().expect("exe");
    let profile = exe.parent().and_then(Path::parent).expect("target/<profile>");
    let bin = profile
        .join("examples")
        .join(format!("mcp_mock_stdio{}", std::env::consts::EXE_SUFFIX));
    if !bin.is_file() {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = StdCommand::new(cargo)
            .args(["build", "-p", "aparte-mcp", "--example", "mcp_mock_stdio"])
            .status()
            .expect("cargo build");
        assert!(status.success());
    }
    bin
}

#[test]
fn the_bridge_relays_a_configured_server_to_the_web_app_only() {
    let env = Env::new();
    let server = mock_server();
    env.cmd()
        .args(["mcp", "add", "mock", "--"])
        .arg(&server)
        .assert()
        .success();
    let mut run = env.spawn(&["--json", "mcp", "bridge", "mock", "--port", "0"]);
    let event = run.event();
    assert_eq!(event["event"], "mcp-bridge");
    let url = event["servers"][0]["url"].as_str().expect("url").to_owned();
    assert!(
        url.starts_with("http://127.0.0.1:") && url.ends_with("/mcp/mock"),
        "{url}"
    );
    let token = run.token();
    let (addr, path) = addr_of(&url);
    let bearer = format!("Bearer {token}");
    let app = "https://maxgfr.github.io";

    let refused = [
        JSON,
        ("authorization", bearer.as_str()),
        ("origin", "https://maxgfr.github.io.evil.example"),
    ];
    let (status, headers, _) = http(&addr, "POST", &path, &refused, &rpc(1, "initialize", json!({})));
    assert_eq!(status, 403);
    assert!(header(&headers, "access-control-allow-origin").is_none());
    let (status, headers, _) = http(
        &addr,
        "OPTIONS",
        &path,
        &[
            ("origin", app),
            ("access-control-request-method", "POST"),
            ("access-control-request-private-network", "true"),
        ],
        "",
    );
    assert_eq!(status, 204);
    assert_eq!(header(&headers, "access-control-allow-origin"), Some(app));
    assert_eq!(header(&headers, "access-control-allow-private-network"), Some("true"));

    let session = initialize(&addr, &path, &bearer, Some(app));
    let auth = [
        JSON,
        ("authorization", bearer.as_str()),
        ("origin", app),
        ("mcp-session-id", session.as_str()),
    ];
    let (status, headers, body) = http(
        &addr,
        "POST",
        &path,
        &auth,
        &rpc(
            2,
            "tools/call",
            json!({"name": "echo", "arguments": {"text": "relayed"}}),
        ),
    );
    assert_eq!(status, 200);
    assert_eq!(header(&headers, "access-control-allow-origin"), Some(app));
    let v: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(v["result"]["content"][0]["text"], "relayed");
    let (out, err) = run.stop();
    assert!(out.iter().all(|l| !l.contains(&token)));
    assert!(
        out.iter()
            .any(|l| l.contains("\"mcp-relay\"") && l.contains("\"echo\"")),
        "{out:?}"
    );
    assert_eq!(err.iter().filter(|l| l.contains(&token)).count(), 1);
}
