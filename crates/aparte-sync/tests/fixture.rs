//! The frozen sync fixture of spec/fixtures/sync-v1, written once by the TypeScript reference, read by the CLI: the
//! documents decode with yrs to exactly what the reference recorded, and a new CLI device joins the vault from a copy
//! of the store, syncs it, and reads the conversation and its photo, with no alarm.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use aparte_crypto::OsRng;
use aparte_crypto::primitives::sha256;
use aparte_crypto::text::parse_secret_key;
use aparte_format::encoding::{base32_decode_array, to_hex};
use aparte_format::names::DocId;
use aparte_store::{Credential, Vault};
use aparte_sync::blobs::get_blob;
use aparte_sync::join::read_stored_vault;
use aparte_sync::providers::folder::FolderStore;
use aparte_sync::streams::{DocTags, stream_name};
use aparte_sync::ydoc::{apply_update, doc_json, new_doc};
use aparte_sync::{Engine, SystemClock, Workspace};
use serde_json::Value;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/fixtures/sync-v1")
}

fn fixture() -> Value {
    serde_json::from_slice(&std::fs::read(root().join("fixture.json")).expect("fixture.json")).expect("json")
}

/// A copy of the frozen store: whatever a round writes never reaches the fixture.
fn copy_store(to: &Path) {
    let from = root().join("store");
    for name in aparte_store::fsx::walk(&from).expect("walk") {
        let target = to.join(&name);
        std::fs::create_dir_all(target.parent().expect("parent")).expect("dir");
        std::fs::copy(from.join(&name), target).expect("copy");
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().expect("string")
}

#[test]
fn the_documents_decode_to_what_the_reference_recorded() {
    let fx = fixture();
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = Vault::new(dir.path().join("vault"));
    let store_dir = dir.path().join("store");
    copy_store(&store_dir);
    let rt = tokio::runtime::Builder::new_current_thread().build().expect("runtime");
    let stored = rt
        .block_on(read_stored_vault(&FolderStore::new(&store_dir, "fixture")))
        .expect("stored vault");
    assert_eq!(stored.vault, str_of(&fx, "vault"));
    vault.join(&stored.vault, &stored.keyslots).expect("join");
    let sk = parse_secret_key(str_of(&fx, "secretKey")).expect("secret key");
    let unlocked = vault
        .unlock(
            &Credential::Passphrase {
                passphrase: str_of(&fx, "passphrase"),
                secret_key: Some(&sk),
            },
            Box::new(OsRng),
        )
        .expect("unlock");
    let tags = DocTags::new(&unlocked.subkeys);
    for doc in ["index", "c06"] {
        let id = DocId::parse(doc).expect("doc");
        assert_eq!(tags.tag(id), str_of(&fx["docs"], doc));
        let ydoc = new_doc(1);
        let mut applied = 0;
        for name in aparte_store::fsx::walk(&store_dir).expect("walk") {
            let Some(parsed) = stream_name(&name) else { continue };
            if parsed.stag != tags.tag(id) {
                continue;
            }
            let bytes = std::fs::read(store_dir.join(&name)).expect("read");
            let opened = aparte_sync::streams::open(&unlocked.subkeys, &name, &bytes).expect("open");
            apply_update(&ydoc, &opened.update).expect("apply");
            applied += 1;
        }
        assert!(applied > 1, "{doc} has several streams");
        let maps: Vec<&str> = if doc == "index" {
            vec!["conversations", "folders", "settings", "providers"]
        } else {
            vec!["messages"]
        };
        assert_eq!(
            doc_json(&ydoc, &maps),
            fx["documents"][doc],
            "{doc} decodes to the recorded maps"
        );
    }
}

#[test]
fn a_cli_device_joins_from_the_store_and_syncs_it() {
    let fx = fixture();
    let dir = tempfile::tempdir().expect("tempdir");
    let store_dir = dir.path().join("store");
    copy_store(&store_dir);
    let remote = FolderStore::new(&store_dir, "fixture");
    let vault = Arc::new(Vault::new(dir.path().join("vault")));
    let rt = tokio::runtime::Builder::new_current_thread().build().expect("runtime");
    let stored = rt.block_on(read_stored_vault(&remote)).expect("stored vault");
    vault.join(&stored.vault, &stored.keyslots).expect("join");
    let sk = parse_secret_key(str_of(&fx, "secretKey")).expect("secret key");
    let unlocked = vault
        .unlock(
            &Credential::Passphrase {
                passphrase: str_of(&fx, "passphrase"),
                secret_key: Some(&sk),
            },
            Box::new(OsRng),
        )
        .expect("unlock");
    assert_eq!(
        unlocked.vault_id,
        base32_decode_array::<16>(str_of(&fx, "vault")).expect("id")
    );
    let clock = Arc::new(SystemClock);
    let ws = Workspace::open(unlocked.store.clone(), clock.clone()).expect("workspace");
    let engine = Engine::new(unlocked.store.clone(), vault.clone(), clock);
    let result = rt.block_on(engine.round(&remote, false, Some(&ws))).expect("round");
    // A device that holds nothing of a document starts from its checkpoints, then fetches the segments above them.
    assert!(result.down >= 6, "the blobs and the checkpoints came down: {result:?}");
    assert!(result.alarms.is_empty(), "{:?}", result.alarms);
    let conversations = ws.conversations().expect("list");
    assert_eq!(conversations.len(), 1);
    let conv = &conversations[0];
    assert_eq!(conv.title, "Renamed on the second device");
    assert_eq!(conv.system, "Answer briefly.");
    let path = ws.path(&conv.id, None).expect("path");
    assert_eq!(
        path.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
        ["user", "assistant", "user", "user"]
    );
    let answer = &path[1];
    assert_eq!(answer.parts[0]["providerMeta"]["anthropic"]["signature"], "c2ln");
    assert_eq!(answer.usage.as_ref().expect("usage")["input"], 12);
    let photo = &fx["photo"];
    let blob = get_blob(&unlocked.store, str_of(photo, "blob"))
        .expect("blob")
        .expect("present");
    assert_eq!(blob.bytes.len() as u64, photo["size"].as_u64().expect("size"));
    assert_eq!(to_hex(&sha256(&blob.bytes)), str_of(photo, "sha256"));
    assert_eq!(blob.manifest.mime, "image/jpeg");
    // A second round lists the same store: nothing to move, still no alarm.
    let again = rt.block_on(engine.round(&remote, false, Some(&ws))).expect("round");
    assert_eq!((again.down, again.up), (0, 0));
    assert!(again.alarms.is_empty());
}
