//! The Git store through the system `git`, against a local bare repository: two CLI devices sync a vault through
//! it, the repository holds the layout of the web app's GitHub store (base64 files under `aparte/`, a README, the
//! constant author and message, no signature), and a push that another device beat is rebuilt on the new head.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use aparte_crypto::OsRng;
use aparte_crypto::text::parse_secret_key;
use aparte_format::keyslot::Argon2Params;
use aparte_store::{CreateOptions, Credential, Vault};
use aparte_sync::join::read_stored_vault;
use aparte_sync::providers::git::{GitStore, GitTarget, read_checkout};
use aparte_sync::{Engine, NewConversation, NewMessage, RemoteStore, SystemClock, Workspace};
use serde_json::json;

const SMALL: Argon2Params = Argon2Params { m: 19456, t: 2, p: 1 };

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn bare(dir: &Path) -> String {
    let repo = dir.join("remote.git");
    std::fs::create_dir_all(&repo).expect("dir");
    git(&repo, &["init", "--bare", "-q", "-b", "main"]);
    repo.to_string_lossy().into_owned()
}

fn store(url: &str, cache: &Path) -> GitStore {
    GitStore::new(
        &GitTarget {
            url: url.to_owned(),
            branch: None,
            root: None,
        },
        cache,
    )
}

#[test]
fn two_devices_sync_through_a_bare_repository() {
    let dir = tempfile::tempdir().expect("tempdir");
    let url = bare(dir.path());
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let clock = Arc::new(SystemClock);

    let va = Arc::new(Vault::new(dir.path().join("a")).with_argon2(SMALL));
    let created = va
        .create("git passphrase", CreateOptions::default(), &mut OsRng, Box::new(OsRng))
        .expect("create");
    let wa = Workspace::open(created.unlocked.store.clone(), clock.clone()).expect("workspace");
    let conv = wa
        .create_conversation(NewConversation {
            title: Some("Over git".into()),
            ..NewConversation::default()
        })
        .expect("conversation");
    let m = wa.new_id().expect("id");
    wa.commit_message(
        &conv,
        &NewMessage::new(&m, None, "user", vec![json!({"type": "text", "text": "hello git"})]),
    )
    .expect("message");
    wa.set_leaf(&conv, Some(&m), None).expect("leaf");
    let sa = store(&url, &dir.path().join("cache-a"));
    let ea = Engine::new(created.unlocked.store.clone(), va.clone(), clock.clone());
    let r = rt.block_on(ea.round(&sa, false, Some(&wa))).expect("round A");
    assert!(r.up >= 5, "{r:?}");

    // The repository is the web app's GitHub layout.
    let checkout = dir.path().join("checkout");
    let out = Command::new("git")
        .args(["clone", "-q", &url])
        .arg(&checkout)
        .output()
        .expect("clone");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let readme = std::fs::read_to_string(checkout.join("aparte/README.md")).expect("readme");
    assert!(readme.starts_with("This folder holds an Aparté vault"));
    let marker = std::fs::read_to_string(checkout.join("aparte/fmt/1")).expect("marker");
    assert_eq!(marker, "YXBhcnRlLzEK", "objects are padded base64 text");
    let objects = read_checkout(&checkout, None).expect("objects");
    assert_eq!(objects.get("fmt/1").map(Vec::as_slice), Some(&b"aparte/1\n"[..]));
    let log = git(&checkout, &["log", "--format=%an <%ae>|%cn|%s|%G?"]);
    for line in log.lines() {
        assert_eq!(
            line,
            "aparte <aparte@users.noreply.github.com>|aparte|aparte: objects|N"
        );
    }

    let vb = Arc::new(Vault::new(dir.path().join("b")).with_argon2(SMALL));
    let sb = store(&url, &dir.path().join("cache-b"));
    let stored = rt.block_on(read_stored_vault(&sb)).expect("stored");
    vb.join(&stored.vault, &stored.keyslots).expect("join");
    let sk = parse_secret_key(created.secret_key.as_deref().expect("kit")).expect("kit");
    let ub = vb
        .unlock(
            &Credential::Passphrase {
                passphrase: "git passphrase",
                secret_key: Some(&sk),
            },
            Box::new(OsRng),
        )
        .expect("unlock");
    let wb = Workspace::open(ub.store.clone(), clock.clone()).expect("workspace");
    let eb = Engine::new(ub.store.clone(), vb.clone(), clock);
    let r = rt.block_on(eb.round(&sb, false, Some(&wb))).expect("round B");
    assert!(r.alarms.is_empty(), "{:?}", r.alarms);
    assert_eq!(wb.path(&conv, None).expect("path")[0].parts[0]["text"], "hello git");

    // Both devices write before either pushes: the second push is rebuilt on the first one's head.
    wa.set_title(&conv, "from A").expect("title");
    let reply = wb.new_id().expect("id");
    wb.commit_message(
        &conv,
        &NewMessage::new(
            &reply,
            Some(m.clone()),
            "user",
            vec![json!({"type": "text", "text": "from B"})],
        ),
    )
    .expect("reply");
    rt.block_on(sa.list()).expect("A lists the old head");
    rt.block_on(eb.round(&sb, false, Some(&wb))).expect("round B");
    rt.block_on(ea.round(&sa, false, Some(&wa))).expect("round A rebuilds");
    rt.block_on(eb.round(&sb, false, Some(&wb))).expect("round B reads A");
    assert_eq!(wb.conversation(&conv).expect("get").expect("conv").title, "from A");
    assert_eq!(wa.messages(&conv).expect("messages").len(), 2);
}

#[test]
fn a_missing_repository_is_not_found() {
    let dir = tempfile::tempdir().expect("tempdir");
    let s = store(
        &dir.path().join("nothing.git").to_string_lossy(),
        &dir.path().join("cache"),
    );
    let rt = tokio::runtime::Builder::new_current_thread().build().expect("runtime");
    let err = rt.block_on(s.list()).unwrap_err();
    assert_eq!(err.kind, aparte_sync::RemoteErrorKind::NotFound, "{err}");
}
