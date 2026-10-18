//! The vault, sync and sessions verbs of the binary, end to end: two homes stand for two devices, a local bare Git
//! repository for the sync store, and a local mock for the provider. A chat in print mode is recorded in the vault
//! (its reasoning signature included), synced, continued on the other device from the vault, and synced back.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::thread::JoinHandle;

use assert_cmd::Command;
use serde_json::Value;

const PASSPHRASE: &str = "vault test passphrase";

fn spec(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../spec/sse")
            .join(name),
    )
    .expect("fixture")
}

/// Serves the given SSE bodies in order, one per connection; returns the request bodies.
fn mock(bodies: Vec<Vec<u8>>) -> (String, JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("addr"));
    let handle = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for body in bodies {
            let Ok((mut sock, _)) = listener.accept() else { break };
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
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes());
            let _ = sock.write_all(&body);
        }
        seen
    });
    (url, handle)
}

/// One device: its own home and directories.
struct Device {
    home: tempfile::TempDir,
}

impl Device {
    fn new() -> Device {
        Device {
            home: tempfile::tempdir().expect("home"),
        }
    }

    fn cmd(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_aparte"));
        c.current_dir(self.home.path())
            .env("HOME", self.home.path())
            .env("APARTE_CONFIG_DIR", self.home.path().join("config"))
            .env("APARTE_DATA_DIR", self.home.path().join("data"))
            .env("APARTE_NO_KEYCHAIN", "1")
            .env("APARTE_ARGON2_COSTS", "19456,2,1")
            .env("NO_COLOR", "1")
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("XDG_DATA_HOME")
            .env_remove("APARTE_LOG")
            .env_remove("APARTE_PASSPHRASE")
            .env_remove("APARTE_NEW_PASSPHRASE")
            .env_remove("APARTE_SECRET_KEY")
            .env_remove("APARTE_PROVIDER")
            .env_remove("APARTE_MODEL")
            .env_remove("APARTE_BASE_URL")
            .env_remove("ANTHROPIC_API_KEY");
        c
    }

    /// A command with the vault's secrets in the environment.
    fn unlocked(&self, kit: &str) -> Command {
        let mut c = self.cmd();
        c.env("APARTE_PASSPHRASE", PASSPHRASE).env("APARTE_SECRET_KEY", kit);
        c
    }
}

fn events(out: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(out)
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn event<'a>(all: &'a [Value], name: &str) -> &'a Value {
    all.iter()
        .find(|e| e["event"] == name)
        .unwrap_or_else(|| panic!("no {name} event in {all:?}"))
}

fn bare(dir: &Path) -> String {
    let repo = dir.join("remote.git");
    std::fs::create_dir_all(&repo).expect("dir");
    let ok = StdCommand::new("git")
        .args(["init", "--bare", "-q", "-b", "main"])
        .arg(&repo)
        .status()
        .expect("git");
    assert!(ok.success());
    repo.to_string_lossy().into_owned()
}

#[test]
fn create_status_unlock_and_change_the_passphrase() {
    let a = Device::new();
    let out = a
        .cmd()
        .args(["vault", "create", "--json"])
        .env("APARTE_NEW_PASSPHRASE", PASSPHRASE)
        .output()
        .expect("run");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let created = events(&out.stdout);
    let kit = event(&created, "vault-created")["secretKey"]
        .as_str()
        .expect("kit")
        .to_owned();
    assert!(kit.starts_with("A1-"));
    assert!(event(&created, "vault-created")["recoveryKey"].is_string());

    let status = events(
        &a.cmd()
            .args(["vault", "status", "--json"])
            .output()
            .expect("run")
            .stdout,
    );
    let s = event(&status, "vault-status");
    assert_eq!(s["state"], "locked");
    assert_eq!(s["slots"].as_array().expect("slots").len(), 2);
    assert_eq!(s["secretKeyOnDevice"], false);

    // Nothing in the store is readable: no file holds the passphrase or a plaintext marker of content.
    for entry in walk(&a.home.path().join("data/vault")) {
        let bytes = std::fs::read(&entry).expect("read");
        assert!(
            !bytes.windows(PASSPHRASE.len()).any(|w| w == PASSPHRASE.as_bytes()),
            "{}",
            entry.display()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&entry).expect("meta").permissions().mode() & 0o077,
                0,
                "{}",
                entry.display()
            );
        }
    }

    a.unlocked(&kit).args(["vault", "unlock-test"]).assert().success();
    a.cmd()
        .args(["vault", "unlock-test"])
        .env("APARTE_PASSPHRASE", "not the passphrase")
        .env("APARTE_SECRET_KEY", &kit)
        .assert()
        .code(5);
    a.cmd()
        .args(["vault", "unlock-test"])
        .env("APARTE_PASSPHRASE", PASSPHRASE)
        .assert()
        .failure();

    a.unlocked(&kit)
        .args(["vault", "change-passphrase"])
        .env("APARTE_NEW_PASSPHRASE", "the next passphrase")
        .assert()
        .success();
    a.unlocked(&kit).args(["vault", "unlock-test"]).assert().code(5);
    a.cmd()
        .args(["vault", "unlock-test"])
        .env("APARTE_PASSPHRASE", "the next passphrase")
        .env("APARTE_SECRET_KEY", &kit)
        .assert()
        .success();
    a.cmd()
        .args(["vault", "create"])
        .env("APARTE_NEW_PASSPHRASE", PASSPHRASE)
        .assert()
        .failure();
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).expect("dir") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

#[test]
fn a_cli_chat_is_saved_synced_and_continued_on_another_device() {
    let remote_dir = tempfile::tempdir().expect("remote");
    let url = bare(remote_dir.path());
    let a = Device::new();
    let out = a
        .cmd()
        .args(["vault", "create", "--json"])
        .env("APARTE_NEW_PASSPHRASE", PASSPHRASE)
        .output()
        .expect("run");
    let kit = event(&events(&out.stdout), "vault-created")["secretKey"]
        .as_str()
        .expect("kit")
        .to_owned();

    // A chat in print mode lands in the vault.
    let (base, server) = mock(vec![spec("anthropic-thinking.sse")]);
    a.unlocked(&kit)
        .args([
            "-p",
            "hello vault",
            "--provider",
            "anthropic",
            "--base-url",
            &base,
            "--no-tools",
        ])
        .env("ANTHROPIC_API_KEY", "test-key-value")
        .assert()
        .success();
    server.join().expect("mock");
    let list = events(
        &a.unlocked(&kit)
            .args(["sessions", "list", "--json"])
            .output()
            .expect("run")
            .stdout,
    );
    let session = event(&list, "session");
    let id = session["id"].as_str().expect("id").to_owned();
    assert_eq!(session["title"], "hello vault");
    assert_eq!(session["messages"], 2);
    let shown = events(
        &a.unlocked(&kit)
            .args(["sessions", "show", &id, "--json"])
            .output()
            .expect("run")
            .stdout,
    );
    let messages: Vec<&Value> = shown.iter().filter(|e| e["event"] == "message").collect();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
    let reasoning = messages[1]["parts"]
        .as_array()
        .expect("parts")
        .iter()
        .find(|p| p["type"] == "reasoning")
        .expect("a reasoning part");
    assert!(
        reasoning["providerMeta"]["anthropic"]["signature"]
            .as_str()
            .is_some_and(|s| s.len() > 20)
    );
    assert!(
        messages[1]["model"]["provider"].as_str().is_some_and(|p| p.len() == 26),
        "a provider entity id"
    );
    assert!(messages[1]["usage"]["output"].is_number());

    let file = a.home.path().join("export.jsonl");
    a.unlocked(&kit)
        .args(["sessions", "export", &id, "-o"])
        .arg(&file)
        .assert()
        .success();
    let text = std::fs::read_to_string(&file).expect("export");
    let lines: Vec<Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).expect("json line"))
        .collect();
    assert_eq!(lines[0]["type"], "session");
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[2]["parentId"], lines[1]["id"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).expect("meta").permissions().mode() & 0o777,
            0o600
        );
    }

    // --no-save leaves the vault as it was.
    let (base2, server2) = mock(vec![spec("anthropic-text.sse")]);
    a.unlocked(&kit)
        .args([
            "-p",
            "not saved",
            "--provider",
            "anthropic",
            "--base-url",
            &base2,
            "--no-tools",
            "--no-save",
        ])
        .env("ANTHROPIC_API_KEY", "test-key-value")
        .assert()
        .success();
    server2.join().expect("mock");
    let list = events(
        &a.unlocked(&kit)
            .args(["sessions", "list", "--json"])
            .output()
            .expect("run")
            .stdout,
    );
    assert_eq!(list.iter().filter(|e| e["event"] == "session").count(), 1);

    // A syncs through the bare repository; B joins from it.
    let out = a
        .unlocked(&kit)
        .args(["sync", "setup", "git", &url, "--json"])
        .output()
        .expect("run");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(
        event(&events(&out.stdout), "sync-round")["up"]
            .as_u64()
            .is_some_and(|n| n > 0)
    );

    let b = Device::new();
    let out = b
        .unlocked(&kit)
        .args(["vault", "join", "git", &url, "--json"])
        .output()
        .expect("run");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let joined = events(&out.stdout);
    assert!(
        event(&joined, "sync-round")["alarms"]
            .as_array()
            .is_some_and(Vec::is_empty)
    );
    let list = events(
        &b.unlocked(&kit)
            .args(["sessions", "list", "--json"])
            .output()
            .expect("run")
            .stdout,
    );
    assert_eq!(event(&list, "session")["id"], id.as_str());

    // B continues the conversation from the vault: the thinking block is replayed with its signature.
    let (base3, server3) = mock(vec![spec("anthropic-text.sse")]);
    b.unlocked(&kit)
        .args([
            "-p",
            "and then?",
            "--provider",
            "anthropic",
            "--base-url",
            &base3,
            "--no-tools",
            "--session",
            &id,
        ])
        .env("ANTHROPIC_API_KEY", "test-key-value")
        .assert()
        .success();
    let sent = server3.join().expect("mock");
    let request = &sent[0];
    let history = request["messages"].as_array().expect("messages");
    assert_eq!(history.len(), 3, "{request}");
    assert!(
        history[1]["content"].to_string().contains("\"signature\""),
        "the signed thinking is replayed"
    );
    b.unlocked(&kit).args(["sync", "now"]).assert().success();
    a.unlocked(&kit).args(["sync", "now"]).assert().success();
    let shown = events(
        &a.unlocked(&kit)
            .args(["sessions", "show", &id, "--json"])
            .output()
            .expect("run")
            .stdout,
    );
    assert_eq!(shown.iter().filter(|e| e["event"] == "message").count(), 4);
    let status = events(
        &a.unlocked(&kit)
            .args(["sync", "status", "--json"])
            .output()
            .expect("run")
            .stdout,
    );
    assert!(
        event(&status, "sync-status")["alarms"]
            .as_array()
            .is_some_and(Vec::is_empty)
    );
    assert!(event(&status, "sync-destination")["lastOkAt"].is_number());
}
