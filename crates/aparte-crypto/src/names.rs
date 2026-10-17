//! The keyed parts of object names (spec/FORMAT.md sections 8.3 to 8.7 and 11.3): tags, shards, content suffixes,
//! blob ids and local record names. Each is a truncated base32 HMAC under `K_obj-name`, `K_blob-id` or
//! `K_local-name`; the grammar itself is in `aparte_format::names`.

use aparte_format::encoding::base32_encode;
use aparte_format::framing::{MAX_LOCAL_ID_LEN, is_purpose};
use aparte_format::names::{self as grammar, DocId, ID_LEN, SUFFIX_LEN, TAG_LEN, seq10};

use crate::keys::{Purpose, Subkeys};
use crate::primitives::sha256;
use crate::{Error, Result};

/// `b32(HMAC(K_purpose, parts...))[0..chars]`: truncation is of characters, not bytes.
fn tag(subkeys: &Subkeys, purpose: Purpose, parts: &[&[u8]], chars: usize) -> String {
    let mut text = base32_encode(&subkeys.mac(purpose, parts));
    text.truncate(chars);
    text
}

/// `dtag = b32(HMAC(K_obj-name, "dtag|" || deviceId))[0..16]`.
pub fn device_tag(subkeys: &Subkeys, device_id: &[u8; 16]) -> String {
    tag(subkeys, Purpose::ObjName, &[b"dtag|", device_id], TAG_LEN)
}

/// `stag = b32(HMAC(K_obj-name, "doc|" || docId))[0..16]`.
pub fn doc_tag(subkeys: &Subkeys, doc: DocId) -> String {
    tag(subkeys, Purpose::ObjName, &[b"doc|", doc.as_str().as_bytes()], TAG_LEN)
}

/// `ktag = b32(HMAC(K_obj-name, "secret|" || secretId))[0..16]`.
pub fn secret_tag(subkeys: &Subkeys, secret_id: &[u8; 16]) -> String {
    tag(subkeys, Purpose::ObjName, &[b"secret|", secret_id], TAG_LEN)
}

/// `shard = "c" || two digits of (HMAC(K_obj-name, "shard|" || convId)[0] & 0x0f)`.
pub fn shard_of(subkeys: &Subkeys, conv_id: &[u8; 16]) -> DocId {
    let mac = subkeys.mac(Purpose::ObjName, &[b"shard|", conv_id]);
    match DocId::shard(mac[0] & 0x0f) {
        Some(doc) => doc,
        None => unreachable!("a nibble is a shard number"),
    }
}

/// `r8 = b32(HMAC(K_obj-name, label || stag || dtag || seq10 || SHA-256(payload)))[0..8]`.
fn stream_suffix(subkeys: &Subkeys, label: &[u8], stag: &str, dtag: &str, seq: &str, payload: &[u8]) -> String {
    let digest = sha256(payload);
    tag(
        subkeys,
        Purpose::ObjName,
        &[label, stag.as_bytes(), dtag.as_bytes(), seq.as_bytes(), &digest],
        SUFFIX_LEN,
    )
}

/// `d/<stag>/s/<dtag>/<bucket7>/<seq10>-<r8>` for the **uncompressed** payload; `invalid-input` outside
/// `1 <= seq <= 9 999 999 999`. The name depends only on the content, so a retry reuses it.
pub fn segment_name(subkeys: &Subkeys, doc: DocId, device_id: &[u8; 16], seq: u64, payload: &[u8]) -> Result<String> {
    let (stag, dtag, seq_text) = (doc_tag(subkeys, doc), device_tag(subkeys, device_id), seq10(seq)?);
    let r8 = stream_suffix(subkeys, b"seg|", &stag, &dtag, &seq_text, payload);
    grammar::segment_name(&stag, &dtag, seq, &r8)
}

/// `d/<stag>/c/<dtag>/<seq10>-<r8>` with the `"ckpt|"` label.
pub fn checkpoint_name(
    subkeys: &Subkeys,
    doc: DocId,
    device_id: &[u8; 16],
    seq: u64,
    payload: &[u8],
) -> Result<String> {
    let (stag, dtag, seq_text) = (doc_tag(subkeys, doc), device_tag(subkeys, device_id), seq10(seq)?);
    let r8 = stream_suffix(subkeys, b"ckpt|", &stag, &dtag, &seq_text, payload);
    grammar::checkpoint_name(&stag, &dtag, seq, &r8)
}

/// `bid = b32(HMAC(K_blob-id, "chunk|" || SHA-256(chunk)))[0..26]`.
pub fn chunk_id(subkeys: &Subkeys, chunk: &[u8]) -> String {
    tag(subkeys, Purpose::BlobId, &[b"chunk|", &sha256(chunk)], ID_LEN)
}

/// `mid = b32(HMAC(K_blob-id, "manifest|" || SHA-256(manifest bytes)))[0..26]`.
pub fn manifest_id(subkeys: &Subkeys, manifest: &[u8]) -> String {
    tag(subkeys, Purpose::BlobId, &[b"manifest|", &sha256(manifest)], ID_LEN)
}

/// `k/<ktag>/<seq10>-<r8>`, `r8 = b32(HMAC(K_obj-name, "sec|" || ktag || seq10 || SHA-256(payload)))[0..8]`.
pub fn secret_version_name(subkeys: &Subkeys, secret_id: &[u8; 16], seq: u64, payload: &[u8]) -> Result<String> {
    let (ktag, seq_text) = (secret_tag(subkeys, secret_id), seq10(seq)?);
    let digest = sha256(payload);
    let r8 = tag(
        subkeys,
        Purpose::ObjName,
        &[b"sec|", ktag.as_bytes(), seq_text.as_bytes(), &digest],
        SUFFIX_LEN,
    );
    grammar::secret_version_name(&ktag, seq, &r8)
}

/// `localName = b32(HMAC(K_local-name, purpose || "|" || id))[0..26]`; `invalid-input` for a purpose outside
/// `[a-z][a-z0-9-]{0,31}` or an id above 1024 bytes.
pub fn local_name(subkeys: &Subkeys, purpose: &str, id: &str) -> Result<String> {
    if !is_purpose(purpose) {
        return Err(Error::InvalidInput("local record purpose"));
    }
    if id.len() > MAX_LOCAL_ID_LEN {
        return Err(Error::InvalidInput("local record id above 1024 bytes"));
    }
    Ok(tag(
        subkeys,
        Purpose::LocalName,
        &[purpose.as_bytes(), b"|", id.as_bytes()],
        ID_LEN,
    ))
}
