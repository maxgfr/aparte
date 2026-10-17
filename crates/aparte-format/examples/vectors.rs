//! Computes the `aparte/1` vector files from `spec/vectors/inputs.json`, in the output schema of
//! `spec/vectors/README.md`, and writes them into `spec/vectors` (or the directory given as the only argument). The
//! TypeScript reference writes the same files from the same inputs; `scripts/check-vectors.sh` compares both.
//!
//! Usage: `cargo run -q -p aparte-format --example vectors -- [out-dir]`
//!
//! Every value is computed through the public API of `aparte-format` and `aparte-crypto`, and each case is checked
//! on the way (every sealed envelope and keyslot reopens, every error is the one the reader reports), so a vector
//! is never written for bytes the implementation would not accept.

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use aparte_crypto::envelope::{Compression, open_envelope, seal_envelope};
use aparte_crypto::keys::{Purpose, Subkeys};
use aparte_crypto::keyslot::{
    NewKeyslot, SlotKeys, SlotSecret, create_keyslot, open_keyslot, passphrase_argon2, passphrase_ikm,
};
use aparte_crypto::names::{
    checkpoint_name, chunk_id, device_tag, doc_tag, local_name, manifest_id, secret_tag, secret_version_name,
    segment_name, shard_of,
};
use aparte_crypto::primitives::aes_gcm_encrypt;
use aparte_crypto::rng::QueueRng;
use aparte_crypto::text::{format_recovery_key, format_secret_key};
use aparte_format::encoding::{base32_decode, base32_encode, base64url_decode, base64url_encode, from_hex, to_hex};
use aparte_format::envelope::{HEADER_LEN, Header, Kind, envelope_aad, pad_plaintext};
use aparte_format::framing::{StreamHeader, StreamKind, encode_local_record, encode_stream_payload};
use aparte_format::keyslot::{Argon2Params, KeyslotKind};
use aparte_format::names::{DocId, chunk_name, manifest_name};
use aparte_format::padme::{padded_size, padme};
use aparte_format::{Keyslot, Result as FormatResult};
use json::{Json, number, object, string};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// A JSON value that keeps the member order of objects, which `serde_json::Value` does not without a feature this
/// workspace leaves off. Output goes through `serde_json`'s writers, whose layout is `JSON.stringify`'s.
mod json {
    use std::fmt;

    use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
    use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
    use serde_json::Number;

    #[derive(Debug, Clone, PartialEq)]
    pub enum Json {
        Null,
        Bool(bool),
        Number(Number),
        String(String),
        Array(Vec<Json>),
        Object(Vec<(String, Json)>),
    }

    impl Json {
        pub fn get(&self, key: &str) -> Option<&Json> {
            self.members().iter().find(|(k, _)| k == key).map(|(_, v)| v)
        }

        /// The member `key`, or null when absent.
        pub fn at(&self, key: &str) -> &Json {
            self.get(key).unwrap_or(&Self::Null)
        }

        pub fn str(&self) -> &str {
            if let Self::String(s) = self { s } else { "" }
        }

        pub fn i64(&self) -> Option<i64> {
            if let Self::Number(n) = self { n.as_i64() } else { None }
        }

        pub fn u64(&self) -> u64 {
            if let Self::Number(n) = self {
                n.as_u64().unwrap_or(0)
            } else {
                0
            }
        }

        pub fn items(&self) -> &[Json] {
            if let Self::Array(items) = self { items } else { &[] }
        }

        pub fn members(&self) -> &[(String, Json)] {
            if let Self::Object(members) = self { members } else { &[] }
        }

        /// Sets the member at a dotted path in place (keeping its position), appends it as the last member of its
        /// object when absent, or removes it when `value` is `None`.
        pub fn set_path(&mut self, path: &[&str], value: Option<Json>) {
            let Self::Object(members) = self else { return };
            let Some((first, rest)) = path.split_first() else {
                return;
            };
            let position = members.iter().position(|(k, _)| k == first);
            match (rest.is_empty(), position, value) {
                (false, Some(i), value) => members[i].1.set_path(rest, value),
                (true, Some(i), Some(value)) => members[i].1 = value,
                (true, None, Some(value)) => members.push(((*first).to_owned(), value)),
                (true, Some(i), None) => {
                    members.remove(i);
                }
                _ => {}
            }
        }
    }

    pub fn object(members: Vec<(&str, Json)>) -> Json {
        Json::Object(members.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }

    pub fn string(text: impl Into<String>) -> Json {
        Json::String(text.into())
    }

    pub fn number(n: u64) -> Json {
        Json::Number(n.into())
    }

    impl Serialize for Json {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            match self {
                Self::Null => serializer.serialize_unit(),
                Self::Bool(b) => serializer.serialize_bool(*b),
                Self::Number(n) => n.serialize(serializer),
                Self::String(s) => serializer.serialize_str(s),
                Self::Array(items) => {
                    let mut seq = serializer.serialize_seq(Some(items.len()))?;
                    for item in items {
                        seq.serialize_element(item)?;
                    }
                    seq.end()
                }
                Self::Object(members) => {
                    let mut map = serializer.serialize_map(Some(members.len()))?;
                    for (k, v) in members {
                        map.serialize_entry(k, v)?;
                    }
                    map.end()
                }
            }
        }
    }

    struct JsonVisitor;

    impl<'de> Visitor<'de> for JsonVisitor {
        type Value = Json;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a JSON value")
        }

        fn visit_unit<E>(self) -> Result<Json, E> {
            Ok(Json::Null)
        }

        fn visit_bool<E>(self, b: bool) -> Result<Json, E> {
            Ok(Json::Bool(b))
        }

        fn visit_u64<E>(self, n: u64) -> Result<Json, E> {
            Ok(Json::Number(n.into()))
        }

        fn visit_i64<E>(self, n: i64) -> Result<Json, E> {
            Ok(Json::Number(n.into()))
        }

        fn visit_f64<E: serde::de::Error>(self, n: f64) -> Result<Json, E> {
            Number::from_f64(n)
                .map(Json::Number)
                .ok_or_else(|| E::custom("a non-finite number"))
        }

        fn visit_str<E>(self, s: &str) -> Result<Json, E> {
            Ok(Json::String(s.to_owned()))
        }

        fn visit_string<E>(self, s: String) -> Result<Json, E> {
            Ok(Json::String(s))
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
            let mut items = Vec::new();
            while let Some(item) = seq.next_element()? {
                items.push(item);
            }
            Ok(Json::Array(items))
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
            let mut members = Vec::new();
            while let Some((k, v)) = map.next_entry::<String, Json>()? {
                members.push((k, v));
            }
            Ok(Json::Object(members))
        }
    }

    impl<'de> Deserialize<'de> for Json {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Json, D::Error> {
            deserializer.deserialize_any(JsonVisitor)
        }
    }
}

fn hex(bytes: &[u8]) -> Json {
    string(to_hex(bytes))
}

fn bytes(value: &Json) -> Result<Vec<u8>> {
    Ok(from_hex(value.str())?)
}

fn array<const N: usize>(value: &Json) -> Result<[u8; N]> {
    bytes(value)?
        .try_into()
        .map_err(|_| format!("expected {N} bytes").into())
}

/// The error code of a call that must fail; a call that succeeds is a broken vector.
fn error_code<T>(result: FormatResult<T>) -> Result<Json> {
    match result {
        Ok(_) => Err("a case that must be rejected was accepted".into()),
        Err(error) => Ok(string(error.code().as_str())),
    }
}

/// The fixed inputs and the keys every file derives from them.
struct Ctx {
    inputs: Json,
    mk: [u8; 32],
    vault: [u8; 16],
    subkeys: Subkeys,
}

impl Ctx {
    fn input(&self, path: &[&str]) -> &Json {
        path.iter().fold(&self.inputs, |value, key| value.at(key))
    }
}

fn kind_of(case: &Json) -> Result<Kind> {
    u8::try_from(case.at("kind").u64())
        .ok()
        .and_then(Kind::from_byte)
        .ok_or_else(|| "envelope kind".into())
}

fn doc_id(text: &str) -> Result<DocId> {
    DocId::parse(text).ok_or_else(|| format!("unknown document {text}").into())
}

fn local_names(ctx: &Ctx) -> Result<Vec<(Json, Json, String)>> {
    let cases = ctx.input(&["names", "local"]).items().iter();
    cases
        .map(|c| {
            let name = local_name(&ctx.subkeys, c.at("purpose").str(), c.at("id").str())?;
            Ok((c.at("purpose").clone(), c.at("id").clone(), name))
        })
        .collect()
}

fn keys_file(ctx: &Ctx) -> Result<Json> {
    let subkeys = Purpose::ALL
        .iter()
        .map(|&p| (p.as_str(), hex(ctx.subkeys.expose(p))))
        .collect();
    let mut object_keys = vec![];
    let mut local_keys = vec![];
    for case in ctx.input(&["envelopes"]).items() {
        let name = case.at("name").str();
        if kind_of(case)?.is_local() {
            local_keys.push(object(vec![
                ("name", string(name)),
                ("key", hex(&*ctx.subkeys.local_key(name))),
            ]));
        } else {
            object_keys.push(object(vec![
                ("name", string(name)),
                ("key", hex(&*ctx.subkeys.object_key(name))),
            ]));
        }
    }
    for (_, _, name) in local_names(ctx)? {
        let key = hex(&*ctx.subkeys.local_key(&name));
        local_keys.push(object(vec![("name", string(name)), ("key", key)]));
    }
    Ok(object(vec![
        ("mk", hex(&ctx.mk)),
        ("vaultId", hex(&ctx.vault)),
        ("vault", string(base32_encode(&ctx.vault))),
        ("subkeys", object(subkeys)),
        ("mkCheck", hex(&ctx.subkeys.master_key_check())),
        ("objectKeys", Json::Array(object_keys)),
        ("localKeys", Json::Array(local_keys)),
    ]))
}

fn argon2_params(ctx: &Ctx) -> Result<Argon2Params> {
    let get = |name: &str| u32::try_from(ctx.input(&["argon2", name]).u64()).map_err(|_| "Argon2 parameter");
    Ok(Argon2Params {
        m: get("m")?,
        t: get("t")?,
        p: get("p")?,
    })
}

/// One keyslot case: the slot created with the queued RNG of FORMAT.md section 6.6, its intermediate values, and
/// a check that it opens with its secret (and, for the Unicode passphrase, with the NFKC-equivalent one).
fn keyslot_case(ctx: &Ctx, case: &Json) -> Result<(Json, Vec<u8>)> {
    let sk: [u8; 16] = array(ctx.input(&["secretKey"]))?;
    let recovery: [u8; 32] = array(ctx.input(&["recoveryKey"]))?;
    let slot_id: [u8; 16] = array(case.at("slotId"))?;
    let iv = bytes(case.at("iv"))?;
    let kind = KeyslotKind::parse(case.at("kind").str()).ok_or("keyslot kind")?;
    let mut head = vec![
        ("id", case.at("id").clone()),
        ("kind", case.at("kind").clone()),
        ("slotId", hex(&slot_id)),
    ];
    let mut argon2 = None;
    let (slot, ikm) = match kind {
        KeyslotKind::Passphrase => {
            let salt: [u8; 16] = array(case.at("salt"))?;
            head.push(("salt", hex(&salt)));
            let passphrase = ctx.input(&["passphrases", case.at("passphrase").str()]).str();
            let secret_key = (case.at("secretKey") == &Json::Bool(true)).then_some(&sk);
            let params = argon2_params(ctx)?;
            let a = passphrase_argon2(passphrase, &salt, params, None)?;
            argon2 = Some(hex(&*a));
            let mut rng = QueueRng::new([slot_id.to_vec(), salt.to_vec(), iv.clone()]);
            let new = NewKeyslot::Passphrase {
                passphrase,
                secret_key,
                params,
            };
            let slot = create_keyslot(&ctx.mk, &ctx.vault, &new, &mut rng, None)?;
            if rng.remaining() != 0 {
                return Err("keyslot creation left random values undrawn".into());
            }
            let mut passphrases = vec![passphrase];
            if case.at("passphrase").str() == "unicode" {
                passphrases.push(ctx.input(&["passphrases", "unicodeEquivalent"]).str());
            }
            for passphrase in passphrases {
                let secret = SlotSecret::Passphrase { passphrase, secret_key };
                if *open_keyslot(&slot, &secret, &ctx.vault, None)? != ctx.mk {
                    return Err("a passphrase slot does not reopen".into());
                }
            }
            (slot, passphrase_ikm(&a, secret_key).to_vec())
        }
        KeyslotKind::Recovery => {
            let mut rng = QueueRng::new([slot_id.to_vec(), iv.clone()]);
            let slot = create_keyslot(
                &ctx.mk,
                &ctx.vault,
                &NewKeyslot::Recovery { key: &recovery },
                &mut rng,
                None,
            )?;
            if *open_keyslot(&slot, &SlotSecret::Recovery { key: &recovery }, &ctx.vault, None)? != ctx.mk {
                return Err("the recovery slot does not reopen".into());
            }
            (slot, recovery.to_vec())
        }
        KeyslotKind::Passkey => {
            let credential = bytes(case.at("credentialId"))?;
            let prf_output: [u8; 32] = array(case.at("prfOutput"))?;
            let prf_salt: [u8; 32] = array(case.at("prfSalt"))?;
            let new = NewKeyslot::Passkey {
                prf_output: &prf_output,
                credential_id: &credential,
                rp_id: case.at("rpId").str(),
                prf_salt: &prf_salt,
            };
            let mut rng = QueueRng::new([slot_id.to_vec(), iv.clone()]);
            let slot = create_keyslot(&ctx.mk, &ctx.vault, &new, &mut rng, None)?;
            if *open_keyslot(
                &slot,
                &SlotSecret::Passkey {
                    prf_output: &prf_output,
                },
                &ctx.vault,
                None,
            )? != ctx.mk
            {
                return Err("the passkey slot does not reopen".into());
            }
            (slot, prf_output.to_vec())
        }
    };
    head.extend([("iv", hex(&iv)), ("name", string(slot.name()))]);
    let keys = SlotKeys::derive(&ikm, &ctx.vault, &slot_id, kind);
    let commit = keys.commit(&ctx.vault, &slot_id);
    if commit != slot.commit {
        return Err("the commitment differs from the created slot's".into());
    }
    let file = slot.serialize();
    if Keyslot::parse(&file, Some(&slot.name()))? != slot {
        return Err("the keyslot file does not parse back".into());
    }
    if let Some(a) = argon2 {
        head.push(("argon2", a));
    }
    head.extend([
        ("ikm", hex(&ikm)),
        ("kek", hex(&*keys.kek)),
        ("kWrap", hex(&*keys.k_wrap)),
        ("kCommit", hex(&*keys.k_commit)),
        ("commit", hex(&commit)),
        ("aad", hex(&slot.aad())),
        ("wrapCt", hex(&slot.wrap_ct)),
        ("mkCheck", hex(&slot.mk_check)),
        ("file", hex(&file)),
    ]);
    Ok((object(head), file))
}

fn keyslots_file(ctx: &Ctx) -> Result<Json> {
    let base_id = ctx.input(&["maliciousKeyslots", "base"]).str();
    let mut cases = vec![];
    let mut base_file = None;
    for case in ctx.input(&["keyslots"]).items() {
        let (out, file) = keyslot_case(ctx, case)?;
        if case.at("id").str() == base_id {
            base_file = Some(file);
        }
        cases.push(out);
    }

    let base_file = base_file.ok_or("the malicious base keyslot is not among the keyslots")?;
    let base: Json = serde_json::from_slice(&base_file)?;
    let mut malicious = vec![];
    for case in ctx.input(&["maliciousKeyslots", "cases"]).items() {
        let path: Vec<&str> = case.at("path").str().split('.').collect();
        let mut mutated = base.clone();
        let value = if case.get("delete") == Some(&Json::Bool(true)) {
            None
        } else {
            Some(case.at("value").clone())
        };
        mutated.set_path(&path, value);
        let mut file = serde_json::to_vec(&mutated)?;
        file.push(b'\n');
        let error = error_code(Keyslot::parse(&file, None))?;
        malicious.push(object(vec![
            ("id", case.at("id").clone()),
            ("file", hex(&file)),
            ("error", error),
        ]));
    }

    // Textual cases: the base file with the first occurrence of `find` replaced, as keyslotTexts states.
    let text_base_id = ctx.input(&["keyslotTexts", "base"]).str();
    if text_base_id != base_id {
        return Err("the keyslot text base differs from the malicious base".into());
    }
    let base_text = String::from_utf8(base_file.clone())?;
    let mut texts = vec![];
    for case in ctx.input(&["keyslotTexts", "cases"]).items() {
        let find = case.at("find").str();
        if !base_text.contains(find) {
            return Err(format!("keyslot text {}: the base file has no {find}", case.at("id").str()).into());
        }
        let file = base_text.replacen(find, case.at("replace").str(), 1).into_bytes();
        let error = error_code(Keyslot::parse(&file, None))?;
        texts.push(object(vec![
            ("id", case.at("id").clone()),
            ("file", hex(&file)),
            ("error", error),
        ]));
    }

    let sk: [u8; 16] = array(ctx.input(&["secretKey"]))?;
    let recovery: [u8; 32] = array(ctx.input(&["recoveryKey"]))?;
    Ok(object(vec![
        ("keyslots", Json::Array(cases)),
        ("secretKeyText", string(format_secret_key(&sk))),
        ("recoveryKeyText", string(format_recovery_key(&recovery))),
        ("malicious", Json::Array(malicious)),
        ("texts", Json::Array(texts)),
    ]))
}

/// One envelope case, sealed with a queued RNG holding its IV; it must reopen to its payload.
fn envelope_case(ctx: &Ctx, case: &Json) -> Result<(Json, Vec<u8>)> {
    let kind = kind_of(case)?;
    let name = case.at("name").str();
    let iv: [u8; 12] = array(case.at("iv"))?;
    let precompressed = case.at("compression").str() == "precompressed";
    let stored = bytes(if precompressed {
        case.at("deflated")
    } else {
        case.at("payload")
    })?;
    let compression = if precompressed {
        Compression::Precompressed
    } else {
        Compression::None
    };
    let mut rng = QueueRng::new([iv.to_vec()]);
    let sealed = seal_envelope(&ctx.subkeys, kind, name, &stored, compression, &mut rng)?;
    let header = Header {
        kind,
        flags: u8::from(precompressed),
        iv,
    }
    .to_bytes();
    if sealed[..HEADER_LEN] != header || rng.remaining() != 0 {
        return Err("the sealed header differs from the spec layout".into());
    }
    let payload = open_envelope(&ctx.subkeys, kind, name, &sealed)?;
    if payload[..] != bytes(case.at("payload"))? {
        return Err("the envelope does not reopen to its payload".into());
    }
    let out = object(vec![
        ("id", case.at("id").clone()),
        ("kind", case.at("kind").clone()),
        ("compression", case.at("compression").clone()),
        ("name", string(name)),
        ("header", hex(&header)),
        ("aad", hex(&envelope_aad(&header, &ctx.vault, name))),
        ("plaintext", hex(&pad_plaintext(&stored)?)),
        ("sealed", hex(&sealed)),
        ("payload", hex(&payload)),
    ]);
    Ok((out, sealed))
}

/// Applies one tamper case to the sealed base envelope: the bytes, name and vault the reader is then given.
fn tampered(ctx: &Ctx, base: &Json, sealed: &[u8], case: &Json) -> Result<(Vec<u8>, String, [u8; 16])> {
    let mut out = sealed.to_vec();
    let mut name = base.at("name").str().to_owned();
    let mut vault = ctx.vault;
    let from_end =
        |len: usize, n: i64| -> Result<usize> { Ok(usize::try_from(if n < 0 { i64::try_from(len)? + n } else { n })?) };
    match case.at("op").str() {
        "xor" => {
            let i = from_end(out.len(), case.at("offset").i64().ok_or("tamper offset")?)?;
            out[i] ^= bytes(case.at("mask"))?[0];
        }
        "set" => {
            let i = from_end(out.len(), case.at("offset").i64().ok_or("tamper offset")?)?;
            out[i] = bytes(case.at("value"))?[0];
        }
        "append" => out.extend_from_slice(&bytes(case.at("value"))?),
        "truncate" => {
            let keep = from_end(out.len(), case.at("length").i64().ok_or("truncate length")?)?;
            out.truncate(keep);
        }
        "open-as" => name = case.at("name").str().to_owned(),
        "open-with-vault" => vault = array(ctx.input(&[case.at("vault").str()]))?,
        "raw" => {
            // A validly encrypted envelope around a plaintext the writer would never produce.
            let iv: [u8; 12] = array(case.at("iv"))?;
            let flags = case.get("flags").map(bytes).transpose()?.map_or(0, |f| f[0]);
            let mut header = [0u8; HEADER_LEN];
            header[..8].copy_from_slice(&[b'A', b'P', b'T', b'1', 1, kind_of(base)?.byte(), flags, 0]);
            header[8..].copy_from_slice(&iv);
            let aad = envelope_aad(&header, &ctx.vault, &name);
            let ct = aes_gcm_encrypt(&ctx.subkeys.object_key(&name), &iv, &bytes(case.at("plaintext"))?, &aad)?;
            out = [&header[..], &ct].concat();
        }
        other => return Err(format!("unknown tamper op {other}").into()),
    }
    Ok((out, name, vault))
}

fn envelopes_file(ctx: &Ctx) -> Result<Json> {
    let base_id = ctx.input(&["tamper", "base"]).str();
    let envelopes = ctx.input(&["envelopes"]).items();
    let base = envelopes
        .iter()
        .find(|c| c.at("id").str() == base_id)
        .ok_or("tamper base")?;
    let mut cases = vec![];
    let mut base_sealed = None;
    for case in envelopes {
        let (out, sealed) = envelope_case(ctx, case)?;
        if case.at("id").str() == base_id {
            base_sealed = Some(sealed);
        }
        cases.push(out);
    }
    let sealed = base_sealed.ok_or("tamper base")?;
    let kind = kind_of(base)?;
    let mut tamper = vec![];
    for case in ctx.input(&["tamper", "cases"]).items() {
        let (opened, name, vault) = tampered(ctx, base, &sealed, case)?;
        let error = error_code(open_envelope(&Subkeys::derive(&ctx.mk, &vault), kind, &name, &opened))?;
        tamper.push(object(vec![
            ("id", case.at("id").clone()),
            ("kind", number(u64::from(kind.byte()))),
            ("name", string(name)),
            ("vaultId", hex(&vault)),
            ("bytes", hex(&opened)),
            ("error", error),
        ]));
    }
    Ok(object(vec![
        ("envelopes", Json::Array(cases)),
        ("tamper", Json::Array(tamper)),
    ]))
}

fn names_file(ctx: &Ctx) -> Result<Json> {
    let names = ctx.input(&["names"]);
    let device = |case: &Json| array::<16>(ctx.input(&["deviceIds", case.at("device").str()]));
    let mut devices = vec![];
    for (key, id) in ctx.input(&["deviceIds"]).members() {
        let id: [u8; 16] = array(id)?;
        let dtag = device_tag(&ctx.subkeys, &id);
        devices.push(object(vec![
            ("device", string(key.as_str())),
            ("deviceId", hex(&id)),
            ("dtag", string(dtag)),
        ]));
    }
    let mut docs = vec![];
    for doc in names.at("docIds").items() {
        docs.push(object(vec![
            ("docId", doc.clone()),
            ("stag", string(doc_tag(&ctx.subkeys, doc_id(doc.str())?))),
        ]));
    }
    let mut shards = vec![];
    for conv in names.at("convIds").items() {
        let shard = shard_of(&ctx.subkeys, &array(conv)?);
        shards.push(object(vec![
            ("convId", conv.clone()),
            ("shard", string(shard.as_str())),
        ]));
    }
    let stream = |list: &str, kind: StreamKind| -> Result<Vec<Json>> {
        let mut out = vec![];
        for c in names.at(list).items() {
            let (doc, id, seq, payload) = (
                doc_id(c.at("doc").str())?,
                device(c)?,
                c.at("seq").u64(),
                bytes(c.at("payload"))?,
            );
            let name = match kind {
                StreamKind::Segment => segment_name(&ctx.subkeys, doc, &id, seq, &payload)?,
                StreamKind::Checkpoint => checkpoint_name(&ctx.subkeys, doc, &id, seq, &payload)?,
            };
            out.push(object(vec![
                ("doc", c.at("doc").clone()),
                ("device", c.at("device").clone()),
                ("seq", c.at("seq").clone()),
                ("name", string(name)),
            ]));
        }
        Ok(out)
    };
    let mut chunks = vec![];
    for chunk in names.at("chunks").items() {
        let id = chunk_id(&ctx.subkeys, &bytes(chunk)?);
        let name = chunk_name(&id)?;
        chunks.push(object(vec![("id", string(id)), ("name", string(name))]));
    }
    let mut manifests = vec![];
    for manifest in names.at("manifests").items() {
        let id = manifest_id(&ctx.subkeys, manifest.str().as_bytes());
        let name = manifest_name(&id)?;
        manifests.push(object(vec![("id", string(id)), ("name", string(name))]));
    }
    let mut secrets = vec![];
    for c in names.at("secrets").items() {
        let id: [u8; 16] = array(c.at("id"))?;
        let name = secret_version_name(&ctx.subkeys, &id, c.at("seq").u64(), &bytes(c.at("payload"))?)?;
        secrets.push(object(vec![
            ("secretId", hex(&id)),
            ("seq", c.at("seq").clone()),
            ("ktag", string(secret_tag(&ctx.subkeys, &id))),
            ("name", string(name)),
        ]));
    }
    let local = local_names(ctx)?
        .into_iter()
        .map(|(purpose, id, name)| object(vec![("purpose", purpose), ("id", id), ("name", string(name))]))
        .collect();
    Ok(object(vec![
        ("devices", Json::Array(devices)),
        ("docs", Json::Array(docs)),
        ("shards", Json::Array(shards)),
        ("segments", Json::Array(stream("segments", StreamKind::Segment)?)),
        (
            "checkpoints",
            Json::Array(stream("checkpoints", StreamKind::Checkpoint)?),
        ),
        ("chunks", Json::Array(chunks)),
        ("manifests", Json::Array(manifests)),
        ("secrets", Json::Array(secrets)),
        ("local", Json::Array(local)),
    ]))
}

fn padme_file(ctx: &Ctx) -> Result<Json> {
    let mut cases = vec![];
    for length in ctx.input(&["padme"]).items() {
        let n = u32::try_from(length.u64())?;
        cases.push(object(vec![
            ("length", length.clone()),
            ("padme", number(padme(n))),
            ("paddedSize", number(padded_size(n))),
        ]));
    }
    Ok(object(vec![("padme", Json::Array(cases))]))
}

fn seq_map(value: &Json) -> BTreeMap<String, u64> {
    value.members().iter().map(|(k, v)| (k.clone(), v.u64())).collect()
}

fn stream_header(header: &Json) -> Result<StreamHeader> {
    Ok(StreamHeader {
        doc: doc_id(header.at("doc").str())?,
        device: header.at("device").str().to_owned(),
        seq: header.at("seq").u64(),
        time: header.at("time").u64(),
        seen: seq_map(header.at("seen")),
        blobs: header.at("blobs").items().iter().map(|b| b.str().to_owned()).collect(),
        covers: header.get("covers").map(seq_map),
    })
}

fn framing_file(ctx: &Ctx) -> Result<Json> {
    let stream = |which: &str, kind: StreamKind| -> Result<Json> {
        let case = ctx.input(&["framing", which]);
        let payload = encode_stream_payload(kind, &stream_header(case.at("header"))?, &bytes(case.at("update"))?)?;
        let hlen = usize::try_from(u32::from_be_bytes(payload[..4].try_into()?))?;
        Ok(object(vec![
            ("header", hex(&payload[4..4 + hlen])),
            ("payload", hex(&payload)),
        ]))
    };
    let local = ctx.input(&["framing", "local"]);
    let (purpose, id) = (local.at("purpose").str(), local.at("id").str());
    let payload = encode_local_record(purpose, id, &bytes(local.at("value"))?)?;
    Ok(object(vec![
        ("segment", stream("segment", StreamKind::Segment)?),
        ("checkpoint", stream("checkpoint", StreamKind::Checkpoint)?),
        (
            "local",
            object(vec![
                ("purpose", string(purpose)),
                ("id", string(id)),
                ("name", string(local_name(&ctx.subkeys, purpose, id)?)),
                ("payload", hex(&payload)),
            ]),
        ),
    ]))
}

type Encode = fn(&[u8]) -> String;
type Decode = fn(&str) -> FormatResult<Vec<u8>>;

fn text_file(ctx: &Ctx) -> Result<Json> {
    let valid = |list: &str, encode: Encode, decode: Decode| -> Result<Json> {
        let mut out = vec![];
        for h in ctx.input(&["text", list]).items() {
            let encoded = encode(&bytes(h)?);
            if decode(&encoded)? != bytes(h)? {
                return Err("an encoding does not round trip".into());
            }
            out.push(object(vec![("hex", h.clone()), ("text", string(encoded))]));
        }
        Ok(Json::Array(out))
    };
    let invalid = |list: &str, decode: Decode| -> Result<Json> {
        let mut out = vec![];
        for t in ctx.input(&["text", list]).items() {
            out.push(object(vec![
                ("text", t.clone()),
                ("error", error_code(decode(t.str()))?),
            ]));
        }
        Ok(Json::Array(out))
    };
    Ok(object(vec![
        ("base32", valid("base32", base32_encode, base32_decode)?),
        ("base32Invalid", invalid("base32Invalid", base32_decode)?),
        ("base64url", valid("base64url", base64url_encode, base64url_decode)?),
        ("base64urlInvalid", invalid("base64urlInvalid", base64url_decode)?),
    ]))
}

fn write(dir: &Path, file: &str, value: &Json) -> Result<()> {
    let mut out = serde_json::to_vec_pretty(value)?;
    out.push(b'\n');
    fs::write(dir.join(file), out)?;
    Ok(())
}

fn main() -> Result<()> {
    let vectors = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors");
    let mut args = std::env::args_os().skip(1);
    let out = args.next().map_or_else(|| vectors.clone(), PathBuf::from);
    if args.next().is_some() {
        return Err("usage: cargo run -q -p aparte-format --example vectors -- [out-dir]".into());
    }
    let inputs: Json = serde_json::from_slice(&fs::read(vectors.join("inputs.json"))?)?;
    if inputs.at("format").str() != aparte_format::FORMAT {
        return Err("inputs.json is not for aparte/1".into());
    }
    let mk: [u8; 32] = array(inputs.at("mk"))?;
    let vault: [u8; 16] = array(inputs.at("vaultId"))?;
    let ctx = Ctx {
        subkeys: Subkeys::derive(&mk, &vault),
        inputs,
        mk,
        vault,
    };
    fs::create_dir_all(&out)?;
    write(&out, "keys.json", &keys_file(&ctx)?)?;
    write(&out, "keyslots.json", &keyslots_file(&ctx)?)?;
    write(&out, "envelopes.json", &envelopes_file(&ctx)?)?;
    write(&out, "names.json", &names_file(&ctx)?)?;
    write(&out, "padme.json", &padme_file(&ctx)?)?;
    write(&out, "framing.json", &framing_file(&ctx)?)?;
    write(&out, "text.json", &text_file(&ctx)?)?;
    Ok(())
}
