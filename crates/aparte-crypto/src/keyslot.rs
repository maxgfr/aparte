//! Creating and opening keyslots (spec/FORMAT.md sections 6.4 to 6.7). The schema and the strict parser are in
//! `aparte_format::keyslot`; this module adds Argon2, the slot keys, the commitment and the wrap.
//!
//! Opening follows section 6.7 step by step: the bounds are checked before Argon2 runs, and the commitment is
//! checked before AES-GCM runs, so a wrong secret is `wrong-secret` and only the right one reaches the wrap.

use aparte_format::keyslot::{Argon2Params, DEFAULT_ARGON2, Kdf, Keyslot, KeyslotKind, wrap_aad};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use crate::argon2::{Argon2Fn, Argon2Input, argon2id};
use crate::keys::{MasterKey, Subkeys};
use crate::primitives::{aes_gcm_decrypt, aes_gcm_encrypt, ct_eq, hkdf32, hmac_sha256};
use crate::rng::{Rng, draw};
use crate::{Error, Result};

/// The secret a keyslot is opened with.
#[derive(Clone, Copy)]
pub enum SlotSecret<'a> {
    /// A passphrase, and the Secret Key when the device knows it.
    Passphrase {
        /// The passphrase as typed; it is normalized to NFKC.
        passphrase: &'a str,
        /// The 16-byte Secret Key, required by a slot with `secretKey: true`.
        secret_key: Option<&'a [u8; 16]>,
    },
    /// The 32-byte recovery key.
    Recovery {
        /// The recovery key `R`.
        key: &'a [u8; 32],
    },
    /// The PRF output of the slot's WebAuthn credential for its `prfSalt`.
    Passkey {
        /// The 32-byte PRF output.
        prf_output: &'a [u8; 32],
    },
}

impl SlotSecret<'_> {
    const fn kind(&self) -> KeyslotKind {
        match self {
            Self::Passphrase { .. } => KeyslotKind::Passphrase,
            Self::Recovery { .. } => KeyslotKind::Recovery,
            Self::Passkey { .. } => KeyslotKind::Passkey,
        }
    }
}

/// What a new keyslot is built from (besides the master key and the vault).
#[derive(Clone, Copy)]
pub enum NewKeyslot<'a> {
    /// A passphrase slot; `params` defaults to [`DEFAULT_ARGON2`] through [`NewKeyslot::passphrase`].
    Passphrase {
        /// The passphrase; it must be non-empty after NFKC normalization.
        passphrase: &'a str,
        /// The Secret Key, or `None` for a slot opened by the passphrase alone.
        secret_key: Option<&'a [u8; 16]>,
        /// The Argon2id costs, within the bounds of spec/FORMAT.md section 6.3.
        params: Argon2Params,
    },
    /// A recovery slot.
    Recovery {
        /// The recovery key `R`.
        key: &'a [u8; 32],
    },
    /// A passkey slot; the credential, relying party and PRF salt come from the WebAuthn ceremony.
    Passkey {
        /// The PRF output for `prf_salt`.
        prf_output: &'a [u8; 32],
        /// The credential id, 16 to 1023 bytes.
        credential_id: &'a [u8],
        /// The relying party id, 1 to 253 characters of `[a-z0-9.-]`.
        rp_id: &'a str,
        /// The PRF `eval.first` input.
        prf_salt: &'a [u8; 32],
    },
}

impl<'a> NewKeyslot<'a> {
    /// A passphrase slot with the default, fixed Argon2 parameters.
    pub const fn passphrase(passphrase: &'a str, secret_key: Option<&'a [u8; 16]>) -> Self {
        Self::Passphrase {
            passphrase,
            secret_key,
            params: DEFAULT_ARGON2,
        }
    }
}

/// `UTF-8(NFKC(passphrase))`; `invalid-input` when empty after normalization. A Rust string is always well-formed,
/// so the lone-surrogate case of the web cannot arise here.
pub fn normalize_passphrase(passphrase: &str) -> Result<Zeroizing<Vec<u8>>> {
    let normalized = Zeroizing::new(passphrase.nfkc().collect::<String>());
    if normalized.is_empty() {
        return Err(Error::InvalidInput("empty passphrase"));
    }
    Ok(Zeroizing::new(normalized.as_bytes().to_vec()))
}

/// `A = Argon2id(UTF-8(NFKC(passphrase)), salt, m, t, p, 32)`.
pub fn passphrase_argon2(
    passphrase: &str,
    salt: &[u8; 16],
    params: Argon2Params,
    argon2: Option<Argon2Fn<'_>>,
) -> Result<Zeroizing<[u8; 32]>> {
    let password = normalize_passphrase(passphrase)?;
    let input = Argon2Input {
        password: &password,
        salt,
        m: params.m,
        t: params.t,
        p: params.p,
        length: 32,
        secret: &[],
        ad: &[],
    };
    let tag = match argon2 {
        Some(f) => f(&input)?,
        None => argon2id(&input)?,
    };
    let mut out = Zeroizing::new([0u8; 32]);
    if tag.len() != 32 {
        return Err(Error::InvalidState("Argon2 returned a tag of another length"));
    }
    out.copy_from_slice(&tag);
    Ok(out)
}

/// `IKM = A || SK` when the Secret Key is part of the input, else `A`.
pub fn passphrase_ikm(a: &[u8; 32], secret_key: Option<&[u8; 16]>) -> Zeroizing<Vec<u8>> {
    let mut ikm = Zeroizing::new(Vec::with_capacity(48));
    ikm.extend_from_slice(a);
    if let Some(sk) = secret_key {
        ikm.extend_from_slice(sk);
    }
    ikm
}

/// The keys of one slot (spec/FORMAT.md section 6.5), zeroed on drop.
pub struct SlotKeys {
    /// `KEK = HKDF(IKM, salt = vaultId || slotId, info = "aparte/1/kek|" || kind)`.
    pub kek: Zeroizing<[u8; 32]>,
    /// `K_wrap = HKDF(KEK, salt = vaultId, info = "aparte/1/wrap")`.
    pub k_wrap: Zeroizing<[u8; 32]>,
    /// `K_commit = HKDF(KEK, salt = vaultId, info = "aparte/1/commit")`.
    pub k_commit: Zeroizing<[u8; 32]>,
}

impl SlotKeys {
    /// Derives `KEK`, `K_wrap` and `K_commit` from the input key material.
    pub fn derive(ikm: &[u8], vault_id: &[u8; 16], slot_id: &[u8; 16], kind: KeyslotKind) -> Self {
        let salt = [&vault_id[..], slot_id].concat();
        let kek = hkdf32(ikm, &salt, &[b"aparte/1/kek|", kind.as_str().as_bytes()]);
        let k_wrap = hkdf32(kek.as_ref(), vault_id, &[b"aparte/1/wrap"]);
        let k_commit = hkdf32(kek.as_ref(), vault_id, &[b"aparte/1/commit"]);
        Self { kek, k_wrap, k_commit }
    }

    /// `commit = HMAC(K_commit, "aparte/1/commit|" || vaultId || slotId)`.
    pub fn commit(&self, vault_id: &[u8; 16], slot_id: &[u8; 16]) -> [u8; 32] {
        hmac_sha256(self.k_commit.as_ref(), &[b"aparte/1/commit|", vault_id, slot_id])
    }
}

/// Creates a keyslot (spec/FORMAT.md section 6.6), drawing from `rng` in this order: `slotId` (16 bytes), the salt
/// (16 bytes, passphrase slots only), the wrap IV (12 bytes). Inputs are checked before anything is drawn:
/// `invalid-input` for an empty passphrase, Argon2 parameters out of bounds or a malformed passkey credential.
pub fn create_keyslot(
    mk: &[u8; 32],
    vault_id: &[u8; 16],
    new: &NewKeyslot<'_>,
    rng: &mut dyn Rng,
    argon2: Option<Argon2Fn<'_>>,
) -> Result<Keyslot> {
    match new {
        NewKeyslot::Passphrase { passphrase, params, .. } => {
            normalize_passphrase(passphrase)?;
            if !params.in_bounds() {
                return Err(Error::InvalidInput("Argon2 parameters out of bounds"));
            }
        }
        NewKeyslot::Passkey {
            credential_id,
            rp_id,
            prf_salt,
            ..
        } => {
            let kdf = Kdf::Passkey {
                credential_id: credential_id.to_vec(),
                rp_id: (*rp_id).to_owned(),
                prf_salt: **prf_salt,
            };
            kdf.validate()
                .map_err(|_| Error::InvalidInput("passkey credential out of bounds"))?;
        }
        NewKeyslot::Recovery { .. } => {}
    }

    let slot_id = draw::<16>(rng)?;
    let (kdf, ikm) = match new {
        NewKeyslot::Passphrase {
            passphrase,
            secret_key,
            params,
        } => {
            let salt = draw::<16>(rng)?;
            let a = passphrase_argon2(passphrase, &salt, *params, argon2)?;
            let kdf = Kdf::Passphrase {
                params: *params,
                salt,
                secret_key: secret_key.is_some(),
            };
            (kdf, passphrase_ikm(&a, *secret_key))
        }
        NewKeyslot::Recovery { key } => (Kdf::Recovery, Zeroizing::new(key.to_vec())),
        NewKeyslot::Passkey {
            prf_output,
            credential_id,
            rp_id,
            prf_salt,
        } => {
            let kdf = Kdf::Passkey {
                credential_id: credential_id.to_vec(),
                rp_id: (*rp_id).to_owned(),
                prf_salt: **prf_salt,
            };
            (kdf, Zeroizing::new(prf_output.to_vec()))
        }
    };
    let wrap_iv = draw::<12>(rng)?;

    let keys = SlotKeys::derive(&ikm, vault_id, &slot_id, kdf.kind());
    let commit = keys.commit(vault_id, &slot_id);
    let aad = wrap_aad(vault_id, &slot_id, &kdf);
    let ct = aes_gcm_encrypt(&keys.k_wrap, &wrap_iv, mk, &aad)?;
    let wrap_ct: [u8; 48] = ct
        .try_into()
        .map_err(|_| Error::InvalidState("wrap of another length"))?;
    let mk_check = Subkeys::derive(mk, vault_id).master_key_check();
    Ok(Keyslot {
        vault_id: *vault_id,
        slot_id,
        kdf,
        commit,
        wrap_iv,
        wrap_ct,
        mk_check,
    })
}

/// The input key material of step 5; `invalid-input` for a secret of another kind, or a passphrase slot that
/// needs the Secret Key opened without it.
fn input_key_material(
    slot: &Keyslot,
    secret: &SlotSecret<'_>,
    argon2: Option<Argon2Fn<'_>>,
) -> Result<Zeroizing<Vec<u8>>> {
    if secret.kind() != slot.kind() {
        return Err(Error::InvalidInput("a secret of another kind than the slot"));
    }
    match (&slot.kdf, secret) {
        (
            Kdf::Passphrase {
                params,
                salt,
                secret_key,
            },
            SlotSecret::Passphrase {
                passphrase,
                secret_key: sk,
            },
        ) => {
            let sk = match (secret_key, sk) {
                (true, None) => return Err(Error::InvalidInput("this slot needs the Secret Key")),
                (true, Some(sk)) => Some(*sk),
                (false, _) => None,
            };
            let a = passphrase_argon2(passphrase, salt, *params, argon2)?;
            Ok(passphrase_ikm(&a, sk))
        }
        (Kdf::Recovery, SlotSecret::Recovery { key }) => Ok(Zeroizing::new(key.to_vec())),
        (Kdf::Passkey { .. }, SlotSecret::Passkey { prf_output }) => Ok(Zeroizing::new(prf_output.to_vec())),
        _ => Err(Error::InvalidInput("a secret of another kind than the slot")),
    }
}

/// Opens a keyslot per spec/FORMAT.md section 6.7 and returns the master key. The slot is validated again, so a
/// hand-built slot with a parameter out of bounds is `unsupported-keyslot` before Argon2 runs; `argon2` replaces
/// the built-in Argon2id when given.
pub fn open_keyslot(
    slot: &Keyslot,
    secret: &SlotSecret<'_>,
    vault_id: &[u8; 16],
    argon2: Option<Argon2Fn<'_>>,
) -> Result<MasterKey> {
    // Steps 1 to 3 hold for a parsed slot; the bounds are checked again for one built by hand.
    slot.validate()?;
    // Step 4.
    if slot.vault_id != *vault_id {
        return Err(Error::Corrupt("keyslot of another vault"));
    }
    // Step 5: Argon2 runs here, and only here.
    let ikm = input_key_material(slot, secret, argon2)?;
    // Step 6: the commitment, before AES-GCM.
    let keys = SlotKeys::derive(&ikm, vault_id, &slot.slot_id, slot.kind());
    if !ct_eq(&keys.commit(vault_id, &slot.slot_id), &slot.commit) {
        return Err(Error::WrongSecret("this secret does not open the slot"));
    }
    // Step 7.
    let plain = aes_gcm_decrypt(&keys.k_wrap, &slot.wrap_iv, &slot.wrap_ct, &slot.aad())?;
    let mut mk = MasterKey::new([0u8; 32]);
    if plain.len() != 32 {
        return Err(Error::Tampered("wrapped master key of another length"));
    }
    mk.copy_from_slice(&plain);
    // Step 8.
    if !ct_eq(&Subkeys::derive(&mk, vault_id).master_key_check(), &slot.mk_check) {
        return Err(Error::Tampered("mkCheck does not match the unwrapped key"));
    }
    Ok(mk)
}
