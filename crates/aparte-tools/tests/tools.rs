//! The built-in tools on real files, processes and sockets, each in its own temporary project directory.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;

use aparte_agent::{CancelToken, Tool, ToolContext, ToolOutput};
use aparte_tools::sandbox::{self, Sandbox};
use aparte_tools::{BlobStore, SandboxPolicy, ToolsConfig, builtin};
use serde_json::{Value, json};

struct Fixture {
    dir: tempfile::TempDir,
    tools: Vec<Arc<dyn Tool>>,
}

impl Fixture {
    fn new() -> Fixture {
        Fixture::with(SandboxPolicy::default())
    }

    fn with(policy: SandboxPolicy) -> Fixture {
        let dir = tempfile::tempdir().expect("project");
        let blobs = Arc::new(BlobStore::new().expect("blobs"));
        let cfg = ToolsConfig {
            sandbox: policy,
            only: None,
        };
        Fixture {
            dir,
            tools: builtin(&cfg, blobs).expect("tools"),
        }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    async fn call(&self, name: &str, input: Value) -> Result<ToolOutput, String> {
        let tool = self.tools.iter().find(|t| t.name() == name).expect("tool");
        let ctx = ToolContext {
            cwd: self.path().canonicalize().expect("cwd"),
            call_id: "t".into(),
            cancel: CancelToken::new(),
        };
        tool.execute(&ctx, input).await.map_err(|e| e.to_string())
    }
}

#[tokio::test]
async fn every_tool_has_an_object_schema_and_a_description() {
    let f = Fixture::new();
    assert_eq!(f.tools.len(), aparte_tools::NAMES.len());
    for t in &f.tools {
        assert_eq!(t.input_schema()["type"], "object", "{}", t.name());
        assert!(!t.description().is_empty());
    }
}

#[tokio::test]
async fn write_read_and_edit_a_file() {
    let f = Fixture::new();
    let out = f
        .call("write", json!({"path": "src/a.txt", "content": "one\ntwo\nthree\n"}))
        .await
        .expect("write");
    assert!(out.content.starts_with("Created"));
    let out = f
        .call("read", json!({"path": "src/a.txt", "offset": 2, "limit": 1}))
        .await
        .expect("read");
    assert!(out.content.starts_with("two\n"), "{}", out.content);
    assert!(out.content.contains("offset=3"));
    let out = f
        .call(
            "edit",
            json!({"path": "src/a.txt", "edits": [{"old_text": "one", "new_text": "1"}, {"old_text": "three", "new_text": "3"}]}),
        )
        .await
        .expect("edit");
    assert!(
        out.details
            .as_ref()
            .is_some_and(|d| d["diff"].as_str().is_some_and(|s| s.contains("+1")))
    );
    assert_eq!(
        std::fs::read_to_string(f.path().join("src/a.txt")).expect("file"),
        "1\ntwo\n3\n"
    );
    let err = f
        .call(
            "edit",
            json!({"path": "src/a.txt", "edits": [{"old_text": "absent", "new_text": "x"}]}),
        )
        .await
        .expect_err("not found");
    assert!(err.contains("not found"));
}

#[tokio::test]
async fn writes_outside_the_project_are_refused() {
    let f = Fixture::new();
    let err = f
        .call("write", json!({"path": "/etc/aparte-should-not-exist", "content": "x"}))
        .await
        .expect_err("refused");
    assert!(err.contains("outside the project"));
}

#[tokio::test]
async fn read_refuses_binary_files() {
    let f = Fixture::new();
    std::fs::write(f.path().join("b.bin"), [0u8, 1, 2]).expect("bin");
    assert!(f.call("read", json!({"path": "b.bin"})).await.is_err());
}

#[tokio::test]
async fn grep_find_and_ls_respect_gitignore() {
    let f = Fixture::new();
    std::fs::create_dir_all(f.path().join("src")).expect("src");
    std::fs::write(f.path().join(".gitignore"), "ignored/\n").expect("gitignore");
    std::fs::create_dir_all(f.path().join("ignored")).expect("ignored");
    std::fs::write(
        f.path().join("src/main.rs"),
        "fn main() {\n    println!(\"needle\");\n}\n",
    )
    .expect("main");
    std::fs::write(f.path().join("ignored/x.rs"), "needle\n").expect("x");
    let out = f.call("grep", json!({"pattern": "needle"})).await.expect("grep");
    assert!(out.content.contains("src/main.rs:2:"), "{}", out.content);
    assert!(!out.content.contains("ignored"));
    let out = f
        .call("grep", json!({"pattern": "NEEDLE", "ignore_case": true, "context": 1}))
        .await
        .expect("grep");
    assert!(out.content.contains("src/main.rs-1- fn main"), "{}", out.content);
    let out = f.call("grep", json!({"pattern": "absent"})).await.expect("grep");
    assert_eq!(out.content, "no matches");
    let out = f.call("find", json!({"pattern": "*.rs"})).await.expect("find");
    assert_eq!(out.content, "src/main.rs");
    let out = f.call("ls", json!({})).await.expect("ls");
    assert!(
        out.content.contains(".gitignore") && out.content.contains("src/"),
        "{}",
        out.content
    );
}

#[tokio::test]
async fn git_runs_read_only_commands_only() {
    let f = Fixture::new();
    let ok = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(f.path())
        .status()
        .is_ok_and(|s| s.success());
    if !ok {
        return;
    }
    std::fs::write(f.path().join("new.txt"), "x").expect("file");
    let out = f
        .call("git", json!({"args": ["status", "--short"]}))
        .await
        .expect("status");
    assert!(out.content.contains("new.txt"), "{}", out.content);
    assert!(f.call("git", json!({"args": ["add", "."]})).await.is_err());
}

fn sandboxed() -> bool {
    sandbox::detect() != Sandbox::None
}

#[tokio::test]
async fn bash_runs_commands_and_reports_exit_codes() {
    let f = Fixture::with(SandboxPolicy {
        required: false,
        ..SandboxPolicy::default()
    });
    let out = f
        .call("bash", json!({"command": "echo hello; echo oops >&2"}))
        .await
        .expect("bash");
    assert!(
        out.content.contains("hello") && out.content.contains("oops"),
        "{}",
        out.content
    );
    assert!(!out.is_error);
    let out = f.call("bash", json!({"command": "exit 3"})).await.expect("bash");
    assert!(out.is_error && out.content.contains("exit code 3"));
    let err = f
        .call("bash", json!({"command": "sleep 30", "timeout": 1}))
        .await
        .expect_err("timeout");
    assert!(err.contains("timed out"));
}

#[tokio::test]
async fn bash_does_not_pass_the_environment_through() {
    let f = Fixture::with(SandboxPolicy {
        required: false,
        ..SandboxPolicy::default()
    });
    // Cargo sets this variable for the test process; the command must not see it.
    assert!(std::env::var_os("CARGO_MANIFEST_DIR").is_some());
    let out = f.call("bash", json!({"command": "env"})).await.expect("bash");
    assert!(!out.content.contains("CARGO_MANIFEST_DIR"), "{}", out.content);
    assert!(out.content.contains("TMPDIR="));
}

#[tokio::test]
async fn bash_output_is_cut_and_saved_whole() {
    let f = Fixture::with(SandboxPolicy {
        required: false,
        ..SandboxPolicy::default()
    });
    let out = f.call("bash", json!({"command": "seq 1 5000"})).await.expect("bash");
    assert!(out.content.contains("5000") && !out.content.starts_with("1\n"));
    let saved = out
        .details
        .as_ref()
        .and_then(|d| d["saved"].as_str())
        .expect("saved path");
    let whole = std::fs::read_to_string(saved).expect("blob");
    assert!(whole.starts_with("1\n2\n"));
}

#[tokio::test]
async fn the_sandbox_confines_writes_and_network() {
    if !sandboxed() {
        // Without a sandbox, a required one makes bash refuse to run.
        let f = Fixture::new();
        let err = f.call("bash", json!({"command": "true"})).await.expect_err("refused");
        assert!(err.contains("no OS sandbox"));
        return;
    }
    let f = Fixture::new();
    let outside = tempfile::tempdir_in(std::env::var_os("HOME").map_or_else(std::env::temp_dir, Into::into))
        .expect("outside dir");
    let target = outside.path().join("escape.txt");
    let out = f
        .call("bash", json!({"command": format!("echo x > '{}'", target.display())}))
        .await
        .expect("bash");
    assert!(out.is_error, "a write outside the project must fail: {}", out.content);
    assert!(!target.exists());
    let out = f
        .call("bash", json!({"command": "echo inside > inside.txt && cat inside.txt"}))
        .await
        .expect("bash");
    assert!(!out.is_error && out.content.contains("inside"), "{}", out.content);
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let port = listener.local_addr().expect("addr").port();
    let out = f
        .call(
            "bash",
            json!({"command": format!("exec 3<>/dev/tcp/127.0.0.1/{port} && echo connected")}),
        )
        .await
        .expect("bash");
    assert!(
        !out.content.contains("connected"),
        "the network must be closed: {}",
        out.content
    );
}

#[tokio::test]
async fn web_fetch_returns_page_text() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().expect("accept");
        let mut buf = [0u8; 2048];
        let _ = sock.read(&mut buf);
        let body = "<html><body><h1>Hi</h1><p>there &amp; back</p></body></html>";
        let resp = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(resp.as_bytes()).expect("write");
    });
    let f = Fixture::new();
    let out = f
        .call("web_fetch", json!({"url": format!("http://{addr}/")}))
        .await
        .expect("fetch");
    assert_eq!(out.content, "Hi\n\nthere & back");
    server.join().expect("server");
    assert!(f.call("web_fetch", json!({"url": "file:///etc/passwd"})).await.is_err());
}
