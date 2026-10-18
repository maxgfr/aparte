//! The decoders against the recorded provider streams of `spec/sse`, the same bytes the web app's adapter tests
//! read: every file of `index.json` is decoded whole and in small chunks, and what comes out must be what `expect`
//! says. Then the HTTP client is run against a local server that serves each file with its status and content type.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

use aparte_llm::caps::Maker;
use aparte_llm::decode::decode_body;
use aparte_llm::{ApiKey, ChatEvent, ChatModel, Client, Message, Protocol, ProviderConfig, Request};
use futures_util::StreamExt;
use serde_json::{Value, json};

fn spec_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/sse")
}

fn index() -> Vec<(String, Value)> {
    let raw = std::fs::read_to_string(spec_dir().join("index.json")).expect("spec/sse/index.json");
    let v: Value = serde_json::from_str(&raw).expect("index is JSON");
    v.as_object()
        .expect("object")
        .iter()
        .filter(|(k, _)| !k.starts_with('$'))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn protocol(provider: &str) -> Protocol {
    match provider {
        "anthropic" => Protocol::Anthropic,
        "openai-compatible" | "openai" => Protocol::OpenaiChat,
        "google" => Protocol::Gemini,
        other => panic!("unknown provider {other}"),
    }
}

/// What a stream amounts to, in the terms of `expect`.
#[derive(Debug, Default)]
struct Outcome {
    text: String,
    reasoning: Vec<Value>,
    stop: Option<Value>,
    raw: Option<String>,
    refusal: Option<Value>,
    usage: Option<Value>,
    error: Option<Value>,
    ends: usize,
}

fn outcome(events: &[ChatEvent]) -> Outcome {
    let mut o = Outcome::default();
    let mut open: Vec<(String, String)> = Vec::new();
    for ev in events {
        match ev {
            ChatEvent::TextDelta { text, .. } => o.text.push_str(text),
            ChatEvent::ReasoningDelta { id, text } => match open.iter_mut().find(|(i, _)| i == id) {
                Some((_, t)) => t.push_str(text),
                None => open.push((id.clone(), text.clone())),
            },
            ChatEvent::ReasoningEnd { id, provider_meta } => {
                let text = open
                    .iter()
                    .position(|(i, _)| i == id)
                    .map(|at| open.remove(at).1)
                    .unwrap_or_default();
                let mut block = json!({ "text": text });
                if let Some(m) = provider_meta {
                    block["providerMeta"] = m.clone();
                }
                o.reasoning.push(block);
            }
            ChatEvent::Usage { usage } => o.usage = Some(serde_json::to_value(usage).expect("usage")),
            ChatEvent::Finish { stop, raw, refusal, .. } => {
                o.stop = Some(serde_json::to_value(stop).expect("stop"));
                o.raw.clone_from(raw);
                o.refusal = refusal.as_ref().map(|r| serde_json::to_value(r).expect("refusal"));
                o.ends += 1;
            }
            ChatEvent::Error { error } => {
                o.error = Some(serde_json::to_value(error).expect("error"));
                o.ends += 1;
            }
            _ => {}
        }
    }
    assert!(open.is_empty(), "reasoning blocks left open: {open:?}");
    o
}

fn check(name: &str, expect: &Value, o: &Outcome) {
    assert_eq!(o.ends, 1, "{name}: exactly one finish or error");
    assert_eq!(o.text, expect["text"].as_str().expect("text"), "{name}: text");
    assert_eq!(
        &Value::Array(o.reasoning.clone()),
        &expect["reasoning"],
        "{name}: reasoning"
    );
    if let Some(stop) = expect.get("stop") {
        assert_eq!(o.stop.as_ref(), Some(stop), "{name}: stop");
        assert_eq!(o.raw.as_deref(), expect["raw"].as_str(), "{name}: raw");
    }
    if let Some(refusal) = expect.get("refusal") {
        assert_eq!(o.refusal.as_ref(), Some(refusal), "{name}: refusal");
    }
    if let Some(usage) = expect.get("usage").and_then(Value::as_object) {
        let got = o.usage.as_ref().unwrap_or_else(|| panic!("{name}: no usage"));
        for (k, v) in usage {
            assert_eq!(got.get(k), Some(v), "{name}: usage.{k}");
        }
    }
    if let Some(err) = expect.get("error").and_then(Value::as_object) {
        let got = o.error.as_ref().unwrap_or_else(|| panic!("{name}: no error"));
        for (k, v) in err {
            assert_eq!(got.get(k), Some(v), "{name}: error.{k}");
        }
    } else {
        assert!(o.error.is_none(), "{name}: unexpected error {:?}", o.error);
    }
}

#[test]
fn every_streaming_fixture_decodes_as_expected_whole_and_chunked() {
    let entries = index();
    assert!(entries.len() >= 8, "the index lists every fixture");
    for (name, entry) in entries {
        if entry["status"] != 200 {
            continue;
        }
        let bytes = std::fs::read(spec_dir().join(&name)).expect("fixture");
        let p = protocol(entry["provider"].as_str().expect("provider"));
        for sizes in [&[usize::MAX][..], &[1], &[3, 7, 1, 64], &[2]] {
            let events = decode_body(p, &bytes, sizes);
            check(&format!("{name} {sizes:?}"), &entry["expect"], &outcome(&events));
        }
    }
}

#[test]
fn the_gemini_fixture_keeps_its_crlf_line_endings() {
    let bytes = std::fs::read(spec_dir().join("gemini-text.sse")).expect("fixture");
    assert!(bytes.windows(2).any(|w| w == b"\r\n"));
}

/// Serves one response per accepted connection, then returns the raw requests it read.
fn serve(responses: Vec<(u16, String, Vec<u8>)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let handle = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for (status, ctype, body) in responses {
            let (mut sock, _) = listener.accept().expect("accept");
            seen.push(read_request(&mut sock));
            let head = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: {ctype}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            sock.write_all(head.as_bytes()).expect("write head");
            sock.write_all(&body).expect("write body");
        }
        seen
    });
    (format!("http://{addr}"), handle)
}

fn read_request(sock: &mut std::net::TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = sock.read(&mut chunk).expect("read");
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
            let len = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if buf.len() >= end + 4 + len {
                break;
            }
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

#[tokio::test]
async fn the_client_streams_every_fixture_over_http() {
    let entries = index();
    let responses: Vec<_> = entries
        .iter()
        .map(|(name, e)| {
            (
                u16::try_from(e["status"].as_u64().expect("status")).expect("u16"),
                e["contentType"].as_str().expect("type").to_owned(),
                std::fs::read(spec_dir().join(name)).expect("fixture"),
            )
        })
        .collect();
    let (base, server) = serve(responses);
    for (name, entry) in &entries {
        let p = protocol(entry["provider"].as_str().expect("provider"));
        let cfg = ProviderConfig {
            id: "test".into(),
            protocol: p,
            maker: Maker::Other,
            base_url: base.clone(),
            api_key: ApiKey::new("sk-test-not-a-real-key"),
        };
        let client = Client::new(cfg).expect("client");
        let req = Request {
            model: entry["model"].as_str().expect("model").into(),
            messages: vec![Message::user("hi")],
            ..Request::default()
        };
        let events: Vec<ChatEvent> = client.stream(&req).expect("stream").collect().await;
        check(name, &entry["expect"], &outcome(&events));
    }
    let seen = server.join().expect("server");
    assert_eq!(seen.len(), entries.len());
    for (req, (_, entry)) in seen.iter().zip(&entries) {
        let lower = req.to_lowercase();
        match entry["provider"].as_str() {
            Some("anthropic") => {
                assert!(lower.starts_with("post /messages "), "{req}");
                assert!(lower.contains("x-api-key: sk-test-not-a-real-key"));
                assert!(lower.contains("anthropic-version: 2023-06-01"));
            }
            Some("google") => assert!(lower.contains(":streamgeneratecontent?alt=sse"), "{req}"),
            _ => {
                assert!(lower.starts_with("post /chat/completions "), "{req}");
                assert!(lower.contains("authorization: bearer sk-test-not-a-real-key"));
            }
        }
    }
}

#[tokio::test]
async fn an_unreachable_server_is_a_retryable_network_error() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    drop(listener);
    let cfg = ProviderConfig {
        id: "test".into(),
        protocol: Protocol::Anthropic,
        maker: Maker::Anthropic,
        base_url: base,
        api_key: None,
    };
    let client = Client::new(cfg).expect("client");
    let req = Request {
        model: "claude-opus-5-5".into(),
        messages: vec![Message::user("hi")],
        ..Request::default()
    };
    let events: Vec<ChatEvent> = client.stream(&req).expect("stream").collect().await;
    match events.as_slice() {
        [ChatEvent::Error { error }] => assert!(error.retryable, "{error:?}"),
        other => panic!("expected one error, got {other:?}"),
    }
}

/// A real call, for a developer with a key: export ANTHROPIC_API_KEY, then run `cargo test -p aparte-llm -- --ignored`.
#[tokio::test]
#[ignore = "calls the Anthropic API and needs ANTHROPIC_API_KEY"]
async fn live_anthropic_call() {
    let key = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .and_then(ApiKey::new)
        .expect("ANTHROPIC_API_KEY");
    let preset = aparte_llm::providers::preset("anthropic").expect("preset");
    let client = Client::new(ProviderConfig::from_preset(preset, Some(key))).expect("client");
    let req = Request {
        model: "claude-haiku-5-5".into(),
        messages: vec![Message::user("Reply with the single word: pong")],
        effort: Some(aparte_llm::Effort::Low),
        max_output_tokens: Some(2048),
        ..Request::default()
    };
    let events: Vec<ChatEvent> = client.stream(&req).expect("stream").collect().await;
    let o = outcome(&events);
    assert!(o.error.is_none(), "{:?}", o.error);
    assert!(o.text.to_lowercase().contains("pong"));
}
