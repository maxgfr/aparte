//! Object names of spec/FORMAT.md section 8 that need no key: the document ids, the strict grammar of section 8.8,
//! and the assembly of a name from its tags. The tags themselves are keyed hashes, computed by the crypto crate.

use std::fmt;

use crate::encoding::{base32_decode_array, base32_encode, is_base32_chars};
use crate::error::{Error, Result};

/// The name of the format marker object.
pub const FMT_NAME: &str = "fmt/1";
/// The bytes of the format marker object: `aparte/1\n`.
pub const FMT_BYTES: &[u8] = b"aparte/1\n";
/// The largest sequence number: ten decimal digits.
pub const MAX_SEQ: u64 = 9_999_999_999;
/// Characters of a document, device or secret tag.
pub const TAG_LEN: usize = 16;
/// Characters of a name suffix `r8`.
pub const SUFFIX_LEN: usize = 8;
/// Characters of a blob chunk or manifest id, and of a local record name.
pub const ID_LEN: usize = 26;

const DOC_IDS: [&str; 17] = [
    "index", "c00", "c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08", "c09", "c10", "c11", "c12", "c13", "c14",
    "c15",
];

/// One of the 17 synced documents: `index`, or a conversation shard `c00` to `c15` (spec/DATA-MODEL.md section 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DocId(u8);

impl DocId {
    /// The index document.
    pub const INDEX: Self = Self(0);

    /// Every document, `index` first.
    pub const ALL: [Self; 17] = {
        let mut all = [Self(0); 17];
        let mut i = 0;
        while i < 17 {
            all[i] = Self(i as u8);
            i += 1;
        }
        all
    };

    /// The shard document `c<nn>`, for `n` in 0 to 15.
    pub const fn shard(n: u8) -> Option<Self> {
        if n < 16 { Some(Self(n + 1)) } else { None }
    }

    /// The shard number, or `None` for the index.
    pub const fn shard_number(self) -> Option<u8> {
        if self.0 == 0 { None } else { Some(self.0 - 1) }
    }

    /// The ASCII document id.
    pub const fn as_str(self) -> &'static str {
        DOC_IDS[self.0 as usize]
    }

    /// The document with this exact id, or `None`.
    pub fn parse(text: &str) -> Option<Self> {
        DOC_IDS.iter().position(|&d| d == text).map(|i| Self(i as u8))
    }
}

impl fmt::Display for DocId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A remote object name, parsed strictly (spec/FORMAT.md section 8.8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedName {
    /// `fmt/1`.
    Fmt,
    /// `keys/<slot>.json`.
    Keyslot {
        /// The 26-character base32 slot id.
        slot: String,
    },
    /// `d/<stag>/s/<dtag>/<bucket7>/<seq10>-<r8>`.
    Segment {
        /// The document tag.
        stag: String,
        /// The device tag.
        dtag: String,
        /// The sequence number.
        seq: u64,
        /// The content suffix.
        r: String,
    },
    /// `d/<stag>/c/<dtag>/<seq10>-<r8>`.
    Checkpoint {
        /// The document tag.
        stag: String,
        /// The device tag.
        dtag: String,
        /// The last own segment the checkpoint covers.
        seq: u64,
        /// The content suffix.
        r: String,
    },
    /// `b/<h2>/<bid>`.
    Chunk {
        /// The 26-character chunk id.
        id: String,
    },
    /// `m/<h2>/<mid>`.
    Manifest {
        /// The 26-character manifest id.
        id: String,
    },
    /// `k/<ktag>/<seq10>-<r8>`.
    Secret {
        /// The secret tag.
        ktag: String,
        /// The version number.
        seq: u64,
        /// The content suffix.
        r: String,
    },
}

/// `seq10`: exactly ten digits; `invalid-input` outside 1 to [`MAX_SEQ`].
pub fn seq10(seq: u64) -> Result<String> {
    check_seq(seq)?;
    Ok(format!("{seq:010}"))
}

/// `bucket7 = floor(seq / 1000)` in seven digits; `invalid-input` outside 1 to [`MAX_SEQ`].
pub fn bucket7(seq: u64) -> Result<String> {
    check_seq(seq)?;
    Ok(format!("{:07}", seq / 1000))
}

/// `invalid-input` unless `1 <= seq <= MAX_SEQ`.
pub fn check_seq(seq: u64) -> Result<()> {
    if (1..=MAX_SEQ).contains(&seq) {
        Ok(())
    } else {
        Err(Error::InvalidInput("sequence number out of range"))
    }
}

fn is_tag(text: &str, len: usize) -> bool {
    text.len() == len && is_base32_chars(text)
}

/// Whether `text` is a 16-character tag of the base32 alphabet (a `dtag`, `stag` or `ktag`).
pub fn is_tag16(text: &str) -> bool {
    is_tag(text, TAG_LEN)
}

/// Whether `text` is a 26-character id of the base32 alphabet (a chunk or manifest id, a local record name).
pub fn is_id26(text: &str) -> bool {
    is_tag(text, ID_LEN)
}

fn check_tag(text: &str, len: usize) -> Result<()> {
    if is_tag(text, len) {
        Ok(())
    } else {
        Err(Error::InvalidInput("not a tag of the base32 alphabet"))
    }
}

/// `keys/<slotId b32>.json`.
pub fn keyslot_name(slot_id: &[u8; 16]) -> String {
    format!("keys/{}.json", base32_encode(slot_id))
}

/// `d/<stag>/s/<dtag>/<bucket7>/<seq10>-<r8>` from its parts.
pub fn segment_name(stag: &str, dtag: &str, seq: u64, r8: &str) -> Result<String> {
    check_tag(stag, TAG_LEN)?;
    check_tag(dtag, TAG_LEN)?;
    check_tag(r8, SUFFIX_LEN)?;
    Ok(format!("d/{stag}/s/{dtag}/{}/{}-{r8}", bucket7(seq)?, seq10(seq)?))
}

/// `d/<stag>/c/<dtag>/<seq10>-<r8>` from its parts.
pub fn checkpoint_name(stag: &str, dtag: &str, seq: u64, r8: &str) -> Result<String> {
    check_tag(stag, TAG_LEN)?;
    check_tag(dtag, TAG_LEN)?;
    check_tag(r8, SUFFIX_LEN)?;
    Ok(format!("d/{stag}/c/{dtag}/{}-{r8}", seq10(seq)?))
}

/// `k/<ktag>/<seq10>-<r8>` from its parts.
pub fn secret_version_name(ktag: &str, seq: u64, r8: &str) -> Result<String> {
    check_tag(ktag, TAG_LEN)?;
    check_tag(r8, SUFFIX_LEN)?;
    Ok(format!("k/{ktag}/{}-{r8}", seq10(seq)?))
}

/// `b/<h2>/<bid>`; `invalid-input` unless `id` is 26 characters of the base32 alphabet.
pub fn chunk_name(id: &str) -> Result<String> {
    check_tag(id, ID_LEN)?;
    Ok(format!("b/{}/{id}", &id[..2]))
}

/// `m/<h2>/<mid>`; `invalid-input` unless `id` is 26 characters of the base32 alphabet.
pub fn manifest_name(id: &str) -> Result<String> {
    check_tag(id, ID_LEN)?;
    Ok(format!("m/{}/{id}", &id[..2]))
}

/// Exactly `n` ASCII digits, as a number.
fn digits(text: &str, n: usize) -> Option<u64> {
    (text.len() == n && text.bytes().all(|c| c.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// `<seq10>-<r8>` with a sequence number of at least 1.
fn seq_and_suffix(text: &str) -> Option<(u64, String)> {
    let (seq, r) = text.split_once('-')?;
    let seq = digits(seq, 10).filter(|&s| s >= 1)?;
    is_tag(r, SUFFIX_LEN).then(|| (seq, r.to_owned()))
}

/// Parses a remote object name strictly; `None` for anything that is not exactly one of the forms of
/// spec/FORMAT.md section 8.8 (an uppercase letter, an extra directory, a renamed copy such as `x 2`, a bucket that
/// does not match the sequence number, a sequence number of 0, a blob directory that does not repeat its id).
pub fn parse_name(name: &str) -> Option<ParsedName> {
    if name == FMT_NAME {
        return Some(ParsedName::Fmt);
    }
    let parts: Vec<&str> = name.split('/').collect();
    match parts.as_slice() {
        ["keys", file] => {
            let slot = file.strip_suffix(".json")?;
            // The slot is the strict base32 of 16 bytes, so its last character carries zero low bits.
            base32_decode_array::<16>(slot).ok()?;
            Some(ParsedName::Keyslot { slot: slot.to_owned() })
        }
        ["d", stag, "s", dtag, bucket, last] if is_tag16(stag) && is_tag16(dtag) => {
            let bucket = digits(bucket, 7)?;
            let (seq, r) = seq_and_suffix(last)?;
            (bucket == seq / 1000).then(|| ParsedName::Segment {
                stag: (*stag).to_owned(),
                dtag: (*dtag).to_owned(),
                seq,
                r,
            })
        }
        ["d", stag, "c", dtag, last] if is_tag16(stag) && is_tag16(dtag) => {
            let (seq, r) = seq_and_suffix(last)?;
            Some(ParsedName::Checkpoint {
                stag: (*stag).to_owned(),
                dtag: (*dtag).to_owned(),
                seq,
                r,
            })
        }
        ["b", h2, id] if is_id26(id) && id[..2] == **h2 => Some(ParsedName::Chunk { id: (*id).to_owned() }),
        ["m", h2, id] if is_id26(id) && id[..2] == **h2 => Some(ParsedName::Manifest { id: (*id).to_owned() }),
        ["k", ktag, last] if is_tag16(ktag) => {
            let (seq, r) = seq_and_suffix(last)?;
            Some(ParsedName::Secret {
                ktag: (*ktag).to_owned(),
                seq,
                r,
            })
        }
        _ => None,
    }
}

/// `unsupported-format` unless `bytes` is exactly the `fmt/1` marker `aparte/1\n` (spec/FORMAT.md section 8.1).
pub fn check_format_marker(bytes: &[u8]) -> Result<()> {
    if bytes == FMT_BYTES {
        Ok(())
    } else {
        Err(Error::UnsupportedFormat("not an aparte/1 store"))
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    const STAG: &str = "aaaaaaaaaaaaaaaa";
    const DTAG: &str = "bbbbbbbbbbbbbbbb";

    #[test]
    fn doc_ids() {
        assert_eq!(DocId::INDEX.as_str(), "index");
        assert_eq!(DocId::shard(7).unwrap().as_str(), "c07");
        assert_eq!(DocId::shard(15).unwrap().as_str(), "c15");
        assert!(DocId::shard(16).is_none());
        assert_eq!(DocId::parse("c03"), DocId::shard(3));
        assert_eq!(DocId::parse("c3"), None);
        assert_eq!(DocId::parse("Index"), None);
        assert_eq!(DocId::ALL.iter().map(|d| d.as_str()).collect::<Vec<_>>(), DOC_IDS);
        assert_eq!(DocId::shard(4).unwrap().shard_number(), Some(4));
        assert_eq!(DocId::INDEX.shard_number(), None);
    }

    #[test]
    fn sequence_formatting() {
        assert_eq!(seq10(42).unwrap(), "0000000042");
        assert_eq!(bucket7(1).unwrap(), "0000000");
        assert_eq!(bucket7(999).unwrap(), "0000000");
        assert_eq!(bucket7(1000).unwrap(), "0000001");
        assert_eq!(bucket7(1_234_567).unwrap(), "0001234");
        assert_eq!(bucket7(MAX_SEQ).unwrap(), "9999999");
        assert!(seq10(0).is_err());
        assert!(seq10(MAX_SEQ + 1).is_err());
    }

    #[test]
    fn names_from_parts_parse_back() {
        let segment = segment_name(STAG, DTAG, 1, "cccccccc").unwrap();
        assert_eq!(
            segment,
            "d/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc"
        );
        assert_eq!(
            parse_name(&segment),
            Some(ParsedName::Segment {
                stag: STAG.into(),
                dtag: DTAG.into(),
                seq: 1,
                r: "cccccccc".into()
            })
        );
        let checkpoint = checkpoint_name(STAG, DTAG, 2, "eeeeeeee").unwrap();
        assert_eq!(checkpoint, "d/aaaaaaaaaaaaaaaa/c/bbbbbbbbbbbbbbbb/0000000002-eeeeeeee");
        assert!(matches!(
            parse_name(&checkpoint),
            Some(ParsedName::Checkpoint { seq: 2, .. })
        ));
        let secret = secret_version_name("iiiiiiiiiiiiiiii", 1, "jjjjjjjj").unwrap();
        assert_eq!(secret, "k/iiiiiiiiiiiiiiii/0000000001-jjjjjjjj");
        assert!(matches!(parse_name(&secret), Some(ParsedName::Secret { seq: 1, .. })));
        let id = "gggggggggggggggggggggggggg";
        assert_eq!(chunk_name(id).unwrap(), "b/gg/gggggggggggggggggggggggggg");
        assert_eq!(
            parse_name(&chunk_name(id).unwrap()),
            Some(ParsedName::Chunk { id: id.into() })
        );
        assert_eq!(manifest_name(id).unwrap(), "m/gg/gggggggggggggggggggggggggg");
        assert_eq!(
            parse_name(&manifest_name(id).unwrap()),
            Some(ParsedName::Manifest { id: id.into() })
        );
        assert!(chunk_name("short").is_err());
        assert!(segment_name("AAAAAAAAAAAAAAAA", DTAG, 1, "cccccccc").is_err());
        assert!(segment_name(STAG, DTAG, 0, "cccccccc").is_err());
    }

    #[test]
    fn keyslot_and_marker_names() {
        assert_eq!(keyslot_name(&[0x11; 16]), "keys/ceirceirceirceirceirceirce.json");
        assert_eq!(
            parse_name("keys/ceirceirceirceirceirceirce.json"),
            Some(ParsedName::Keyslot {
                slot: "ceirceirceirceirceirceirce".into()
            })
        );
        assert_eq!(parse_name("fmt/1"), Some(ParsedName::Fmt));
        assert!(check_format_marker(b"aparte/1\n").is_ok());
        for bad in [&b"aparte/1"[..], b"aparte/2\n", b"aparte/1\n\n", b""] {
            assert_eq!(
                check_format_marker(bad).unwrap_err().code().as_str(),
                "unsupported-format"
            );
        }
    }

    #[test]
    fn parse_name_is_strict() {
        let cases = [
            String::new(),
            "fmt/2".into(),
            "fmt/1/".into(),
            format!("d/{STAG}/s/{DTAG}/0000000/0000000001-ccccccc"),
            format!("d/{STAG}/s/{DTAG}/0000000/0000000001-cccccccc/x"),
            format!("d/{STAG}/s/{DTAG}/0000001/0000000001-cccccccc"),
            format!("d/{STAG}/s/{DTAG}/0000000/0000000000-cccccccc"),
            format!("d/{}/s/{DTAG}/0000000/0000000001-cccccccc", STAG.to_uppercase()),
            format!("d/{STAG}/s/{DTAG}/0000000/0000000001-cccccccc 2"),
            format!("d/{STAG}/x/{DTAG}/0000000/0000000001-cccccccc"),
            format!("d/{STAG}/c/{DTAG}/0000000/0000000001-cccccccc"),
            format!("d/{STAG}/c/{DTAG}/0000000000-cccccccc"),
            format!("d/{STAG}/s/{DTAG}/000000/0000000001-cccccccc"),
            format!("d/{STAG}/s/{DTAG}/0000000/+000000001-cccccccc"),
            "b/ab/bbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            "b/bb/bbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            "m/bb/bbbbbbbbbbbbbbbbbbbbbbbbb1".into(),
            "k/iiiiiiiiiiiiiiii/0000000000-jjjjjjjj".into(),
            "keys/ceirceirceirceirceirceirc.json".into(),
            "keys/ceirceirceirceirceirceircf.json".into(),
            "keys/CEIRCEIRCEIRCEIRCEIRCEIRCE.json".into(),
            "keys/ceirceirceirceirceirceirce.JSON".into(),
            "/fmt/1".into(),
            "keys/sub/ceirceirceirceirceirceirce.json".into(),
        ];
        for name in cases {
            assert_eq!(parse_name(&name), None, "{name:?}");
        }
    }

    proptest! {
        #[test]
        fn every_built_segment_name_is_lowercase_and_parses_back(
            stag in "[a-z2-7]{16}", dtag in "[a-z2-7]{16}", seq in 1..=MAX_SEQ, r in "[a-z2-7]{8}",
        ) {
            let name = segment_name(&stag, &dtag, seq, &r).unwrap();
            prop_assert_eq!(name.to_lowercase(), name.clone());
            prop_assert_eq!(parse_name(&name), Some(ParsedName::Segment { stag, dtag, seq, r }));
        }

        #[test]
        fn parse_name_never_panics_and_accepts_only_canonical_names(name in "[a-z0-9/.: -]{0,80}") {
            if let Some(parsed) = parse_name(&name) {
                let rebuilt = match parsed {
                    ParsedName::Fmt => FMT_NAME.to_owned(),
                    ParsedName::Keyslot { slot } => format!("keys/{slot}.json"),
                    ParsedName::Segment { stag, dtag, seq, r } => segment_name(&stag, &dtag, seq, &r).unwrap(),
                    ParsedName::Checkpoint { stag, dtag, seq, r } => checkpoint_name(&stag, &dtag, seq, &r).unwrap(),
                    ParsedName::Chunk { id } => chunk_name(&id).unwrap(),
                    ParsedName::Manifest { id } => manifest_name(&id).unwrap(),
                    ParsedName::Secret { ktag, seq, r } => secret_version_name(&ktag, seq, &r).unwrap(),
                };
                prop_assert_eq!(rebuilt, name);
            }
        }
    }
}
