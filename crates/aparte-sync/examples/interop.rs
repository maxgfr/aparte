//! A CLI device driven from the command line, for the mixed end-to-end check of scripts/check-interop.sh (the CLI
//! and the TypeScript reference syncing through one Git repository):
//!
//! ```text
//! interop push-folder <git-url> <folder>                     push a folder store's objects in the Git layout
//! interop create <git-url> <data-dir>                        a new vault with a conversation and a photo
//! interop read <git-url> <data-dir> <passphrase> <kit>       join (once), sync, print what the device sees
//! interop append <git-url> <data-dir> <passphrase> <kit> <text>  also answer the active branch, and sync
//! ```
//!
//! Its vaults use the small Argon2 costs of the vectors: they protect nothing.

use std::path::Path;
use std::sync::Arc;

use aparte_crypto::OsRng;
use aparte_crypto::primitives::sha256;
use aparte_crypto::text::parse_secret_key;
use aparte_format::encoding::to_hex;
use aparte_format::keyslot::Argon2Params;
use aparte_store::{CreateOptions, Credential, Vault, VaultState};
use aparte_sync::blobs::{get_blob, put_blob};
use aparte_sync::join::read_stored_vault;
use aparte_sync::providers::folder::FolderStore;
use aparte_sync::providers::git::{GitStore, GitTarget};
use aparte_sync::{Engine, NewConversation, NewMessage, RemoteStore, SystemClock, Workspace};
use serde_json::{Value, json};

const SMALL: Argon2Params = Argon2Params { m: 19456, t: 2, p: 1 };
const PASSPHRASE: &str = "interop passphrase: Aparté, ☕";

fn git(url: &str, data: &Path) -> GitStore {
    GitStore::new(
        &GitTarget {
            url: url.to_owned(),
            branch: None,
            root: None,
        },
        data.join("git-cache"),
    )
}

fn fail(message: String) -> ! {
    eprintln!("interop: {message}");
    std::process::exit(1)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|e| fail(e.to_string()));
    let out = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["push-folder", url, folder] => rt.block_on(push_folder(url, Path::new(folder))),
        ["create", url, data] => rt.block_on(create(url, Path::new(data))),
        ["read", url, data, pass, kit] => rt.block_on(device(url, Path::new(data), pass, kit, None)),
        ["append", url, data, pass, kit, text] => rt.block_on(device(url, Path::new(data), pass, kit, Some(text))),
        _ => fail("usage: interop push-folder|create|read|append ...".into()),
    };
    match out {
        Ok(v) => println!("{v}"),
        Err(e) => fail(e),
    }
}

async fn push_folder(url: &str, folder: &Path) -> Result<Value, String> {
    let source = FolderStore::new(folder, "source");
    let dest = git(url, folder.parent().unwrap_or(folder));
    let entries = source.list().await.map_err(|e| e.to_string())?;
    let mut n = 0;
    for entry in &entries {
        if aparte_format::names::parse_name(&entry.name).is_none() {
            continue;
        }
        let bytes = source.get(entry).await.map_err(|e| e.to_string())?.unwrap_or_default();
        dest.put(&entry.name, &bytes).await.map_err(|e| e.to_string())?;
        n += 1;
    }
    dest.flush().await.map_err(|e| e.to_string())?;
    Ok(json!({"pushed": n}))
}

fn summary(ws: &Workspace, store: &aparte_store::RecordStore) -> Result<Value, String> {
    let mut conversations = Vec::new();
    for c in ws.conversations().map_err(|e| e.to_string())? {
        let path = ws.path(&c.id, None).map_err(|e| e.to_string())?;
        let mut messages = Vec::new();
        for m in path {
            let mut parts = Vec::new();
            for p in &m.parts {
                let mut p = p.clone();
                if let Some(id) = p.get("blob").and_then(Value::as_str).map(str::to_owned)
                    && let Ok(Some(blob)) = get_blob(store, &id)
                {
                    p["bytes"] = json!(blob.bytes.len());
                    p["sha256"] = json!(to_hex(&sha256(&blob.bytes)));
                }
                parts.push(p);
            }
            messages.push(json!({"id": m.id, "role": m.role, "status": m.status, "model": m.model, "parts": parts}));
        }
        conversations.push(json!({"id": c.id, "title": c.title, "system": c.system, "path": messages}));
    }
    Ok(json!({ "conversations": conversations }))
}

async fn create(url: &str, data: &Path) -> Result<Value, String> {
    let clock = Arc::new(SystemClock);
    let vault = Arc::new(Vault::new(data.join("vault")).with_argon2(SMALL));
    let created = vault
        .create(PASSPHRASE, CreateOptions::default(), &mut OsRng, Box::new(OsRng))
        .map_err(|e| e.to_string())?;
    let store = created.unlocked.store.clone();
    let ws = Workspace::open(store.clone(), clock.clone()).map_err(|e| e.to_string())?;
    let provider = ws
        .create_provider("anthropic", "Anthropic", None, None)
        .map_err(|e| e.to_string())?;
    let conv = ws
        .create_conversation(NewConversation {
            title: Some("Started in the CLI".into()),
            system: Some("Answer briefly.".into()),
            ..NewConversation::default()
        })
        .map_err(|e| e.to_string())?;
    let photo: Vec<u8> = (0..2_101_248u32)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8)
        .collect();
    let blob = put_blob(&store, &photo, "image/jpeg", Some("cli.jpg")).map_err(|e| e.to_string())?;
    let user = ws.new_id().map_err(|e| e.to_string())?;
    ws.commit_message(
        &conv,
        &NewMessage::new(
            &user,
            None,
            "user",
            vec![
                json!({"type": "text", "text": "Bonjour depuis la CLI, 日本 🙂"}),
                json!({"type": "image", "blob": blob, "mediaType": "image/jpeg", "width": 64, "height": 48, "name": "cli.jpg"}),
            ],
        ),
    )
    .map_err(|e| e.to_string())?;
    let answer = ws.new_id().map_err(|e| e.to_string())?;
    let mut m = NewMessage::new(
        &answer,
        Some(user.clone()),
        "assistant",
        vec![
            json!({"type": "reasoning", "text": "A short answer.", "providerMeta": {"anthropic": {"type": "thinking", "signature": "Y2xp"}}}),
            json!({"type": "text", "text": "Hello from the CLI."}),
        ],
    );
    m.model = Some(aparte_sync::ModelRef {
        provider,
        id: "claude-opus-5-5".into(),
    });
    m.usage = Some(json!({"input": 10, "output": 5}));
    m.stop = Some("end".into());
    m.effort = Some("low".into());
    ws.commit_message(&conv, &m).map_err(|e| e.to_string())?;
    ws.set_leaf(&conv, Some(&answer), None).map_err(|e| e.to_string())?;
    let engine = Engine::new(store.clone(), vault.clone(), clock);
    let remote = git(url, data);
    engine
        .round(&remote, false, Some(&ws))
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "passphrase": PASSPHRASE,
        "secretKey": created.secret_key,
        "conversation": conv,
        "photo": {"blob": blob, "size": photo.len(), "sha256": to_hex(&sha256(&photo))},
    }))
}

async fn device(url: &str, data: &Path, pass: &str, kit: &str, text: Option<&str>) -> Result<Value, String> {
    let clock = Arc::new(SystemClock);
    let vault = Arc::new(Vault::new(data.join("vault")).with_argon2(SMALL));
    let remote = git(url, data);
    if vault.state().map_err(|e| e.to_string())? == VaultState::Absent {
        let stored = read_stored_vault(&remote).await.map_err(|e| e.to_string())?;
        vault.join(&stored.vault, &stored.keyslots).map_err(|e| e.to_string())?;
    }
    let sk = parse_secret_key(kit).map_err(|e| e.to_string())?;
    let unlocked = vault
        .unlock(
            &Credential::Passphrase {
                passphrase: pass,
                secret_key: Some(&sk),
            },
            Box::new(OsRng),
        )
        .map_err(|e| e.to_string())?;
    let ws = Workspace::open(unlocked.store.clone(), clock.clone()).map_err(|e| e.to_string())?;
    let engine = Engine::new(unlocked.store.clone(), vault.clone(), clock);
    let first = engine
        .round(&remote, false, Some(&ws))
        .await
        .map_err(|e| e.to_string())?;
    let mut alarms = first.alarms;
    if let Some(text) = text {
        let conv = ws
            .conversations()
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .ok_or("no conversation to answer")?;
        let user = ws.new_id().map_err(|e| e.to_string())?;
        ws.commit_message(
            &conv.id,
            &NewMessage::new(
                &user,
                conv.leaf.clone(),
                "user",
                vec![json!({"type": "text", "text": text})],
            ),
        )
        .map_err(|e| e.to_string())?;
        let answer = ws.new_id().map_err(|e| e.to_string())?;
        let mut m = NewMessage::new(
            &answer,
            Some(user.clone()),
            "assistant",
            vec![
                json!({"type": "reasoning", "text": "", "providerMeta": {"anthropic": {"type": "redacted_thinking", "data": "cmVkYWN0ZWQ"}}}),
                json!({"type": "text", "text": "Answered by the CLI."}),
            ],
        );
        m.stop = Some("end".into());
        ws.commit_message(&conv.id, &m).map_err(|e| e.to_string())?;
        ws.set_leaf(&conv.id, Some(&answer), Some(conv.leaf.as_deref()))
            .map_err(|e| e.to_string())?;
        ws.set_title(&conv.id, "Answered in the CLI")
            .map_err(|e| e.to_string())?;
        alarms = engine
            .round(&remote, false, Some(&ws))
            .await
            .map_err(|e| e.to_string())?
            .alarms;
    }
    let mut out = summary(&ws, &unlocked.store)?;
    out["alarms"] = serde_json::to_value(&alarms).unwrap_or(Value::Null);
    Ok(out)
}
