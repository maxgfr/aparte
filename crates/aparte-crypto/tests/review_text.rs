//! Review: spec/FORMAT.md sections 6.8 and 6.9 accept only characters of the base32 alphabet, case-insensitively.
//! `compact` in text.rs lowercases with Unicode `str::to_lowercase`, which maps U+212A KELVIN SIGN to ASCII `k`, so
//! the CLI accepts a Secret Key or recovery key text holding a character outside the alphabet. The web parsers
//! (secretKey.ts, recovery.ts) check the text is ASCII before any case mapping and refuse it (`invalid-input`).

use aparte_crypto::text::{format_recovery_key, format_secret_key, parse_recovery_key, parse_secret_key};

const KELVIN: char = '\u{212A}';

/// The first key of the form [i; N] whose text holds a `K` after its prefix.
fn with_k<const N: usize>(format: impl Fn(&[u8; N]) -> String, skip: usize) -> String {
    (0u8..=255)
        .map(|i| format(&[i; N]))
        .find(|t| t[skip..].contains('K'))
        .expect("some key text holds a K")
}

#[test]
fn secret_key_text_with_a_kelvin_sign_is_refused() {
    let text = with_k::<16>(format_secret_key, 3);
    assert!(parse_secret_key(&text).is_ok());
    let hostile = format!("{}{}", &text[..3], text[3..].replacen('K', &KELVIN.to_string(), 1));
    assert_ne!(hostile, text);
    let result = parse_secret_key(&hostile);
    assert_eq!(
        result.map(|_| ()).unwrap_err().code().as_str(),
        "invalid-input",
        "{hostile:?} holds a character outside the base32 alphabet"
    );
}

#[test]
fn recovery_key_text_with_a_kelvin_sign_is_refused() {
    let text = with_k::<32>(format_recovery_key, 0);
    assert!(parse_recovery_key(&text).is_ok());
    let hostile = text.replacen('K', &KELVIN.to_string(), 1);
    let result = parse_recovery_key(&hostile);
    assert_eq!(
        result.map(|_| ()).unwrap_err().code().as_str(),
        "invalid-input",
        "{hostile:?} holds a character outside the base32 alphabet"
    );
}
