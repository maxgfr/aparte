//! The client against the mock server: stdio with the process group killed on shutdown, Streamable HTTP, tool calls
//! and their annotations, pinning and drift, and the OAuth login with tokens kept encrypted.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use aparte_agent::{CancelToken, ToolContext};
use aparte_mcp::auth::{Login, MemoryVault, SecretVault, TokenStore};
use aparte_mcp::config::{ServerConfig, Source, Transport};
use aparte_mcp::mock::{MockOptions, serve_http};
use aparte_mcp::{ConnectOptions, McpError, McpManager, PinStatus, PinStore, ServerState, connect};
use serde_json::json;

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

fn http(name: &str, url: &str) -> ServerConfig {
    ServerConfig {
        name: name.into(),
        transport: Transport::Http {
            url: url.into(),
            headers: Default::default(),
            oauth: None,
        },
        disabled: false,
        source: Source::User,
        file: PathBuf::from("mcp.json"),
    }
}

fn ctx() -> ToolContext {
    ToolContext {
        cwd: std::env::temp_dir(),
        call_id: "c1".into(),
        cancel: CancelToken::new(),
    }
}

fn alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[tokio::test]
async fn stdio_tools_run_and_the_process_group_dies_with_the_connection() {
    let dir = tempfile::tempdir().expect("dir");
    let pid_file = dir.path().join("child.pid");
    let server = stdio(
        "mock",
        &[("APARTE_MOCK_CHILD_PID_FILE", &pid_file.display().to_string())],
    );
    let opts = ConnectOptions::new(dir.path());
    let mut pins = PinStore::in_memory();
    let m = McpManager::start(std::slice::from_ref(&server), &opts, &mut pins).await;
    let ServerState::Connected {
        tools,
        blocked,
        server_info,
    } = &m.statuses()[0].state
    else {
        panic!("not connected: {:?}", m.statuses());
    };
    assert_eq!(tools, &["echo", "add", "write_note", "fail"]);
    assert!(blocked.is_empty(), "a new server is approved on first use");
    assert_eq!(server_info.as_deref(), Some("aparte-mock 1.0.0"));
    let tools = m.tools();
    let echo = tools.iter().find(|t| t.name() == "mcp__mock__echo").expect("echo");
    assert!(echo.description().starts_with("[MCP server mock, tool echo]"));
    assert!(
        !aparte_agent::approval::needs_approval(echo.annotations(), false),
        "read-only and closed world"
    );
    let out = echo.execute(&ctx(), json!({"text": "hi there"})).await.expect("call");
    assert_eq!((out.content.as_str(), out.is_error), ("hi there", false));
    let write = tools
        .iter()
        .find(|t| t.name() == "mcp__mock__write_note")
        .expect("write");
    assert!(
        aparte_agent::approval::needs_approval(write.annotations(), true),
        "destructive asks even when trusted"
    );
    let fail = tools.iter().find(|t| t.name() == "mcp__mock__fail").expect("fail");
    assert!(fail.execute(&ctx(), json!({})).await.expect("call").is_error);
    let add = tools.iter().find(|t| t.name() == "mcp__mock__add").expect("add");
    let out = add.execute(&ctx(), json!({"a": 2, "b": 40})).await.expect("call");
    assert_eq!(out.content, "42");
    assert_eq!(out.details.expect("details")["structured"]["sum"], 42.0);

    let child = std::fs::read_to_string(&pid_file).expect("the helper started");
    assert!(alive(&child));
    drop(tools);
    m.shutdown().await;
    let mut gone = false;
    for _ in 0..50 {
        if !alive(&child) {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(gone, "the helper of the server was killed with its process group");
}

#[tokio::test]
async fn a_changed_or_new_tool_is_held_back_until_approved() {
    let cfg = tempfile::tempdir().expect("cfg");
    let opts = ConnectOptions::new(cfg.path());
    let mut pins = PinStore::load(cfg.path()).expect("pins");
    let first = McpManager::start(&[stdio("srv", &[])], &opts, &mut pins).await;
    assert_eq!(first.tools().len(), 4);
    first.shutdown().await;
    assert!(
        cfg.path().join("mcp-pins.json").is_file(),
        "first use is pinned and saved"
    );

    let mut pins = PinStore::load(cfg.path()).expect("pins");
    let changed = stdio("srv", &[("APARTE_MOCK_VARIANT", "2")]);
    let second = McpManager::start(std::slice::from_ref(&changed), &opts, &mut pins).await;
    let ServerState::Connected { tools, blocked, .. } = &second.statuses()[0].state else {
        panic!("not connected");
    };
    assert_eq!(tools, &["add", "write_note", "fail"]);
    assert_eq!(
        blocked,
        &[
            ("echo".to_owned(), PinStatus::Changed),
            ("extra".to_owned(), PinStatus::New)
        ]
    );
    let names: Vec<String> = second.tools().iter().map(|t| t.name().to_owned()).collect();
    assert!(
        !names.iter().any(|n| n.contains("echo")),
        "the changed description never reaches the model"
    );
    assert!(second.summary()[0].contains("aparte mcp tools srv --approve"));

    // Approving the definitions as they are now lets them through.
    let conn = connect(&changed, &opts).await.expect("connect");
    let listed = aparte_mcp::client::check_pins(&mut pins, "srv", &conn.tools);
    pins.approve("srv", listed.into_iter().map(|(n, f, _)| (n, f)));
    pins.save().expect("save");
    conn.shutdown().await;
    second.shutdown().await;
    let mut pins = PinStore::load(cfg.path()).expect("pins");
    let third = McpManager::start(&[changed], &opts, &mut pins).await;
    assert_eq!(third.tools().len(), 5);
    third.shutdown().await;
}

#[tokio::test]
async fn streamable_http_servers_list_and_call_tools() {
    let mock = serve_http(MockOptions::default()).await.expect("mock");
    let opts = ConnectOptions::new(std::env::temp_dir());
    let mut pins = PinStore::in_memory();
    let m = McpManager::start(&[http("web", &mock.url())], &opts, &mut pins).await;
    let tools = m.tools();
    let add = tools
        .iter()
        .find(|t| t.name() == "mcp__web__add")
        .unwrap_or_else(|| panic!("{:?}", m.statuses()));
    assert_eq!(
        add.execute(&ctx(), json!({"a": 1, "b": 2}))
            .await
            .expect("call")
            .content,
        "3"
    );
    assert!(mock.seen().iter().any(|l| l == "POST /mcp"));
    drop(tools);
    m.shutdown().await;
}

#[tokio::test]
async fn an_unreachable_or_refused_server_is_reported_not_fatal() {
    let opts = ConnectOptions {
        connect_timeout: Duration::from_secs(10),
        ..ConnectOptions::new(std::env::temp_dir())
    };
    let mut pins = PinStore::in_memory();
    let mut missing = stdio("missing", &[]);
    if let Transport::Stdio { command, .. } = &mut missing.transport {
        *command = "/nonexistent/aparte-mcp-server".into();
    }
    let plain = http("plain", "http://example.com/mcp");
    let mut off = stdio("off", &[]);
    off.disabled = true;
    let m = McpManager::start(&[missing, plain, off], &opts, &mut pins).await;
    let states: Vec<&ServerState> = m.statuses().iter().map(|s| &s.state).collect();
    assert!(matches!(states[0], ServerState::Failed { error } if error.contains("cannot start")));
    assert!(matches!(states[1], ServerState::Failed { error } if error.contains("loopback")));
    assert_eq!(states[2], &ServerState::Disabled);
    assert!(m.tools().is_empty());
}

#[tokio::test]
async fn oauth_login_stores_encrypted_tokens_that_later_connections_use() {
    let mock = serve_http(MockOptions {
        variant: 1,
        oauth: true,
    })
    .await
    .expect("mock");
    let cfg = tempfile::tempdir().expect("cfg");
    let vault: Arc<dyn SecretVault> = Arc::new(MemoryVault::default());
    let opts = ConnectOptions {
        config_dir: Some(cfg.path().to_path_buf()),
        vault: Some(vault.clone()),
        ..ConnectOptions::new(cfg.path())
    };
    let server = http("secure", &mock.url());
    let before = connect(&server, &opts).await;
    assert!(matches!(before, Err(McpError::NeedsLogin { .. })), "{before:?}");

    // The "browser": follow the authorization URL to its redirect, then call the loopback callback.
    let open = |url: &str| {
        let url = url.to_owned();
        tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("client");
            let r = client.get(&url).send().await.expect("authorize");
            assert_eq!(r.status().as_u16(), 302, "the mock approves at once");
            let location = r.headers()["location"].to_str().expect("location").to_owned();
            let page = client.get(&location).send().await.expect("callback");
            assert!(page.text().await.expect("page").contains("Signed in"));
        });
    };
    let store = TokenStore::new(cfg.path(), "secure", vault.clone());
    aparte_mcp::auth::login(
        &mock.url(),
        store.clone(),
        aparte_mcp::client::http_client().expect("http"),
        Login {
            client_id: None,
            scopes: Vec::new(),
            open: &open,
            timeout: Duration::from_secs(20),
        },
    )
    .await
    .expect("login");
    assert!(
        mock.seen().iter().any(|l| l.starts_with("POST /register")),
        "dynamic client registration"
    );
    let token = mock.issued_tokens().pop().expect("a token was issued");
    let on_disk = std::fs::read(cfg.path().join("mcp-auth/secure.bin")).expect("token file");
    assert!(
        !String::from_utf8_lossy(&on_disk).contains(&token),
        "the token is not readable on disk"
    );

    let conn = connect(&server, &opts).await.expect("connects with the stored token");
    assert_eq!(conn.tools.len(), 4);
    conn.shutdown().await;
    assert!(store.remove().expect("logout"));
    assert!(matches!(
        connect(&server, &opts).await,
        Err(McpError::NeedsLogin { .. })
    ));
}
