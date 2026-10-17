//! Review of name handling in the Rust crypto crate against spec/FORMAT.md and the TypeScript reference.
//!
//! 1. Section 9.6 / 11.3: a local record id is 0 to 1024 bytes. names.ts `localName` refuses a longer id
//!    (`invalid-input`); `local_name` derives a name for it.
//! 2. Sections 7.3 / 8: names are printable ASCII of a strict grammar. keys.ts `nameBytes` refuses anything outside
//!    `[\x21-\x7e]+` (an empty name, a space such as a sync client's `x 2`, a control character); `seal_envelope` and
//!    `open_envelope` only check `is_ascii`, so they key and authenticate objects under names the web refuses.
//! 3. Section 2: every comparison of a recomputed name MUST run in constant time. `check_stream_header` compares the
//!    recomputed `stag` with `!=`, an early-exit comparison, while `open_local_record` uses `ct_eq`.

use aparte_crypto::names::local_name;
use aparte_crypto::{Compression, OsRng, Subkeys, seal_envelope};
use aparte_format::envelope::Kind;

fn subkeys() -> Subkeys {
    Subkeys::derive(&[7u8; 32], &[0xf0; 16])
}

#[test]
fn a_local_record_id_above_1024_bytes_has_no_name() {
    let keys = subkeys();
    assert!(local_name(&keys, "draft", &"i".repeat(1024)).is_ok());
    let result = local_name(&keys, "draft", &"i".repeat(1025));
    assert_eq!(result.unwrap_err().code().as_str(), "invalid-input");
}

#[test]
fn an_envelope_name_outside_printable_ascii_is_refused() {
    let keys = subkeys();
    for name in ["", "x 2", "b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa\n", "\u{7f}"] {
        let result = seal_envelope(&keys, Kind::Chunk, name, &[1, 2, 3], Compression::None, &mut OsRng);
        assert_eq!(
            result.map(|_| ()).unwrap_err().code().as_str(),
            "invalid-input",
            "{name:?} is not a printable ASCII name"
        );
    }
}

#[test]
fn the_recomputed_stream_tag_is_compared_in_constant_time() {
    let source = include_str!("../src/records.rs");
    assert!(
        !source.contains("doc_tag(subkeys, header.doc) != *stag"),
        "check_stream_header compares the recomputed stag with an early-exit `!=`"
    );
}
