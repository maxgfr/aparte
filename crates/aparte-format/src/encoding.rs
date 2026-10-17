//! Encodings of spec/FORMAT.md section 3: strict base32 and base64url, lowercase hex, the JSON string escaping of the
//! writer serialization, and RFC 8785 canonical JSON for the subset `aparte/1` uses.
//!
//! Every decoder is strict so that each byte string has exactly one text form: two implementations can then compare
//! encoded values as strings and a reader can reject anything a writer would not produce.

use std::cmp::Ordering;

use serde_json::Value;

use crate::error::{Error, Result};

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX: &[u8; 16] = b"0123456789abcdef";

/// The largest integer `canonical_json` writes, `2^53 - 1`, the last one JavaScript represents exactly.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn base32_value(c: u8) -> Option<u8> {
    match c {
        b'a'..=b'z' => Some(c - b'a'),
        b'2'..=b'7' => Some(c - b'2' + 26),
        _ => None,
    }
}

fn base64url_value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

/// Encodes `bits` bits per character, most significant first; the last character carries the remaining bits in
/// its high positions and zeros below.
fn encode_bits(bytes: &[u8], bits: u32, alphabet: &[u8]) -> String {
    let mask = (1u32 << bits) - 1;
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(bits as usize));
    let mut buffer: u32 = 0;
    let mut held: u32 = 0;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        held += 8;
        while held >= bits {
            held -= bits;
            out.push(char::from(alphabet[((buffer >> held) & mask) as usize]));
        }
        buffer &= (1 << held) - 1;
    }
    if held > 0 {
        out.push(char::from(alphabet[((buffer << (bits - held)) & mask) as usize]));
    }
    out
}

/// Decodes `bits` bits per character; rejects a character outside the alphabet and non-zero unused low bits.
/// The caller has already rejected the impossible lengths.
fn decode_bits(text: &str, bits: u32, value: fn(u8) -> Option<u8>) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * bits as usize / 8);
    let mut buffer: u32 = 0;
    let mut held: u32 = 0;
    for &c in text.as_bytes() {
        buffer = (buffer << bits) | u32::from(value(c)?);
        held += bits;
        if held >= 8 {
            held -= 8;
            out.push(((buffer >> held) & 0xff) as u8);
            buffer &= (1 << held) - 1;
        }
    }
    // The bits left over do not make a byte: they must be zero, so that each byte string has a single encoding.
    (buffer == 0).then_some(out)
}

/// Lowercase RFC 4648 base32 without padding (spec/FORMAT.md section 3.1).
pub fn base32_encode(bytes: &[u8]) -> String {
    encode_bits(bytes, 5, BASE32)
}

/// Strict base32 decode: lowercase alphabet only, no padding, a length whose remainder modulo 8 is not 1, 3 or 6,
/// and zero trailing bits; `invalid-input` otherwise.
pub fn base32_decode(text: &str) -> Result<Vec<u8>> {
    if matches!(text.len() % 8, 1 | 3 | 6) {
        return Err(Error::InvalidInput("base32 length"));
    }
    decode_bits(text, 5, base32_value).ok_or(Error::InvalidInput("base32 text"))
}

/// Strict base32 decode to exactly `N` bytes.
pub fn base32_decode_array<const N: usize>(text: &str) -> Result<[u8; N]> {
    base32_decode(text)?
        .try_into()
        .map_err(|_| Error::InvalidInput("base32 length"))
}

/// Whether every character of `text` is in the lowercase base32 alphabet (no strictness on the trailing bits:
/// truncated tags of spec/FORMAT.md section 3.1 end anywhere).
pub fn is_base32_chars(text: &str) -> bool {
    text.bytes().all(|c| base32_value(c).is_some())
}

/// RFC 4648 base64url without padding (spec/FORMAT.md section 3.2).
pub fn base64url_encode(bytes: &[u8]) -> String {
    encode_bits(bytes, 6, BASE64URL)
}

/// Strict base64url decode: url alphabet only, no padding, a length whose remainder modulo 4 is not 1, and zero
/// trailing bits; `invalid-input` otherwise.
pub fn base64url_decode(text: &str) -> Result<Vec<u8>> {
    if text.len() % 4 == 1 {
        return Err(Error::InvalidInput("base64url length"));
    }
    decode_bits(text, 6, base64url_value).ok_or(Error::InvalidInput("base64url text"))
}

/// Strict base64url decode to exactly `N` bytes.
pub fn base64url_decode_array<const N: usize>(text: &str) -> Result<[u8; N]> {
    base64url_decode(text)?
        .try_into()
        .map_err(|_| Error::InvalidInput("base64url length"))
}

/// Lowercase hex.
pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

/// Strict lowercase hex of even length; `invalid-input` otherwise.
pub fn from_hex(text: &str) -> Result<Vec<u8>> {
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let bytes = text.as_bytes();
    let (pairs, rest) = bytes.as_chunks::<2>();
    if !rest.is_empty() {
        return Err(Error::InvalidInput("hex length"));
    }
    pairs
        .iter()
        .map(|&[high, low]| Some((digit(high)? << 4) | digit(low)?))
        .collect::<Option<Vec<u8>>>()
        .ok_or(Error::InvalidInput("hex digit"))
}

/// Strict UTF-8 decode; `invalid-input` on invalid UTF-8 instead of a replacement character.
pub fn from_utf8(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes).map_err(|_| Error::InvalidInput("invalid UTF-8"))
}

/// `u32be(n)`; `invalid-input` when `n` does not fit in 32 bits.
pub fn u32be(n: usize) -> Result<[u8; 4]> {
    u32::try_from(n)
        .map(u32::to_be_bytes)
        .map_err(|_| Error::InvalidInput("length above 2^32"))
}

/// Appends `text` as a JSON string, escaped exactly as `JSON.stringify` escapes it: `"` and `\` with a backslash,
/// the five short control escapes, every other code point below U+0020 as `\u00xx` in lowercase, everything else
/// as it is. A Rust string is always well-formed, so the lone-surrogate escapes of `JSON.stringify` never arise.
pub fn push_json_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                let code = u32::from(c) as u8;
                out.push_str("\\u00");
                out.push(char::from(HEX[usize::from(code >> 4)]));
                out.push(char::from(HEX[usize::from(code & 0x0f)]));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The JSON string form of `text` (see [`push_json_string`]).
pub fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    push_json_string(&mut out, text);
    out
}

/// An integer of a parsed JSON value, as spec/FORMAT.md section 6.3 defines one: a number with no fractional part,
/// in `[0, 2^53)`. A float with an integral value counts, as it does for `Number.isInteger` in JavaScript.
pub fn json_uint(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return (n <= MAX_SAFE_INTEGER).then_some(n);
    }
    let f = value.as_f64()?;
    // The range test comes first, so the conversion below is exact.
    if f.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER as f64).contains(&f) {
        Some(f as u64)
    } else {
        None
    }
}

fn compare_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn push_canonical(out: &mut String, value: &Value) -> Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(_) => {
            let n = json_number(value).ok_or(Error::InvalidInput("canonical JSON takes safe integers only"))?;
            out.push_str(&n.to_string());
        }
        Value::String(s) => push_json_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_canonical(out, item)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut members: Vec<(&String, &Value)> = map.iter().collect();
            members.sort_by(|a, b| compare_utf16(a.0, b.0));
            out.push('{');
            for (i, (key, item)) in members.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_json_string(out, key);
                out.push(':');
                push_canonical(out, item)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// A safe integer of either sign, for canonical JSON.
fn json_number(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return (n.unsigned_abs() <= MAX_SAFE_INTEGER).then_some(n);
    }
    if let Some(n) = value.as_u64() {
        return (n <= MAX_SAFE_INTEGER).then_some(n as i64);
    }
    let f = value.as_f64()?;
    let limit = MAX_SAFE_INTEGER as f64;
    (f.fract() == 0.0 && (-limit..=limit).contains(&f)).then_some(f as i64)
}

/// RFC 8785 canonical JSON (spec/FORMAT.md section 3.3) of strings, booleans, null, arrays, objects and safe
/// integers: members sorted by UTF-16 code units, no whitespace, strings escaped as `JSON.stringify` escapes them,
/// integers in plain decimal. Any other number is `invalid-input`.
pub fn canonical_json(value: &Value) -> Result<String> {
    let mut out = String::new();
    push_canonical(&mut out, value)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use serde_json::json;

    use super::*;

    const INPUTS: &str = include_str!("../../../spec/vectors/inputs.json");

    fn inputs() -> Value {
        serde_json::from_str(INPUTS).unwrap()
    }

    fn strings(value: &Value) -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn base32_rfc4648_vectors() {
        let cases = [
            ("", ""),
            ("f", "my"),
            ("fo", "mzxq"),
            ("foo", "mzxw6"),
            ("foob", "mzxw6yq"),
            ("fooba", "mzxw6ytb"),
            ("foobar", "mzxw6ytboi"),
        ];
        for (plain, encoded) in cases {
            assert_eq!(base32_encode(plain.as_bytes()), encoded);
            assert_eq!(base32_decode(encoded).unwrap(), plain.as_bytes());
        }
    }

    #[test]
    fn base32_ids() {
        assert_eq!(base32_encode(&[0; 16]), "a".repeat(26));
        assert_eq!(base32_encode(&[0; 32]).len(), 52);
        assert_eq!(base32_encode(&[0x11; 16]), "ceirceirceirceirceirceirce");
        let vault: Vec<u8> = (0xf0..=0xff).collect();
        assert_eq!(base32_encode(&vault), "6dy7f47u6x3pp6hz7l57z7p674");
    }

    #[test]
    fn base32_vector_inputs() {
        let inputs = inputs();
        for hex in strings(&inputs["text"]["base32"]) {
            let bytes = from_hex(&hex).unwrap();
            assert_eq!(base32_decode(&base32_encode(&bytes)).unwrap(), bytes);
        }
        for text in strings(&inputs["text"]["base32Invalid"]) {
            assert_eq!(
                base32_decode(&text).unwrap_err().code().as_str(),
                "invalid-input",
                "{text:?}"
            );
        }
    }

    #[test]
    fn base32_rejects_every_non_canonical_last_character() {
        for (value, c) in BASE32.iter().enumerate() {
            let text = format!("a{}", char::from(*c));
            if value % 4 == 0 {
                assert_eq!(base32_decode(&text).unwrap().len(), 1);
            } else {
                assert_eq!(base32_decode(&text).unwrap_err().code().as_str(), "invalid-input");
            }
        }
    }

    #[test]
    fn base64url_rfc4648_vectors() {
        let cases = [
            ("", ""),
            ("f", "Zg"),
            ("fo", "Zm8"),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg"),
            ("fooba", "Zm9vYmE"),
            ("foobar", "Zm9vYmFy"),
        ];
        for (plain, encoded) in cases {
            assert_eq!(base64url_encode(plain.as_bytes()), encoded);
            assert_eq!(base64url_decode(encoded).unwrap(), plain.as_bytes());
        }
        assert_eq!(base64url_encode(&[0xfb, 0xff]), "-_8");
        assert_eq!(base64url_encode(&[0xfb, 0xff, 0xbf]), "-_-_");
        assert_eq!(base64url_encode(&[0x22; 16]), "IiIiIiIiIiIiIiIiIiIiIg");
    }

    #[test]
    fn base64url_vector_inputs() {
        let inputs = inputs();
        for hex in strings(&inputs["text"]["base64url"]) {
            let bytes = from_hex(&hex).unwrap();
            assert_eq!(base64url_decode(&base64url_encode(&bytes)).unwrap(), bytes);
        }
        for text in strings(&inputs["text"]["base64urlInvalid"]) {
            assert_eq!(
                base64url_decode(&text).unwrap_err().code().as_str(),
                "invalid-input",
                "{text:?}"
            );
        }
    }

    #[test]
    fn fixed_length_decoders() {
        assert_eq!(
            base32_decode_array::<16>("ceirceirceirceirceirceirce").unwrap(),
            [0x11; 16]
        );
        assert!(base32_decode_array::<16>("ceirceirceirceirceirceir").is_err());
        assert_eq!(
            base64url_decode_array::<16>("IiIiIiIiIiIiIiIiIiIiIg").unwrap(),
            [0x22; 16]
        );
        assert!(base64url_decode_array::<16>("IiIiIiIiIiIiIiIiIiIi").is_err());
    }

    #[test]
    fn hex_round_trip_and_strictness() {
        assert_eq!(to_hex(&[0, 0xab, 0xff]), "00abff");
        assert_eq!(from_hex("00abff").unwrap(), [0, 0xab, 0xff]);
        for bad in ["0", "abc", "zz", "0g", "AB", " 00"] {
            assert!(from_hex(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn utf8_and_u32be() {
        assert_eq!(from_utf8("Aparté".as_bytes()).unwrap(), "Aparté");
        assert!(from_utf8(&[0xc3]).is_err());
        assert!(from_utf8(&[0xff, 0xfe]).is_err());
        assert_eq!(u32be(0x3e).unwrap(), [0, 0, 0, 0x3e]);
        assert_eq!(u32be(0xffff_fffe).unwrap(), [0xff, 0xff, 0xff, 0xfe]);
        assert!(u32be(1 << 32).is_err());
    }

    #[test]
    fn json_strings_escape_like_json_stringify() {
        assert_eq!(json_string("é\"\\\n"), "\"é\\\"\\\\\\n\"");
        assert_eq!(
            json_string("\u{0}\u{1f}\u{7f}\u{2028}"),
            "\"\\u0000\\u001f\u{7f}\u{2028}\""
        );
        assert_eq!(json_string("\u{8}\u{c}\r\t"), "\"\\b\\f\\r\\t\"");
        for text in ["", "plain", "\u{1}\u{1e}", "😀 emoji", "a\"b"] {
            assert_eq!(json_string(text), serde_json::to_string(text).unwrap());
        }
    }

    #[test]
    fn json_uint_is_a_safe_non_negative_integer() {
        assert_eq!(json_uint(&json!(19456)), Some(19456));
        assert_eq!(json_uint(&json!(65536.0)), Some(65536));
        assert_eq!(json_uint(&json!(4_294_967_296_u64)), Some(4_294_967_296));
        assert_eq!(json_uint(&json!(65536.5)), None);
        assert_eq!(json_uint(&json!(-1)), None);
        assert_eq!(json_uint(&json!("65536")), None);
        assert_eq!(json_uint(&json!(1_u64 << 53)), None);
        assert_eq!(json_uint(&json!(1e300)), None);
    }

    #[test]
    fn canonical_json_rfc8785_subset() {
        let kdf = json!({"v": 19, "alg": "argon2id", "m": 19456, "t": 2, "p": 1, "salt": "IiIiIiIiIiIiIiIiIiIiIg", "secretKey": true});
        assert_eq!(
            canonical_json(&kdf).unwrap(),
            r#"{"alg":"argon2id","m":19456,"p":1,"salt":"IiIiIiIiIiIiIiIiIiIiIg","secretKey":true,"t":2,"v":19}"#
        );
        let nested = json!({"b": [3, {"y": null, "x": false}], "a": "é\"\\\n"});
        assert_eq!(
            canonical_json(&nested).unwrap(),
            "{\"a\":\"é\\\"\\\\\\n\",\"b\":[3,{\"x\":false,\"y\":null}]}"
        );
        assert_eq!(
            canonical_json(&json!({"alg": "recovery"})).unwrap(),
            r#"{"alg":"recovery"}"#
        );
        assert_eq!(
            canonical_json(&json!({"b": 1, "B": 2, "a": 3, "_": 4})).unwrap(),
            r#"{"B":2,"_":4,"a":3,"b":1}"#
        );
        assert_eq!(canonical_json(&json!(-5)).unwrap(), "-5");
        assert!(canonical_json(&json!(1.5)).is_err());
    }

    #[test]
    fn canonical_json_sorts_by_utf16_code_units_not_bytes() {
        // U+FF61 is above U+10000's surrogates in UTF-8 byte order, below them in UTF-16: RFC 8785 uses UTF-16.
        let value = json!({"\u{ff61}": 1, "\u{10000}": 2});
        assert_eq!(canonical_json(&value).unwrap(), "{\"\u{10000}\":2,\"\u{ff61}\":1}");
    }

    proptest! {
        #[test]
        fn base32_round_trips_any_bytes(bytes in proptest::collection::vec(any::<u8>(), 0..80)) {
            let text = base32_encode(&bytes);
            prop_assert!(text.bytes().all(|c| BASE32.contains(&c)));
            prop_assert_eq!(text.len(), (bytes.len() * 8).div_ceil(5));
            prop_assert_eq!(base32_decode(&text).unwrap(), bytes);
        }

        #[test]
        fn base32_id_last_character_has_zero_low_bits(id in any::<[u8; 16]>()) {
            let text = base32_encode(&id);
            prop_assert!("aeimquy4".contains(&text[25..]));
        }

        #[test]
        fn base64url_round_trips_any_bytes(bytes in proptest::collection::vec(any::<u8>(), 0..80)) {
            let text = base64url_encode(&bytes);
            prop_assert!(text.bytes().all(|c| BASE64URL.contains(&c)));
            prop_assert_eq!(base64url_decode(&text).unwrap(), bytes);
        }

        #[test]
        fn decoders_accept_only_their_own_encodings(text in "[a-z2-7A-Z0-9_=+/ -]{0,24}") {
            if let Ok(bytes) = base32_decode(&text) {
                prop_assert_eq!(base32_encode(&bytes), text.clone());
            }
            if let Ok(bytes) = base64url_decode(&text) {
                prop_assert_eq!(base64url_encode(&bytes), text);
            }
        }

        #[test]
        fn hex_round_trips(bytes in proptest::collection::vec(any::<u8>(), 0..64)) {
            prop_assert_eq!(from_hex(&to_hex(&bytes)).unwrap(), bytes);
        }

        #[test]
        fn json_string_matches_serde_json(text in any::<String>()) {
            prop_assert_eq!(json_string(&text), serde_json::to_string(&text).unwrap());
        }
    }
}
