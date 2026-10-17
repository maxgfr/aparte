//! Payload framing of spec/FORMAT.md section 9: segment and checkpoint payloads, blob manifests and local records.
//!
//! Writers produce the writer serialization of section 3.4 and readers accept only that form: a reader re-encodes
//! what it parsed and rejects any other bytes (`corrupt`), so both implementations agree on what a payload says.
//! Checks that need the vault keys (a header's `doc` against the name's `stag`, a record name against its
//! purpose and id) are done by the crypto crate on top of these.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::encoding::{MAX_SAFE_INTEGER, base64url_decode_array, base64url_encode, json_uint, push_json_string};
use crate::envelope::MAX_CHUNK;
use crate::error::{Error, Result};
use crate::names::{DocId, MAX_SEQ, is_id26, is_tag16};

/// The largest segment or checkpoint header, in bytes.
pub const MAX_HEADER_LEN: usize = 65536;
/// The largest local record id, in bytes.
pub const MAX_LOCAL_ID_LEN: usize = 1024;
/// The longest local record purpose.
pub const MAX_PURPOSE_LEN: usize = 32;

/// Whether the stream payload is a segment or a checkpoint (the checkpoint header adds `covers`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StreamKind {
    /// A segment: one Yjs update.
    Segment,
    /// A checkpoint: the full state of the document.
    Checkpoint,
}

/// The header of a segment or checkpoint payload (spec/FORMAT.md sections 9.1 and 9.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamHeader {
    /// The document.
    pub doc: DocId,
    /// The writer's `dtag`.
    pub device: String,
    /// This segment's sequence number, or the last own segment a checkpoint covers.
    pub seq: u64,
    /// The writer's clock in Unix milliseconds; informative only.
    pub time: u64,
    /// `dtag -> highest contiguous seq applied`, for every other device.
    pub seen: BTreeMap<String, u64>,
    /// Manifest ids the update references; written sorted and without duplicates.
    pub blobs: Vec<String>,
    /// Checkpoints only: `dtag -> seq` for every device, the writer included.
    pub covers: Option<BTreeMap<String, u64>>,
}

/// A decoded stream payload, borrowing the update from the payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamPayload<'a> {
    /// The parsed header.
    pub header: StreamHeader,
    /// The Yjs v2 update, non-empty.
    pub update: &'a [u8],
}

fn push_seq_map(out: &mut String, map: &BTreeMap<String, u64>) {
    out.push('{');
    for (i, (key, seq)) in map.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_json_string(out, key);
        out.push(':');
        out.push_str(&seq.to_string());
    }
    out.push('}');
}

impl StreamHeader {
    /// The schema of spec/FORMAT.md sections 9.1 and 9.2, beyond what the types enforce.
    fn check(&self, kind: StreamKind, error: fn(&'static str) -> Error) -> Result<()> {
        let seq_ok = |s: u64| (1..=MAX_SEQ).contains(&s);
        if !is_tag16(&self.device) {
            return Err(error("stream header device is not a dtag"));
        }
        if !seq_ok(self.seq) {
            return Err(error("stream header seq out of range"));
        }
        if self.time > MAX_SAFE_INTEGER {
            return Err(error("stream header time out of range"));
        }
        // seen lists the other devices only. A count of 0 (nothing contiguous from 1) is allowed in seen and covers.
        if self
            .seen
            .iter()
            .any(|(d, &s)| !is_tag16(d) || *d == self.device || s > MAX_SEQ)
        {
            return Err(error("stream header seen"));
        }
        if !self.blobs.iter().all(|b| is_id26(b)) || !self.blobs.windows(2).all(|w| w[0] < w[1]) {
            return Err(error("stream header blobs"));
        }
        match (&self.covers, kind) {
            (None, StreamKind::Segment) => Ok(()),
            (Some(covers), StreamKind::Checkpoint) => {
                if covers.iter().any(|(d, &s)| !is_tag16(d) || s > MAX_SEQ)
                    || covers.get(&self.device) != Some(&self.seq)
                {
                    return Err(error("checkpoint header covers"));
                }
                Ok(())
            }
            _ => Err(error("covers is present exactly in checkpoints")),
        }
    }

    /// The header JSON in writer order: `v`, `doc`, `device`, `seq`, `time`, `seen`, `blobs`, then `covers`.
    fn to_json(&self) -> String {
        let mut out = String::with_capacity(256);
        out.push_str("{\"v\":1,\"doc\":");
        push_json_string(&mut out, self.doc.as_str());
        out.push_str(",\"device\":");
        push_json_string(&mut out, &self.device);
        out.push_str(&format!(",\"seq\":{},\"time\":{},\"seen\":", self.seq, self.time));
        push_seq_map(&mut out, &self.seen);
        out.push_str(",\"blobs\":[");
        for (i, blob) in self.blobs.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            push_json_string(&mut out, blob);
        }
        out.push(']');
        if let Some(covers) = &self.covers {
            out.push_str(",\"covers\":");
            push_seq_map(&mut out, covers);
        }
        out.push('}');
        out
    }
}

/// `payload = u32be(hlen) || header || update` (spec/FORMAT.md section 9.1). The writer sorts and deduplicates
/// `blobs`; anything else outside the schema is `invalid-input`.
pub fn encode_stream_payload(kind: StreamKind, header: &StreamHeader, update: &[u8]) -> Result<Vec<u8>> {
    let mut header = header.clone();
    header.blobs.sort_unstable();
    header.blobs.dedup();
    header.check(kind, Error::InvalidInput)?;
    if update.is_empty() {
        return Err(Error::InvalidInput("empty update"));
    }
    let json = header.to_json();
    if json.len() > MAX_HEADER_LEN {
        return Err(Error::InvalidInput("stream header above 65536 bytes"));
    }
    let mut payload = Vec::with_capacity(4 + json.len() + update.len());
    // The bound above keeps the length within 32 bits.
    payload.extend_from_slice(&(json.len() as u32).to_be_bytes());
    payload.extend_from_slice(json.as_bytes());
    payload.extend_from_slice(update);
    Ok(payload)
}

fn seq_map(value: &Value) -> Option<BTreeMap<String, u64>> {
    value
        .as_object()?
        .iter()
        .map(|(k, v)| Some((k.clone(), json_uint(v)?)))
        .collect()
}

fn members<'a>(value: &'a Value, names: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    (object.len() == names.len() && names.iter().all(|n| object.contains_key(*n))).then_some(object)
}

/// Parses a segment or checkpoint payload strictly: `1 <= hlen <= 65536`, a non-empty update, exactly the header
/// members of the kind with their types, the schema rules, and the writer serialization; `corrupt` otherwise.
pub fn decode_stream_payload(kind: StreamKind, payload: &[u8]) -> Result<StreamPayload<'_>> {
    let corrupt = Error::Corrupt("stream header");
    let (prefix, rest) = payload
        .split_first_chunk::<4>()
        .ok_or(Error::Corrupt("stream payload too short"))?;
    let hlen = u32::from_be_bytes(*prefix) as usize;
    if hlen == 0 || hlen > MAX_HEADER_LEN || hlen >= rest.len() {
        return Err(Error::Corrupt("stream header length"));
    }
    let (json, update) = rest.split_at(hlen);
    let value: Value = serde_json::from_slice(json).map_err(|_| corrupt.clone())?;
    let names: &[&str] = match kind {
        StreamKind::Segment => &["v", "doc", "device", "seq", "time", "seen", "blobs"],
        StreamKind::Checkpoint => &["v", "doc", "device", "seq", "time", "seen", "blobs", "covers"],
    };
    let o = members(&value, names).ok_or_else(|| corrupt.clone())?;
    if json_uint(&o["v"]) != Some(1) {
        return Err(Error::Corrupt("stream header version"));
    }
    let header = StreamHeader {
        doc: o["doc"]
            .as_str()
            .and_then(DocId::parse)
            .ok_or_else(|| corrupt.clone())?,
        device: o["device"].as_str().ok_or_else(|| corrupt.clone())?.to_owned(),
        seq: json_uint(&o["seq"]).ok_or_else(|| corrupt.clone())?,
        time: json_uint(&o["time"]).ok_or_else(|| corrupt.clone())?,
        seen: seq_map(&o["seen"]).ok_or_else(|| corrupt.clone())?,
        blobs: o["blobs"]
            .as_array()
            .and_then(|a| a.iter().map(|b| b.as_str().map(str::to_owned)).collect())
            .ok_or_else(|| corrupt.clone())?,
        covers: match kind {
            StreamKind::Segment => None,
            StreamKind::Checkpoint => Some(seq_map(&o["covers"]).ok_or_else(|| corrupt.clone())?),
        },
    };
    header.check(kind, Error::Corrupt)?;
    if header.to_json().as_bytes() != json {
        return Err(Error::Corrupt("stream header is not in writer form"));
    }
    Ok(StreamPayload { header, update })
}

/// A blob manifest (spec/FORMAT.md section 9.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    /// The MIME type.
    pub mime: String,
    /// The total size of the file in bytes.
    pub size: u64,
    /// SHA-256 of the whole file.
    pub sha256: [u8; 32],
    /// The chunk ids (`bid`), in file order: `ceil(size / 2097152)` of them.
    pub chunks: Vec<String>,
    /// The file name, when known.
    pub name: Option<String>,
}

impl Manifest {
    fn check(&self, error: fn(&'static str) -> Error) -> Result<()> {
        if self.size > MAX_SAFE_INTEGER {
            return Err(error("manifest size out of range"));
        }
        if self.chunks.len() as u64 != self.size.div_ceil(MAX_CHUNK as u64) || !self.chunks.iter().all(|c| is_id26(c)) {
            return Err(error("manifest chunks"));
        }
        Ok(())
    }

    /// The manifest JSON in writer order: `v`, `type`, `size`, `sha256`, `chunks`, then `name` when present.
    fn to_json(&self) -> String {
        let mut out = String::with_capacity(128 + 29 * self.chunks.len());
        out.push_str("{\"v\":1,\"type\":");
        push_json_string(&mut out, &self.mime);
        out.push_str(&format!(
            ",\"size\":{},\"sha256\":\"{}\",\"chunks\":[",
            self.size,
            base64url_encode(&self.sha256)
        ));
        for (i, chunk) in self.chunks.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            push_json_string(&mut out, chunk);
        }
        out.push(']');
        if let Some(name) = &self.name {
            out.push_str(",\"name\":");
            push_json_string(&mut out, name);
        }
        out.push('}');
        out
    }

    /// The manifest bytes; `invalid-input` when the chunk count does not match the size.
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.check(Error::InvalidInput)?;
        Ok(self.to_json().into_bytes())
    }

    /// Parses manifest bytes strictly; `corrupt` for anything but the writer serialization of a valid manifest.
    /// The chunk ids and the file hash are verified by the reader once the chunks are fetched.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let corrupt = || Error::Corrupt("manifest");
        let value: Value = serde_json::from_slice(bytes).map_err(|_| corrupt())?;
        let o = members(&value, &["v", "type", "size", "sha256", "chunks", "name"])
            .or_else(|| members(&value, &["v", "type", "size", "sha256", "chunks"]))
            .ok_or_else(corrupt)?;
        if json_uint(&o["v"]) != Some(1) {
            return Err(Error::Corrupt("manifest version"));
        }
        let manifest = Self {
            mime: o["type"].as_str().ok_or_else(corrupt)?.to_owned(),
            size: json_uint(&o["size"]).ok_or_else(corrupt)?,
            sha256: o["sha256"]
                .as_str()
                .and_then(|s| base64url_decode_array(s).ok())
                .ok_or_else(corrupt)?,
            chunks: o["chunks"]
                .as_array()
                .and_then(|a| a.iter().map(|c| c.as_str().map(str::to_owned)).collect())
                .ok_or_else(corrupt)?,
            name: match o.get("name") {
                None => None,
                Some(name) => Some(name.as_str().ok_or_else(corrupt)?.to_owned()),
            },
        };
        manifest.check(Error::Corrupt)?;
        if manifest.to_json().as_bytes() != bytes {
            return Err(Error::Corrupt("manifest is not in writer form"));
        }
        Ok(manifest)
    }
}

/// Whether `purpose` matches `[a-z][a-z0-9-]{0,31}`.
pub fn is_purpose(purpose: &str) -> bool {
    let bytes = purpose.as_bytes();
    (1..=MAX_PURPOSE_LEN).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// A decoded local record payload (spec/FORMAT.md section 9.6), borrowing from the payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalRecord<'a> {
    /// The purpose, `[a-z][a-z0-9-]{0,31}`.
    pub purpose: &'a str,
    /// The record id, 0 to 1024 bytes of UTF-8.
    pub id: &'a str,
    /// The record's bytes.
    pub value: &'a [u8],
}

/// `payload = u8(len(purpose)) || purpose || u16be(len(id)) || id || value`; `invalid-input` for a purpose outside
/// `[a-z][a-z0-9-]{0,31}` or an id above 1024 bytes.
pub fn encode_local_record(purpose: &str, id: &str, value: &[u8]) -> Result<Vec<u8>> {
    if !is_purpose(purpose) {
        return Err(Error::InvalidInput("local record purpose"));
    }
    if id.len() > MAX_LOCAL_ID_LEN {
        return Err(Error::InvalidInput("local record id above 1024 bytes"));
    }
    let mut payload = Vec::with_capacity(3 + purpose.len() + id.len() + value.len());
    // Both bounds above keep the lengths within a byte and two bytes.
    payload.push(purpose.len() as u8);
    payload.extend_from_slice(purpose.as_bytes());
    payload.extend_from_slice(&(id.len() as u16).to_be_bytes());
    payload.extend_from_slice(id.as_bytes());
    payload.extend_from_slice(value);
    Ok(payload)
}

/// Parses a local record payload; `corrupt` for a bad purpose, an id that is not UTF-8 or above 1024 bytes, or a
/// length beyond the payload.
pub fn decode_local_record(payload: &[u8]) -> Result<LocalRecord<'_>> {
    let corrupt = || Error::Corrupt("local record framing");
    let (&plen, rest) = payload.split_first().ok_or_else(corrupt)?;
    let (purpose, rest) = rest.split_at_checked(usize::from(plen)).ok_or_else(corrupt)?;
    let (ilen, rest) = rest.split_first_chunk::<2>().ok_or_else(corrupt)?;
    let ilen = usize::from(u16::from_be_bytes(*ilen));
    let (id, value) = rest.split_at_checked(ilen).ok_or_else(corrupt)?;
    let purpose = std::str::from_utf8(purpose)
        .ok()
        .filter(|p| is_purpose(p))
        .ok_or_else(corrupt)?;
    let id = std::str::from_utf8(id)
        .ok()
        .filter(|i| i.len() <= MAX_LOCAL_ID_LEN)
        .ok_or_else(corrupt)?;
    Ok(LocalRecord { purpose, id, value })
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::encoding::{from_hex, to_hex};

    const A: &str = "aaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbb";

    fn segment_header() -> StreamHeader {
        StreamHeader {
            doc: DocId::shard(7).unwrap(),
            device: A.into(),
            seq: 3,
            time: 1_760_000_000_000,
            seen: [(B.to_owned(), 12), ("aaaaaaaaaaaaaaab".to_owned(), 4)].into(),
            blobs: vec!["zzzzzzzzzzzzzzzzzzzzzzzzzz".into(), "mmmmmmmmmmmmmmmmmmmmmmmmmm".into()],
            covers: None,
        }
    }

    #[test]
    fn segment_payload_is_writer_ordered_and_sorted() {
        let payload = encode_stream_payload(StreamKind::Segment, &segment_header(), &[0, 0, 2, 1]).unwrap();
        let json = r#"{"v":1,"doc":"c07","device":"aaaaaaaaaaaaaaaa","seq":3,"time":1760000000000,"seen":{"aaaaaaaaaaaaaaab":4,"bbbbbbbbbbbbbbbb":12},"blobs":["mmmmmmmmmmmmmmmmmmmmmmmmmm","zzzzzzzzzzzzzzzzzzzzzzzzzz"]}"#;
        assert_eq!(&payload[..4], &(json.len() as u32).to_be_bytes());
        assert_eq!(&payload[4..4 + json.len()], json.as_bytes());
        assert_eq!(&payload[4 + json.len()..], &[0, 0, 2, 1]);
        let decoded = decode_stream_payload(StreamKind::Segment, &payload).unwrap();
        let mut expected = segment_header();
        expected.blobs.sort();
        assert_eq!(
            decoded,
            StreamPayload {
                header: expected,
                update: &[0, 0, 2, 1]
            }
        );
        assert!(decode_stream_payload(StreamKind::Checkpoint, &payload).is_err());
    }

    #[test]
    fn checkpoint_payload_has_covers() {
        let header = StreamHeader {
            doc: DocId::INDEX,
            device: A.into(),
            seq: 7,
            time: 1_760_000_000_001,
            seen: [(B.to_owned(), 12)].into(),
            blobs: vec![],
            covers: Some([(B.to_owned(), 12), (A.to_owned(), 7)].into()),
        };
        let payload = encode_stream_payload(StreamKind::Checkpoint, &header, &[0, 0, 0x0a, 0x0b, 0x0c]).unwrap();
        let text = String::from_utf8_lossy(&payload[4..]).into_owned();
        assert!(text.starts_with(r#"{"v":1,"doc":"index","device":"aaaaaaaaaaaaaaaa","seq":7,"time":1760000000001,"seen":{"bbbbbbbbbbbbbbbb":12},"blobs":[],"covers":{"aaaaaaaaaaaaaaaa":7,"bbbbbbbbbbbbbbbb":12}}"#));
        assert_eq!(
            decode_stream_payload(StreamKind::Checkpoint, &payload).unwrap().header,
            header
        );
        let mut wrong = header.clone();
        wrong.covers = Some([(A.to_owned(), 6)].into());
        assert!(encode_stream_payload(StreamKind::Checkpoint, &wrong, &[1]).is_err());
        assert!(encode_stream_payload(StreamKind::Segment, &header, &[1]).is_err());
    }

    #[test]
    fn writer_refuses_headers_outside_the_schema() {
        let base = segment_header();
        let mut cases = vec![];
        let mut h = base.clone();
        h.device = "A".repeat(16);
        cases.push(h);
        let mut h = base.clone();
        h.seq = 0;
        cases.push(h);
        let mut h = base.clone();
        h.seen.insert(A.into(), 1);
        cases.push(h);
        let mut h = base.clone();
        h.blobs.push("short".into());
        cases.push(h);
        let mut h = base.clone();
        h.time = 1 << 53;
        cases.push(h);
        for header in cases {
            assert_eq!(
                encode_stream_payload(StreamKind::Segment, &header, &[1])
                    .unwrap_err()
                    .code()
                    .as_str(),
                "invalid-input"
            );
        }
        assert!(encode_stream_payload(StreamKind::Segment, &base, &[]).is_err());
    }

    #[test]
    fn reader_rejects_anything_but_the_writer_form() {
        let good = encode_stream_payload(StreamKind::Segment, &segment_header(), &[9]).unwrap();
        let json = std::str::from_utf8(&good[4..good.len() - 1]).unwrap().to_owned();
        let frame = |json: &str, update: &[u8]| {
            let mut p = (json.len() as u32).to_be_bytes().to_vec();
            p.extend_from_slice(json.as_bytes());
            p.extend_from_slice(update);
            p
        };
        let cases = [
            frame(&json, &[]),
            frame(&json.replace("\"v\":1", "\"v\":2"), &[9]),
            frame(&json.replace(",\"time\"", ", \"time\""), &[9]),
            frame(&json.replace("\"seq\":3", "\"seq\":\"3\""), &[9]),
            frame(&format!("{},\"extra\":1}}", &json[..json.len() - 1]), &[9]),
            frame(&json.replace("\"doc\":\"c07\"", "\"doc\":\"c16\""), &[9]),
            frame(
                &json.replace(
                    "\"aaaaaaaaaaaaaaab\":4,\"bbbbbbbbbbbbbbbb\":12",
                    "\"bbbbbbbbbbbbbbbb\":12,\"aaaaaaaaaaaaaaab\":4",
                ),
                &[9],
            ),
            frame(
                &json.replace(
                    "\"mmmmmmmmmmmmmmmmmmmmmmmmmm\",\"zzzzzzzzzzzzzzzzzzzzzzzzzz\"",
                    "\"zzzzzzzzzzzzzzzzzzzzzzzzzz\",\"mmmmmmmmmmmmmmmmmmmmmmmmmm\"",
                ),
                &[9],
            ),
            vec![0, 0, 0, 0, 1],
            vec![0, 0, 0],
            good[..good.len() - 1].to_vec(),
        ];
        for payload in cases {
            assert_eq!(
                decode_stream_payload(StreamKind::Segment, &payload)
                    .unwrap_err()
                    .code()
                    .as_str(),
                "corrupt",
                "{}",
                String::from_utf8_lossy(&payload)
            );
        }
    }

    #[test]
    fn manifest_of_the_vectors_round_trips() {
        let text = r#"{"v":1,"type":"image/jpeg","size":2097153,"sha256":"47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU","chunks":["aaaaaaaaaaaaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbbbbbbbbbbbb"],"name":"photo.jpg"}"#;
        let manifest = Manifest::decode(text.as_bytes()).unwrap();
        assert_eq!(manifest.size, 2_097_153);
        assert_eq!(manifest.chunks.len(), 2);
        assert_eq!(manifest.name.as_deref(), Some("photo.jpg"));
        assert_eq!(manifest.encode().unwrap(), text.as_bytes());
        let unnamed = Manifest {
            name: None,
            ..manifest.clone()
        };
        assert_eq!(Manifest::decode(&unnamed.encode().unwrap()).unwrap(), unnamed);
        let wrong_count = Manifest {
            size: 2_097_152,
            ..manifest.clone()
        };
        assert!(wrong_count.encode().is_err());
        let empty = Manifest {
            size: 0,
            chunks: vec![],
            ..manifest
        };
        assert_eq!(Manifest::decode(&empty.encode().unwrap()).unwrap(), empty);
        for bad in [
            text.replace("2097153", "2097152"),
            text.replace(",\"name\":\"photo.jpg\"", ",\"name\":null"),
            text.replace("\"v\":1,", "\"v\":1, "),
            text.replace("photo.jpg\"}", "photo.jpg\",\"x\":1}"),
        ] {
            assert_eq!(
                Manifest::decode(bad.as_bytes()).unwrap_err().code().as_str(),
                "corrupt",
                "{bad}"
            );
        }
    }

    #[test]
    fn local_record_of_the_vectors() {
        let payload =
            encode_local_record("device", "id", &from_hex("d0d1d2d3d4d5d6d7d8d9dadbdcdddedf").unwrap()).unwrap();
        assert_eq!(
            to_hex(&payload),
            "0664657669636500026964d0d1d2d3d4d5d6d7d8d9dadbdcdddedf"
        );
        let record = decode_local_record(&payload).unwrap();
        assert_eq!((record.purpose, record.id), ("device", "id"));
        assert_eq!(record.value.len(), 16);
    }

    #[test]
    fn local_record_purposes_and_ids() {
        for bad in ["", "Device", "a|b", "1abc", &"x".repeat(33), "with space", "-a"] {
            assert!(encode_local_record(bad, "id", b"").is_err(), "{bad:?}");
        }
        assert!(encode_local_record(&"x".repeat(32), "", b"").is_ok());
        assert!(encode_local_record("a", &"i".repeat(1025), b"").is_err());
        assert!(encode_local_record("a", &"i".repeat(1024), b"").is_ok());
        for bad in [
            &[][..],
            &[3, b'a'],
            &[1, b'A', 0, 0],
            &[1, b'a', 0],
            &[1, b'a', 0, 2, b'x'],
            &[1, b'a', 0, 1, 0xff],
        ] {
            assert_eq!(
                decode_local_record(bad).unwrap_err().code().as_str(),
                "corrupt",
                "{bad:?}"
            );
        }
        let long_id = [&[1, b'a', 0x04, 0x01][..], &[b'i'; 1025]].concat();
        assert!(decode_local_record(&long_id).is_err());
    }

    proptest! {
        #[test]
        fn local_records_round_trip(
            purpose in "[a-z][a-z0-9-]{0,31}",
            id in ".{0,64}",
            value in proptest::collection::vec(any::<u8>(), 0..64),
        ) {
            let payload = encode_local_record(&purpose, &id, &value).unwrap();
            let record = decode_local_record(&payload).unwrap();
            prop_assert_eq!(record, LocalRecord { purpose: &purpose, id: &id, value: &value });
        }

        #[test]
        fn stream_payloads_round_trip(
            shard in 0u8..16,
            device in "[a-z2-7]{16}",
            seq in 1u64..=MAX_SEQ,
            time in 0u64..=MAX_SAFE_INTEGER,
            seen in proptest::collection::btree_map("[a-z2-7]{16}", 0u64..=MAX_SEQ, 0..4),
            blobs in proptest::collection::vec("[a-z2-7]{26}", 0..4),
            update in proptest::collection::vec(any::<u8>(), 1..32),
        ) {
            let mut seen = seen;
            seen.remove(&device);
            let header = StreamHeader { doc: DocId::shard(shard).unwrap(), device, seq, time, seen, blobs, covers: None };
            let payload = encode_stream_payload(StreamKind::Segment, &header, &update).unwrap();
            let decoded = decode_stream_payload(StreamKind::Segment, &payload).unwrap();
            let mut expected = header;
            expected.blobs.sort();
            expected.blobs.dedup();
            prop_assert_eq!(decoded.header, expected);
            prop_assert_eq!(decoded.update, &update[..]);
        }
    }
}
