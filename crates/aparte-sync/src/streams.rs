//! Segments and checkpoints as objects (spec/FORMAT.md sections 8.4, 8.5, 9.1 and 9.2): the document tags both ways,
//! and the updates a document is made of in the object mirror of this device.

use std::collections::{BTreeMap, HashMap};

use aparte_crypto::Subkeys;
use aparte_crypto::names::doc_tag;
use aparte_crypto::records::{OpenedStream, open_stream};
use aparte_format::names::{DocId, ParsedName, parse_name};
use aparte_store::RecordStore;
use zeroize::Zeroizing;

use crate::error::Result;

/// The `stag` of every document, both ways.
#[derive(Debug, Clone)]
pub struct DocTags {
    by_doc: BTreeMap<DocId, String>,
    by_tag: HashMap<String, DocId>,
}

impl DocTags {
    /// The tags of the 17 documents.
    pub fn new(subkeys: &Subkeys) -> DocTags {
        let by_doc: BTreeMap<DocId, String> = DocId::ALL.iter().map(|&d| (d, doc_tag(subkeys, d))).collect();
        let by_tag = by_doc.iter().map(|(d, t)| (t.clone(), *d)).collect();
        DocTags { by_doc, by_tag }
    }

    /// The tag of a document.
    pub fn tag(&self, doc: DocId) -> &str {
        self.by_doc.get(&doc).map_or("", String::as_str)
    }

    /// The document of a tag, or `None` for a tag of no document of this vault.
    pub fn doc(&self, stag: &str) -> Option<DocId> {
        self.by_tag.get(stag).copied()
    }
}

/// A segment or checkpoint name, parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamName {
    /// Whether it is a checkpoint.
    pub checkpoint: bool,
    /// The document tag.
    pub stag: String,
    /// The device tag.
    pub dtag: String,
    /// The sequence number.
    pub seq: u64,
}

/// The parsed name when `name` is a segment or a checkpoint.
pub fn stream_name(name: &str) -> Option<StreamName> {
    match parse_name(name)? {
        ParsedName::Segment { stag, dtag, seq, .. } => Some(StreamName {
            checkpoint: false,
            stag,
            dtag,
            seq,
        }),
        ParsedName::Checkpoint { stag, dtag, seq, .. } => Some(StreamName {
            checkpoint: true,
            stag,
            dtag,
            seq,
        }),
        _ => None,
    }
}

/// Opens a segment or checkpoint read under `name` (envelope, payload, then the header against the name).
pub fn open(subkeys: &Subkeys, name: &str, bytes: &[u8]) -> Result<OpenedStream> {
    Ok(open_stream(subkeys, name, bytes)?)
}

/// The updates of a document held in the object mirror: every checkpoint, then every segment a checkpoint does not
/// cover. An object that does not open is skipped (the mirror holds only authenticated objects; this keeps one
/// damaged file from closing a whole document).
pub fn mirrored_updates(store: &RecordStore, tags: &DocTags, doc: DocId) -> Result<Vec<Zeroizing<Vec<u8>>>> {
    let names = store.object_names(&format!("d/{}/", tags.tag(doc)))?;
    let streams: Vec<(String, StreamName)> = names
        .into_iter()
        .filter_map(|n| stream_name(&n).map(|s| (n, s)))
        .collect();
    let mut covered: HashMap<String, u64> = HashMap::new();
    let mut out = Vec::new();
    for pass_checkpoints in [true, false] {
        for (name, parsed) in &streams {
            if parsed.checkpoint != pass_checkpoints {
                continue;
            }
            if !pass_checkpoints && parsed.seq <= covered.get(&parsed.dtag).copied().unwrap_or(0) {
                continue;
            }
            let Some(bytes) = store.get_object(name)? else {
                continue;
            };
            let Ok(opened) = open(store.subkeys(), name, &bytes) else {
                continue;
            };
            for (dtag, &seq) in opened.header.covers.iter().flatten() {
                let entry = covered.entry(dtag.clone()).or_insert(0);
                *entry = (*entry).max(seq);
            }
            out.push(opened.update);
        }
    }
    Ok(out)
}
