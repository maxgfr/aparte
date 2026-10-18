//! Standard base64 (RFC 4648 section 4), the content of every object file in a Git store (spec/FORMAT.md section
//! 10.5): written padded and without line breaks; read with the "forgiving" decoding of the web platform's `atob`
//! (ASCII whitespace removed, padding optional), as the web app reads it.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Padded standard base64, no line break.
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 0x3f) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some(u32::from(c - b'A')),
        b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// The WHATWG forgiving-base64 decode; `None` for text that is not base64.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let mut data: Vec<u8> = text
        .bytes()
        .filter(|c| !matches!(c, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r'))
        .collect();
    if data.len().is_multiple_of(4) {
        for _ in 0..2 {
            if data.last() == Some(&b'=') {
                data.pop();
            }
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for c in data {
        buffer = (buffer << 6) | value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[test]
    fn rfc_4648_vectors() {
        for (plain, coded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode(plain.as_bytes()), coded);
            assert_eq!(decode(coded).as_deref(), Some(plain.as_bytes()));
        }
        assert_eq!(decode("Zm9v\nYg").as_deref(), Some(&b"foob"[..]));
        assert_eq!(decode("Zm9vY"), None);
        assert_eq!(decode("Zm9v!"), None);
    }

    proptest! {
        #[test]
        fn round_trips(bytes in proptest::collection::vec(any::<u8>(), 0..300)) {
            prop_assert_eq!(decode(&encode(&bytes)), Some(bytes));
        }
    }
}
