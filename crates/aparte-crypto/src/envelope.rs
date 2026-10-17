//! Sealing and opening envelopes (spec/FORMAT.md sections 7.5 and 7.6). The key is `K_obj(name)` for kinds 1 to 5
//! and `K_local(name)` for kind 6; the AAD binds every header byte, the vault and the name.

use aparte_format::envelope::{
    FLAG_DEFLATE, HEADER_LEN, Header, Kind, MAX_CHUNK, MAX_PAYLOAD, deflate_raw, envelope_aad, inflate_raw,
    pad_plaintext, parse_header, unpad_plaintext,
};
use zeroize::Zeroizing;

use crate::keys::Subkeys;
use crate::primitives::{aes_gcm_decrypt, aes_gcm_encrypt};
use crate::rng::{Rng, draw};
use crate::{Error, Result};

/// How the payload is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Compression {
    /// As it is.
    #[default]
    None,
    /// Compressed with deflate-raw when that makes it smaller (spec/FORMAT.md section 7.6), else as it is.
    DeflateRaw,
    /// The payload already is a deflate-raw stream and is sealed as it is, with the flag set. The vectors use it,
    /// since compressed bytes differ between libraries.
    Precompressed,
}

fn key_for(subkeys: &Subkeys, kind: Kind, name: &str) -> Zeroizing<[u8; 32]> {
    if kind.is_local() {
        subkeys.local_key(name)
    } else {
        subkeys.object_key(name)
    }
}

/// Names are one or more printable ASCII characters, `[\x21-\x7e]+`, as keys.ts `nameBytes` requires: no empty
/// name, no space, no control character.
fn check_name(name: &str) -> Result<()> {
    if !name.is_empty() && name.bytes().all(|c| (0x21..=0x7e).contains(&c)) {
        Ok(())
    } else {
        Err(Error::InvalidInput("object and record names are printable ASCII"))
    }
}

/// Seals `payload` under the key of `kind` and `name`, drawing exactly one 12-byte IV from `rng`.
/// `invalid-input` for compression on kinds 3 to 6, a payload above `2^26` bytes, or a chunk above 2 MiB.
pub fn seal_envelope(
    subkeys: &Subkeys,
    kind: Kind,
    name: &str,
    payload: &[u8],
    compression: Compression,
    rng: &mut dyn Rng,
) -> Result<Vec<u8>> {
    check_name(name)?;
    if compression != Compression::None && !kind.allows_compression() {
        return Err(Error::InvalidInput("compression is for segments and checkpoints only"));
    }
    if payload.len() > MAX_PAYLOAD {
        return Err(Error::InvalidInput("payload above 2^26 bytes"));
    }
    if kind == Kind::Chunk && payload.len() > MAX_CHUNK {
        return Err(Error::InvalidInput("blob chunk above 2 MiB"));
    }
    let (stored, flags): (Zeroizing<Vec<u8>>, u8) = match compression {
        Compression::None => (Zeroizing::new(payload.to_vec()), 0),
        Compression::Precompressed => (Zeroizing::new(payload.to_vec()), FLAG_DEFLATE),
        Compression::DeflateRaw => {
            let deflated = Zeroizing::new(deflate_raw(payload)?);
            if deflated.len() < payload.len() {
                (deflated, FLAG_DEFLATE)
            } else {
                (Zeroizing::new(payload.to_vec()), 0)
            }
        }
    };
    let iv = draw::<12>(rng)?;
    let header = Header { kind, flags, iv }.to_bytes();
    let plaintext = Zeroizing::new(pad_plaintext(&stored)?);
    let aad = envelope_aad(&header, subkeys.vault_id(), name);
    let sealed = aes_gcm_encrypt(&key_for(subkeys, kind, name), &iv, &plaintext, &aad)?;
    let mut out = Vec::with_capacity(HEADER_LEN + sealed.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Opens an envelope with the checks of spec/FORMAT.md section 7.5, in that order, and returns the payload
/// (inflated when the flag is set). `kind` is the kind the name implies.
pub fn open_envelope(subkeys: &Subkeys, kind: Kind, name: &str, bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    check_name(name)?;
    // Steps 1 to 6.
    let header = parse_header(bytes, Some(kind))?;
    let (head, sealed) = bytes.split_at(HEADER_LEN);
    let mut header_bytes = [0u8; HEADER_LEN];
    header_bytes.copy_from_slice(head);
    // Step 7.
    let aad = envelope_aad(&header_bytes, subkeys.vault_id(), name);
    let plaintext = aes_gcm_decrypt(&key_for(subkeys, kind, name), &header.iv, sealed, &aad)?;
    // Steps 8 to 10.
    let stored = unpad_plaintext(&plaintext)?;
    // Step 11.
    if header.is_compressed() {
        Ok(Zeroizing::new(inflate_raw(stored, MAX_PAYLOAD)?))
    } else {
        Ok(Zeroizing::new(stored.to_vec()))
    }
}
