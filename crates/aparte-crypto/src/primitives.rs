//! The primitives of spec/FORMAT.md section 2: SHA-256, HMAC-SHA-256, HKDF-SHA-256 and AES-256-GCM, all from the
//! pure-Rust RustCrypto crates, plus a constant-time comparison.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::{Error, Result};

/// The largest HKDF-SHA-256 output, `255 * 32` bytes (RFC 5869).
pub const MAX_HKDF_LEN: usize = 255 * 32;

/// SHA-256 (FIPS 180-4).
pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// HMAC-SHA-256 (RFC 2104, RFC 4231) over the concatenation of `parts`, with a key of any length.
pub fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    // HMAC takes keys of any length (longer ones are hashed first), so this never fails.
    let Ok(mut mac) = <Hmac<Sha256> as KeyInit>::new_from_slice(key) else {
        unreachable!("HMAC accepts keys of every length")
    };
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

/// RFC 5869 HKDF-SHA-256, `Expand(Extract(salt, ikm), info, length)`; an empty salt is allowed. `invalid-input`
/// above [`MAX_HKDF_LEN`].
pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], length: usize) -> Result<Zeroizing<Vec<u8>>> {
    let mut okm = Zeroizing::new(vec![0u8; length]);
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, &mut okm)
        .map_err(|_| Error::InvalidInput("HKDF output above 8160 bytes"))?;
    Ok(okm)
}

/// The 32-byte HKDF of the format, over an info string built from `info` parts.
pub fn hkdf32(ikm: &[u8], salt: &[u8], info: &[&[u8]]) -> Zeroizing<[u8; 32]> {
    let info = info.concat();
    let mut okm = Zeroizing::new([0u8; 32]);
    // 32 bytes is always a valid HKDF-SHA-256 output length.
    if Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(&info, okm.as_mut())
        .is_err()
    {
        unreachable!("32 bytes is a valid HKDF output length")
    }
    okm
}

/// AES-256-GCM with a 12-byte IV: returns `ciphertext || tag`.
pub fn aes_gcm_encrypt(key: &[u8; 32], iv: &[u8; 12], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    Aes256Gcm::new(key.into())
        .encrypt(&Nonce::from(*iv), Payload { msg: plaintext, aad })
        .map_err(|_| Error::InvalidInput("AES-GCM input too long"))
}

/// The inverse of [`aes_gcm_encrypt`]; `tampered` when the tag does not verify.
pub fn aes_gcm_decrypt(key: &[u8; 32], iv: &[u8; 12], sealed: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    Aes256Gcm::new(key.into())
        .decrypt(&Nonce::from(*iv), Payload { msg: sealed, aad })
        .map(Zeroizing::new)
        .map_err(|_| Error::Tampered("AES-GCM tag does not verify"))
}

/// Equality in time independent of the contents when the lengths are equal.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_digests() {
        assert_eq!(
            aparte_format::encoding::to_hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            aparte_format::encoding::to_hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn hmac_parts_are_concatenated() {
        assert_eq!(hmac_sha256(b"k", &[b"ab", b"c"]), hmac_sha256(b"k", &[b"abc"]));
    }

    #[test]
    fn hkdf_lengths() {
        assert_eq!(hkdf_sha256(b"ikm", b"", b"", 0).unwrap().len(), 0);
        assert_eq!(hkdf_sha256(b"ikm", b"", b"", MAX_HKDF_LEN).unwrap().len(), MAX_HKDF_LEN);
        assert_eq!(
            hkdf_sha256(b"ikm", b"", b"", MAX_HKDF_LEN + 1)
                .unwrap_err()
                .code()
                .as_str(),
            "invalid-input"
        );
        assert_eq!(
            &hkdf32(b"ikm", b"s", &[b"a", b"b"])[..],
            &hkdf_sha256(b"ikm", b"s", b"ab", 32).unwrap()[..]
        );
    }

    #[test]
    fn aes_gcm_authenticates_the_aad() {
        let key = [1u8; 32];
        let iv = [0u8; 12];
        let sealed = aes_gcm_encrypt(&key, &iv, b"x", b"aad").unwrap();
        assert_eq!(sealed.len(), 17);
        assert_eq!(&aes_gcm_decrypt(&key, &iv, &sealed, b"aad").unwrap()[..], b"x");
        assert_eq!(
            aes_gcm_decrypt(&key, &iv, &sealed, b"aae").unwrap_err().code().as_str(),
            "tampered"
        );
        assert_eq!(
            aes_gcm_decrypt(&key, &iv, &sealed[..15], b"aad")
                .unwrap_err()
                .code()
                .as_str(),
            "tampered"
        );
    }

    #[test]
    fn constant_time_equality() {
        assert!(ct_eq(&[1, 2], &[1, 2]));
        assert!(!ct_eq(&[1, 2], &[1, 3]));
        assert!(!ct_eq(&[1, 2], &[1, 2, 0]));
        assert!(ct_eq(&[], &[]));
    }
}
