//! Padmé padding (Nikitin et al., PETS 2019), spec/FORMAT.md section 7.4.

/// The smallest envelope plaintext: a short object is padded up to this size.
pub const MIN_PLAINTEXT: u64 = 64;

/// `padme(L)` on 64-bit lengths below `2^62`, where neither the rounding nor the result can overflow.
const fn padme64(length: u64) -> u64 {
    if length < 2 {
        return length;
    }
    // E = floor(log2(L)), S = floor(log2(E)) + 1 (the bit length of E), z = E - S.
    let e = 63 - length.leading_zeros();
    let s = 32 - e.leading_zeros();
    let mask = (1u64 << (e - s)) - 1;
    (length + mask) & !mask
}

/// `padme(L)`: `L` rounded up so that only `O(log log L)` bits of it remain, adding at most about 12 %.
pub const fn padme(length: u32) -> u64 {
    padme64(length as u64)
}

/// The envelope plaintext size for a stored payload of `payload_length` bytes: `max(64, padme(4 + n))`.
pub const fn padded_size(payload_length: u32) -> u64 {
    let padded = padme64(4 + payload_length as u64);
    if padded < MIN_PLAINTEXT { MIN_PLAINTEXT } else { padded }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::{padded_size, padme};

    #[test]
    fn known_values() {
        // Computed from the definition in spec/FORMAT.md section 7.4, independently of the implementation.
        let table: [(u32, u64); 38] = [
            (0, 0),
            (1, 1),
            (2, 2),
            (3, 3),
            (4, 4),
            (5, 5),
            (7, 7),
            (8, 8),
            (9, 10),
            (15, 16),
            (16, 16),
            (17, 18),
            (31, 32),
            (32, 32),
            (33, 36),
            (63, 64),
            (64, 64),
            (65, 72),
            (66, 72),
            (100, 104),
            (127, 128),
            (128, 128),
            (129, 144),
            (255, 256),
            (256, 256),
            (257, 272),
            (1000, 1024),
            (1023, 1024),
            (1024, 1024),
            (1025, 1088),
            (4096, 4096),
            (65535, 65536),
            (65536, 65536),
            (65537, 67584),
            (1_000_000, 1_015_808),
            (2_097_152, 2_097_152),
            (2_097_156, 2_162_688),
            (2_097_157, 2_162_688),
        ];
        for (length, padded) in table {
            assert_eq!(padme(length), padded, "padme({length})");
        }
        assert_eq!(padme(u32::MAX), 1 << 32);
    }

    #[test]
    fn padded_sizes() {
        for (payload, size) in [
            (0, 64),
            (60, 64),
            (61, 72),
            (62, 72),
            (1000, 1024),
            (2_097_152, 2_162_688),
        ] {
            assert_eq!(padded_size(payload), size, "paddedSize({payload})");
        }
        // 4 + n does not overflow: the sum is computed on 64 bits.
        assert_eq!(padded_size(u32::MAX), (1 << 32) + (1 << 26));
    }

    proptest! {
        #[test]
        fn never_shrinks_adds_at_most_an_eighth_and_is_idempotent(a in 0u32..(1 << 30), b in 0u32..(1 << 30)) {
            let pa = padme(a);
            prop_assert!(pa >= u64::from(a));
            prop_assert!((pa - u64::from(a)) * 8 <= u64::from(a));
            prop_assert_eq!(padme(u32::try_from(pa).unwrap()), pa);
            if a <= b {
                prop_assert!(pa <= padme(b));
            }
        }

        #[test]
        fn padded_size_is_max_64_padme_4_plus_n(n in 0u32..=(1 << 26)) {
            prop_assert_eq!(padded_size(n), padme(4 + n).max(64));
        }
    }
}
