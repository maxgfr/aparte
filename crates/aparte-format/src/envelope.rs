//! The envelope layout of spec/FORMAT.md section 7, without the cipher: the header, the padded plaintext, and the
//! deflate-raw stream. The crypto crate seals and opens envelopes with these pieces, in the order section 7.5 fixes.

use std::io::Write as _;

use flate2::{Compression, Decompress, FlushDecompress, Status, write::DeflateEncoder};

use crate::error::{Error, Result};
use crate::padme::padded_size;

/// `APT1`, the first four bytes of every envelope.
pub const MAGIC: [u8; 4] = *b"APT1";
/// The only envelope version of `aparte/1`.
pub const VERSION: u8 = 1;
/// The only key epoch of `aparte/1`; the byte is reserved for key rotation.
pub const EPOCH: u8 = 0;
/// Header size: magic, version, kind, flags, epoch, IV.
pub const HEADER_LEN: usize = 20;
/// AES-GCM IV size.
pub const IV_LEN: usize = 12;
/// AES-GCM tag size.
pub const TAG_LEN: usize = 16;
/// The shortest envelope: a header, the 64-byte minimum plaintext and a tag.
pub const MIN_ENVELOPE_LEN: usize = 100;
/// The largest payload, stored or inflated: `2^26` bytes (64 MiB).
pub const MAX_PAYLOAD: usize = 1 << 26;
/// The largest blob chunk: 2 MiB of plaintext.
pub const MAX_CHUNK: usize = 2_097_152;
/// Flag bit 0: the payload is a deflate-raw stream.
pub const FLAG_DEFLATE: u8 = 0x01;

/// The object an envelope holds (spec/FORMAT.md section 7.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    /// 1: a segment, keyed by `K_obj(name)`.
    Segment,
    /// 2: a checkpoint, keyed by `K_obj(name)`.
    Checkpoint,
    /// 3: a blob chunk, keyed by `K_obj(name)`.
    Chunk,
    /// 4: a blob manifest, keyed by `K_obj(name)`.
    Manifest,
    /// 5: a secret version, keyed by `K_obj(name)`.
    SecretVersion,
    /// 6: a local record, keyed by `K_local(name)`.
    LocalRecord,
}

impl Kind {
    /// Every kind, in byte order.
    pub const ALL: [Self; 6] = [
        Self::Segment,
        Self::Checkpoint,
        Self::Chunk,
        Self::Manifest,
        Self::SecretVersion,
        Self::LocalRecord,
    ];

    /// The header byte of this kind.
    pub const fn byte(self) -> u8 {
        match self {
            Self::Segment => 1,
            Self::Checkpoint => 2,
            Self::Chunk => 3,
            Self::Manifest => 4,
            Self::SecretVersion => 5,
            Self::LocalRecord => 6,
        }
    }

    /// The kind of a header byte, or `None` outside 1 to 6.
    pub const fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            1 => Some(Self::Segment),
            2 => Some(Self::Checkpoint),
            3 => Some(Self::Chunk),
            4 => Some(Self::Manifest),
            5 => Some(Self::SecretVersion),
            6 => Some(Self::LocalRecord),
            _ => None,
        }
    }

    /// Whether the deflate flag is allowed: segments and checkpoints only.
    pub const fn allows_compression(self) -> bool {
        matches!(self, Self::Segment | Self::Checkpoint)
    }

    /// Whether the envelope is keyed by `K_local(name)` rather than `K_obj(name)`.
    pub const fn is_local(self) -> bool {
        matches!(self, Self::LocalRecord)
    }
}

/// A parsed envelope header; the version and the epoch are the only values `aparte/1` accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    /// What the envelope holds.
    pub kind: Kind,
    /// Bit 0 set: the payload is a deflate-raw stream.
    pub flags: u8,
    /// The AES-GCM IV.
    pub iv: [u8; IV_LEN],
}

impl Header {
    /// The 20 header bytes, which are also the start of the AAD.
    pub fn to_bytes(&self) -> [u8; HEADER_LEN] {
        let mut out = [0u8; HEADER_LEN];
        out[..4].copy_from_slice(&MAGIC);
        out[4] = VERSION;
        out[5] = self.kind.byte();
        out[6] = self.flags;
        out[7] = EPOCH;
        out[8..].copy_from_slice(&self.iv);
        out
    }

    /// Whether the payload is a deflate-raw stream.
    pub const fn is_compressed(&self) -> bool {
        self.flags & FLAG_DEFLATE != 0
    }
}

/// The structural checks of spec/FORMAT.md section 7.5, steps 1 to 6, in that order and without decrypting.
/// With `expected` set, step 4 also requires the kind the object name implies.
pub fn parse_header(bytes: &[u8], expected: Option<Kind>) -> Result<Header> {
    if bytes.len() < MIN_ENVELOPE_LEN {
        return Err(Error::Corrupt("envelope shorter than 100 bytes"));
    }
    if bytes[..4] != MAGIC {
        return Err(Error::Corrupt("envelope magic"));
    }
    if bytes[4] != VERSION {
        return Err(Error::UnsupportedFormat("envelope version"));
    }
    let kind = Kind::from_byte(bytes[5]).ok_or(Error::Corrupt("envelope kind"))?;
    if expected.is_some_and(|e| e != kind) {
        return Err(Error::Corrupt("envelope of another kind"));
    }
    let flags = bytes[6];
    if flags & !FLAG_DEFLATE != 0 || (flags & FLAG_DEFLATE != 0 && !kind.allows_compression()) {
        return Err(Error::Corrupt("envelope flags"));
    }
    if bytes[7] != EPOCH {
        return Err(Error::UnsupportedFormat("envelope key epoch"));
    }
    let mut iv = [0u8; IV_LEN];
    iv.copy_from_slice(&bytes[8..HEADER_LEN]);
    Ok(Header { kind, flags, iv })
}

/// The additional data of an envelope: `header || vaultId || name` (spec/FORMAT.md section 7.3).
pub fn envelope_aad(header: &[u8; HEADER_LEN], vault_id: &[u8; 16], name: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(HEADER_LEN + 16 + name.len());
    aad.extend_from_slice(header);
    aad.extend_from_slice(vault_id);
    aad.extend_from_slice(name.as_bytes());
    aad
}

/// The padded plaintext of a stored payload: `u32be(n) || payload' || zeros` up to `max(64, padme(4 + n))`.
/// `invalid-input` above [`MAX_PAYLOAD`].
pub fn pad_plaintext(stored: &[u8]) -> Result<Vec<u8>> {
    if stored.len() > MAX_PAYLOAD {
        return Err(Error::InvalidInput("payload above 2^26 bytes"));
    }
    // The bound above keeps both conversions exact.
    let n = stored.len() as u32;
    let size = padded_size(n) as usize;
    let mut plaintext = Vec::with_capacity(size);
    plaintext.extend_from_slice(&n.to_be_bytes());
    plaintext.extend_from_slice(stored);
    plaintext.resize(size, 0);
    Ok(plaintext)
}

/// Steps 8 to 10 of spec/FORMAT.md section 7.5 on an authenticated plaintext: the length fits, the size is the
/// canonical padded size, and every padding byte is zero. Returns the stored payload (still compressed if it was).
pub fn unpad_plaintext(plaintext: &[u8]) -> Result<&[u8]> {
    let size = plaintext.len();
    let Some(prefix) = plaintext.first_chunk::<4>() else {
        return Err(Error::Corrupt("plaintext shorter than its length prefix"));
    };
    let n = u32::from_be_bytes(*prefix);
    let n_usize = n as usize;
    if n_usize > size - 4 || n_usize > MAX_PAYLOAD {
        return Err(Error::Corrupt("payload length beyond the plaintext"));
    }
    if padded_size(n) != size as u64 {
        return Err(Error::Corrupt("plaintext size is not the padded size of its payload"));
    }
    let (stored, padding) = plaintext[4..].split_at(n_usize);
    if padding.iter().any(|&b| b != 0) {
        return Err(Error::Corrupt("non-zero padding"));
    }
    Ok(stored)
}

/// `deflate-raw(data)`: an RFC 1951 stream without a zlib or gzip wrapper. The bytes depend on the library, so
/// nothing in the format is derived from them (spec/FORMAT.md section 7.6).
pub fn deflate_raw(data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = DeflateEncoder::new(Vec::with_capacity(data.len() / 2 + 64), Compression::default());
    encoder
        .write_all(data)
        .map_err(|_| Error::InvalidState("deflate failed"))?;
    encoder.finish().map_err(|_| Error::InvalidState("deflate failed"))
}

/// Inflates a complete deflate-raw stream (step 11 of spec/FORMAT.md section 7.5): the stream must end, nothing may
/// follow it, and the output must stay within `limit` bytes; `corrupt` otherwise. Memory stays bounded by `limit`
/// whatever the input claims.
pub fn inflate_raw(data: &[u8], limit: usize) -> Result<Vec<u8>> {
    let mut inflater = Decompress::new(false);
    let mut out: Vec<u8> = Vec::with_capacity(data.len().saturating_mul(4).clamp(64, limit.saturating_add(1)));
    loop {
        if out.len() == out.capacity() {
            // One byte past the limit is enough to know the stream is too large.
            let room = limit.saturating_add(1).saturating_sub(out.len());
            if room == 0 {
                return Err(Error::Corrupt("inflated payload above the limit"));
            }
            out.reserve_exact(out.len().max(4096).min(room));
        }
        let consumed = usize::try_from(inflater.total_in()).map_err(|_| Error::Corrupt("deflate stream"))?;
        let before = (inflater.total_in(), inflater.total_out());
        let status = inflater
            .decompress_vec(&data[consumed..], &mut out, FlushDecompress::None)
            .map_err(|_| Error::Corrupt("invalid deflate stream"))?;
        if out.len() > limit {
            return Err(Error::Corrupt("inflated payload above the limit"));
        }
        match status {
            Status::StreamEnd => break,
            Status::Ok | Status::BufError => {
                let stalled = before == (inflater.total_in(), inflater.total_out());
                if stalled && out.len() < out.capacity() {
                    // No progress with room to write: the input ended before the stream did.
                    return Err(Error::Corrupt("truncated deflate stream"));
                }
            }
        }
    }
    if inflater.total_in() != data.len() as u64 {
        return Err(Error::Corrupt("data after the deflate stream"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::encoding::from_hex;

    fn envelope(kind: u8, flags: u8, epoch: u8) -> Vec<u8> {
        let mut bytes = vec![0u8; 108];
        bytes[..4].copy_from_slice(&MAGIC);
        bytes[4] = VERSION;
        bytes[5] = kind;
        bytes[6] = flags;
        bytes[7] = epoch;
        bytes
    }

    #[test]
    fn header_round_trip_and_layout() {
        let header = Header {
            kind: Kind::Segment,
            flags: 0,
            iv: core::array::from_fn(|i| 0xa0 + i as u8),
        };
        let bytes = header.to_bytes();
        assert_eq!(to_hex_slice(&bytes), "4150543101010000a0a1a2a3a4a5a6a7a8a9aaab");
        let mut full = bytes.to_vec();
        full.resize(108, 0);
        assert_eq!(parse_header(&full, Some(Kind::Segment)).unwrap(), header);
        assert_eq!(parse_header(&full, None).unwrap(), header);
    }

    fn to_hex_slice(bytes: &[u8]) -> String {
        crate::encoding::to_hex(bytes)
    }

    #[test]
    fn header_checks_run_in_the_spec_order() {
        assert_eq!(parse_header(&[0; 99], None).unwrap_err().code().as_str(), "corrupt");
        let mut bad_magic = envelope(1, 0, 0);
        bad_magic[0] ^= 1;
        // A bad magic wins over a bad version: step 2 comes before step 3.
        bad_magic[4] = 2;
        assert_eq!(parse_header(&bad_magic, None).unwrap_err().code().as_str(), "corrupt");
        assert_eq!(parse_header(&envelope(1, 0, 0)[..], None).unwrap().kind, Kind::Segment);
        let mut version = envelope(7, 2, 1);
        version[4] = 2;
        assert_eq!(
            parse_header(&version, None).unwrap_err().code().as_str(),
            "unsupported-format"
        );
        assert_eq!(
            parse_header(&envelope(0, 0, 0), None).unwrap_err().code().as_str(),
            "corrupt"
        );
        assert_eq!(
            parse_header(&envelope(7, 0, 0), None).unwrap_err().code().as_str(),
            "corrupt"
        );
        assert_eq!(
            parse_header(&envelope(2, 0, 0), Some(Kind::Segment))
                .unwrap_err()
                .code()
                .as_str(),
            "corrupt"
        );
        assert_eq!(
            parse_header(&envelope(1, 2, 0), None).unwrap_err().code().as_str(),
            "corrupt"
        );
        assert_eq!(
            parse_header(&envelope(3, 1, 0), None).unwrap_err().code().as_str(),
            "corrupt"
        );
        assert!(parse_header(&envelope(2, 1, 0), None).unwrap().is_compressed());
        // A bad flag wins over a bad epoch: step 5 comes before step 6.
        assert_eq!(
            parse_header(&envelope(1, 0x80, 1), None).unwrap_err().code().as_str(),
            "corrupt"
        );
        assert_eq!(
            parse_header(&envelope(1, 0, 1), None).unwrap_err().code().as_str(),
            "unsupported-format"
        );
    }

    #[test]
    fn padding_edges() {
        assert_eq!(pad_plaintext(&[]).unwrap().len(), 64);
        assert_eq!(pad_plaintext(&[7; 60]).unwrap().len(), 64);
        assert_eq!(pad_plaintext(&[7; 61]).unwrap().len(), 72);
        let p = pad_plaintext(&[7; 62]).unwrap();
        assert_eq!(&p[..4], &[0, 0, 0, 0x3e]);
        assert_eq!(p.len(), 72);
        assert!(p[66..].iter().all(|&b| b == 0));
        assert_eq!(unpad_plaintext(&p).unwrap(), &[7; 62]);
        assert_eq!(
            pad_plaintext(&vec![0; MAX_PAYLOAD + 1]).unwrap_err().code().as_str(),
            "invalid-input"
        );
    }

    #[test]
    fn unpad_rejects_non_canonical_plaintexts() {
        // The raw tamper plaintexts of spec/vectors/inputs.json.
        let non_zero = from_hex(&format!("00000004deadbeef{}01", "00".repeat(55))).unwrap();
        let beyond = from_hex(&format!("0000003d{}", "00".repeat(60))).unwrap();
        let excess = from_hex(&format!("00000004deadbeef{}", "00".repeat(64))).unwrap();
        for plaintext in [non_zero, beyond, excess, vec![0, 0, 0], vec![0xff; 64]] {
            assert_eq!(unpad_plaintext(&plaintext).unwrap_err().code().as_str(), "corrupt");
        }
    }

    #[test]
    fn inflate_checks_completeness_trailing_data_and_size() {
        let stream = from_hex("4b2c482c2a49d53754284e4dcf4dcd2b5148ca4fa954481c151da1a200").unwrap();
        let inflated = inflate_raw(&stream, MAX_PAYLOAD).unwrap();
        assert_eq!(inflated, b"aparte/1 segment body ".repeat(24));
        assert_eq!(inflate_raw(&stream, inflated.len()).unwrap(), inflated);
        assert!(inflate_raw(&stream, inflated.len() - 1).is_err());
        assert!(inflate_raw(&stream[..stream.len() - 1], MAX_PAYLOAD).is_err());
        let mut trailing = stream.clone();
        trailing.push(0);
        assert!(inflate_raw(&trailing, MAX_PAYLOAD).is_err());
        assert!(inflate_raw(&[0xff, 0xff, 0xff, 0xff], MAX_PAYLOAD).is_err());
        assert!(inflate_raw(&[], MAX_PAYLOAD).is_err());
    }

    #[test]
    fn inflate_stops_a_bomb_at_the_limit() {
        let bomb = deflate_raw(&vec![0; MAX_PAYLOAD + 1]).unwrap();
        assert!(bomb.len() < 100_000);
        assert_eq!(inflate_raw(&bomb, MAX_PAYLOAD).unwrap_err().code().as_str(), "corrupt");
    }

    proptest! {
        #[test]
        fn pad_and_unpad_round_trip(stored in proptest::collection::vec(any::<u8>(), 0..3000)) {
            let plaintext = pad_plaintext(&stored).unwrap();
            prop_assert_eq!(plaintext.len() as u64, padded_size(stored.len() as u32));
            prop_assert_eq!(unpad_plaintext(&plaintext).unwrap(), &stored[..]);
        }

        #[test]
        fn deflate_and_inflate_round_trip(data in proptest::collection::vec(0u8..4, 0..5000)) {
            let stream = deflate_raw(&data).unwrap();
            prop_assert_eq!(inflate_raw(&stream, MAX_PAYLOAD).unwrap(), data);
        }

        #[test]
        fn header_parse_accepts_only_what_to_bytes_writes(bytes in proptest::collection::vec(any::<u8>(), 100..120)) {
            if let Ok(header) = parse_header(&bytes, None) {
                prop_assert_eq!(&header.to_bytes()[..], &bytes[..HEADER_LEN]);
            }
        }
    }
}
