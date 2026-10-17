//! The user-facing text of the Secret Key (spec/FORMAT.md section 6.8) and of the recovery key (section 6.9):
//! shown in uppercase, parsed case-insensitively, spaces and hyphens ignored.

use aparte_format::encoding::{base32_decode, base32_encode};
use zeroize::Zeroizing;

use crate::primitives::sha256;
use crate::rng::{Rng, draw};
use crate::{Error, Result};

/// `C = SHA-256("aparte/1/secret-key|" || SK)[0..3]`.
fn checksum(secret_key: &[u8; 16]) -> [u8; 3] {
    let digest = sha256(&[&b"aparte/1/secret-key|"[..], secret_key].concat());
    [digest[0], digest[1], digest[2]]
}

/// Removes spaces and hyphens and lowercases, the way both parsers start; `None` when what is left holds anything
/// but ASCII letters and digits. The check comes before any case mapping, so no Unicode lowercasing (U+212A KELVIN
/// SIGN to `k`) can turn another character into a letter of the alphabet, as in secretKey.ts and recovery.ts.
fn compact(text: &str) -> Option<Zeroizing<String>> {
    let kept = Zeroizing::new(text.chars().filter(|&c| c != ' ' && c != '-').collect::<String>());
    if !kept.bytes().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(Zeroizing::new(kept.to_ascii_lowercase()))
}

/// A fresh 16-byte Secret Key.
pub fn generate_secret_key(rng: &mut dyn Rng) -> Result<Zeroizing<[u8; 16]>> {
    draw::<16>(rng).map(Zeroizing::new)
}

/// The Emergency Kit text `A1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`: the first 30 base32 characters of
/// `SK || C`, which carry the 128 bits of the key and 22 checksum bits.
pub fn format_secret_key(secret_key: &[u8; 16]) -> String {
    let mut bytes = Zeroizing::new([0u8; 19]);
    bytes[..16].copy_from_slice(secret_key);
    bytes[16..].copy_from_slice(&checksum(secret_key));
    let s = Zeroizing::new(base32_encode(bytes.as_ref()).to_uppercase());
    let groups: Vec<&str> = (0..6).map(|i| &s[i * 5..i * 5 + 5]).collect();
    format!("A1-{}", groups.join("-"))
}

/// Parses Secret Key text: `A1` and exactly 30 base32 characters once spaces and hyphens are removed, any case,
/// with a matching 22-bit checksum; `invalid-input` otherwise. A typo is caught with probability `1 - 2^-22`.
pub fn parse_secret_key(text: &str) -> Result<Zeroizing<[u8; 16]>> {
    let invalid = Error::InvalidInput("not a Secret Key");
    let compact = compact(text).ok_or_else(|| invalid.clone())?;
    let body = compact.strip_prefix("a1").ok_or_else(|| invalid.clone())?;
    if body.len() != 30 {
        return Err(invalid);
    }
    // 30 characters are 150 bits; two zero characters make 32 characters, 20 bytes, with nothing left over.
    let decoded = Zeroizing::new(base32_decode(&format!("{body}aa")).map_err(|_| invalid.clone())?);
    let mut key = Zeroizing::new([0u8; 16]);
    key.copy_from_slice(&decoded[..16]);
    let expected = checksum(&key);
    // The 22 checksum bits are the first 2 bytes of C and the top 6 bits of its third byte.
    if decoded[16..18] != expected[..2] || (decoded[18] ^ expected[2]) & 0xfc != 0 {
        return Err(invalid);
    }
    Ok(key)
}

/// A fresh 32-byte recovery key.
pub fn generate_recovery_key(rng: &mut dyn Rng) -> Result<Zeroizing<[u8; 32]>> {
    draw::<32>(rng).map(Zeroizing::new)
}

/// The 52 characters of `uppercase(b32(R))` in 13 groups of 4.
pub fn format_recovery_key(recovery_key: &[u8; 32]) -> String {
    let s = Zeroizing::new(base32_encode(recovery_key).to_uppercase());
    let groups: Vec<&str> = (0..13).map(|i| &s[i * 4..i * 4 + 4]).collect();
    groups.join("-")
}

/// Parses recovery key text: spaces and hyphens removed, any case, a strict base32 decode to exactly 32 bytes;
/// `invalid-input` otherwise. There is no checksum: a typo surfaces as `wrong-secret` when the slot is opened.
pub fn parse_recovery_key(text: &str) -> Result<Zeroizing<[u8; 32]>> {
    let invalid = Error::InvalidInput("not a recovery key");
    let decoded =
        Zeroizing::new(base32_decode(&compact(text).ok_or_else(|| invalid.clone())?).map_err(|_| invalid.clone())?);
    let mut key = Zeroizing::new([0u8; 32]);
    if decoded.len() != 32 {
        return Err(invalid);
    }
    key.copy_from_slice(&decoded);
    Ok(key)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::rng::QueueRng;

    const SK: [u8; 16] = [
        0x0f, 0x1e, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0x87, 0x96, 0xa5, 0xb4, 0xc3, 0xd2, 0xe1, 0xf0,
    ];
    const ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    fn is_shape(text: &str, first: usize, group: usize, groups: usize) -> bool {
        let parts: Vec<&str> = text.split('-').collect();
        parts.len() == groups + usize::from(first > 0)
            && parts
                .iter()
                .skip(usize::from(first > 0))
                .all(|p| p.len() == group && p.chars().all(|c| ALPHABET.contains(c)))
    }

    #[test]
    fn secret_key_text_follows_the_definition() {
        let text = format_secret_key(&SK);
        assert!(text.starts_with("A1-"));
        assert!(is_shape(&text, 2, 5, 6), "{text}");
        let c = checksum(&SK);
        let expected = base32_encode(&[&SK[..], &c].concat())[..30].to_uppercase();
        assert_eq!(text.replace('-', "")[2..], expected);
    }

    #[test]
    fn secret_key_parsing_ignores_case_spaces_and_hyphens() {
        let text = format_secret_key(&SK);
        assert_eq!(*parse_secret_key(&text).unwrap(), SK);
        assert_eq!(*parse_secret_key(&text.to_lowercase()).unwrap(), SK);
        assert_eq!(*parse_secret_key(&text.replace('-', "")).unwrap(), SK);
        assert_eq!(*parse_secret_key(&format!(" {} ", text.replace('-', " "))).unwrap(), SK);
    }

    #[test]
    fn secret_key_detects_any_single_mistyped_character() {
        let text = format_secret_key(&SK);
        for (i, c) in text.char_indices().skip(3) {
            if c == '-' {
                continue;
            }
            let next = ALPHABET.chars().nth((ALPHABET.find(c).unwrap() + 1) % 32).unwrap();
            let typo = format!("{}{next}{}", &text[..i], &text[i + 1..]);
            assert!(parse_secret_key(&typo).is_err(), "{typo}");
        }
    }

    #[test]
    fn secret_key_rejects_malformed_text() {
        for bad in [
            "",
            "A1",
            "A2-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA",
            "B1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA",
            "A1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAA",
            "A1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAAA",
            "A1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAA0",
            "A1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAA8",
            "A1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAA!",
            "A1_AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA",
        ] {
            assert_eq!(
                parse_secret_key(bad).unwrap_err().code().as_str(),
                "invalid-input",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn recovery_key_text() {
        let key: [u8; 32] = core::array::from_fn(|i| 0x7f - i as u8);
        let text = format_recovery_key(&key);
        assert!(is_shape(&text, 0, 4, 13), "{text}");
        assert_eq!(text.replace('-', "").to_lowercase(), base32_encode(&key));
        assert_eq!(*parse_recovery_key(&text).unwrap(), key);
        assert_eq!(*parse_recovery_key(&text.to_lowercase()).unwrap(), key);
        assert_eq!(*parse_recovery_key(&text.replace('-', " ")).unwrap(), key);
        let flat = text.replace('-', "");
        for bad in [
            flat[..51].to_owned(),
            format!("{flat}A"),
            format!("{}1", &flat[..51]),
            // The 52nd character carries 1 data bit and 4 bits that must be zero: B (value 1) is never valid there.
            format!("{}B", &flat[..51]),
            String::new(),
        ] {
            assert_eq!(
                parse_recovery_key(&bad).unwrap_err().code().as_str(),
                "invalid-input",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn generators_draw_from_the_injected_rng() {
        let mut rng = QueueRng::new([SK.to_vec(), vec![9u8; 32]]);
        assert_eq!(*generate_secret_key(&mut rng).unwrap(), SK);
        assert_eq!(*generate_recovery_key(&mut rng).unwrap(), [9u8; 32]);
        assert_eq!(rng.remaining(), 0);
    }

    proptest! {
        #[test]
        fn secret_keys_round_trip(key in any::<[u8; 16]>()) {
            prop_assert_eq!(*parse_secret_key(&format_secret_key(&key)).unwrap(), key);
        }

        #[test]
        fn recovery_keys_round_trip(key in any::<[u8; 32]>()) {
            prop_assert_eq!(*parse_recovery_key(&format_recovery_key(&key)).unwrap(), key);
        }
    }
}
