//! Content-addressed blobs in the object mirror (spec/FORMAT.md sections 8.6 and 9.4, spec/DATA-MODEL.md section
//! 4.4): a file is cut into chunks of 2 MiB, each sealed under `b/<h2>/<bid>`, and a manifest lists them under
//! `m/<h2>/<mid>`. The ids are keyed hashes of the plaintext, so the same bytes are stored once; the sync engine
//! uploads them before the segments that reference them.

use aparte_crypto::envelope::{Compression, open_envelope, seal_envelope};
use aparte_crypto::names::{chunk_id, manifest_id};
use aparte_crypto::primitives::sha256;
use aparte_format::envelope::{Kind, MAX_CHUNK};
use aparte_format::framing::Manifest;
use aparte_format::names::{chunk_name, manifest_name};
use aparte_store::RecordStore;

use crate::error::{Result, corrupt};

/// A random source drawing from the store's generator.
struct StoreRng<'a>(&'a RecordStore);

impl aparte_crypto::Rng for StoreRng<'_> {
    fn fill(&mut self, dest: &mut [u8]) -> aparte_crypto::Result<()> {
        self.0.fill_random(dest).map_err(aparte_format::Error::from)
    }
}

/// Stores `bytes` and returns the manifest id; storing the same bytes (and type and name) again returns the same id.
pub fn put_blob(store: &RecordStore, bytes: &[u8], mime: &str, file_name: Option<&str>) -> Result<String> {
    let keys = store.subkeys();
    let mut chunks = Vec::new();
    for chunk in bytes.chunks(MAX_CHUNK) {
        let id = chunk_id(keys, chunk);
        let name = chunk_name(&id)?;
        if !store.has_object(&name)? {
            let sealed = seal_envelope(keys, Kind::Chunk, &name, chunk, Compression::None, &mut StoreRng(store))?;
            store.put_object(&name, &sealed)?;
        }
        chunks.push(id);
    }
    let manifest = Manifest {
        mime: mime.to_owned(),
        size: bytes.len() as u64,
        sha256: sha256(bytes),
        chunks,
        name: file_name.map(str::to_owned),
    }
    .encode()?;
    let id = manifest_id(keys, &manifest);
    let name = manifest_name(&id)?;
    if !store.has_object(&name)? {
        let sealed = seal_envelope(
            keys,
            Kind::Manifest,
            &name,
            &manifest,
            Compression::None,
            &mut StoreRng(store),
        )?;
        store.put_object(&name, &sealed)?;
    }
    Ok(id)
}

/// A blob as stored: its manifest and its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blob {
    /// The manifest.
    pub manifest: Manifest,
    /// The file.
    pub bytes: Vec<u8>,
}

/// The blob of a manifest id, or `None` when this device does not have it (yet). Each chunk's id, the total size and
/// the file's SHA-256 are verified (spec/FORMAT.md section 9.4); `corrupt` otherwise.
pub fn get_blob(store: &RecordStore, id: &str) -> Result<Option<Blob>> {
    let keys = store.subkeys();
    let name = manifest_name(id)?;
    let Some(sealed) = store.get_object(&name)? else {
        return Ok(None);
    };
    let payload = open_envelope(keys, Kind::Manifest, &name, &sealed)?;
    if manifest_id(keys, &payload) != id {
        return Err(corrupt("a manifest does not match its id"));
    }
    let manifest = Manifest::decode(&payload)?;
    let mut bytes = Vec::with_capacity(usize::try_from(manifest.size).unwrap_or(0));
    for chunk in &manifest.chunks {
        let chunk_object = chunk_name(chunk)?;
        let Some(sealed) = store.get_object(&chunk_object)? else {
            return Ok(None);
        };
        let plain = open_envelope(keys, Kind::Chunk, &chunk_object, &sealed)?;
        if chunk_id(keys, &plain) != *chunk {
            return Err(corrupt("a chunk does not match its id"));
        }
        bytes.extend_from_slice(&plain);
    }
    if bytes.len() as u64 != manifest.size || sha256(&bytes) != manifest.sha256 {
        return Err(corrupt("a blob does not match its manifest"));
    }
    Ok(Some(Blob { manifest, bytes }))
}
