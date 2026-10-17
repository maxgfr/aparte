//! The envelope of spec/FORMAT.md section 7 against spec/vectors/inputs.json. Every sealed case is decrypted here by
//! hand with the key and AAD the spec defines, so the layout is pinned independently of the envelope module; then
//! each tamper class must fail with the error of section 7.5, and random bit flips must never open.

use aparte_crypto::envelope::{Compression, open_envelope, seal_envelope};
use aparte_crypto::keys::{Purpose, Subkeys};
use aparte_crypto::primitives::{aes_gcm_decrypt, aes_gcm_encrypt, hkdf_sha256};
use aparte_crypto::rng::{OsRng, QueueRng};
use aparte_format::encoding::{from_hex, to_hex};
use aparte_format::envelope::{Kind, MAX_PAYLOAD, deflate_raw, inflate_raw};
use aparte_format::padme::padded_size;
use proptest::prelude::*;
use serde_json::Value;

const MAGIC: &[u8] = b"APT1";

fn inputs() -> Value {
    serde_json::from_str(include_str!("../../../spec/vectors/inputs.json")).unwrap()
}

fn hex(value: &Value) -> Vec<u8> {
    from_hex(value.as_str().unwrap()).unwrap()
}

fn subkeys_for(inputs: &Value, vault: &str) -> Subkeys {
    let mk: [u8; 32] = hex(&inputs["mk"]).try_into().unwrap();
    Subkeys::derive(&mk, &hex(&inputs[vault]).try_into().unwrap())
}

fn kind_of(case: &Value) -> Kind {
    Kind::from_byte(u8::try_from(case["kind"].as_u64().unwrap()).unwrap()).unwrap()
}

fn stored(case: &Value) -> Vec<u8> {
    if case["compression"] == "precompressed" {
        hex(&case["deflated"])
    } else {
        hex(&case["payload"])
    }
}

fn seal_case(subkeys: &Subkeys, case: &Value) -> Vec<u8> {
    let compression = if case["compression"] == "precompressed" {
        Compression::Precompressed
    } else {
        Compression::None
    };
    let mut rng = QueueRng::new([hex(&case["iv"])]);
    let sealed = seal_envelope(
        subkeys,
        kind_of(case),
        case["name"].as_str().unwrap(),
        &stored(case),
        compression,
        &mut rng,
    )
    .unwrap();
    assert_eq!(rng.remaining(), 0, "exactly one IV is drawn");
    sealed
}

/// The raw key bytes the spec defines, computed with plain HKDF.
fn raw_key(inputs: &Value, kind: Kind, name: &str) -> [u8; 32] {
    let mk = hex(&inputs["mk"]);
    let vault = hex(&inputs["vaultId"]);
    let (purpose, label) = if kind == Kind::LocalRecord {
        ("local-enc", "local")
    } else {
        ("obj-enc", "obj")
    };
    let subkey = hkdf_sha256(
        &mk,
        &[b"aparte/1/vault", &vault[..]].concat(),
        format!("aparte/1/{purpose}").as_bytes(),
        32,
    )
    .unwrap();
    let key = hkdf_sha256(&subkey, &vault, format!("aparte/1/{label}|{name}").as_bytes(), 32).unwrap();
    key[..].try_into().unwrap()
}

fn aad(header: &[u8], vault: &[u8], name: &str) -> Vec<u8> {
    [header, vault, name.as_bytes()].concat()
}

#[test]
fn every_vector_envelope_has_the_spec_layout() {
    let inputs = inputs();
    let subkeys = subkeys_for(&inputs, "vaultId");
    let vault = hex(&inputs["vaultId"]);
    for case in inputs["envelopes"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let name = case["name"].as_str().unwrap();
        let kind = kind_of(case);
        let sealed = seal_case(&subkeys, case);
        let stored = stored(case);
        let size = usize::try_from(padded_size(u32::try_from(stored.len()).unwrap())).unwrap();
        assert_eq!(sealed.len(), 20 + size + 16, "{id}");

        let header = &sealed[..20];
        assert_eq!(&header[..4], MAGIC);
        assert_eq!(header[4], 1);
        assert_eq!(header[5], kind.byte());
        assert_eq!(header[6], u8::from(case["compression"] == "precompressed"), "{id}");
        assert_eq!(header[7], 0);
        assert_eq!(to_hex(&header[8..]), case["iv"].as_str().unwrap());

        let key = raw_key(&inputs, kind, name);
        let iv: [u8; 12] = header[8..].try_into().unwrap();
        let plaintext = aes_gcm_decrypt(&key, &iv, &sealed[20..], &aad(header, &vault, name)).unwrap();
        assert_eq!(plaintext.len(), size);
        assert_eq!(
            u32::from_be_bytes(plaintext[..4].try_into().unwrap()) as usize,
            stored.len()
        );
        assert_eq!(&plaintext[4..4 + stored.len()], &stored[..]);
        assert!(plaintext[4 + stored.len()..].iter().all(|&b| b == 0));

        let opened = open_envelope(&subkeys, kind, name, &sealed).unwrap();
        assert_eq!(to_hex(&opened), case["payload"].as_str().unwrap(), "{id}");
    }
}

#[test]
fn padding_edges_and_the_worked_example() {
    let inputs = inputs();
    let subkeys = subkeys_for(&inputs, "vaultId");
    let by_id = |id: &str| {
        inputs["envelopes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(seal_case(&subkeys, &by_id("empty")).len(), 100);
    assert_eq!(seal_case(&subkeys, &by_id("boundary-60")).len(), 100);
    assert_eq!(seal_case(&subkeys, &by_id("boundary-61")).len(), 108);
    // spec/FORMAT.md section 15.3.
    let sealed = seal_case(&subkeys, &by_id("segment-plain"));
    assert_eq!(sealed.len(), 108);
    assert_eq!(to_hex(&sealed[..20]), "4150543101010000a0a1a2a3a4a5a6a7a8a9aaab");
}

#[test]
fn the_precomputed_streams_inflate_to_their_payloads() {
    let inputs = inputs();
    for case in inputs["envelopes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["compression"] == "precompressed")
    {
        assert_eq!(
            inflate_raw(&hex(&case["deflated"]), MAX_PAYLOAD).unwrap(),
            hex(&case["payload"])
        );
    }
}

#[test]
fn deflate_raw_compresses_segments_and_checkpoints() {
    let subkeys = subkeys_for(&inputs(), "vaultId");
    let payload = b"aparte/1 segment body ".repeat(200);
    for kind in [Kind::Segment, Kind::Checkpoint] {
        let name = format!(
            "d/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/000000000{}-cccccccc",
            kind.byte()
        );
        let sealed = seal_envelope(&subkeys, kind, &name, &payload, Compression::DeflateRaw, &mut OsRng).unwrap();
        assert_eq!(sealed[6], 1);
        assert!(sealed.len() < payload.len() / 4);
        assert_eq!(
            &open_envelope(&subkeys, kind, &name, &sealed).unwrap()[..],
            &payload[..]
        );
    }
    // Incompressible data is stored as it is, without the flag.
    let random: Vec<u8> = (0..64u32)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect();
    let name = "d/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc";
    let sealed = seal_envelope(
        &subkeys,
        Kind::Segment,
        name,
        &random,
        Compression::DeflateRaw,
        &mut OsRng,
    )
    .unwrap();
    assert_eq!(sealed[6], 0);
    assert_eq!(
        &open_envelope(&subkeys, Kind::Segment, name, &sealed).unwrap()[..],
        &random[..]
    );
}

#[test]
fn compression_is_refused_for_kinds_3_to_6() {
    let subkeys = subkeys_for(&inputs(), "vaultId");
    for kind in [Kind::Chunk, Kind::Manifest, Kind::SecretVersion, Kind::LocalRecord] {
        for compression in [Compression::DeflateRaw, Compression::Precompressed] {
            let error = seal_envelope(
                &subkeys,
                kind,
                "b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa",
                &[0; 8],
                compression,
                &mut OsRng,
            )
            .unwrap_err();
            assert_eq!(error.code().as_str(), "invalid-input");
        }
    }
}

#[test]
fn seal_draws_one_iv_and_refuses_oversized_payloads() {
    let subkeys = subkeys_for(&inputs(), "vaultId");
    let name = "b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa";
    let mut rng = QueueRng::new([vec![1u8; 12]]);
    seal_envelope(&subkeys, Kind::Chunk, name, &[0; 4], Compression::None, &mut rng).unwrap();
    assert_eq!(rng.remaining(), 0);
    let a = seal_envelope(&subkeys, Kind::Chunk, name, &[0; 4], Compression::None, &mut OsRng).unwrap();
    let b = seal_envelope(&subkeys, Kind::Chunk, name, &[0; 4], Compression::None, &mut OsRng).unwrap();
    assert_ne!(a, b);
    let segment = "d/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc";
    let big = vec![0; MAX_PAYLOAD + 1];
    let error = seal_envelope(&subkeys, Kind::Segment, segment, &big, Compression::None, &mut OsRng).unwrap_err();
    assert_eq!(error.code().as_str(), "invalid-input");
    let chunk = vec![0; 2_097_153];
    let error = seal_envelope(&subkeys, Kind::Chunk, name, &chunk, Compression::None, &mut OsRng).unwrap_err();
    assert_eq!(error.code().as_str(), "invalid-input");
    let error = seal_envelope(&subkeys, Kind::Chunk, "b/é", &[], Compression::None, &mut OsRng).unwrap_err();
    assert_eq!(error.code().as_str(), "invalid-input");
}

#[test]
fn kind_6_uses_the_local_key_and_the_others_the_object_key() {
    let inputs = inputs();
    let subkeys = subkeys_for(&inputs, "vaultId");
    let local = inputs["envelopes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == 6)
        .unwrap();
    let name = local["name"].as_str().unwrap();
    let sealed = seal_case(&subkeys, local);
    let iv: [u8; 12] = sealed[8..20].try_into().unwrap();
    let wrong = aes_gcm_decrypt(
        &subkeys.object_key(name),
        &iv,
        &sealed[20..],
        &aad(&sealed[..20], subkeys.vault_id(), name),
    );
    assert_eq!(wrong.unwrap_err().code().as_str(), "tampered");
    assert_eq!(*subkeys.local_key(name), raw_key(&inputs, Kind::LocalRecord, name));
    assert_ne!(subkeys.expose(Purpose::LocalEnc), subkeys.expose(Purpose::ObjEnc));
}

/// The expected error of each tamper class, by the step of spec/FORMAT.md section 7.5 it breaks.
fn expected_error(id: &str) -> &'static str {
    match id {
        "magic" | "kind-unknown" | "kind-mismatch" | "flags-unknown" | "truncated-short" | "padding-non-zero"
        | "length-beyond" | "padding-excess" | "deflate-garbage" => "corrupt",
        "version" | "epoch" => "unsupported-format",
        "flags-compress" | "iv" | "ciphertext" | "tag" | "trailing-byte" | "truncated-tag" | "name-swap"
        | "vault-swap" => "tampered",
        other => panic!("no expectation for tamper case {other}"),
    }
}

/// Applies one tamper case of the vectors to the sealed base envelope; returns the bytes, the name and the
/// vault to open with.
fn tamper(inputs: &Value, base: &Value, sealed: &[u8], case: &Value) -> (Vec<u8>, String, String) {
    let mut bytes = sealed.to_vec();
    let mut name = base["name"].as_str().unwrap().to_owned();
    let mut vault = "vaultId".to_owned();
    let at = |len: usize| {
        let offset = case["offset"].as_i64().unwrap();
        usize::try_from(if offset < 0 { len as i64 + offset } else { offset }).unwrap()
    };
    match case["op"].as_str().unwrap() {
        "xor" => {
            let i = at(bytes.len());
            bytes[i] ^= hex(&case["mask"])[0];
        }
        "set" => {
            let i = at(bytes.len());
            bytes[i] = hex(&case["value"])[0];
        }
        "append" => bytes.extend_from_slice(&hex(&case["value"])),
        "truncate" => {
            let length = case["length"].as_i64().unwrap();
            let keep = if length < 0 {
                bytes.len() as i64 + length
            } else {
                length
            };
            bytes.truncate(usize::try_from(keep).unwrap());
        }
        "open-as" => name = case["name"].as_str().unwrap().to_owned(),
        "open-with-vault" => vault = case["vault"].as_str().unwrap().to_owned(),
        "raw" => {
            // A validly encrypted envelope around a plaintext the writer would never produce.
            let iv: [u8; 12] = hex(&case["iv"]).try_into().unwrap();
            let flags = case.get("flags").map_or(0, |f| hex(f)[0]);
            let header = [MAGIC, &[1, 1, flags, 0], &iv].concat();
            let key = raw_key(inputs, Kind::Segment, &name);
            let ct = aes_gcm_encrypt(
                &key,
                &iv,
                &hex(&case["plaintext"]),
                &aad(&header, &hex(&inputs["vaultId"]), &name),
            )
            .unwrap();
            bytes = [header, ct].concat();
        }
        other => panic!("unknown tamper op {other}"),
    }
    (bytes, name, vault)
}

#[test]
fn every_tamper_class_fails_with_the_error_of_its_step() {
    let inputs = inputs();
    let subkeys = subkeys_for(&inputs, "vaultId");
    let base_id = inputs["tamper"]["base"].as_str().unwrap();
    let base = inputs["envelopes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == base_id)
        .unwrap();
    let sealed = seal_case(&subkeys, base);
    let cases = inputs["tamper"]["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 19);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let (bytes, name, vault) = tamper(&inputs, base, &sealed, case);
        let keys = subkeys_for(&inputs, &vault);
        let error = open_envelope(&keys, Kind::Segment, &name, &bytes).unwrap_err();
        assert_eq!(error.code().as_str(), expected_error(id), "{id}: {error}");
    }
}

#[test]
fn a_compressed_payload_that_inflates_beyond_2_26_bytes_is_corrupt() {
    let subkeys = subkeys_for(&inputs(), "vaultId");
    let bomb = deflate_raw(&vec![0; MAX_PAYLOAD + 1]).unwrap();
    let name = "d/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc";
    let sealed = seal_envelope(
        &subkeys,
        Kind::Segment,
        name,
        &bomb,
        Compression::Precompressed,
        &mut OsRng,
    )
    .unwrap();
    assert_eq!(
        open_envelope(&subkeys, Kind::Segment, name, &sealed)
            .unwrap_err()
            .code()
            .as_str(),
        "corrupt"
    );
}

#[test]
fn envelopes_shorter_than_the_minimum_are_corrupt() {
    let subkeys = subkeys_for(&inputs(), "vaultId");
    let name = "d/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc";
    for len in [0, 20, 99] {
        assert_eq!(
            open_envelope(&subkeys, Kind::Segment, name, &vec![0; len])
                .unwrap_err()
                .code()
                .as_str(),
            "corrupt"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn any_payload_round_trips(
        kind in 1u8..=6,
        payload in proptest::collection::vec(any::<u8>(), 0..600),
        name in "[a-z0-9/-]{1,70}",
    ) {
        let subkeys = subkeys_for(&inputs(), "vaultId");
        let kind = Kind::from_byte(kind).unwrap();
        let sealed = seal_envelope(&subkeys, kind, &name, &payload, Compression::None, &mut OsRng).unwrap();
        prop_assert_eq!(&open_envelope(&subkeys, kind, &name, &sealed).unwrap()[..], &payload[..]);
        if kind.allows_compression() {
            let sealed = seal_envelope(&subkeys, kind, &name, &payload, Compression::DeflateRaw, &mut OsRng).unwrap();
            prop_assert_eq!(&open_envelope(&subkeys, kind, &name, &sealed).unwrap()[..], &payload[..]);
        }
    }

    #[test]
    fn any_single_bit_flip_is_rejected(payload in proptest::collection::vec(any::<u8>(), 0..200), bit in any::<usize>()) {
        let subkeys = subkeys_for(&inputs(), "vaultId");
        let name = "d/aaaaaaaaaaaaaaaa/c/bbbbbbbbbbbbbbbb/0000000003-ffffffff";
        let mut sealed = seal_envelope(&subkeys, Kind::Checkpoint, name, &payload, Compression::DeflateRaw, &mut OsRng).unwrap();
        let bit = bit % (sealed.len() * 8);
        sealed[bit / 8] ^= 1 << (bit % 8);
        prop_assert!(open_envelope(&subkeys, Kind::Checkpoint, name, &sealed).is_err());
    }
}
