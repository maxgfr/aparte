//! The agent modes of the binary against a local mock of the provider APIs: print mode, the JSON event stream, RPC,
//! tool calls and approvals, exit codes, and keys kept out of every log.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::thread::JoinHandle;

use assert_cmd::Command;
use serde_json::Value;

fn spec(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../spec/sse")
            .join(name),
    )
    .expect("fixture")
}

const TOOL_USE: &str = r#"event: message_start
data: {"type":"message_start","message":{"id":"msg_t","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":5,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"TOOL","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"INPUT"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":9}}

event: message_stop
data: {"type":"message_stop"}

"#;

fn tool_use(tool: &str, input: &Value) -> Vec<u8> {
    let escaped = serde_json::to_string(&input.to_string()).expect("json");
    TOOL_USE
        .replace("TOOL", tool)
        .replace("\"INPUT\"", &escaped)
        .into_bytes()
}

/// A request the mock received.
#[derive(Debug)]
struct Seen {
    head: String,
    body: Value,
}

/// Serves the given responses in order, one per connection.
fn mock(responses: Vec<(u16, &'static str, Vec<u8>)>) -> (String, JoinHandle<Vec<Seen>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("addr"));
    let handle = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for (status, ctype, body) in responses {
            let Ok((mut sock, _)) = listener.accept() else {
                break;
            };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            let (head, body_start, len) = loop {
                let n = sock.read(&mut chunk).expect("read");
                if n == 0 {
                    break (String::new(), 0, 0);
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
                    let len = head
                        .to_lowercase()
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                        .unwrap_or(0);
                    break (head, end + 4, len);
                }
            };
            while buf.len() < body_start + len {
                let n = sock.read(&mut chunk).expect("read body");
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let request = serde_json::from_slice(&buf[body_start..]).unwrap_or(Value::Null);
            seen.push(Seen { head, body: request });
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: {ctype}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(reply.as_bytes());
            let _ = sock.write_all(&body);
        }
        seen
    });
    (url, handle)
}

fn sse(body: Vec<u8>) -> (u16, &'static str, Vec<u8>) {
    (200, "text/event-stream", body)
}

struct Env {
    home: tempfile::TempDir,
    project: tempfile::TempDir,
}

impl Env {
    fn new() -> Env {
        Env {
            home: tempfile::tempdir().expect("home"),
            project: tempfile::tempdir().expect("project"),
        }
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
            .env_remove("APARTE_PROVIDER")
            .env_remove("APARTE_MODEL")
            .env_remove("APARTE_BASE_URL");
        for var in [
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
        ] {
            c.env_remove(var);
        }
        c
    }

    fn cmd(&self) -> Command {
        let mut c = StdCommand::new(env!("CARGO_BIN_EXE_aparte"));
        self.apply(&mut c);
        Command::from_std(c)
    }

    fn project(&self) -> &Path {
        self.project.path()
    }
}

#[test]
fn print_mode_streams_the_answer() {
    let (url, server) = mock(vec![sse(spec("anthropic-text.sse"))]);
    let env = Env::new();
    let out = env
        .cmd()
        .args([
            "--base-url",
            &url,
            "--no-tools",
            "--effort",
            "high",
            "-p",
            "What is the capital of France?",
        ])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "The capital of France is **Paris**.\n"
    );
    let seen = server.join().expect("server");
    let body = &seen[0].body;
    assert!(seen[0].head.starts_with("POST /messages "));
    assert_eq!(body["model"], "claude-opus-5-5");
    assert_eq!(body["stream"], true);
    assert_eq!(body["thinking"]["type"], "adaptive");
    assert_eq!(body["output_config"]["effort"], "high");
    assert!(body.get("temperature").is_none());
    assert_eq!(
        body["messages"][0]["content"][0]["text"],
        "What is the capital of France?"
    );
}

#[test]
fn the_api_key_is_sent_but_never_logged() {
    let (url, server) = mock(vec![sse(spec("anthropic-text.sse"))]);
    let env = Env::new();
    let secret = "sk-ant-api03-very-secret-test-key";
    let out = env
        .cmd()
        .env("ANTHROPIC_API_KEY", secret)
        .env("APARTE_LOG", "trace")
        .args(["-vv", "--json", "--base-url", &url, "--no-tools", "-p", "hi"])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0));
    let all = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!all.contains("very-secret"), "the key leaked into the output");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("provider call"),
        "trace logs were on"
    );
    let seen = server.join().expect("server");
    assert!(seen[0].head.to_lowercase().contains(&format!("x-api-key: {secret}")));
}

#[test]
fn json_mode_prints_one_event_per_line() {
    let (url, _server) = mock(vec![sse(spec("anthropic-thinking.sse"))]);
    let env = Env::new();
    let out = env
        .cmd()
        .args(["--json", "--base-url", &url, "--no-tools", "-p", "Is 1009 prime?"])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0));
    let events: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).expect("every line is JSON"))
        .collect();
    let kinds: Vec<&str> = events.iter().filter_map(|e| e["event"].as_str()).collect();
    assert_eq!(kinds.first(), Some(&"agent-start"));
    assert_eq!(kinds.last(), Some(&"agent-end"));
    assert!(kinds.contains(&"reasoning-delta") && kinds.contains(&"text-delta"));
    let message = events.iter().find(|e| e["event"] == "message-end").expect("message");
    let reasoning = &message["message"]["content"][0];
    assert_eq!(reasoning["type"], "reasoning");
    assert!(
        reasoning["providerMeta"]["anthropic"]["signature"]
            .as_str()
            .is_some_and(|s| s.starts_with("EqRjeh")),
        "the signature is kept for replay"
    );
}

#[test]
fn a_missing_key_exits_with_the_auth_code() {
    let env = Env::new();
    env.cmd()
        .args(["-p", "hi"])
        .assert()
        .code(8)
        .stderr(predicates::str::contains("ANTHROPIC_API_KEY"));
}

#[test]
fn a_refused_key_exits_with_the_auth_code() {
    let (url, _server) = mock(vec![(401, "application/json", spec("anthropic-auth-error.json"))]);
    let env = Env::new();
    env.cmd()
        .args(["--base-url", &url, "--no-tools", "-p", "hi"])
        .assert()
        .code(8)
        .stderr(predicates::str::contains("invalid x-api-key"));
}

#[test]
fn a_refusal_exits_with_its_own_code() {
    let (url, _server) = mock(vec![sse(spec("anthropic-refusal.sse"))]);
    let env = Env::new();
    env.cmd()
        .args(["--base-url", &url, "--no-tools", "-p", "hi"])
        .assert()
        .code(9)
        .stderr(predicates::str::contains("cyber"));
}

#[test]
fn an_overloaded_stream_exits_with_the_network_code() {
    let (url, _server) = mock(vec![sse(spec("anthropic-error.sse"))]);
    let env = Env::new();
    env.cmd()
        .args(["--base-url", &url, "--no-tools", "-p", "hi"])
        .assert()
        .code(3);
}

#[test]
fn an_effort_the_model_does_not_take_is_refused_before_any_call() {
    let env = Env::new();
    env.cmd()
        .args([
            "--base-url",
            "http://127.0.0.1:9",
            "--no-tools",
            "--effort",
            "minimal",
            "-p",
            "hi",
        ])
        .assert()
        .code(1)
        .stdout(predicates::str::is_empty())
        .stderr(predicates::str::contains("does not take effort minimal"));
}

#[test]
fn tool_calls_run_and_their_results_go_back() {
    let (url, server) = mock(vec![
        sse(tool_use("ls", &serde_json::json!({"path": "."}))),
        sse(spec("anthropic-text.sse")),
    ]);
    let env = Env::new();
    std::fs::write(env.project().join("hello.txt"), "hi").expect("file");
    let out = env
        .cmd()
        .args(["--base-url", &url, "--tools", "ls,read", "-p", "list"])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stderr).contains("▸ ls ."));
    let seen = server.join().expect("server");
    assert_eq!(seen.len(), 2);
    let tools: Vec<&str> = seen[0].body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert_eq!(tools, ["read", "ls"]);
    let last = seen[1].body["messages"]
        .as_array()
        .and_then(|m| m.last())
        .expect("message");
    assert_eq!(last["content"][0]["type"], "tool_result");
    assert_eq!(last["content"][0]["tool_use_id"], "toolu_1");
    assert!(
        last["content"][0]["content"]
            .as_str()
            .is_some_and(|c| c.contains("hello.txt"))
    );
}

#[test]
fn writes_need_approval_in_print_mode() {
    let (url, server) = mock(vec![
        sse(tool_use(
            "write",
            &serde_json::json!({"path": "made.txt", "content": "x"}),
        )),
        sse(spec("anthropic-text.sse")),
    ]);
    let env = Env::new();
    env.cmd().args(["--base-url", &url, "-p", "write it"]).assert().code(0);
    assert!(
        !env.project().join("made.txt").exists(),
        "the write ran without approval"
    );
    let seen = server.join().expect("server");
    let result = &seen[1].body["messages"]
        .as_array()
        .and_then(|m| m.last())
        .expect("message")["content"][0];
    assert_eq!(result["is_error"], true);
    assert!(result["content"].as_str().is_some_and(|c| c.contains("denied")));
}

#[test]
fn yes_approves_writes() {
    let (url, _server) = mock(vec![
        sse(tool_use(
            "write",
            &serde_json::json!({"path": "made.txt", "content": "x"}),
        )),
        sse(spec("anthropic-text.sse")),
    ]);
    let env = Env::new();
    let export = env.project().join("session.jsonl");
    env.cmd()
        .args(["--base-url", &url, "--yes", "--export"])
        .arg(&export)
        .args(["-p", "write it"])
        .assert()
        .code(0);
    assert_eq!(
        std::fs::read_to_string(env.project().join("made.txt")).expect("written"),
        "x"
    );
    let text = std::fs::read_to_string(&export).expect("export");
    let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).expect("jsonl")).collect();
    assert_eq!(lines[0]["type"], "session");
    assert_eq!(lines.len(), 1 + 4, "user, tool call, tool result, answer");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&export).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[test]
fn openai_compatible_and_gemini_providers_work_too() {
    let (url, server) = mock(vec![sse(spec("openai-compatible-text.sse"))]);
    let env = Env::new();
    env.cmd()
        .args(["--provider", "groq", "--base-url", &url, "--no-tools", "-p", "hi"])
        .assert()
        .code(0)
        .stdout("Bonjour means hello.\n");
    let seen = server.join().expect("server");
    assert!(seen[0].head.starts_with("POST /chat/completions "));
    assert_eq!(seen[0].body["stream_options"]["include_usage"], true);

    let (url, server) = mock(vec![sse(spec("gemini-text.sse"))]);
    env.cmd()
        .args([
            "--provider",
            "google",
            "--model",
            "gemini-3-flash",
            "--base-url",
            &url,
            "--no-tools",
            "-p",
            "rain",
        ])
        .assert()
        .code(0)
        .stdout(predicates::str::starts_with("A haiku about rain:"));
    let seen = server.join().expect("server");
    assert!(
        seen[0]
            .head
            .starts_with("POST /models/gemini-3-flash:streamGenerateContent?alt=sse ")
    );
}

#[test]
fn rpc_runs_prompts_and_answers_commands() {
    let (url, _server) = mock(vec![sse(spec("anthropic-text.sse"))]);
    let env = Env::new();
    let mut c = StdCommand::new(env!("CARGO_BIN_EXE_aparte"));
    env.apply(&mut c);
    let mut child = c
        .args(["rpc", "--base-url", &url, "--no-tools"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut lines = BufReader::new(child.stdout.take().expect("stdout")).lines();
    let mut next = || -> Value {
        let line = lines.next().expect("a line").expect("read");
        serde_json::from_str(&line).expect("JSON line")
    };
    assert_eq!(next()["event"], "ready");
    writeln!(stdin, r#"{{"type":"prompt","message":"capital?","id":1}}"#).expect("write");
    let mut text = String::new();
    loop {
        let ev = next();
        if ev["event"] == "response" {
            assert_eq!(
                (ev["id"].clone(), ev["success"].clone()),
                (Value::from(1), Value::from(true))
            );
        }
        if ev["event"] == "text-delta" {
            text.push_str(ev["text"].as_str().unwrap_or_default());
        }
        if ev["event"] == "agent-end" {
            assert_eq!(ev["reason"], "done");
            break;
        }
    }
    assert_eq!(text, "The capital of France is **Paris**.");
    writeln!(stdin, r#"{{"type":"get_messages","id":"m"}}"#).expect("write");
    let ev = next();
    assert_eq!(ev["command"], "get_messages");
    assert_eq!(ev["messages"].as_array().map(Vec::len), Some(2));
    writeln!(stdin, "not json").expect("write");
    assert_eq!(next()["success"], false);
    writeln!(stdin, r#"{{"type":"set_effort","effort":"max"}}"#).expect("write");
    assert_eq!(next()["success"], true);
    writeln!(stdin, r#"{{"type":"quit"}}"#).expect("write");
    assert_eq!(next()["command"], "quit");
    drop(stdin);
    assert!(child.wait().expect("wait").success());
}

#[test]
fn models_lists_presets_with_effort_levels() {
    let env = Env::new();
    let out = env
        .cmd()
        .args(["--json", "models", "--provider", "anthropic"])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0));
    let events: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).expect("json"))
        .collect();
    let opus = events.iter().find(|e| e["id"] == "claude-opus-5-5").expect("opus");
    assert_eq!(opus["default"], true);
    assert_eq!(
        opus["effort"],
        serde_json::json!(["low", "medium", "high", "xhigh", "max"])
    );
}

#[test]
fn models_remote_lists_the_provider_models() {
    let body = br#"{"data":[{"id":"claude-opus-5-5"},{"id":"claude-haiku-5-5"}],"has_more":false}"#.to_vec();
    let (url, server) = mock(vec![(200, "application/json", body)]);
    let env = Env::new();
    env.cmd()
        .args(["models", "--remote", "--base-url", &url])
        .assert()
        .code(0)
        .stdout("claude-haiku-5-5\nclaude-opus-5-5\n");
    assert!(
        server.join().expect("server")[0]
            .head
            .starts_with("GET /models?limit=1000 ")
    );
}

#[test]
fn trust_is_recorded_privately() {
    let env = Env::new();
    env.cmd().arg("trust").assert().code(0);
    let out = env.cmd().args(["--json", "trust", "--list"]).output().expect("run");
    let line: Value =
        serde_json::from_str(String::from_utf8_lossy(&out.stdout).lines().next().expect("a line")).expect("json");
    assert_eq!(line["trusted"], true);
    let file = env.home.path().join("config/trust.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).expect("trust file").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir = std::fs::metadata(env.home.path().join("config"))
            .expect("dir")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir, 0o700);
    }
}

#[test]
fn a_trusted_project_runs_edits_without_asking() {
    let (url, _server) = mock(vec![
        sse(tool_use(
            "edit",
            &serde_json::json!({"path": "a.txt", "edits": [{"old_text": "old", "new_text": "new"}]}),
        )),
        sse(spec("anthropic-text.sse")),
    ]);
    let env = Env::new();
    std::fs::write(env.project().join("a.txt"), "old\n").expect("file");
    env.cmd().arg("trust").assert().code(0);
    env.cmd().args(["--base-url", &url, "-p", "edit"]).assert().code(0);
    assert_eq!(
        std::fs::read_to_string(env.project().join("a.txt")).expect("file"),
        "new\n"
    );
}

#[test]
fn the_interface_needs_a_terminal() {
    let env = Env::new();
    env.cmd()
        .env("ANTHROPIC_API_KEY", "sk-test")
        .write_stdin("")
        .assert()
        .code(1)
        .stderr(predicates::str::contains("no terminal"));
}
