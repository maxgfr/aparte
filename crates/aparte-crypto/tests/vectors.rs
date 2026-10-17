//! The committed vectors of spec/vectors (written by the TypeScript reference) read back by this implementation:
//! every sealed envelope opens to its payload, every tamper case fails with its error, every keyslot file parses and
//! opens, every malicious file is refused, and every name, key and encoding is the one recomputed here.

use aparte_crypto::envelope::open_envelope;
use aparte_crypto::keys::{Purpose, Subkeys};
use aparte_crypto::keyslot::{SlotSecret, open_keyslot};
use aparte_crypto::names::{chunk_id, device_tag, doc_tag, local_name, manifest_id, shard_of};
use aparte_crypto::text::{format_recovery_key, format_secret_key, parse_recovery_key, parse_secret_key};
use aparte_format::encoding::{base32_decode, base32_encode, base64url_decode, base64url_encode, from_hex, to_hex};
use aparte_format::envelope::Kind;
use aparte_format::keyslot::Keyslot;
use aparte_format::names::DocId;
use aparte_format::padme::{padded_size, padme};
use serde_json::Value;

fn load(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn hex(value: &Value) -> Vec<u8> {
    from_hex(value.as_str().unwrap()).unwrap()
}

fn list<'a>(value: &'a Value, key: &str) -> &'a Vec<Value> {
    value[key].as_array().unwrap()
}

fn inputs() -> Value {
    load(include_str!("../../../spec/vectors/inputs.json"))
}

fn subkeys(inputs: &Value, vault: &[u8]) -> Subkeys {
    Subkeys::derive(&hex(&inputs["mk"]).try_into().unwrap(), &vault.try_into().unwrap())
}

#[test]
fn keys() {
    let (inputs, keys) = (inputs(), load(include_str!("../../../spec/vectors/keys.json")));
    let subkeys = subkeys(&inputs, &hex(&keys["vaultId"]));
    assert_eq!(keys["vault"], base32_encode(&hex(&keys["vaultId"])));
    for purpose in Purpose::ALL {
        assert_eq!(keys["subkeys"][purpose.as_str()], to_hex(subkeys.expose(purpose)));
    }
    assert_eq!(keys["mkCheck"], to_hex(&subkeys.master_key_check()));
    for entry in list(&keys, "objectKeys") {
        assert_eq!(
            entry["key"],
            to_hex(&*subkeys.object_key(entry["name"].as_str().unwrap()))
        );
    }
    for entry in list(&keys, "localKeys") {
        assert_eq!(
            entry["key"],
            to_hex(&*subkeys.local_key(entry["name"].as_str().unwrap()))
        );
    }
}

#[test]
fn envelopes_open_and_tamper_cases_fail() {
    let (inputs, file) = (inputs(), load(include_str!("../../../spec/vectors/envelopes.json")));
    let keys = subkeys(&inputs, &hex(&inputs["vaultId"]));
    let envelopes = list(&file, "envelopes");
    assert_eq!(envelopes.len(), list(&inputs, "envelopes").len());
    for case in envelopes {
        let kind = Kind::from_byte(u8::try_from(case["kind"].as_u64().unwrap()).unwrap()).unwrap();
        let opened = open_envelope(&keys, kind, case["name"].as_str().unwrap(), &hex(&case["sealed"])).unwrap();
        assert_eq!(to_hex(&opened), case["payload"].as_str().unwrap(), "{}", case["id"]);
        assert_eq!(hex(&case["sealed"])[..20], hex(&case["header"])[..]);
    }
    let tamper = list(&file, "tamper");
    assert_eq!(tamper.len(), list(&inputs["tamper"], "cases").len());
    for case in tamper {
        let kind = Kind::from_byte(u8::try_from(case["kind"].as_u64().unwrap()).unwrap()).unwrap();
        let keys = subkeys(&inputs, &hex(&case["vaultId"]));
        let error = open_envelope(&keys, kind, case["name"].as_str().unwrap(), &hex(&case["bytes"])).unwrap_err();
        assert_eq!(error.code().as_str(), case["error"].as_str().unwrap(), "{}", case["id"]);
    }
}

#[test]
fn keyslots_parse_and_open_and_malicious_files_are_refused() {
    let (inputs, file) = (inputs(), load(include_str!("../../../spec/vectors/keyslots.json")));
    let vault: [u8; 16] = hex(&inputs["vaultId"]).try_into().unwrap();
    let mk = hex(&inputs["mk"]);
    let sk: [u8; 16] = hex(&inputs["secretKey"]).try_into().unwrap();
    let recovery: [u8; 32] = hex(&inputs["recoveryKey"]).try_into().unwrap();
    for (case, input) in list(&file, "keyslots").iter().zip(list(&inputs, "keyslots")) {
        let slot = Keyslot::parse(&hex(&case["file"]), Some(case["name"].as_str().unwrap())).unwrap();
        assert_eq!(slot.serialize(), hex(&case["file"]));
        assert_eq!(slot.aad(), hex(&case["aad"]));
        assert_eq!(to_hex(&slot.commit), case["commit"].as_str().unwrap());
        let prf: [u8; 32];
        let secret = match input["kind"].as_str().unwrap() {
            "passphrase" => SlotSecret::Passphrase {
                passphrase: inputs["passphrases"][input["passphrase"].as_str().unwrap()]
                    .as_str()
                    .unwrap(),
                secret_key: (input["secretKey"] == true).then_some(&sk),
            },
            "recovery" => SlotSecret::Recovery { key: &recovery },
            _ => {
                prf = hex(&input["prfOutput"]).try_into().unwrap();
                SlotSecret::Passkey { prf_output: &prf }
            }
        };
        assert_eq!(
            &open_keyslot(&slot, &secret, &vault, None).unwrap()[..],
            &mk[..],
            "{}",
            case["id"]
        );
    }
    for case in list(&file, "malicious") {
        let error = Keyslot::parse(&hex(&case["file"]), None).unwrap_err();
        assert_eq!(error.code().as_str(), case["error"].as_str().unwrap(), "{}", case["id"]);
    }
    let texts = list(&file, "texts");
    assert_eq!(texts.len(), list(&inputs["keyslotTexts"], "cases").len());
    for case in texts {
        let error = Keyslot::parse(&hex(&case["file"]), None).unwrap_err();
        assert_eq!(error.code().as_str(), case["error"].as_str().unwrap(), "{}", case["id"]);
    }
    assert_eq!(file["secretKeyText"], format_secret_key(&sk));
    assert_eq!(*parse_secret_key(file["secretKeyText"].as_str().unwrap()).unwrap(), sk);
    assert_eq!(file["recoveryKeyText"], format_recovery_key(&recovery));
    assert_eq!(
        *parse_recovery_key(file["recoveryKeyText"].as_str().unwrap()).unwrap(),
        recovery
    );
}

#[test]
fn names() {
    let (inputs, file) = (inputs(), load(include_str!("../../../spec/vectors/names.json")));
    let keys = subkeys(&inputs, &hex(&inputs["vaultId"]));
    for case in list(&file, "devices") {
        assert_eq!(
            case["dtag"],
            device_tag(&keys, &hex(&case["deviceId"]).try_into().unwrap())
        );
    }
    for case in list(&file, "docs") {
        assert_eq!(
            case["stag"],
            doc_tag(&keys, DocId::parse(case["docId"].as_str().unwrap()).unwrap())
        );
    }
    for case in list(&file, "shards") {
        assert_eq!(
            case["shard"],
            shard_of(&keys, &hex(&case["convId"]).try_into().unwrap()).as_str()
        );
    }
    for (case, chunk) in list(&file, "chunks").iter().zip(list(&inputs["names"], "chunks")) {
        assert_eq!(case["id"], chunk_id(&keys, &hex(chunk)));
    }
    for (case, manifest) in list(&file, "manifests").iter().zip(list(&inputs["names"], "manifests")) {
        assert_eq!(case["id"], manifest_id(&keys, manifest.as_str().unwrap().as_bytes()));
    }
    for case in list(&file, "local") {
        let name = local_name(&keys, case["purpose"].as_str().unwrap(), case["id"].as_str().unwrap()).unwrap();
        assert_eq!(case["name"], name);
    }
}

#[test]
fn padme_and_text() {
    let padme_file = load(include_str!("../../../spec/vectors/padme.json"));
    for case in list(&padme_file, "padme") {
        let length = u32::try_from(case["length"].as_u64().unwrap()).unwrap();
        assert_eq!(case["padme"], padme(length));
        assert_eq!(case["paddedSize"], padded_size(length));
    }
    let text = load(include_str!("../../../spec/vectors/text.json"));
    for case in list(&text, "base32") {
        assert_eq!(case["text"], base32_encode(&hex(&case["hex"])));
        assert_eq!(
            base32_decode(case["text"].as_str().unwrap()).unwrap(),
            hex(&case["hex"])
        );
    }
    for case in list(&text, "base64url") {
        assert_eq!(case["text"], base64url_encode(&hex(&case["hex"])));
        assert_eq!(
            base64url_decode(case["text"].as_str().unwrap()).unwrap(),
            hex(&case["hex"])
        );
    }
    for (key, decode) in [
        (
            "base32Invalid",
            base32_decode as fn(&str) -> aparte_crypto::Result<Vec<u8>>,
        ),
        ("base64urlInvalid", base64url_decode),
    ] {
        for case in list(&text, key) {
            let error = decode(case["text"].as_str().unwrap()).unwrap_err();
            assert_eq!(error.code().as_str(), case["error"].as_str().unwrap());
        }
    }
}
