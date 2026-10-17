//! Typed objects on top of envelopes: local records (spec/FORMAT.md sections 9.6 and 11.3), and segments and
//! checkpoints (sections 9.1 and 9.2) with the header checks that need the vault keys.

use aparte_format::envelope::Kind;
use aparte_format::framing::{
    StreamHeader, StreamKind, decode_local_record, decode_stream_payload, encode_local_record,
};
use aparte_format::names::{ParsedName, parse_name};
use zeroize::Zeroizing;

use crate::envelope::{Compression, open_envelope, seal_envelope};
use crate::keys::Subkeys;
use crate::names::{doc_tag, local_name};
use crate::primitives::ct_eq;
use crate::rng::Rng;
use crate::{Error, Result};

/// An opened local record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedLocalRecord {
    /// The purpose, `[a-z][a-z0-9-]{0,31}`.
    pub purpose: String,
    /// The record id.
    pub id: String,
    /// The record's bytes, zeroed on drop.
    pub value: Zeroizing<Vec<u8>>,
}

/// Seals a local record and returns its name and envelope (kind 6, keyed by `K_local(name)`).
pub fn seal_local_record(
    subkeys: &Subkeys,
    purpose: &str,
    id: &str,
    value: &[u8],
    rng: &mut dyn Rng,
) -> Result<(String, Vec<u8>)> {
    let name = local_name(subkeys, purpose, id)?;
    let payload = Zeroizing::new(encode_local_record(purpose, id, value)?);
    let sealed = seal_envelope(subkeys, Kind::LocalRecord, &name, &payload, Compression::None, rng)?;
    Ok((name, sealed))
}

/// Opens a local record stored under `name`, and recomputes the name from the framed purpose and id: a record
/// moved to another name is `corrupt` (it would not even decrypt, since the name selects the key).
pub fn open_local_record(subkeys: &Subkeys, name: &str, bytes: &[u8]) -> Result<OpenedLocalRecord> {
    let payload = open_envelope(subkeys, Kind::LocalRecord, name, bytes)?;
    let record = decode_local_record(&payload)?;
    let expected = local_name(subkeys, record.purpose, record.id).map_err(|_| Error::Corrupt("local record"))?;
    if !ct_eq(expected.as_bytes(), name.as_bytes()) {
        return Err(Error::Corrupt("local record name differs from its purpose and id"));
    }
    Ok(OpenedLocalRecord {
        purpose: record.purpose.to_owned(),
        id: record.id.to_owned(),
        value: Zeroizing::new(record.value.to_vec()),
    })
}

/// An opened segment or checkpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedStream {
    /// Segment or checkpoint, from the name.
    pub kind: StreamKind,
    /// The checked header.
    pub header: StreamHeader,
    /// The Yjs v2 update, zeroed on drop.
    pub update: Zeroizing<Vec<u8>>,
}

/// The checks of spec/FORMAT.md section 9.1 that need the keys: the header's `doc` has the name's `stag`, its
/// `device` is the name's `dtag` and its `seq` the name's `seq`; `corrupt` otherwise.
pub fn check_stream_header(subkeys: &Subkeys, name: &ParsedName, header: &StreamHeader) -> Result<()> {
    let (stag, dtag, seq) = match name {
        ParsedName::Segment { stag, dtag, seq, .. } | ParsedName::Checkpoint { stag, dtag, seq, .. } => {
            (stag, dtag, *seq)
        }
        _ => return Err(Error::InvalidInput("not a segment or checkpoint name")),
    };
    // The recomputed stag is a secret-derived name: compared in constant time (spec/FORMAT.md section 2).
    let stag_matches = ct_eq(doc_tag(subkeys, header.doc).as_bytes(), stag.as_bytes());
    if !stag_matches || header.device != *dtag || header.seq != seq {
        return Err(Error::Corrupt("stream header does not match its name"));
    }
    Ok(())
}

/// Opens a segment or checkpoint by its remote name: the name must parse as one, the envelope must open with
/// the kind it implies, and the payload must frame and match the name.
pub fn open_stream(subkeys: &Subkeys, name: &str, bytes: &[u8]) -> Result<OpenedStream> {
    let parsed = parse_name(name).ok_or(Error::InvalidInput("not an object name"))?;
    let (kind, envelope_kind) = match parsed {
        ParsedName::Segment { .. } => (StreamKind::Segment, Kind::Segment),
        ParsedName::Checkpoint { .. } => (StreamKind::Checkpoint, Kind::Checkpoint),
        _ => return Err(Error::InvalidInput("not a segment or checkpoint name")),
    };
    let payload = open_envelope(subkeys, envelope_kind, name, bytes)?;
    let decoded = decode_stream_payload(kind, &payload)?;
    check_stream_header(subkeys, &parsed, &decoded.header)?;
    Ok(OpenedStream {
        kind,
        header: decoded.header,
        update: Zeroizing::new(decoded.update.to_vec()),
    })
}
