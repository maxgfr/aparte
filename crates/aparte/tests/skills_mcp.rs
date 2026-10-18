//! Skills and MCP servers through the binary: the verbs, the `<available_skills>` block and the `skill` tool, skill
//! scripts run by `bash` only when approved, `/skill:<name>` prompts, and MCP tools called in print and RPC modes
//! against the mock server of `aparte-mcp`.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::thread::JoinHandle;

use assert_cmd::Command;
use serde_json::{Value, json};

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

fn tool_use(tool: &str, input: &Value) -> (u16, &'static str, Vec<u8>) {
    let escaped = serde_json::to_string(&input.to_string()).expect("json");
    let body = TOOL_USE
        .replace("TOOL", tool)
        .replace("\"INPUT\"", &escaped)
        .into_bytes();
    (200, "text/event-stream", body)
}

fn text() -> (u16, &'static str, Vec<u8>) {
    (200, "text/event-stream", spec("anthropic-text.sse"))
}

/// Serves the given responses in order, one per connection; returns the request bodies.
fn mock(responses: Vec<(u16, &'static str, Vec<u8>)>) -> (String, JoinHandle<Vec<Value>>) {
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
            let (start, len) = loop {
                let n = sock.read(&mut chunk).expect("read");
                if n == 0 {
                    break (0, 0);
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                        .unwrap_or(0);
                    break (end + 4, len);
                }
            };
            while buf.len() < start + len {
                let n = sock.read(&mut chunk).expect("read body");
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            seen.push(serde_json::from_slice(&buf[start..]).unwrap_or(Value::Null));
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
            .env_remove("APARTE_BASE_URL")
            .env_remove("ANTHROPIC_API_KEY")
    }

    fn cmd(&self) -> Command {
        let mut c = StdCommand::new(env!("CARGO_BIN_EXE_aparte"));
        self.apply(&mut c);
        Command::from_std(c)
    }

    fn json(&self, args: &[&str]) -> Vec<Value> {
        let out = self.cmd().arg("--json").args(args).output().expect("run");
        assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| serde_json::from_str(l).expect("JSON line"))
            .collect()
    }

    fn project(&self) -> &Path {
        self.project.path()
    }

    /// A skill under `<root>/<name>` with a script.
    fn skill(&self, root: &Path, name: &str, extra: &str) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(dir.join("scripts")).expect("mkdir");
        std::fs::write(
            dir.join("SKILL.md"),
            format!(
                "---\nname: {name}\ndescription: Greets people by name when asked for a greeting.\n{extra}---\n# {name}\n\nRun `sh <skill-dir>/scripts/hello.sh NAME` and repeat what it prints.\n"
            ),
        )
        .expect("write");
        std::fs::write(dir.join("scripts/hello.sh"), "echo \"hello, $1\"\n").expect("script");
        dir.canonicalize().expect("canonical")
    }
}

fn sandbox_flags() -> Vec<&'static str> {
    let bwrap = || {
        StdCommand::new("bwrap")
            .args(["--ro-bind", "/", "/", "true"])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    if cfg!(target_os = "macos") || cfg!(target_os = "linux") && bwrap() {
        Vec::new()
    } else {
        vec!["--no-sandbox"]
    }
}

fn last_result(body: &Value) -> Value {
    body["messages"]
        .as_array()
        .and_then(|m| m.last())
        .map(|m| m["content"][0].clone())
        .expect("a tool result")
}

#[test]
fn skills_are_listed_with_their_scope_and_trust() {
    let env = Env::new();
    env.skill(&env.home.path().join(".agents/skills"), "greet", "");
    env.skill(&env.project().join(".agents/skills"), "local", "");
    env.skill(
        &env.home.path().join(".claude/skills"),
        "manual",
        "disable-model-invocation: true\n",
    );
    let events = env.json(&["skills", "list"]);
    let by_name = |n: &str| events.iter().find(|e| e["name"] == n).cloned().expect(n);
    assert_eq!(by_name("greet")["offered"], true);
    assert_eq!(by_name("greet")["scope"], "user");
    assert_eq!(by_name("local")["scope"], "project");
    assert_eq!(by_name("local")["offered"], false, "an untrusted project's skills wait");
    assert_eq!(by_name("manual")["offered"], false);
    env.cmd().arg("trust").assert().code(0);
    let events = env.json(&["skills", "list"]);
    assert!(events.iter().any(|e| e["name"] == "local" && e["offered"] == true));

    let show = env.json(&["skills", "show", "greet"]);
    assert!(show[0]["body"].as_str().is_some_and(|b| b.contains("scripts/hello.sh")));
    assert_eq!(show[0]["files"], json!(["scripts/hello.sh"]));
    env.cmd().args(["skills", "show", "nope"]).assert().code(1);
    let dirs = env.json(&["skills", "path"]);
    assert!(
        dirs.iter()
            .any(|d| d["path"].as_str().is_some_and(|p| p.ends_with(".agents/skills")) && d["exists"] == true)
    );
}

#[test]
fn the_model_loads_a_skill_then_its_script_runs_only_when_approved() {
    let env = Env::new();
    let dir = env.skill(&env.home.path().join(".agents/skills"), "greet", "");
    let script = format!("sh {}/scripts/hello.sh Ada", dir.display());
    // Without approval (print mode, no --yes), the script is not run.
    let (url, server) = mock(vec![
        tool_use("skill", &json!({"name": "greet"})),
        tool_use("bash", &json!({"command": script})),
        text(),
    ]);
    let out = env
        .cmd()
        .args(["--base-url", &url, "-p", "greet Ada"])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    let seen = server.join().expect("server");
    let system = seen[0]["system"].to_string();
    assert!(
        system.contains("<available_skills>") && system.contains("<name>greet</name>"),
        "{system}"
    );
    let tools: Vec<&str> = seen[0]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(tools.contains(&"skill"));
    let loaded = last_result(&seen[1]);
    let instructions = loaded["content"].as_str().expect("text");
    assert!(
        instructions.contains(&format!("sh {}/scripts/hello.sh NAME", dir.display())),
        "{instructions}"
    );
    let denied = last_result(&seen[2]);
    assert_eq!(denied["is_error"], true);
    assert!(denied["content"].as_str().is_some_and(|c| c.contains("denied")));

    // Approved (--yes), it runs under the sandbox.
    let (url, server) = mock(vec![tool_use("bash", &json!({"command": script})), text()]);
    let out = env
        .cmd()
        .args(["--base-url", &url, "--yes"])
        .args(sandbox_flags())
        .args(["-p", "greet Ada"])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    let seen = server.join().expect("server");
    let ran = last_result(&seen[1]);
    assert_eq!(ran["content"], "hello, Ada\n", "{ran}");
}

#[test]
fn a_user_invocation_sends_the_skill_and_untrusted_project_skills_stay_out() {
    let env = Env::new();
    env.skill(
        &env.home.path().join(".agents/skills"),
        "manual",
        "disable-model-invocation: true\n",
    );
    env.skill(&env.project().join(".agents/skills"), "local", "");
    let (url, server) = mock(vec![text()]);
    env.cmd()
        .args(["--base-url", &url, "-p", "/skill:manual for Grace"])
        .assert()
        .code(0);
    let seen = server.join().expect("server");
    let prompt = seen[0]["messages"][0]["content"][0]["text"].as_str().expect("prompt");
    assert!(prompt.contains("The user invoked the skill \"manual\"") && prompt.ends_with("for Grace"));
    let system = seen[0]["system"].to_string();
    assert!(
        !system.contains("<available_skills>"),
        "no skill is offered: one is manual, one untrusted"
    );
    let tools = seen[0]["tools"].as_array().expect("tools");
    assert!(!tools.iter().any(|t| t["name"] == "skill"));
    env.cmd()
        .args(["--base-url", &url, "-p", "/skill:missing"])
        .assert()
        .code(1)
        .stderr(predicates::str::contains("no skill named"));
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
fn mcp_servers_are_added_listed_and_their_tools_pinned() {
    let env = Env::new();
    let server = mock_server();
    let server = server.to_str().expect("utf-8 path");
    env.cmd()
        .args(["mcp", "add", "mock", "-e", "APARTE_MOCK_VARIANT=1", "--", server])
        .assert()
        .code(0);
    env.cmd().args(["mcp", "add", "mock", server]).assert().code(1);
    env.cmd()
        .args(["mcp", "add", "web", "http://example.com/mcp"])
        .assert()
        .code(1)
        .stderr(predicates::str::contains("loopback"));
    let config = std::fs::read_to_string(env.home.path().join("config/mcp.json")).expect("config");
    let doc: Value = serde_json::from_str(&config).expect("json");
    assert_eq!(doc["mcpServers"]["mock"]["command"], server);
    let listed = env.json(&["mcp", "list"]);
    assert_eq!(
        (listed[0]["name"].clone(), listed[0]["transport"].clone()),
        (json!("mock"), json!("stdio"))
    );

    let tools = env.json(&["mcp", "tools", "mock"]);
    let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    assert_eq!(names, ["echo", "add", "write_note", "fail"]);
    assert!(tools.iter().all(|t| t["status"] == "pinned"));
    assert_eq!(tools[0]["exposedAs"], "mcp__mock__echo");
    assert_eq!(tools[0]["asks"], false);
    assert_eq!(tools[2]["asks"], true);

    // The server changes a tool: it is held back until approved.
    env.cmd()
        .args([
            "mcp",
            "add",
            "--force",
            "mock",
            "-e",
            "APARTE_MOCK_VARIANT=2",
            "--",
            server,
        ])
        .assert()
        .code(0);
    let tools = env.json(&["mcp", "tools", "mock"]);
    let status = |n: &str| {
        tools
            .iter()
            .find(|t| t["name"] == n)
            .map(|t| t["status"].clone())
            .expect(n)
    };
    assert_eq!(
        (status("echo"), status("extra"), status("add")),
        (json!("changed"), json!("new"), json!("pinned"))
    );
    let human = env.cmd().args(["mcp", "tools", "mock"]).output().expect("run");
    assert!(String::from_utf8_lossy(&human.stdout).contains("aparte mcp tools mock --approve"));
    env.json(&["mcp", "tools", "mock", "--approve"]);
    let tools = env.json(&["mcp", "tools", "mock"]);
    assert!(tools.iter().all(|t| t["status"] == "pinned"));

    env.cmd().args(["mcp", "remove", "mock"]).assert().code(0);
    let pins = std::fs::read_to_string(env.home.path().join("config/mcp-pins.json")).expect("pins");
    assert!(!pins.contains("\"mock\""), "removing a server forgets its pins");
    env.cmd().args(["mcp", "remove", "mock"]).assert().code(1);
}

#[test]
fn mcp_tools_are_called_by_the_agent_with_annotation_driven_approvals() {
    let env = Env::new();
    let server = mock_server();
    env.cmd()
        .args(["mcp", "add", "mock", server.to_str().expect("path")])
        .assert()
        .code(0);
    let (url, model) = mock(vec![
        tool_use("mcp__mock__echo", &json!({"text": "from the server"})),
        tool_use("mcp__mock__write_note", &json!({"note": "x"})),
        text(),
    ]);
    let out = env
        .cmd()
        .args(["--json", "--base-url", &url, "--tools", "read", "-p", "use the server"])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    let seen = model.join().expect("model");
    let tools: Vec<&str> = seen[0]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert_eq!(
        tools,
        [
            "read",
            "mcp__mock__echo",
            "mcp__mock__add",
            "mcp__mock__write_note",
            "mcp__mock__fail"
        ]
    );
    let echoed = last_result(&seen[1]);
    assert_eq!(
        (echoed["content"].clone(), echoed["is_error"].clone()),
        (json!("from the server"), json!(false))
    );
    let denied = last_result(&seen[2]);
    assert_eq!(denied["is_error"], true, "a destructive MCP tool needs approval");
    let events: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).expect("json"))
        .collect();
    let status = events
        .iter()
        .find(|e| e["event"] == "mcp-server")
        .expect("an mcp-server event");
    assert_eq!(
        (status["name"].clone(), status["state"].clone()),
        (json!("mock"), json!("connected"))
    );

    // --no-mcp starts nothing.
    let (url, model) = mock(vec![text()]);
    env.cmd()
        .args(["--base-url", &url, "--no-mcp", "--tools", "read", "-p", "hi"])
        .assert()
        .code(0);
    let seen = model.join().expect("model");
    assert_eq!(seen[0]["tools"].as_array().map(Vec::len), Some(1));
}

#[test]
fn rpc_reports_skills_and_mcp_servers() {
    let env = Env::new();
    env.skill(&env.home.path().join(".agents/skills"), "greet", "");
    let server = mock_server();
    env.cmd()
        .args(["mcp", "add", "mock", server.to_str().expect("path")])
        .assert()
        .code(0);
    let (url, _model) = mock(vec![]);
    let mut c = StdCommand::new(env!("CARGO_BIN_EXE_aparte"));
    env.apply(&mut c);
    let mut child = c
        .args(["rpc", "--base-url", &url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut lines = BufReader::new(child.stdout.take().expect("stdout")).lines();
    let mut next = || -> Value { serde_json::from_str(&lines.next().expect("line").expect("read")).expect("json") };
    let ready = next();
    assert_eq!(ready["event"], "ready");
    assert_eq!(ready["skills"], json!(["greet"]));
    assert_eq!(ready["mcpServers"][0]["state"], "connected");
    writeln!(stdin, r#"{{"type":"get_tools","id":1}}"#).expect("write");
    let tools = next();
    let names: Vec<&str> = tools["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(names.contains(&"skill") && names.contains(&"mcp__mock__echo"));
    writeln!(stdin, r#"{{"type":"get_skills"}}"#).expect("write");
    assert_eq!(next()["skills"][0]["name"], "greet");
    writeln!(stdin, r#"{{"type":"get_mcp"}}"#).expect("write");
    assert_eq!(next()["servers"][0]["tools"].as_array().map(Vec::len), Some(4));
    writeln!(stdin, r#"{{"type":"prompt","message":"/skill:nope"}}"#).expect("write");
    assert_eq!(next()["success"], false);
    writeln!(stdin, r#"{{"type":"quit"}}"#).expect("write");
    assert_eq!(next()["command"], "quit");
    drop(stdin);
    assert!(child.wait().expect("wait").success());
}
