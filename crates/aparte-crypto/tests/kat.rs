//! Published known answers for the primitives the format is built on (spec/kat): RFC 5869 (HKDF-SHA256), RFC 4231
//! (HMAC-SHA256), Wycheproof (AES-256-GCM) and RFC 9106 plus the Argon2 reference tests (Argon2id). If a primitive
//! or the wrapper around it drifts, these fail before any vector does.

use aparte_crypto::argon2::{Argon2Input, argon2id};
use aparte_crypto::primitives::{aes_gcm_decrypt, aes_gcm_encrypt, hkdf_sha256, hmac_sha256};
use aparte_format::encoding::{from_hex, to_hex};
use serde_json::Value;

fn kat(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn hex(value: &Value) -> Vec<u8> {
    from_hex(value.as_str().unwrap()).unwrap()
}

fn tests(value: &Value) -> &Vec<Value> {
    value["tests"].as_array().unwrap()
}

fn ids(value: &Value) -> Vec<u64> {
    tests(value).iter().map(|t| t["tcId"].as_u64().unwrap()).collect()
}

#[test]
fn hkdf_sha256_rfc5869() {
    let file = kat(include_str!("../../../spec/kat/hkdf-sha256.json"));
    assert_eq!(file["source"], "https://www.rfc-editor.org/rfc/rfc5869.txt");
    assert_eq!(ids(&file), [1, 2, 3]);
    for case in tests(&file) {
        let length = usize::try_from(case["length"].as_u64().unwrap()).unwrap();
        let okm = hkdf_sha256(&hex(&case["ikm"]), &hex(&case["salt"]), &hex(&case["info"]), length).unwrap();
        assert_eq!(to_hex(&okm), case["okm"].as_str().unwrap(), "case {}", case["tcId"]);
        // PRK = HMAC(salt, IKM), with the RFC 5869 rule that an empty salt is 32 zero bytes.
        let salt = hex(&case["salt"]);
        let salt = if salt.is_empty() { vec![0; 32] } else { salt };
        assert_eq!(
            to_hex(&hmac_sha256(&salt, &[&hex(&case["ikm"])])),
            case["prk"].as_str().unwrap()
        );
    }
}

#[test]
fn hmac_sha256_rfc4231() {
    let file = kat(include_str!("../../../spec/kat/hmac-sha256.json"));
    assert_eq!(file["source"], "https://www.rfc-editor.org/rfc/rfc4231.txt");
    assert_eq!(ids(&file), [1, 2, 3, 4, 5, 6, 7]);
    for case in tests(&file) {
        let mac = to_hex(&hmac_sha256(&hex(&case["key"]), &[&hex(&case["data"])]));
        let expected = case["mac"].as_str().unwrap();
        match case["truncateBytes"].as_u64() {
            Some(n) => assert_eq!(&mac[..usize::try_from(n).unwrap() * 2], expected),
            None => assert_eq!(mac, expected, "case {}", case["tcId"]),
        }
    }
}

#[test]
fn aes_256_gcm_wycheproof() {
    let file = kat(include_str!("../../../spec/kat/aes-256-gcm.json"));
    assert!(
        file["source"]
            .as_str()
            .unwrap()
            .contains("wycheproof/main/testvectors_v1/aes_gcm_test.json")
    );
    assert_eq!([&file["keySize"], &file["ivSize"], &file["tagSize"]], [256, 96, 128]);
    let (mut valid, mut invalid) = (0, 0);
    for case in tests(&file) {
        let key: [u8; 32] = hex(&case["key"]).try_into().unwrap();
        let iv: [u8; 12] = hex(&case["iv"]).try_into().unwrap();
        let sealed = [hex(&case["ct"]), hex(&case["tag"])].concat();
        let aad = hex(&case["aad"]);
        let id = &case["tcId"];
        match case["result"].as_str().unwrap() {
            "valid" => {
                valid += 1;
                assert_eq!(
                    aes_gcm_encrypt(&key, &iv, &hex(&case["msg"]), &aad).unwrap(),
                    sealed,
                    "case {id}"
                );
                assert_eq!(
                    &aes_gcm_decrypt(&key, &iv, &sealed, &aad).unwrap()[..],
                    &hex(&case["msg"])[..]
                );
            }
            "invalid" => {
                invalid += 1;
                let error = aes_gcm_decrypt(&key, &iv, &sealed, &aad).unwrap_err();
                assert_eq!(error.code().as_str(), "tampered", "case {id}");
            }
            other => panic!("unknown result {other}"),
        }
    }
    assert!(valid + invalid >= 30 && valid > 0 && invalid > 0);
}

fn argon2_case(case: &Value) {
    let u32_of = |name: &str| u32::try_from(case[name].as_u64().unwrap()).unwrap();
    assert_eq!(case["version"], 19);
    let (password, salt) = (hex(&case["password"]), hex(&case["salt"]));
    let secret = case.get("secret").map(hex).unwrap_or_default();
    let ad = case.get("ad").map(hex).unwrap_or_default();
    let input = Argon2Input {
        password: &password,
        salt: &salt,
        m: u32_of("memoryKiB"),
        t: u32_of("passes"),
        p: u32_of("parallelism"),
        length: usize::try_from(case["tagLength"].as_u64().unwrap()).unwrap(),
        secret: &secret,
        ad: &ad,
    };
    assert_eq!(
        to_hex(&argon2id(&input).unwrap()),
        case["tag"].as_str().unwrap(),
        "case {}",
        case["tcId"]
    );
}

#[test]
fn argon2id_rfc9106_with_secret_and_associated_data() {
    let file = kat(include_str!("../../../spec/kat/argon2id.json"));
    assert_eq!(file["rfc9106"]["source"], "https://www.rfc-editor.org/rfc/rfc9106.txt");
    for case in tests(&file["rfc9106"]) {
        argon2_case(case);
    }
}

#[test]
fn argon2id_reference_implementation_cases() {
    let file = kat(include_str!("../../../spec/kat/argon2id.json"));
    assert!(
        file["reference"]["source"]
            .as_str()
            .unwrap()
            .contains("phc-winner-argon2")
    );
    assert_eq!(ids(&file["reference"]), [1, 2, 3, 4, 5, 6, 7, 8]);
    for case in tests(&file["reference"]) {
        argon2_case(case);
    }
}
