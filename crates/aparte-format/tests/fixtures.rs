//! The frozen sync fixture of spec/fixtures/sync-v1, written once by the TypeScript reference (web/scripts/fixtures.ts),
//! read by this implementation: the store holds exactly the recorded objects, both keyslots open with the recorded
//! secrets, and every segment, checkpoint, chunk and manifest opens and decodes to what fixture.json records. The Yjs
//! updates are compared by hash (the CLI decodes them with yrs in its sync crate).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use aparte_crypto::envelope::open_envelope;
use aparte_crypto::keys::Subkeys;
use aparte_crypto::keyslot::{SlotSecret, open_keyslot};
use aparte_crypto::names::{chunk_id, doc_tag, manifest_id};
use aparte_crypto::primitives::sha256;
use aparte_crypto::records::open_stream;
use aparte_crypto::text::{parse_recovery_key, parse_secret_key};
use aparte_format::encoding::{base32_decode_array, base64url_encode, to_hex};
use aparte_format::envelope::Kind;
use aparte_format::framing::{Manifest, StreamKind};
use aparte_format::keyslot::{Keyslot, KeyslotKind};
use aparte_format::names::{DocId, ParsedName, check_format_marker, parse_name};
use serde_json::Value;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/fixtures/sync-v1")
}

fn fixture() -> Value {
    serde_json::from_slice(&fs::read(root().join("fixture.json")).unwrap()).unwrap()
}

fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            walk(base, &path, out);
        } else {
            let name = path
                .strip_prefix(base)
                .unwrap()
                .components()
                .map(|c| c.as_os_str().to_str().unwrap().to_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.insert(name, fs::read(&path).unwrap());
        }
    }
}

fn store() -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let base = root().join("store");
    walk(&base, &base, &mut out);
    out
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}

fn subkeys(fixture: &Value, store: &BTreeMap<String, Vec<u8>>) -> Subkeys {
    let vault: [u8; 16] = base32_decode_array(str_of(fixture, "vault")).unwrap();
    let slots: Vec<Keyslot> = store
        .iter()
        .filter(|(name, _)| name.starts_with("keys/"))
        .map(|(name, bytes)| Keyslot::parse(bytes, Some(name)).unwrap())
        .collect();
    let passphrase = slots.iter().find(|s| s.kind() == KeyslotKind::Passphrase).unwrap();
    let secret_key = parse_secret_key(str_of(fixture, "secretKey")).unwrap();
    let mk = open_keyslot(
        passphrase,
        &SlotSecret::Passphrase {
            passphrase: str_of(fixture, "passphrase"),
            secret_key: Some(&secret_key),
        },
        &vault,
        None,
    )
    .unwrap();
    let recovery = slots.iter().find(|s| s.kind() == KeyslotKind::Recovery).unwrap();
    let recovery_key = parse_recovery_key(str_of(fixture, "recoveryKey")).unwrap();
    let again = open_keyslot(recovery, &SlotSecret::Recovery { key: &recovery_key }, &vault, None).unwrap();
    assert_eq!(*mk, *again, "both slots wrap the same master key");
    Subkeys::derive(&mk, &vault)
}

#[test]
fn the_store_holds_exactly_the_recorded_objects() {
    let fixture = fixture();
    let store = store();
    let objects = fixture["objects"].as_array().unwrap();
    let recorded: Vec<&str> = objects.iter().map(|o| str_of(o, "name")).collect();
    let mut sorted = recorded.clone();
    sorted.sort_unstable();
    assert_eq!(store.keys().map(String::as_str).collect::<Vec<_>>(), sorted);
    for object in objects {
        let name = str_of(object, "name");
        assert_eq!(to_hex(&sha256(&store[name])), str_of(object, "sha256"), "{name}");
        assert!(parse_name(name).is_some(), "{name} parses");
    }
    check_format_marker(&store["fmt/1"]).unwrap();
}

#[test]
fn every_object_opens_to_what_the_fixture_records() {
    let fixture = fixture();
    let store = store();
    let keys = subkeys(&fixture, &store);
    for (doc, stag) in fixture["docs"].as_object().unwrap() {
        assert_eq!(doc_tag(&keys, DocId::parse(doc).unwrap()), stag.as_str().unwrap());
    }
    let mut streams = 0;
    for object in fixture["objects"].as_array().unwrap() {
        let name = str_of(object, "name");
        let bytes = &store[name];
        match parse_name(name).unwrap() {
            ParsedName::Segment { .. } | ParsedName::Checkpoint { .. } => {
                let opened = open_stream(&keys, name, bytes).unwrap();
                let h = &object["header"];
                assert_eq!(opened.header.doc.as_str(), str_of(h, "doc"), "{name}");
                assert_eq!(opened.header.device, str_of(h, "device"), "{name}");
                assert_eq!(opened.header.seq, h["seq"].as_u64().unwrap(), "{name}");
                assert_eq!(opened.header.time, h["time"].as_u64().unwrap(), "{name}");
                let seen: BTreeMap<String, u64> = h["seen"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.as_u64().unwrap()))
                    .collect();
                assert_eq!(opened.header.seen, seen, "{name}");
                let blobs: Vec<String> = h["blobs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| b.as_str().unwrap().to_owned())
                    .collect();
                assert_eq!(opened.header.blobs, blobs, "{name}");
                match opened.kind {
                    StreamKind::Checkpoint => {
                        let covers: BTreeMap<String, u64> = h["covers"]
                            .as_object()
                            .unwrap()
                            .iter()
                            .map(|(k, v)| (k.clone(), v.as_u64().unwrap()))
                            .collect();
                        assert_eq!(opened.header.covers, Some(covers), "{name}");
                    }
                    StreamKind::Segment => assert_eq!(opened.header.covers, None, "{name}"),
                }
                assert_eq!(to_hex(&sha256(&opened.update)), str_of(object, "update"), "{name}");
                streams += 1;
            }
            ParsedName::Chunk { id } => {
                let chunk = open_envelope(&keys, Kind::Chunk, name, bytes).unwrap();
                assert_eq!(chunk.len() as u64, object["size"].as_u64().unwrap());
                assert_eq!(to_hex(&sha256(&chunk)), str_of(object, "plaintext"));
                assert_eq!(
                    chunk_id(&keys, &chunk),
                    id,
                    "a chunk id is the keyed hash of its plaintext"
                );
            }
            ParsedName::Manifest { id } => {
                let payload = open_envelope(&keys, Kind::Manifest, name, bytes).unwrap();
                assert_eq!(manifest_id(&keys, &payload), id);
                let manifest = Manifest::decode(&payload).unwrap();
                let m = &object["manifest"];
                assert_eq!(manifest.mime, str_of(m, "type"));
                assert_eq!(manifest.size, m["size"].as_u64().unwrap());
                assert_eq!(base64url_encode(&manifest.sha256), str_of(m, "sha256"));
                let chunks: Vec<&str> = m["chunks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| c.as_str().unwrap())
                    .collect();
                assert_eq!(manifest.chunks, chunks);
                assert_eq!(
                    manifest.encode().unwrap(),
                    payload.to_vec(),
                    "the manifest is in writer form"
                );
            }
            ParsedName::Keyslot { .. } => {
                let slot = Keyslot::parse(bytes, Some(name)).unwrap();
                assert_eq!(slot.serialize(), *bytes, "the keyslot is in writer form");
            }
            ParsedName::Fmt => check_format_marker(bytes).unwrap(),
            ParsedName::Secret { .. } => panic!("the fixture holds no secret version"),
        }
    }
    assert!(streams >= 10, "segments and checkpoints of two devices");
}

#[test]
fn the_photo_reassembles_from_its_chunks() {
    let fixture = fixture();
    let store = store();
    let keys = subkeys(&fixture, &store);
    let photo = &fixture["photo"];
    let id = str_of(photo, "blob");
    let name = format!("m/{}/{id}", &id[..2]);
    let manifest = Manifest::decode(&open_envelope(&keys, Kind::Manifest, &name, &store[&name]).unwrap()).unwrap();
    let mut file = Vec::new();
    for chunk in &manifest.chunks {
        let chunk_name = format!("b/{}/{chunk}", &chunk[..2]);
        file.extend_from_slice(&open_envelope(&keys, Kind::Chunk, &chunk_name, &store[&chunk_name]).unwrap());
    }
    assert_eq!(manifest.chunks.len(), 2, "a photo above 2 MiB is two chunks");
    assert_eq!(file.len() as u64, photo["size"].as_u64().unwrap());
    assert_eq!(sha256(&file), manifest.sha256);
    assert_eq!(to_hex(&sha256(&file)), str_of(photo, "sha256"));
}
