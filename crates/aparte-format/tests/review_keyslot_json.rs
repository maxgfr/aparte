//! Review: TypeScript is the reference (CLAUDE.md, spec/FORMAT.md section 15) and both readers must reach the same
//! verdict on the same bytes. serde_json refuses valid JSON that JSON.parse accepts: a number that overflows f64
//! (`1e400`) and nesting deeper than 128 levels. Inside `kdf` both are a broken rule of section 6.3 (a number out of
//! bounds, an extra member), so the web reports `unsupported-keyslot` at step 2 while the CLI reports `corrupt` at
//! step 1 ("not JSON").

use aparte_format::keyslot::Keyslot;

const CANONICAL: &str = "{\"format\":\"aparte/1\",\"type\":\"keyslot\",\"vault\":\"6dy7f47u6x3pp6hz7l57z7p674\",\
\"slot\":\"ceirceirceirceirceirceirce\",\"kind\":\"passphrase\",\"kdf\":{\"alg\":\"argon2id\",\"v\":19,\"m\":19456,\
\"t\":2,\"p\":1,\"salt\":\"IiIiIiIiIiIiIiIiIiIiIg\",\"secretKey\":true},\
\"commit\":\"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\",\"wrap\":{\"iv\":\"MzMzMzMzMzMzMzMz\",\
\"ct\":\"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC\"},\
\"mkCheck\":\"AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM\"}\n";

fn code(text: &str) -> &'static str {
    Keyslot::parse(text.as_bytes(), None).unwrap_err().code().as_str()
}

#[test]
fn the_base_file_parses() {
    assert!(Keyslot::parse(CANONICAL.as_bytes(), None).is_ok());
}

#[test]
fn a_kdf_number_beyond_f64_is_out_of_bounds_as_on_the_web() {
    // JSON.parse gives Infinity; keyslot.ts reports "m out of bounds" (unsupported-keyslot).
    let text = CANONICAL.replace("\"m\":19456", "\"m\":1e400");
    assert_eq!(code(&text), "unsupported-keyslot");
}

#[test]
fn a_deeply_nested_extra_kdf_member_is_unsupported_as_on_the_web() {
    // JSON.parse accepts 200 levels; keyslot.ts reports "members missing or extra" (unsupported-keyslot).
    let nested = format!("{}{}", "[".repeat(200), "]".repeat(200));
    let text = CANONICAL.replace("\"secretKey\":true", &format!("\"secretKey\":true,\"x\":{nested}"));
    assert_eq!(code(&text), "unsupported-keyslot");
}
