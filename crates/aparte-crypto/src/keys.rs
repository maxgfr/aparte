//! The key schedule of spec/FORMAT.md section 5: six subkeys from the master key, one AES key per object or local
//! record name, and the master key check.
//!
//! Secret bytes live in types that zero themselves when dropped. The master key is read once to derive the
//! subkeys and is not kept by [`Subkeys`].

use zeroize::{Zeroize, Zeroizing};

use crate::primitives::{hkdf32, hmac_sha256};

/// The 32-byte master key `MK`, zeroed on drop.
pub type MasterKey = Zeroizing<[u8; 32]>;

/// One of the six subkeys of spec/FORMAT.md section 5.2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Purpose {
    /// `K_obj-enc`: HKDF input key of the remote object keys.
    ObjEnc,
    /// `K_obj-name`: HMAC key of the tags, shards and name suffixes.
    ObjName,
    /// `K_blob-id`: HMAC key of the chunk and manifest ids.
    BlobId,
    /// `K_local-enc`: HKDF input key of the local record keys.
    LocalEnc,
    /// `K_local-name`: HMAC key of the local record names.
    LocalName,
    /// `K_check`: HMAC key of `mkCheck`.
    Check,
}

impl Purpose {
    /// Every purpose, in the order of spec/FORMAT.md section 5.2.
    pub const ALL: [Self; 6] = [
        Self::ObjEnc,
        Self::ObjName,
        Self::BlobId,
        Self::LocalEnc,
        Self::LocalName,
        Self::Check,
    ];

    /// The ASCII purpose of the HKDF info string `"aparte/1/" || purpose`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ObjEnc => "obj-enc",
            Self::ObjName => "obj-name",
            Self::BlobId => "blob-id",
            Self::LocalEnc => "local-enc",
            Self::LocalName => "local-name",
            Self::Check => "check",
        }
    }
}

/// The six subkeys of a vault, zeroed on drop.
pub struct Subkeys {
    vault_id: [u8; 16],
    keys: [[u8; 32]; 6],
}

impl Drop for Subkeys {
    fn drop(&mut self) {
        self.keys.zeroize();
    }
}

impl std::fmt::Debug for Subkeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subkeys")
            .field("vault_id", &self.vault_id)
            .finish_non_exhaustive()
    }
}

/// `K_purpose = HKDF(ikm = MK, salt = "aparte/1/vault" || vaultId, info = "aparte/1/" || purpose)`.
pub fn subkey(mk: &[u8; 32], vault_id: &[u8; 16], purpose: Purpose) -> Zeroizing<[u8; 32]> {
    let salt = [&b"aparte/1/vault"[..], vault_id].concat();
    hkdf32(mk, &salt, &[b"aparte/1/", purpose.as_str().as_bytes()])
}

impl Subkeys {
    /// The key schedule of spec/FORMAT.md section 5.2. The caller keeps (and zeroes) `mk`; nothing here retains it.
    pub fn derive(mk: &[u8; 32], vault_id: &[u8; 16]) -> Self {
        let mut keys = [[0u8; 32]; 6];
        for (slot, purpose) in keys.iter_mut().zip(Purpose::ALL) {
            *slot = *subkey(mk, vault_id, purpose);
        }
        Self {
            vault_id: *vault_id,
            keys,
        }
    }

    /// The vault these keys belong to; not secret, carried along because every derivation needs it.
    pub const fn vault_id(&self) -> &[u8; 16] {
        &self.vault_id
    }

    /// The raw bytes of one subkey. The vectors print them; nothing else should need them.
    pub const fn expose(&self, purpose: Purpose) -> &[u8; 32] {
        &self.keys[purpose as usize]
    }

    /// `HMAC(K_purpose, parts...)`, for the HMAC subkeys.
    pub fn mac(&self, purpose: Purpose, parts: &[&[u8]]) -> [u8; 32] {
        hmac_sha256(self.expose(purpose), parts)
    }

    /// `K_obj(name) = HKDF(ikm = K_obj-enc, salt = vaultId, info = "aparte/1/obj|" || name)`.
    pub fn object_key(&self, name: &str) -> Zeroizing<[u8; 32]> {
        hkdf32(
            self.expose(Purpose::ObjEnc),
            &self.vault_id,
            &[b"aparte/1/obj|", name.as_bytes()],
        )
    }

    /// `K_local(name) = HKDF(ikm = K_local-enc, salt = vaultId, info = "aparte/1/local|" || name)`.
    pub fn local_key(&self, name: &str) -> Zeroizing<[u8; 32]> {
        hkdf32(
            self.expose(Purpose::LocalEnc),
            &self.vault_id,
            &[b"aparte/1/local|", name.as_bytes()],
        )
    }

    /// `mkCheck = HMAC(K_check, "aparte/1/check|" || vaultId)`.
    pub fn master_key_check(&self) -> [u8; 32] {
        self.mac(Purpose::Check, &[b"aparte/1/check|", &self.vault_id])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::primitives::{aes_gcm_decrypt, aes_gcm_encrypt, hkdf_sha256};

    const MK: [u8; 32] = {
        let mut mk = [0u8; 32];
        let mut i = 0;
        while i < 32 {
            mk[i] = i as u8;
            i += 1;
        }
        mk
    };
    const VAULT: [u8; 16] = [
        0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
    ];

    fn raw(purpose: &str, vault: &[u8]) -> Vec<u8> {
        hkdf_sha256(
            &MK,
            &[b"aparte/1/vault", vault].concat(),
            format!("aparte/1/{purpose}").as_bytes(),
            32,
        )
        .unwrap()
        .to_vec()
    }

    #[test]
    fn subkeys_follow_the_formula_and_differ() {
        let keys = Subkeys::derive(&MK, &VAULT);
        assert_eq!(keys.vault_id(), &VAULT);
        for purpose in Purpose::ALL {
            assert_eq!(keys.expose(purpose).to_vec(), raw(purpose.as_str(), &VAULT));
        }
        let mut all: Vec<_> = Purpose::ALL.iter().map(|&p| *keys.expose(p)).collect();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), 6);
        let other = Subkeys::derive(&MK, &[0xe0; 16]);
        assert_ne!(other.expose(Purpose::ObjName), keys.expose(Purpose::ObjName));
        assert!(!format!("{keys:?}").contains("keys:"));
    }

    #[test]
    fn object_and_local_keys() {
        let keys = Subkeys::derive(&MK, &VAULT);
        let name = "d/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc";
        let expected = hkdf_sha256(
            &raw("obj-enc", &VAULT),
            &VAULT,
            format!("aparte/1/obj|{name}").as_bytes(),
            32,
        )
        .unwrap();
        assert_eq!(&keys.object_key(name)[..], &expected[..]);
        let local = "kkkkkkkkkkkkkkkkkkkkkkkkkk";
        let expected = hkdf_sha256(
            &raw("local-enc", &VAULT),
            &VAULT,
            format!("aparte/1/local|{local}").as_bytes(),
            32,
        )
        .unwrap();
        assert_eq!(&keys.local_key(local)[..], &expected[..]);
        assert_ne!(keys.object_key(name), keys.local_key(name));
        assert_ne!(keys.object_key(name), keys.object_key(&format!("{name}x")));
        let sealed = aes_gcm_encrypt(&keys.object_key(name), &[7; 12], b"object plaintext", b"").unwrap();
        assert!(aes_gcm_decrypt(&keys.local_key(name), &[7; 12], &sealed, b"").is_err());
    }

    #[test]
    fn master_key_check_formula() {
        let keys = Subkeys::derive(&MK, &VAULT);
        let expected = hmac_sha256(&raw("check", &VAULT), &[b"aparte/1/check|", &VAULT]);
        assert_eq!(keys.master_key_check(), expected);
    }
}
