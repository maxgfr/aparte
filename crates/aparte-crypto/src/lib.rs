//! Cryptography of the `aparte/1` format: key derivation, keyslots and authenticated encryption.
//!
//! Only pure-Rust primitives are used (OpenSSL is banned in `deny.toml`), and every operation is defined against the
//! vectors in `spec/vectors` so that the CLI and the web app agree byte for byte. The primitives land with the
//! format; this crate only fixes the contract for now.

#![forbid(unsafe_code)]

/// The format whose primitives this crate implements.
pub const FORMAT: &str = aparte_format::FORMAT;

#[cfg(test)]
mod tests {
    #[test]
    fn implements_the_shared_format() {
        assert_eq!(super::FORMAT, aparte_format::FORMAT);
    }
}
