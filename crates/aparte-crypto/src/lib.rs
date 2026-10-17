//! Cryptography of the `aparte/1` format: key derivation, keyslots and authenticated encryption.
//!
//! Only pure-Rust primitives are used (OpenSSL is banned in `deny.toml`), and every operation is defined against the
//! vectors in `spec/vectors` so that the CLI and the web app agree byte for byte. The layouts, encodings and the
//! keyslot schema come from `aparte-format`; this crate adds the keys.
//!
//! Secret bytes (the master key, subkeys, Argon2 outputs, opened payloads) are held in types that zero themselves
//! when dropped, and every random draw goes through an injected [`Rng`].

#![forbid(unsafe_code)]

pub mod argon2;
pub mod envelope;
pub mod keys;
pub mod keyslot;
pub mod names;
pub mod primitives;
pub mod records;
pub mod rng;
pub mod text;

pub use aparte_format::{Error, ErrorCode, Result};
pub use envelope::{Compression, open_envelope, seal_envelope};
pub use keys::{MasterKey, Purpose, Subkeys};
pub use keyslot::{NewKeyslot, SlotSecret, create_keyslot, open_keyslot};
pub use rng::{OsRng, QueueRng, Rng};

/// The format whose primitives this crate implements.
pub const FORMAT: &str = aparte_format::FORMAT;

#[cfg(test)]
mod tests {
    #[test]
    fn implements_the_shared_format() {
        assert_eq!(super::FORMAT, aparte_format::FORMAT);
    }
}
