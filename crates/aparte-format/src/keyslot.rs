//! Keyslot files of spec/FORMAT.md section 6: the schema, the bounds, the strict parser (steps 1 to 3 of section
//! 6.7), the writer serialization and the wrap's associated data. Creating and opening a slot needs the cipher and
//! Argon2, and lives in the crypto crate.
//!
//! The binary members are held decoded, in fixed-size arrays: since every encoding is strict, re-encoding them gives
//! back the only valid text, which is what makes the canonical-form check of step 3 meaningful.

use std::collections::BTreeMap;

use serde_json::value::RawValue;
use serde_json::{Map, Value, json};

use crate::FORMAT;
use crate::encoding::{
    base32_decode_array, base32_encode, base64url_decode, base64url_decode_array, base64url_encode, canonical_json,
    json_uint, push_json_string,
};
use crate::error::{Error, Result};
use crate::names::keyslot_name;

/// The Argon2 version of every passphrase slot, `0x13`.
pub const ARGON2_VERSION: u64 = 19;

/// The parameters writers use: fixed, never calibrated to the device, so every device can open every slot.
pub const DEFAULT_ARGON2: Argon2Params = Argon2Params { m: 65536, t: 3, p: 1 };

/// Inclusive bounds of the memory cost, in KiB.
pub const ARGON2_M_BOUNDS: (u32, u32) = (19456, 262_144);
/// Inclusive bounds of the passes.
pub const ARGON2_T_BOUNDS: (u32, u32) = (2, 10);
/// Inclusive bounds of the lanes.
pub const ARGON2_P_BOUNDS: (u32, u32) = (1, 4);

/// Inclusive bounds of a passkey credential id, in bytes.
pub const CREDENTIAL_ID_BOUNDS: (usize, usize) = (16, 1023);
/// The longest relying party id.
pub const MAX_RP_ID_LEN: usize = 253;

const MEMBERS: [&str; 9] = [
    "format", "type", "vault", "slot", "kind", "kdf", "commit", "wrap", "mkCheck",
];

/// Argon2id costs of a passphrase slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Params {
    /// Memory in KiB.
    pub m: u32,
    /// Passes.
    pub t: u32,
    /// Lanes.
    pub p: u32,
}

impl Argon2Params {
    /// Whether every cost is within the bounds of spec/FORMAT.md section 6.3.
    pub const fn in_bounds(&self) -> bool {
        within(self.m, ARGON2_M_BOUNDS) && within(self.t, ARGON2_T_BOUNDS) && within(self.p, ARGON2_P_BOUNDS)
    }
}

const fn within(value: u32, (min, max): (u32, u32)) -> bool {
    value >= min && value <= max
}

/// The kind of secret a keyslot is opened with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeyslotKind {
    /// A passphrase through Argon2id, with or without the Secret Key.
    Passphrase,
    /// The 32-byte recovery key.
    Recovery,
    /// The PRF output of a WebAuthn credential.
    Passkey,
}

impl KeyslotKind {
    /// The ASCII kind name, as written in the file and the AAD.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Passphrase => "passphrase",
            Self::Recovery => "recovery",
            Self::Passkey => "passkey",
        }
    }

    /// The kind of an exact kind name.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "passphrase" => Some(Self::Passphrase),
            "recovery" => Some(Self::Recovery),
            "passkey" => Some(Self::Passkey),
            _ => None,
        }
    }
}

/// The `kdf` object of a keyslot (spec/FORMAT.md section 6.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kdf {
    /// `{"alg":"argon2id","v":19,"m","t","p","salt","secretKey"}`.
    Passphrase {
        /// The Argon2id costs.
        params: Argon2Params,
        /// The 16-byte Argon2 salt.
        salt: [u8; 16],
        /// Whether the Secret Key is part of the input key material.
        secret_key: bool,
    },
    /// `{"alg":"recovery"}`.
    Recovery,
    /// `{"alg":"prf","credentialId","rpId","prfSalt"}`.
    Passkey {
        /// The WebAuthn credential id, 16 to 1023 bytes.
        credential_id: Vec<u8>,
        /// The relying party id, 1 to 253 characters of `[a-z0-9.-]`.
        rp_id: String,
        /// The WebAuthn PRF `eval.first` input.
        prf_salt: [u8; 32],
    },
}

impl Kdf {
    /// The kind this kdf belongs to.
    pub const fn kind(&self) -> KeyslotKind {
        match self {
            Self::Passphrase { .. } => KeyslotKind::Passphrase,
            Self::Recovery => KeyslotKind::Recovery,
            Self::Passkey { .. } => KeyslotKind::Passkey,
        }
    }

    /// The rules of spec/FORMAT.md section 6.3 that the types do not already enforce; `unsupported-keyslot`.
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Passphrase { params, .. } if !params.in_bounds() => {
                Err(Error::UnsupportedKeyslot("Argon2 parameters out of bounds"))
            }
            Self::Passkey {
                credential_id, rp_id, ..
            } => {
                let (min, max) = CREDENTIAL_ID_BOUNDS;
                if !(min..=max).contains(&credential_id.len()) {
                    return Err(Error::UnsupportedKeyslot("passkey credential id length"));
                }
                if !is_rp_id(rp_id) {
                    return Err(Error::UnsupportedKeyslot("passkey relying party id"));
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// The kdf as a JSON value (member order is irrelevant here: it feeds [`canonical_json`]).
    fn to_value(&self) -> Value {
        match self {
            Self::Passphrase {
                params,
                salt,
                secret_key,
            } => json!({
                "alg": "argon2id",
                "v": ARGON2_VERSION,
                "m": params.m,
                "t": params.t,
                "p": params.p,
                "salt": base64url_encode(salt),
                "secretKey": secret_key,
            }),
            Self::Recovery => json!({ "alg": "recovery" }),
            Self::Passkey {
                credential_id,
                rp_id,
                prf_salt,
            } => json!({
                "alg": "prf",
                "credentialId": base64url_encode(credential_id),
                "rpId": rp_id,
                "prfSalt": base64url_encode(prf_salt),
            }),
        }
    }

    /// `canon(kdf)`, RFC 8785 (spec/FORMAT.md section 3.3).
    pub fn canonical(&self) -> String {
        // Only strings, booleans and integers below 2^32 occur, which canonical_json always accepts.
        canonical_json(&self.to_value()).unwrap_or_default()
    }

    /// Appends the kdf in writer order (spec/FORMAT.md section 3.4).
    fn push_writer(&self, out: &mut String) {
        match self {
            Self::Passphrase {
                params,
                salt,
                secret_key,
            } => {
                out.push_str(&format!(
                    "{{\"alg\":\"argon2id\",\"v\":{ARGON2_VERSION},\"m\":{},\"t\":{},\"p\":{},\"salt\":\"{}\",\
                     \"secretKey\":{secret_key}}}",
                    params.m,
                    params.t,
                    params.p,
                    base64url_encode(salt),
                ));
            }
            Self::Recovery => out.push_str("{\"alg\":\"recovery\"}"),
            Self::Passkey {
                credential_id,
                rp_id,
                prf_salt,
            } => {
                out.push_str("{\"alg\":\"prf\",\"credentialId\":\"");
                out.push_str(&base64url_encode(credential_id));
                out.push_str("\",\"rpId\":");
                push_json_string(out, rp_id);
                out.push_str(",\"prfSalt\":\"");
                out.push_str(&base64url_encode(prf_salt));
                out.push_str("\"}");
            }
        }
    }
}

fn is_rp_id(text: &str) -> bool {
    (1..=MAX_RP_ID_LEN).contains(&text.len())
        && text
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
}

/// A parsed keyslot file (spec/FORMAT.md section 6.2). `format` is always `aparte/1` and `type` always `keyslot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keyslot {
    /// The vault this slot opens.
    pub vault_id: [u8; 16],
    /// This slot's id, which is also its file name.
    pub slot_id: [u8; 16],
    /// How the input key material is computed; it also fixes the kind.
    pub kdf: Kdf,
    /// `commit`, checked before the wrap is decrypted.
    pub commit: [u8; 32],
    /// The IV of the wrap.
    pub wrap_iv: [u8; 12],
    /// `AES-GCM(K_wrap, wrap.iv, MK, aad)`: 32 bytes of ciphertext and a 16-byte tag.
    pub wrap_ct: [u8; 48],
    /// `mkCheck`, checked after the unwrap.
    pub mk_check: [u8; 32],
}

/// Requires `value` to be a JSON string, else returns `error`.
fn string(value: &Value, error: Error) -> Result<&str> {
    value.as_str().ok_or(error)
}

/// Requires an object with exactly the members `names`, else returns `error`.
fn exact_object<'a>(value: &'a Value, names: &[&str], error: Error) -> Result<&'a Map<String, Value>> {
    let object = value.as_object().ok_or_else(|| error.clone())?;
    if object.len() != names.len() || !names.iter().all(|n| object.contains_key(*n)) {
        return Err(error);
    }
    Ok(object)
}

fn corrupt_b64<const N: usize>(value: &Value) -> Result<[u8; N]> {
    let text = string(value, Error::Corrupt("keyslot member is not a string"))?;
    base64url_decode_array(text).map_err(|_| Error::Corrupt("keyslot binary member"))
}

fn corrupt_b32(value: &Value) -> Result<[u8; 16]> {
    let text = string(value, Error::Corrupt("keyslot member is not a string"))?;
    base32_decode_array(text).map_err(|_| Error::Corrupt("keyslot id"))
}

fn kdf_uint(object: &Map<String, Value>, name: &str, bounds: (u32, u32)) -> Result<u32> {
    let n = json_uint(&object[name]).ok_or(Error::UnsupportedKeyslot("kdf parameter is not an integer"))?;
    u32::try_from(n)
        .ok()
        .filter(|&n| within(n, bounds))
        .ok_or(Error::UnsupportedKeyslot("Argon2 parameter out of bounds"))
}

fn kdf_b64<const N: usize>(object: &Map<String, Value>, name: &str) -> Result<[u8; N]> {
    let text = string(&object[name], Error::UnsupportedKeyslot("kdf member is not a string"))?;
    base64url_decode_array(text).map_err(|_| Error::UnsupportedKeyslot("kdf binary member"))
}

/// A JSON object whose member values are kept as unparsed text. serde_json skips a raw value without building it,
/// so a number of any magnitude and a nesting of any depth pass, as they do through `JSON.parse`; on a repeated
/// member the last one wins, as with `JSON.parse`.
type RawObject = BTreeMap<String, Box<RawValue>>;

/// Whether a JSON text holds a `\u` escape of a surrogate that is not the high half of a high-low pair followed by
/// its low half (spec/FORMAT.md section 6.7 step 1). Valid UTF-8 cannot encode a surrogate, so in a UTF-8 JSON
/// text a lone surrogate can only come from such an escape. Outside strings a backslash is not JSON at all, and
/// inside one it always starts an escape, so scanning escapes from the left finds exactly the ones `JSON.parse`
/// decodes. keyslot.ts runs the same scan.
fn has_lone_surrogate_escape(text: &[u8]) -> bool {
    fn unit(text: &[u8], at: usize) -> Option<u16> {
        let hex = text.get(at..at + 4)?;
        let hex = std::str::from_utf8(hex).ok()?;
        if !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        u16::from_str_radix(hex, 16).ok()
    }
    let mut i = 0;
    while i < text.len() {
        if text[i] != b'\\' {
            i += 1;
            continue;
        }
        if text.get(i + 1) != Some(&b'u') {
            i += 2;
            continue;
        }
        match unit(text, i + 2) {
            Some(0xd800..=0xdbff) => {
                let low = (text.get(i + 6) == Some(&b'\\') && text.get(i + 7) == Some(&b'u'))
                    .then(|| unit(text, i + 8))
                    .flatten();
                if !matches!(low, Some(0xdc00..=0xdfff)) {
                    return true;
                }
                i += 12;
            }
            Some(0xdc00..=0xdfff) => return true,
            _ => i += 2,
        }
    }
    false
}

/// The kdf members as JSON values. A member serde_json cannot hold as a [`Value`] (a number beyond `f64`, nesting
/// deeper than its limit) is valid JSON that breaks a rule of section 6.3 whatever its name: an extra member, or a
/// known one of the wrong type or out of bounds. So it is `unsupported-keyslot`, as on the web.
fn kdf_values(members: &RawObject) -> Result<Value> {
    let mut object = Map::new();
    for (name, raw) in members {
        let value =
            serde_json::from_str(raw.get()).map_err(|_| Error::UnsupportedKeyslot("kdf member out of bounds"))?;
        object.insert(name.clone(), value);
    }
    Ok(Value::Object(object))
}

/// Step 2 for the `kdf` object: every member present, none extra, `alg` matching the kind, bounds respected.
fn parse_kdf(kind: KeyslotKind, members: &RawObject) -> Result<Kdf> {
    let value = &kdf_values(members)?;
    let error = Error::UnsupportedKeyslot("kdf members");
    let kdf = match kind {
        KeyslotKind::Passphrase => {
            let o = exact_object(value, &["alg", "v", "m", "t", "p", "salt", "secretKey"], error)?;
            if o["alg"].as_str() != Some("argon2id") {
                return Err(Error::UnsupportedKeyslot("kdf algorithm"));
            }
            if json_uint(&o["v"]) != Some(ARGON2_VERSION) {
                return Err(Error::UnsupportedKeyslot("Argon2 version"));
            }
            let params = Argon2Params {
                m: kdf_uint(o, "m", ARGON2_M_BOUNDS)?,
                t: kdf_uint(o, "t", ARGON2_T_BOUNDS)?,
                p: kdf_uint(o, "p", ARGON2_P_BOUNDS)?,
            };
            let salt = kdf_b64::<16>(o, "salt")?;
            let secret_key = o["secretKey"]
                .as_bool()
                .ok_or(Error::UnsupportedKeyslot("secretKey is not a boolean"))?;
            Kdf::Passphrase {
                params,
                salt,
                secret_key,
            }
        }
        KeyslotKind::Recovery => {
            let o = exact_object(value, &["alg"], error)?;
            if o["alg"].as_str() != Some("recovery") {
                return Err(Error::UnsupportedKeyslot("kdf algorithm"));
            }
            Kdf::Recovery
        }
        KeyslotKind::Passkey => {
            let o = exact_object(value, &["alg", "credentialId", "rpId", "prfSalt"], error)?;
            if o["alg"].as_str() != Some("prf") {
                return Err(Error::UnsupportedKeyslot("kdf algorithm"));
            }
            let credential_id = string(&o["credentialId"], Error::UnsupportedKeyslot("credentialId"))
                .and_then(|t| base64url_decode(t).map_err(|_| Error::UnsupportedKeyslot("credentialId")))?;
            let rp_id = string(&o["rpId"], Error::UnsupportedKeyslot("rpId"))?.to_owned();
            let prf_salt = kdf_b64::<32>(o, "prfSalt")?;
            Kdf::Passkey {
                credential_id,
                rp_id,
                prf_salt,
            }
        }
    };
    kdf.validate()?;
    Ok(kdf)
}

impl Keyslot {
    /// The kind of this slot.
    pub const fn kind(&self) -> KeyslotKind {
        self.kdf.kind()
    }

    /// `keys/<slot>.json`.
    pub fn name(&self) -> String {
        keyslot_name(&self.slot_id)
    }

    /// The base32 vault id, as written in the file.
    pub fn vault(&self) -> String {
        base32_encode(&self.vault_id)
    }

    /// The base32 slot id, as written in the file.
    pub fn slot(&self) -> String {
        base32_encode(&self.slot_id)
    }

    /// The bounds of spec/FORMAT.md section 6.3 (`unsupported-keyslot`). A parsed slot always passes; a slot built
    /// by hand is checked again before any costly work.
    pub fn validate(&self) -> Result<()> {
        self.kdf.validate()
    }

    /// Steps 1 to 3 of spec/FORMAT.md section 6.7, in that order: the JSON shape outside `kdf` (`corrupt`), the
    /// format, kind and kdf rules (`unsupported-keyslot`), then the single canonical form (`corrupt`). With `name`,
    /// the file must be `keys/<slot>.json`. Nothing costly runs here.
    pub fn parse(bytes: &[u8], name: Option<&str>) -> Result<Self> {
        // Step 1: the shape of everything outside kdf.
        let text = std::str::from_utf8(bytes).map_err(|_| Error::Corrupt("keyslot is not UTF-8"))?;
        if has_lone_surrogate_escape(bytes) {
            return Err(Error::Corrupt("keyslot text is not well-formed Unicode"));
        }
        let raw: RawObject = serde_json::from_str(text).map_err(|_| Error::Corrupt("keyslot is not a JSON object"))?;
        if raw.len() != MEMBERS.len() || !MEMBERS.iter().all(|n| raw.contains_key(*n)) {
            return Err(Error::Corrupt("keyslot members"));
        }
        // Outside kdf only strings and the wrap object of strings are allowed, so a value serde_json cannot hold
        // (a number beyond f64, nesting deeper than its limit) is of the wrong type there: corrupt.
        let mut outside = Map::new();
        for (name, member) in raw.iter().filter(|(name, _)| name.as_str() != "kdf") {
            let value = serde_json::from_str(member.get()).map_err(|_| Error::Corrupt("keyslot member type"))?;
            outside.insert(name.clone(), value);
        }
        let o = &outside;
        let not_string = || Error::Corrupt("keyslot member is not a string");
        let format = o["format"].as_str().ok_or_else(not_string)?;
        if o["type"].as_str().ok_or_else(not_string)? != "keyslot" {
            return Err(Error::Corrupt("not a keyslot"));
        }
        let vault_id = corrupt_b32(&o["vault"])?;
        let slot_id = corrupt_b32(&o["slot"])?;
        if name.is_some_and(|n| n != keyslot_name(&slot_id)) {
            return Err(Error::Corrupt("keyslot file name differs from its slot"));
        }
        let kind = o["kind"].as_str().ok_or_else(not_string)?;
        let kdf_members: RawObject =
            serde_json::from_str(raw["kdf"].get()).map_err(|_| Error::Corrupt("keyslot kdf is not an object"))?;
        let commit = corrupt_b64::<32>(&o["commit"])?;
        let wrap = exact_object(&o["wrap"], &["iv", "ct"], Error::Corrupt("keyslot wrap members"))?;
        let wrap_iv = corrupt_b64::<12>(&wrap["iv"])?;
        let wrap_ct = corrupt_b64::<48>(&wrap["ct"])?;
        let mk_check = corrupt_b64::<32>(&o["mkCheck"])?;

        // Step 2: what this build accepts to run.
        if format != FORMAT {
            return Err(Error::UnsupportedKeyslot("keyslot of another format"));
        }
        let kind = KeyslotKind::parse(kind).ok_or(Error::UnsupportedKeyslot("unknown keyslot kind"))?;
        let kdf = parse_kdf(kind, &kdf_members)?;

        // Step 3: a file is valid only in its single canonical form.
        let slot = Self {
            vault_id,
            slot_id,
            kdf,
            commit,
            wrap_iv,
            wrap_ct,
            mk_check,
        };
        if slot.serialize() != bytes {
            return Err(Error::Corrupt("keyslot is not in canonical form"));
        }
        Ok(slot)
    }

    /// The writer serialization in the member order of spec/FORMAT.md section 6.2, followed by one line feed.
    pub fn serialize(&self) -> Vec<u8> {
        let mut out = String::with_capacity(512);
        out.push_str("{\"format\":");
        push_json_string(&mut out, FORMAT);
        out.push_str(",\"type\":\"keyslot\",\"vault\":\"");
        out.push_str(&self.vault());
        out.push_str("\",\"slot\":\"");
        out.push_str(&self.slot());
        out.push_str("\",\"kind\":\"");
        out.push_str(self.kind().as_str());
        out.push_str("\",\"kdf\":");
        self.kdf.push_writer(&mut out);
        out.push_str(",\"commit\":\"");
        out.push_str(&base64url_encode(&self.commit));
        out.push_str("\",\"wrap\":{\"iv\":\"");
        out.push_str(&base64url_encode(&self.wrap_iv));
        out.push_str("\",\"ct\":\"");
        out.push_str(&base64url_encode(&self.wrap_ct));
        out.push_str("\"},\"mkCheck\":\"");
        out.push_str(&base64url_encode(&self.mk_check));
        out.push_str("\"}\n");
        out.into_bytes()
    }

    /// The wrap's additional data, `"aparte/1|keyslot|" || vault || "|" || slot || "|" || kind || "|" || canon(kdf)`.
    pub fn aad(&self) -> Vec<u8> {
        wrap_aad(&self.vault_id, &self.slot_id, &self.kdf)
    }
}

/// The wrap's additional data of a slot that is still being built (spec/FORMAT.md section 6.5).
pub fn wrap_aad(vault_id: &[u8; 16], slot_id: &[u8; 16], kdf: &Kdf) -> Vec<u8> {
    format!(
        "aparte/1|keyslot|{}|{}|{}|{}",
        base32_encode(vault_id),
        base32_encode(slot_id),
        kdf.kind().as_str(),
        kdf.canonical()
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn sample() -> Keyslot {
        Keyslot {
            vault_id: core::array::from_fn(|i| 0xf0 + i as u8),
            slot_id: [0x11; 16],
            kdf: Kdf::Passphrase {
                params: Argon2Params { m: 19456, t: 2, p: 1 },
                salt: [0x22; 16],
                secret_key: true,
            },
            commit: [1; 32],
            wrap_iv: [0x33; 12],
            wrap_ct: [2; 48],
            mk_check: [3; 32],
        }
    }

    fn passkey() -> Keyslot {
        Keyslot {
            kdf: Kdf::Passkey {
                credential_id: (1..=32).collect(),
                rp_id: "aparte.example".into(),
                prf_salt: [0xbb; 32],
            },
            ..sample()
        }
    }

    fn text(slot: &Keyslot) -> String {
        String::from_utf8(slot.serialize()).unwrap()
    }

    /// The sample's JSON with one change, serialized compactly; serde_json sorts the members, so the result is
    /// never canonical, and only checks that come before step 3 can name the error.
    fn mutated(slot: &Keyslot, change: impl FnOnce(&mut Map<String, Value>)) -> Vec<u8> {
        let mut value: Value = serde_json::from_str(&text(slot)).unwrap();
        change(value.as_object_mut().unwrap());
        format!("{value}\n").into_bytes()
    }

    fn code(result: Result<Keyslot>) -> &'static str {
        result.unwrap_err().code().as_str()
    }

    #[test]
    fn constants() {
        assert_eq!(DEFAULT_ARGON2, Argon2Params { m: 65536, t: 3, p: 1 });
        assert!(DEFAULT_ARGON2.in_bounds());
        assert_eq!(
            (ARGON2_M_BOUNDS, ARGON2_T_BOUNDS, ARGON2_P_BOUNDS),
            ((19456, 262_144), (2, 10), (1, 4))
        );
    }

    #[test]
    fn writer_order_and_the_spec_aad() {
        let slot = sample();
        assert_eq!(
            text(&slot),
            "{\"format\":\"aparte/1\",\"type\":\"keyslot\",\"vault\":\"6dy7f47u6x3pp6hz7l57z7p674\",\
             \"slot\":\"ceirceirceirceirceirceirce\",\"kind\":\"passphrase\",\"kdf\":{\"alg\":\"argon2id\",\"v\":19,\
             \"m\":19456,\"t\":2,\"p\":1,\"salt\":\"IiIiIiIiIiIiIiIiIiIiIg\",\"secretKey\":true},\
             \"commit\":\"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\",\"wrap\":{\"iv\":\"MzMzMzMzMzMzMzMz\",\
             \"ct\":\"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC\"},\
             \"mkCheck\":\"AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM\"}\n"
        );
        // spec/FORMAT.md section 15.2.
        assert_eq!(
            String::from_utf8(slot.aad()).unwrap(),
            "aparte/1|keyslot|6dy7f47u6x3pp6hz7l57z7p674|ceirceirceirceirceirceirce|passphrase|\
             {\"alg\":\"argon2id\",\"m\":19456,\"p\":1,\"salt\":\"IiIiIiIiIiIiIiIiIiIiIg\",\"secretKey\":true,\
             \"t\":2,\"v\":19}"
        );
        assert_eq!(slot.name(), "keys/ceirceirceirceirceirceirce.json");
        let recovery = Keyslot {
            kdf: Kdf::Recovery,
            ..sample()
        };
        assert!(
            String::from_utf8(recovery.aad())
                .unwrap()
                .ends_with("|recovery|{\"alg\":\"recovery\"}")
        );
        assert!(
            String::from_utf8(passkey().aad())
                .unwrap()
                .ends_with("|passkey|{\"alg\":\"prf\",\"credentialId\":\"AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA\",\"prfSalt\":\"u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7s\",\"rpId\":\"aparte.example\"}")
        );
    }

    #[test]
    fn every_kind_round_trips() {
        for slot in [
            sample(),
            Keyslot {
                kdf: Kdf::Recovery,
                ..sample()
            },
            passkey(),
        ] {
            let bytes = slot.serialize();
            assert_eq!(Keyslot::parse(&bytes, Some(&slot.name())).unwrap(), slot);
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["kind"], slot.kind().as_str());
        }
    }

    #[test]
    fn step_1_shape_is_corrupt() {
        let slot = sample();
        let canonical = slot.serialize();
        let cases: Vec<Vec<u8>> = vec![
            vec![0xff, 0xfe, 0x7b],
            b"not json\n".to_vec(),
            b"[]\n".to_vec(),
            mutated(&slot, |o| {
                o.insert("label".into(), json!("phone"));
            }),
            mutated(&slot, |o| {
                o.remove("mkCheck");
            }),
            mutated(&slot, |o| {
                o.insert("type".into(), json!("key"));
            }),
            mutated(&slot, |o| {
                o.insert("format".into(), json!(1));
            }),
            mutated(&slot, |o| {
                o.insert("kind".into(), json!(null));
            }),
            mutated(&slot, |o| {
                o.insert("kdf".into(), json!("argon2id"));
            }),
            mutated(&slot, |o| {
                o.insert("commit".into(), json!("not+base64url"));
            }),
            mutated(&slot, |o| {
                o.insert("commit".into(), json!(base64url_encode(&[0; 31])));
            }),
            mutated(&slot, |o| {
                o.insert("wrap".into(), json!({"iv": "MzMzMzMzMzMzMzMz", "ct": "AAAA"}));
            }),
            mutated(&slot, |o| {
                o.insert("wrap".into(), json!({"iv": "MzMzMzMzMzMzMzMz"}));
            }),
            mutated(&slot, |o| {
                o.insert("slot".into(), json!("ceirceirceirceirceirceircf"));
            }),
            mutated(&slot, |o| {
                o.insert("vault".into(), json!("6DY7F47U6X3PP6HZ7L57Z7P674"));
            }),
            serde_json::to_vec_pretty(&serde_json::from_slice::<Value>(&canonical).unwrap()).unwrap(),
            canonical[..canonical.len() - 1].to_vec(),
            [&canonical[..], b"\n"].concat(),
            [b" ", &canonical[..]].concat(),
        ];
        for bytes in cases {
            assert_eq!(
                code(Keyslot::parse(&bytes, None)),
                "corrupt",
                "{}",
                String::from_utf8_lossy(&bytes)
            );
        }
        // Members reordered: valid JSON, valid values, but not the canonical bytes.
        let reordered = text(&slot).replacen(
            "{\"format\":\"aparte/1\",\"type\":\"keyslot\",",
            "{\"type\":\"keyslot\",\"format\":\"aparte/1\",",
            1,
        );
        assert_eq!(code(Keyslot::parse(reordered.as_bytes(), None)), "corrupt");
        assert_eq!(
            code(Keyslot::parse(
                &canonical,
                Some(&format!("keys/{}.json", "a".repeat(26)))
            )),
            "corrupt"
        );
        assert_eq!(code(Keyslot::parse(&canonical, Some("keys/x.json"))), "corrupt");
    }

    #[test]
    fn step_2_rules_are_unsupported_even_when_the_rest_is_not_canonical() {
        let slot = sample();
        let kdf = |change: fn(&mut Map<String, Value>)| mutated(&slot, |o| change(o["kdf"].as_object_mut().unwrap()));
        let cases: Vec<Vec<u8>> = vec![
            mutated(&slot, |o| {
                o.insert("format".into(), json!("aparte/2"));
            }),
            mutated(&slot, |o| {
                o.insert("kind".into(), json!("password"));
            }),
            mutated(&slot, |o| {
                o.insert("kind".into(), json!("recovery"));
            }),
            kdf(|k| {
                k.insert("m".into(), json!(19455));
            }),
            kdf(|k| {
                k.insert("m".into(), json!(262_145));
            }),
            kdf(|k| {
                k.insert("m".into(), json!(4_294_967_296_u64));
            }),
            kdf(|k| {
                k.insert("m".into(), json!(65536.5));
            }),
            kdf(|k| {
                k.insert("m".into(), json!("65536"));
            }),
            kdf(|k| {
                k.insert("t".into(), json!(1));
            }),
            kdf(|k| {
                k.insert("t".into(), json!(11));
            }),
            kdf(|k| {
                k.insert("p".into(), json!(0));
            }),
            kdf(|k| {
                k.insert("p".into(), json!(5));
            }),
            kdf(|k| {
                k.insert("p".into(), json!(-1));
            }),
            kdf(|k| {
                k.insert("v".into(), json!(16));
            }),
            kdf(|k| {
                k.insert("alg".into(), json!("argon2i"));
            }),
            kdf(|k| {
                k.insert("salt".into(), json!("IiIiIiIiIiIiIiIiIiIi"));
            }),
            kdf(|k| {
                k.insert("salt".into(), json!("IiIiIiIiIiIiIiIiIiIiIiI"));
            }),
            kdf(|k| {
                k.insert("secretKey".into(), json!("true"));
            }),
            kdf(|k| {
                k.insert("lanes".into(), json!(1));
            }),
            kdf(|k| {
                k.remove("t");
            }),
        ];
        for bytes in cases {
            assert_eq!(
                code(Keyslot::parse(&bytes, None)),
                "unsupported-keyslot",
                "{}",
                String::from_utf8_lossy(&bytes)
            );
        }
        let pk = passkey();
        let passkey_kdf =
            |change: fn(&mut Map<String, Value>)| mutated(&pk, |o| change(o["kdf"].as_object_mut().unwrap()));
        for bytes in [
            passkey_kdf(|k| {
                k.insert("rpId".into(), json!("Aparte.Example"));
            }),
            passkey_kdf(|k| {
                k.insert("rpId".into(), json!(""));
            }),
            passkey_kdf(|k| {
                k.insert("credentialId".into(), json!(""));
            }),
            passkey_kdf(|k| {
                k.insert("prfSalt".into(), json!("AAAA"));
            }),
            passkey_kdf(|k| {
                k.insert("alg".into(), json!("argon2id"));
            }),
        ] {
            assert_eq!(code(Keyslot::parse(&bytes, None)), "unsupported-keyslot");
        }
    }

    #[test]
    fn an_integral_float_is_an_integer_but_not_canonical() {
        let bytes = text(&sample()).replace("\"m\":19456", "\"m\":19456.0");
        assert_eq!(code(Keyslot::parse(bytes.as_bytes(), None)), "corrupt");
        let bytes = text(&sample()).replace("\"m\":19456", "\"m\":1.9456e4");
        assert_eq!(code(Keyslot::parse(bytes.as_bytes(), None)), "corrupt");
    }

    #[test]
    fn validate_catches_hand_built_slots() {
        let mut slot = sample();
        slot.kdf = Kdf::Passphrase {
            params: Argon2Params { m: 1 << 30, t: 2, p: 1 },
            salt: [0; 16],
            secret_key: false,
        };
        assert_eq!(slot.validate().unwrap_err().code().as_str(), "unsupported-keyslot");
        slot.kdf = Kdf::Passkey {
            credential_id: vec![0; 15],
            rp_id: "a".into(),
            prf_salt: [0; 32],
        };
        assert!(slot.validate().is_err());
        slot.kdf = Kdf::Passkey {
            credential_id: vec![0; 1024],
            rp_id: "a".into(),
            prf_salt: [0; 32],
        };
        assert!(slot.validate().is_err());
        slot.kdf = Kdf::Passkey {
            credential_id: vec![0; 16],
            rp_id: "a".repeat(254),
            prf_salt: [0; 32],
        };
        assert!(slot.validate().is_err());
        slot.kdf = Kdf::Passkey {
            credential_id: vec![0; 1023],
            rp_id: "a".repeat(253),
            prf_salt: [0; 32],
        };
        assert!(slot.validate().is_ok());
    }

    proptest! {
        #[test]
        fn any_valid_slot_round_trips(
            vault_id in any::<[u8; 16]>(),
            slot_id in any::<[u8; 16]>(),
            m in 19456u32..=262_144,
            t in 2u32..=10,
            p in 1u32..=4,
            salt in any::<[u8; 16]>(),
            secret_key in any::<bool>(),
            commit in any::<[u8; 32]>(),
            wrap_iv in any::<[u8; 12]>(),
            ct in proptest::collection::vec(any::<u8>(), 48),
        ) {
            let slot = Keyslot {
                vault_id,
                slot_id,
                kdf: Kdf::Passphrase { params: Argon2Params { m, t, p }, salt, secret_key },
                commit,
                wrap_iv,
                wrap_ct: ct.try_into().unwrap(),
                mk_check: commit,
            };
            prop_assert_eq!(Keyslot::parse(&slot.serialize(), Some(&slot.name())).unwrap(), slot);
        }

        #[test]
        fn any_single_byte_change_is_rejected_or_changes_the_slot(index in 0usize..400, byte in any::<u8>()) {
            let slot = sample();
            let mut bytes = slot.serialize();
            let index = index % bytes.len();
            if bytes[index] != byte {
                bytes[index] = byte;
                if let Ok(parsed) = Keyslot::parse(&bytes, None) {
                    prop_assert_ne!(parsed, slot);
                }
            }
        }
    }
}
