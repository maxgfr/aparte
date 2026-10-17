//! Object names of spec/FORMAT.md section 8 and local record names of section 11.3, against spec/vectors/inputs.json.
//! Each tag and suffix is recomputed here from its HMAC formula with the raw subkey bytes, so the names module is
//! pinned to the spec rather than to itself. Local records and stream payloads are opened end to end.

use std::collections::{BTreeMap, BTreeSet};

use aparte_crypto::keys::Subkeys;
use aparte_crypto::names::{
    checkpoint_name, chunk_id, device_tag, doc_tag, local_name, manifest_id, secret_tag, secret_version_name,
    segment_name, shard_of,
};
use aparte_crypto::primitives::{hkdf_sha256, hmac_sha256, sha256};
use aparte_crypto::records::{open_local_record, open_stream, seal_local_record};
use aparte_crypto::rng::OsRng;
use aparte_crypto::{Compression, seal_envelope};
use aparte_format::encoding::{base32_encode, from_hex};
use aparte_format::envelope::Kind;
use aparte_format::framing::{StreamHeader, StreamKind, encode_stream_payload};
use aparte_format::names::{DocId, ParsedName, chunk_name, manifest_name, parse_name};
use proptest::prelude::*;
use serde_json::Value;

struct Fixture {
    inputs: Value,
    subkeys: Subkeys,
    obj_name: Vec<u8>,
    blob_id: Vec<u8>,
    local_name: Vec<u8>,
}

fn hex(value: &Value) -> Vec<u8> {
    from_hex(value.as_str().unwrap()).unwrap()
}

fn fixture() -> Fixture {
    let inputs: Value = serde_json::from_str(include_str!("../../../spec/vectors/inputs.json")).unwrap();
    let mk = hex(&inputs["mk"]);
    let vault = hex(&inputs["vaultId"]);
    let raw = |purpose: &str| {
        hkdf_sha256(
            &mk,
            &[b"aparte/1/vault", &vault[..]].concat(),
            format!("aparte/1/{purpose}").as_bytes(),
            32,
        )
        .unwrap()
        .to_vec()
    };
    Fixture {
        subkeys: Subkeys::derive(&mk.clone().try_into().unwrap(), &vault.clone().try_into().unwrap()),
        obj_name: raw("obj-name"),
        blob_id: raw("blob-id"),
        local_name: raw("local-name"),
        inputs,
    }
}

fn tag(key: &[u8], message: &[u8], chars: usize) -> String {
    base32_encode(&hmac_sha256(key, &[message]))[..chars].to_owned()
}

impl Fixture {
    fn device(&self, which: &Value) -> [u8; 16] {
        hex(&self.inputs["deviceIds"][which.as_str().unwrap()])
            .try_into()
            .unwrap()
    }

    fn stag(&self, doc: &str) -> String {
        tag(&self.obj_name, format!("doc|{doc}").as_bytes(), 16)
    }

    fn dtag(&self, device: &[u8; 16]) -> String {
        tag(&self.obj_name, &[&b"dtag|"[..], device].concat(), 16)
    }
}

#[test]
fn device_document_and_secret_tags() {
    let f = fixture();
    for which in ["a", "b"] {
        let device = f.device(&Value::from(which));
        assert_eq!(device_tag(&f.subkeys, &device), f.dtag(&device));
    }
    for doc in f.inputs["names"]["docIds"].as_array().unwrap() {
        let doc = doc.as_str().unwrap();
        assert_eq!(doc_tag(&f.subkeys, DocId::parse(doc).unwrap()), f.stag(doc));
    }
    let tags: BTreeSet<String> = DocId::ALL.iter().map(|&d| doc_tag(&f.subkeys, d)).collect();
    assert_eq!(tags.len(), 17);
    let id: [u8; 16] = hex(&f.inputs["names"]["secrets"][0]["id"]).try_into().unwrap();
    assert_eq!(
        secret_tag(&f.subkeys, &id),
        tag(&f.obj_name, &[&b"secret|"[..], &id].concat(), 16)
    );
}

#[test]
fn shards() {
    let f = fixture();
    for conv in f.inputs["names"]["convIds"].as_array().unwrap() {
        let conv: [u8; 16] = hex(conv).try_into().unwrap();
        let mac = hmac_sha256(&f.obj_name, &[b"shard|", &conv]);
        assert_eq!(shard_of(&f.subkeys, &conv).as_str(), format!("c{:02}", mac[0] & 0x0f));
    }
    let seen: BTreeSet<DocId> = (0..400u32)
        .map(|i| shard_of(&f.subkeys, &core::array::from_fn(|j| (i as usize * j) as u8)))
        .collect();
    assert_eq!(seen.len(), 16);
    assert!(!seen.contains(&DocId::INDEX));
}

#[test]
fn segment_and_checkpoint_names() {
    let f = fixture();
    let streams = [
        ("segments", "seg|", StreamKind::Segment),
        ("checkpoints", "ckpt|", StreamKind::Checkpoint),
    ];
    for (list, label, kind) in streams {
        for case in f.inputs["names"][list].as_array().unwrap() {
            let doc = case["doc"].as_str().unwrap();
            let device = f.device(&case["device"]);
            let seq = case["seq"].as_u64().unwrap();
            let payload = hex(&case["payload"]);
            let (stag, dtag) = (f.stag(doc), f.dtag(&device));
            let message = [format!("{label}{stag}{dtag}{seq:010}").as_bytes(), &sha256(&payload)].concat();
            let r8 = tag(&f.obj_name, &message, 8);
            let doc_id = DocId::parse(doc).unwrap();
            let (name, expected, parsed) = match kind {
                StreamKind::Segment => (
                    segment_name(&f.subkeys, doc_id, &device, seq, &payload).unwrap(),
                    format!("d/{stag}/s/{dtag}/{:07}/{seq:010}-{r8}", seq / 1000),
                    ParsedName::Segment { stag, dtag, seq, r: r8 },
                ),
                StreamKind::Checkpoint => (
                    checkpoint_name(&f.subkeys, doc_id, &device, seq, &payload).unwrap(),
                    format!("d/{stag}/c/{dtag}/{seq:010}-{r8}"),
                    ParsedName::Checkpoint { stag, dtag, seq, r: r8 },
                ),
            };
            assert_eq!(name, expected);
            assert_eq!(parse_name(&name), Some(parsed));
        }
    }
}

#[test]
fn names_are_stable_for_one_payload_and_refuse_bad_sequence_numbers() {
    let f = fixture();
    let device = f.device(&Value::from("b"));
    let doc = DocId::shard(7).unwrap();
    let a = segment_name(&f.subkeys, doc, &device, 5, b"update").unwrap();
    assert_eq!(segment_name(&f.subkeys, doc, &device, 5, b"update").unwrap(), a);
    assert_ne!(segment_name(&f.subkeys, doc, &device, 5, b"update2").unwrap(), a);
    assert_ne!(segment_name(&f.subkeys, doc, &device, 6, b"update").unwrap(), a);
    let bucket = |seq| {
        segment_name(&f.subkeys, DocId::INDEX, &device, seq, b"")
            .unwrap()
            .split('/')
            .nth(4)
            .unwrap()
            .to_owned()
    };
    assert_eq!(bucket(1), "0000000");
    assert_eq!(bucket(999), "0000000");
    assert_eq!(bucket(1000), "0000001");
    assert_eq!(bucket(1_234_567), "0001234");
    assert_eq!(bucket(9_999_999_999), "9999999");
    for seq in [0, 10_000_000_000] {
        let error = segment_name(&f.subkeys, DocId::INDEX, &device, seq, b"").unwrap_err();
        assert_eq!(error.code().as_str(), "invalid-input");
    }
}

#[test]
fn blob_ids_and_names() {
    let f = fixture();
    for chunk in f.inputs["names"]["chunks"].as_array().unwrap() {
        let chunk = hex(chunk);
        let id = tag(&f.blob_id, &[&b"chunk|"[..], &sha256(&chunk)].concat(), 26);
        assert_eq!(chunk_id(&f.subkeys, &chunk), id);
        assert_eq!(chunk_name(&id).unwrap(), format!("b/{}/{id}", &id[..2]));
        assert_eq!(parse_name(&chunk_name(&id).unwrap()), Some(ParsedName::Chunk { id }));
    }
    for manifest in f.inputs["names"]["manifests"].as_array().unwrap() {
        let bytes = manifest.as_str().unwrap().as_bytes();
        let id = tag(&f.blob_id, &[&b"manifest|"[..], &sha256(bytes)].concat(), 26);
        assert_eq!(manifest_id(&f.subkeys, bytes), id);
        assert_eq!(
            parse_name(&manifest_name(&id).unwrap()),
            Some(ParsedName::Manifest { id })
        );
    }
    assert_ne!(
        chunk_id(&f.subkeys, b"same bytes"),
        manifest_id(&f.subkeys, b"same bytes")
    );
}

#[test]
fn secret_version_names() {
    let f = fixture();
    for case in f.inputs["names"]["secrets"].as_array().unwrap() {
        let id: [u8; 16] = hex(&case["id"]).try_into().unwrap();
        let seq = case["seq"].as_u64().unwrap();
        let payload = hex(&case["payload"]);
        let ktag = tag(&f.obj_name, &[&b"secret|"[..], &id].concat(), 16);
        let r8 = tag(
            &f.obj_name,
            &[format!("sec|{ktag}{seq:010}").as_bytes(), &sha256(&payload)].concat(),
            8,
        );
        let name = secret_version_name(&f.subkeys, &id, seq, &payload).unwrap();
        assert_eq!(name, format!("k/{ktag}/{seq:010}-{r8}"));
        assert_eq!(parse_name(&name), Some(ParsedName::Secret { ktag, seq, r: r8 }));
    }
}

#[test]
fn local_record_names() {
    let f = fixture();
    for case in f.inputs["names"]["local"].as_array().unwrap() {
        let (purpose, id) = (case["purpose"].as_str().unwrap(), case["id"].as_str().unwrap());
        let expected = tag(&f.local_name, format!("{purpose}|{id}").as_bytes(), 26);
        assert_eq!(local_name(&f.subkeys, purpose, id).unwrap(), expected);
    }
    for purpose in ["", "Device", "a|b", "1abc", &"x".repeat(33), "with space"] {
        assert_eq!(
            local_name(&f.subkeys, purpose, "id").unwrap_err().code().as_str(),
            "invalid-input",
            "{purpose:?}"
        );
    }
}

#[test]
fn local_records_open_only_under_their_own_name() {
    let f = fixture();
    let local = &f.inputs["framing"]["local"];
    let (purpose, id, value) = (
        local["purpose"].as_str().unwrap(),
        local["id"].as_str().unwrap(),
        hex(&local["value"]),
    );
    let (name, sealed) = seal_local_record(&f.subkeys, purpose, id, &value, &mut OsRng).unwrap();
    assert_eq!(name, local_name(&f.subkeys, purpose, id).unwrap());
    let opened = open_local_record(&f.subkeys, &name, &sealed).unwrap();
    assert_eq!(
        (opened.purpose.as_str(), opened.id.as_str(), &opened.value[..]),
        (purpose, id, &value[..])
    );

    // A record whose framed purpose and id do not give its name is corrupt, even when it decrypts.
    let other = local_name(&f.subkeys, "draft", "x").unwrap();
    let payload = aparte_format::framing::encode_local_record(purpose, id, &value).unwrap();
    let moved = seal_envelope(
        &f.subkeys,
        Kind::LocalRecord,
        &other,
        &payload,
        Compression::None,
        &mut OsRng,
    )
    .unwrap();
    assert_eq!(
        open_local_record(&f.subkeys, &other, &moved)
            .unwrap_err()
            .code()
            .as_str(),
        "corrupt"
    );
    assert_eq!(
        open_local_record(&f.subkeys, &other, &sealed)
            .unwrap_err()
            .code()
            .as_str(),
        "tampered"
    );
}

#[test]
fn streams_open_and_match_their_names() {
    let f = fixture();
    let device = f.device(&Value::from("a"));
    let dtag = device_tag(&f.subkeys, &device);
    let other = device_tag(&f.subkeys, &f.device(&Value::from("b")));
    let header = StreamHeader {
        doc: DocId::shard(7).unwrap(),
        device: dtag.clone(),
        seq: 3,
        time: 1_760_000_000_000,
        seen: BTreeMap::from([(other.clone(), 12)]),
        blobs: vec![],
        covers: None,
    };
    let payload = encode_stream_payload(StreamKind::Segment, &header, &[0, 0, 2, 1]).unwrap();
    let name = segment_name(&f.subkeys, header.doc, &device, 3, &payload).unwrap();
    let sealed = seal_envelope(
        &f.subkeys,
        Kind::Segment,
        &name,
        &payload,
        Compression::DeflateRaw,
        &mut OsRng,
    )
    .unwrap();
    let opened = open_stream(&f.subkeys, &name, &sealed).unwrap();
    assert_eq!(opened.header, header);
    assert_eq!(&opened.update[..], &[0, 0, 2, 1]);

    // A header that names another document, device or seq than its object name is corrupt.
    for wrong in [
        StreamHeader {
            doc: DocId::INDEX,
            ..header.clone()
        },
        StreamHeader {
            device: other.clone(),
            seen: BTreeMap::new(),
            ..header.clone()
        },
        StreamHeader {
            seq: 4,
            ..header.clone()
        },
    ] {
        let payload = encode_stream_payload(StreamKind::Segment, &wrong, &[1]).unwrap();
        let sealed = seal_envelope(
            &f.subkeys,
            Kind::Segment,
            &name,
            &payload,
            Compression::None,
            &mut OsRng,
        )
        .unwrap();
        assert_eq!(
            open_stream(&f.subkeys, &name, &sealed).unwrap_err().code().as_str(),
            "corrupt"
        );
    }
    assert_eq!(
        open_stream(&f.subkeys, "b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa", &sealed)
            .unwrap_err()
            .code()
            .as_str(),
        "invalid-input"
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn every_generated_name_is_lowercase_and_parses_back(
        device in any::<[u8; 16]>(),
        seq in 1u64..=9_999_999_999,
        payload in proptest::collection::vec(any::<u8>(), 0..64),
    ) {
        let f = fixture();
        let doc = DocId::shard(3).unwrap();
        let name = segment_name(&f.subkeys, doc, &device, seq, &payload).unwrap();
        prop_assert_eq!(name.to_lowercase(), name.clone());
        let parsed = matches!(parse_name(&name), Some(ParsedName::Segment { seq: s, .. }) if s == seq);
        prop_assert!(parsed);
        let name = checkpoint_name(&f.subkeys, doc, &device, seq, &payload).unwrap();
        let parsed = matches!(parse_name(&name), Some(ParsedName::Checkpoint { seq: s, .. }) if s == seq);
        prop_assert!(parsed);
    }
}
