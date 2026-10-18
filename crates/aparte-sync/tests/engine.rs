//! The sync engine between CLI devices through an in-memory store, and against an adversarial store: convergence,
//! the `seen` vectors, checkpoints, keyslot changes, and the alarms of spec/FORMAT.md section 10.3 (rollback,
//! withholding, forks, tampering), plus hostile objects that must never enter the mirror.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use aparte_crypto::OsRng;
use aparte_crypto::text::parse_secret_key;
use aparte_format::keyslot::Argon2Params;
use aparte_store::{CreateOptions, Credential, Unlocked, Vault};
use aparte_sync::blobs::{get_blob, put_blob};
use aparte_sync::join::read_stored_vault;
use aparte_sync::providers::memory::{MemoryBucket, MemoryStore};
use aparte_sync::streams::stream_name;
use aparte_sync::{Clock, Engine, NewConversation, NewMessage, RemoteErrorKind, Workspace};
use proptest::prelude::*;
use serde_json::json;

const SMALL: Argon2Params = Argon2Params { m: 19456, t: 2, p: 1 };
const PASSPHRASE: &str = "a test passphrase";

#[derive(Debug, Default)]
struct TestClock(AtomicU64);

impl TestClock {
    fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now(&self) -> u64 {
        1_760_000_000_000 + self.0.fetch_add(1, Ordering::SeqCst)
    }
}

struct Device {
    vault: Arc<Vault>,
    unlocked: Unlocked,
    ws: Workspace,
    engine: Engine,
    clock: Arc<TestClock>,
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
}

fn device(vault: Arc<Vault>, unlocked: Unlocked) -> Device {
    let clock = Arc::new(TestClock::default());
    let ws = Workspace::open(unlocked.store.clone(), clock.clone()).expect("workspace");
    let mut engine = Engine::new(unlocked.store.clone(), vault.clone(), clock.clone());
    engine.withhold_ms = 1000;
    Device {
        vault,
        unlocked,
        ws,
        engine,
        clock,
    }
}

/// A device that creates a vault; returns it with its Emergency Kit text.
fn first(dir: &Path) -> (Device, String) {
    let vault = Arc::new(Vault::new(dir.join("a")).with_argon2(SMALL));
    let created = vault
        .create(PASSPHRASE, CreateOptions::default(), &mut OsRng, Box::new(OsRng))
        .expect("create");
    let kit = created.secret_key.clone().expect("kit");
    (device(vault, created.unlocked), kit)
}

/// A device that joins the vault of `store`.
fn join(dir: &Path, name: &str, store: &MemoryStore, kit: &str) -> Device {
    let vault = Arc::new(Vault::new(dir.join(name)).with_argon2(SMALL));
    let stored = rt().block_on(read_stored_vault(store)).expect("stored");
    vault.join(&stored.vault, &stored.keyslots).expect("join");
    let sk = parse_secret_key(kit).expect("kit");
    let unlocked = vault
        .unlock(
            &Credential::Passphrase {
                passphrase: PASSPHRASE,
                secret_key: Some(&sk),
            },
            Box::new(OsRng),
        )
        .expect("unlock");
    device(vault, unlocked)
}

fn round(d: &Device, store: &MemoryStore) -> aparte_sync::RoundResult {
    rt().block_on(d.engine.round(store, false, Some(&d.ws))).expect("round")
}

/// A conversation of a user message and an answer with a reasoning part; returns its id.
fn chat(d: &Device, text: &str) -> String {
    let conv =
        d.ws.create_conversation(NewConversation {
            title: Some("From the CLI".into()),
            system: Some("Be brief.".into()),
            ..NewConversation::default()
        })
        .expect("create");
    let user = d.ws.new_id().expect("id");
    d.ws.commit_message(
        &conv,
        &NewMessage::new(&user, None, "user", vec![json!({"type": "text", "text": text})]),
    )
    .expect("user");
    d.ws.set_leaf(&conv, Some(&user), None).expect("leaf");
    let answer = d.ws.new_id().expect("id");
    let mut m = NewMessage::new(
        &answer,
        Some(user.clone()),
        "assistant",
        vec![
            json!({"type": "reasoning", "text": "thinking", "providerMeta": {"anthropic": {"type": "thinking", "signature": "c2ln"}}}),
            json!({"type": "text", "text": "an answer"}),
        ],
    );
    m.usage = Some(json!({"input": 3, "output": 2}));
    m.stop = Some("end".into());
    d.ws.commit_message(&conv, &m).expect("answer");
    d.ws.set_leaf(&conv, Some(&answer), Some(Some(&user))).expect("leaf");
    conv
}

#[test]
fn two_devices_converge_and_see_each_other() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bucket = MemoryBucket::new();
    let store = MemoryStore::new(bucket.clone(), "memory");
    let (a, kit) = first(dir.path());
    let conv = chat(&a, "Bonjour, café 日本 🙂");
    let photo: Vec<u8> = (0..2_200_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let blob = put_blob(&a.unlocked.store, &photo, "image/png", Some("p.png")).expect("blob");
    let leaf =
        a.ws.conversation(&conv)
            .expect("get")
            .expect("conv")
            .leaf
            .expect("leaf");
    let photo_message = a.ws.new_id().expect("id");
    a.ws.commit_message(
        &conv,
        &NewMessage::new(
            &photo_message,
            Some(leaf),
            "user",
            vec![json!({"type": "image", "blob": blob, "mediaType": "image/png", "width": 2, "height": 2})],
        ),
    )
    .expect("photo message");
    a.ws.set_leaf(&conv, Some(&photo_message), None).expect("leaf");
    let first_round = round(&a, &store);
    assert!(first_round.sealed >= 2 && first_round.up > 0, "{first_round:?}");
    assert!(bucket.read("fmt/1").is_some());
    assert_eq!(bucket.names("keys/").len(), 2);

    let b = join(dir.path(), "b", &store, &kit);
    let joined = round(&b, &store);
    assert!(joined.alarms.is_empty(), "{:?}", joined.alarms);
    let seen = b.ws.conversations().expect("list");
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].id, conv);
    let path = b.ws.path(&conv, None).expect("path");
    assert_eq!(
        path.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
        ["user", "assistant", "user"]
    );
    assert_eq!(path[0].parts[0]["text"], "Bonjour, café 日本 🙂");
    assert_eq!(path[1].parts[0]["providerMeta"]["anthropic"]["signature"], "c2ln");
    let got = get_blob(&b.unlocked.store, path[2].parts[0]["blob"].as_str().expect("blob"))
        .expect("get")
        .expect("here");
    assert_eq!(got.bytes, photo);

    b.ws.set_title(&conv, "Renamed on B").expect("rename");
    let reply = b.ws.new_id().expect("id");
    b.ws.commit_message(
        &conv,
        &NewMessage::new(
            &reply,
            Some(photo_message.clone()),
            "user",
            vec![json!({"type": "text", "text": "from B"})],
        ),
    )
    .expect("reply");
    b.ws.set_leaf(&conv, Some(&reply), None).expect("leaf");
    round(&b, &store);
    let back = round(&a, &store);
    assert!(back.alarms.is_empty(), "{:?}", back.alarms);
    let c = a.ws.conversation(&conv).expect("get").expect("conv");
    assert_eq!(c.title, "Renamed on B");
    assert_eq!(a.ws.path(&conv, None).expect("path").len(), 4);

    // Each device's later segments name what it had applied of the other.
    let a_tag = a.engine.device_tag().expect("tag");
    let b_tag = b.engine.device_tag().expect("tag");
    let mut b_saw_a = false;
    for name in bucket.names("d/") {
        let p = stream_name(&name).expect("stream");
        let opened =
            aparte_sync::streams::open(&a.unlocked.subkeys, &name, &bucket.read(&name).expect("bytes")).expect("open");
        if p.dtag == b_tag && opened.header.seen.get(&a_tag).copied().unwrap_or(0) > 0 {
            b_saw_a = true;
        }
    }
    assert!(b_saw_a, "B's segments name A's");
}

#[test]
fn checkpoints_let_a_new_device_start_from_them() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bucket = MemoryBucket::new();
    let store = MemoryStore::new(bucket.clone(), "memory");
    let (mut a, kit) = first(dir.path());
    a.engine.checkpoint_every = 2;
    let conv = chat(&a, "one");
    round(&a, &store);
    a.ws.set_title(&conv, "two").expect("title");
    round(&a, &store);
    a.ws.set_title(&conv, "three").expect("title");
    round(&a, &store);
    assert!(
        bucket
            .names("d/")
            .iter()
            .any(|n| stream_name(n).is_some_and(|p| p.checkpoint)),
        "a checkpoint was written"
    );
    let c = join(dir.path(), "c", &store, &kit);
    let result = round(&c, &store);
    assert!(result.alarms.is_empty(), "{:?}", result.alarms);
    assert_eq!(c.ws.conversation(&conv).expect("get").expect("conv").title, "three");
    assert_eq!(c.ws.path(&conv, None).expect("path").len(), 2);
}

#[test]
fn a_rollback_a_gap_and_a_fork_raise_alarms_and_delete_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bucket = MemoryBucket::new();
    let store = MemoryStore::new(bucket.clone(), "memory");
    let (a, kit) = first(dir.path());
    let conv = chat(&a, "hello");
    round(&a, &store);
    for t in ["x", "y", "z"] {
        a.ws.set_title(&conv, t).expect("title");
        round(&a, &store);
    }
    let a_tag = a.engine.device_tag().expect("tag");
    let index_tag = a.ws.tags().tag(aparte_format::names::DocId::INDEX).to_owned();
    let mut index_segments: Vec<String> = bucket
        .names("d/")
        .into_iter()
        .filter(|n| stream_name(n).is_some_and(|p| !p.checkpoint && p.dtag == a_tag && p.stag == index_tag))
        .collect();
    index_segments.sort();
    assert!(index_segments.len() >= 4);

    // A gap below a listed segment that a new device never had, kept across listings longer than the delay.
    let middle = index_segments[1].clone();
    let saved = bucket.remove(&middle).expect("present");
    let b = join(dir.path(), "b", &store, &kit);
    let first_listing = round(&b, &store);
    assert!(
        first_listing.alarms.is_empty(),
        "a first listing is trusted: {:?}",
        first_listing.alarms
    );
    b.clock.advance(5_000);
    let withheld = round(&b, &store);
    assert!(
        withheld.alarms.iter().any(|al| al.kind == "withheld"),
        "{:?}",
        withheld.alarms
    );
    bucket.write(&middle, &saved);
    round(&b, &store);

    // A rollback: the highest segment disappears.
    let last = index_segments.last().expect("last").clone();
    bucket.remove(&last).expect("present");
    let rolled = round(&b, &store);
    assert!(
        rolled.alarms.iter().any(|al| al.kind == "rollback"),
        "{:?}",
        rolled.alarms
    );
    assert!(
        b.unlocked.store.has_object(&last).expect("has"),
        "nothing local is deleted"
    );
    assert_eq!(b.ws.conversation(&conv).expect("get").expect("conv").title, "z");

    // A fork: two names for one (document, device, seq).
    let p = stream_name(&index_segments[0]).expect("parsed");
    let forged = format!("{}aaaaaaaa", &index_segments[0][..index_segments[0].len() - 8]);
    assert_ne!(forged, index_segments[0]);
    bucket.write(&forged, &bucket.read(&index_segments[0]).expect("bytes"));
    let forked = round(&b, &store);
    assert!(
        forked
            .alarms
            .iter()
            .any(|al| al.kind == "fork" && al.id.contains(&format!(":{}", p.seq))),
        "{:?}",
        forked.alarms
    );
    assert!(
        !b.unlocked.store.has_object(&forged).expect("has"),
        "the forged copy does not authenticate"
    );
}

#[test]
fn a_tampered_object_is_refused_then_reported() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bucket = MemoryBucket::new();
    let store = MemoryStore::new(bucket.clone(), "memory");
    let (a, kit) = first(dir.path());
    chat(&a, "hello");
    round(&a, &store);
    let target = bucket.names("d/")[0].clone();
    let mut bytes = bucket.read(&target).expect("bytes");
    let at = bytes.len() / 2;
    bytes[at] ^= 0x40;
    bucket.remove(&target);
    bucket.write(&target, &bytes);
    let b = join(dir.path(), "b", &store, &kit);
    let mut last = round(&b, &store);
    for _ in 0..3 {
        last = round(&b, &store);
    }
    assert!(
        last.alarms
            .iter()
            .any(|al| al.kind == "tampered" && al.detail.contains("tampered")),
        "{:?}",
        last.alarms
    );
    assert!(!b.unlocked.store.has_object(&target).expect("has"));
}

#[test]
fn a_device_that_finds_its_tag_used_elsewhere_takes_a_new_one() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bucket = MemoryBucket::new();
    let store = MemoryStore::new(bucket.clone(), "memory");
    let (a, _) = first(dir.path());
    chat(&a, "hello");
    round(&a, &store);
    let before = a.engine.device_tag().expect("tag");
    let mine = bucket.names("d/")[0].clone();
    let p = stream_name(&mine).expect("parsed");
    let clone_name = aparte_format::names::segment_name(&p.stag, &p.dtag, p.seq + 100, "bbbbbbbb").expect("name");
    bucket.write(&clone_name, &bucket.read(&mine).expect("bytes"));
    let result = round(&a, &store);
    assert!(
        result.alarms.iter().any(|al| al.id == format!("fork:{before}")),
        "{:?}",
        result.alarms
    );
    assert_ne!(a.engine.device_tag().expect("tag"), before);
}

#[test]
fn a_new_passphrase_reaches_the_other_devices_and_the_old_slot_leaves_the_store() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bucket = MemoryBucket::new();
    let store = MemoryStore::new(bucket.clone(), "memory");
    let (a, kit) = first(dir.path());
    round(&a, &store);
    let b = join(dir.path(), "b", &store, &kit);
    round(&b, &store);
    let sk = parse_secret_key(&kit).expect("kit");
    let changed = a
        .vault
        .change_passphrase(
            &Credential::Passphrase {
                passphrase: PASSPHRASE,
                secret_key: Some(&sk),
            },
            "another passphrase",
            &mut OsRng,
        )
        .expect("change");
    round(&a, &store);
    assert!(bucket.read(&format!("keys/{}.json", changed.added)).is_some());
    assert!(
        bucket.read(&format!("keys/{}.json", changed.previous)).is_none(),
        "removed where the store allows it"
    );
    round(&b, &store);
    b.vault
        .unlock(
            &Credential::Passphrase {
                passphrase: "another passphrase",
                secret_key: Some(&sk),
            },
            Box::new(OsRng),
        )
        .expect("the new passphrase opens B");
}

#[test]
fn a_store_of_another_vault_is_incompatible() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bucket = MemoryBucket::new();
    let store = MemoryStore::new(bucket.clone(), "memory");
    let (a, _) = first(dir.path());
    round(&a, &store);
    let other_dir = tempfile::tempdir().expect("tempdir");
    let (other, _) = first(other_dir.path());
    let err = rt()
        .block_on(other.engine.round(&store, false, Some(&other.ws)))
        .unwrap_err();
    assert_eq!(err.remote_kind(), Some(RemoteErrorKind::Incompatible));
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 24, .. ProptestConfig::default() })]

    /// Random bytes under valid object names: the round goes on, nothing hostile enters the mirror.
    #[test]
    fn hostile_objects_never_enter_the_mirror(
        objects in proptest::collection::vec((0usize..4, proptest::collection::vec(any::<u8>(), 0..400)), 1..6),
    ) {
        let dir = tempfile::tempdir().expect("tempdir");
        let bucket = MemoryBucket::new();
        let store = MemoryStore::new(bucket.clone(), "memory");
        let (a, kit) = first(dir.path());
        chat(&a, "hello");
        round(&a, &store);
        let tags = a.ws.tags().clone();
        let stag = tags.tag(aparte_format::names::DocId::INDEX).to_owned();
        let mut planted = Vec::new();
        for (i, (kind, bytes)) in objects.iter().enumerate() {
            let id = format!("{}{}", "q".repeat(25), ["a", "e", "i", "m"][i % 4]);
            let name = match kind {
                0 => format!("b/{}/{id}", &id[..2]),
                1 => format!("m/{}/{id}", &id[..2]),
                2 => aparte_format::names::segment_name(&stag, "zzzzzzzzzzzzzzzz", (i + 1) as u64, "cccccccc").expect("name"),
                _ => aparte_format::names::checkpoint_name(&stag, "yyyyyyyyyyyyyyyy", (i + 1) as u64, "cccccccc").expect("name"),
            };
            bucket.write(&name, bytes);
            planted.push(name);
        }
        let b = join(dir.path(), "b", &store, &kit);
        let result = rt().block_on(b.engine.round(&store, false, Some(&b.ws)));
        prop_assert!(result.is_ok(), "{:?}", result.err());
        for name in planted {
            prop_assert!(!b.unlocked.store.has_object(&name).expect("has"), "{} entered the mirror", name);
        }
        prop_assert_eq!(b.ws.conversations().expect("list").len(), 1);
    }
}
