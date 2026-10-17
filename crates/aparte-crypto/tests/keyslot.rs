//! Keyslots of spec/FORMAT.md section 6 with the small Argon2 parameters of spec/vectors/inputs.json. The full
//! derivation is recomputed here from the primitives, so the keyslot module is pinned to the spec; then every
//! rejection path is checked, including that a hostile parameter never reaches Argon2.

use std::cell::Cell;

use aparte_crypto::Result;
use aparte_crypto::argon2::{Argon2Input, argon2id};
use aparte_crypto::keys::Subkeys;
use aparte_crypto::keyslot::{NewKeyslot, SlotSecret, create_keyslot, normalize_passphrase, open_keyslot};
use aparte_crypto::primitives::{aes_gcm_decrypt, hkdf_sha256, hmac_sha256};
use aparte_crypto::rng::{OsRng, QueueRng};
use aparte_format::encoding::{base32_encode, base64url_encode, canonical_json, from_hex};
use aparte_format::keyslot::{Argon2Params, DEFAULT_ARGON2, Kdf, Keyslot};
use serde_json::{Map, Value, json};
use zeroize::Zeroizing;

struct Fixture {
    inputs: Value,
    mk: [u8; 32],
    vault: [u8; 16],
    sk: [u8; 16],
    recovery: [u8; 32],
    params: Argon2Params,
}

fn hex(value: &Value) -> Vec<u8> {
    from_hex(value.as_str().unwrap()).unwrap()
}

fn fixture() -> Fixture {
    let inputs: Value = serde_json::from_str(include_str!("../../../spec/vectors/inputs.json")).unwrap();
    let u32_of = |name: &str| u32::try_from(inputs["argon2"][name].as_u64().unwrap()).unwrap();
    Fixture {
        mk: hex(&inputs["mk"]).try_into().unwrap(),
        vault: hex(&inputs["vaultId"]).try_into().unwrap(),
        sk: hex(&inputs["secretKey"]).try_into().unwrap(),
        recovery: hex(&inputs["recoveryKey"]).try_into().unwrap(),
        params: Argon2Params {
            m: u32_of("m"),
            t: u32_of("t"),
            p: u32_of("p"),
        },
        inputs,
    }
}

impl Fixture {
    fn case(&self, id: &str) -> &Value {
        self.inputs["keyslots"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap()
    }

    fn passphrase(&self, which: &str) -> &str {
        self.inputs["passphrases"][which].as_str().unwrap()
    }

    /// Creates the slot of a vector case with a queued RNG; returns it and the values left undrawn.
    fn create(&self, id: &str) -> (Keyslot, usize) {
        let c = self.case(id);
        let mut values = vec![hex(&c["slotId"])];
        if c["kind"] == "passphrase" {
            values.push(hex(&c["salt"]));
        }
        values.push(hex(&c["iv"]));
        let mut rng = QueueRng::new(values);
        let (credential, prf_output, prf_salt);
        let new = match c["kind"].as_str().unwrap() {
            "passphrase" => NewKeyslot::Passphrase {
                passphrase: self.passphrase(c["passphrase"].as_str().unwrap()),
                secret_key: c["secretKey"].as_bool().unwrap().then_some(&self.sk),
                params: self.params,
            },
            "recovery" => NewKeyslot::Recovery { key: &self.recovery },
            _ => {
                credential = hex(&c["credentialId"]);
                prf_output = <[u8; 32]>::try_from(hex(&c["prfOutput"])).unwrap();
                prf_salt = <[u8; 32]>::try_from(hex(&c["prfSalt"])).unwrap();
                NewKeyslot::Passkey {
                    prf_output: &prf_output,
                    credential_id: &credential,
                    rp_id: c["rpId"].as_str().unwrap(),
                    prf_salt: &prf_salt,
                }
            }
        };
        let slot = create_keyslot(&self.mk, &self.vault, &new, &mut rng, None).unwrap();
        (slot, rng.remaining())
    }

    fn open(&self, slot: &Keyslot, secret: &SlotSecret<'_>) -> Result<Zeroizing<[u8; 32]>> {
        open_keyslot(slot, secret, &self.vault, None)
    }
}

fn hkdf(ikm: &[u8], salt: &[u8], info: &str) -> Vec<u8> {
    hkdf_sha256(ikm, salt, info.as_bytes(), 32).unwrap().to_vec()
}

fn code<T>(result: Result<T>) -> &'static str {
    match result {
        Ok(_) => "ok",
        Err(error) => error.code().as_str(),
    }
}

/// The base slot's JSON with one change, serialized with members in their original order (as the vectors do).
fn mutated(slot: &Keyslot, change: impl FnOnce(&mut Map<String, Value>)) -> Vec<u8> {
    let text = String::from_utf8(slot.serialize()).unwrap();
    let mut object = ordered::parse(&text);
    change(&mut object);
    let mut out = ordered::to_string(&object);
    out.push('\n');
    out.into_bytes()
}

/// A minimal ordered view of a keyslot file: serde_json sorts object members here, so the writer order is rebuilt
/// by hand from the member list of spec/FORMAT.md section 6.2.
mod ordered {
    use serde_json::{Map, Value};

    const TOP: [&str; 9] = [
        "format", "type", "vault", "slot", "kind", "kdf", "commit", "wrap", "mkCheck",
    ];
    const KDF: [&str; 10] = [
        "alg",
        "v",
        "m",
        "t",
        "p",
        "salt",
        "secretKey",
        "credentialId",
        "rpId",
        "prfSalt",
    ];

    pub fn parse(text: &str) -> Map<String, Value> {
        serde_json::from_str(text).unwrap()
    }

    fn write(map: &Map<String, Value>, order: &[&str]) -> String {
        let mut keys: Vec<&String> = map.keys().collect();
        // Known members in writer order, then any extra member last, as JavaScript appends a new one.
        keys.sort_by_key(|k| order.iter().position(|o| o == k).unwrap_or(usize::MAX));
        let members: Vec<String> = keys
            .into_iter()
            .map(|k| {
                let value = match (&map[k], k.as_str()) {
                    (Value::Object(kdf), "kdf") => write(kdf, &KDF),
                    (Value::Object(wrap), "wrap") => write(wrap, &["iv", "ct"]),
                    (v, _) => v.to_string(),
                };
                format!("{}:{value}", Value::String(k.clone()))
            })
            .collect();
        format!("{{{}}}", members.join(","))
    }

    pub fn to_string(map: &Map<String, Value>) -> String {
        write(map, &TOP)
    }
}

#[test]
fn constants_and_normalization() {
    let f = fixture();
    assert_eq!(DEFAULT_ARGON2, Argon2Params { m: 65536, t: 3, p: 1 });
    let (unicode, equivalent) = (f.passphrase("unicode"), f.passphrase("unicodeEquivalent"));
    assert_ne!(unicode, equivalent);
    assert_eq!(
        normalize_passphrase(unicode).unwrap(),
        normalize_passphrase(equivalent).unwrap()
    );
    assert_eq!(
        &normalize_passphrase("\u{fb01} \u{216b} \u{ff03}").unwrap()[..],
        b"fi XII #"
    );
    assert_eq!(&normalize_passphrase("e\u{301}").unwrap()[..], "é".as_bytes());
    assert_eq!(code(normalize_passphrase("")), "invalid-input");
}

#[test]
fn creating_draws_slot_id_then_salt_then_iv() {
    let f = fixture();
    for case in f.inputs["keyslots"].as_array().unwrap() {
        assert_eq!(f.create(case["id"].as_str().unwrap()).1, 0);
    }
}

#[test]
fn a_passphrase_slot_follows_the_spec_derivation() {
    let f = fixture();
    let c = f.case("passphrase-secret-key");
    let (slot, _) = f.create("passphrase-secret-key");
    let slot_id = hex(&c["slotId"]);
    assert_eq!(slot.vault(), base32_encode(&f.vault));
    assert_eq!(slot.slot(), "ceirceirceirceirceirceirce");
    assert_eq!(
        slot.kdf,
        Kdf::Passphrase {
            params: f.params,
            salt: [0x22; 16],
            secret_key: true
        }
    );
    assert_eq!(base64url_encode(&slot.wrap_iv), "MzMzMzMzMzMzMzMz");

    let salt = hex(&c["salt"]);
    let password = normalize_passphrase(f.passphrase("unicode")).unwrap();
    let input = Argon2Input {
        password: &password,
        salt: &salt,
        m: 19456,
        t: 2,
        p: 1,
        length: 32,
        secret: &[],
        ad: &[],
    };
    let a = argon2id(&input).unwrap();
    let ikm = [&a[..], &f.sk].concat();
    let kek = hkdf(&ikm, &[&f.vault[..], &slot_id].concat(), "aparte/1/kek|passphrase");
    let k_wrap = hkdf(&kek, &f.vault, "aparte/1/wrap");
    let k_commit = hkdf(&kek, &f.vault, "aparte/1/commit");
    let commit = hmac_sha256(&k_commit, &[b"aparte/1/commit|", &f.vault, &slot_id]);
    assert_eq!(slot.commit, commit);

    let kdf = json!({"alg": "argon2id", "v": 19, "m": 19456, "t": 2, "p": 1, "salt": "IiIiIiIiIiIiIiIiIiIiIg", "secretKey": true});
    let aad = format!(
        "aparte/1|keyslot|{}|{}|passphrase|{}",
        slot.vault(),
        slot.slot(),
        canonical_json(&kdf).unwrap()
    );
    assert_eq!(slot.aad(), aad.as_bytes());
    let k_wrap: [u8; 32] = k_wrap.try_into().unwrap();
    assert_eq!(
        &aes_gcm_decrypt(&k_wrap, &slot.wrap_iv, &slot.wrap_ct, aad.as_bytes()).unwrap()[..],
        &f.mk
    );
    assert_eq!(slot.mk_check, Subkeys::derive(&f.mk, &f.vault).master_key_check());
}

#[test]
fn a_slot_without_the_secret_key_uses_ikm_a() {
    let f = fixture();
    let c = f.case("passphrase-only");
    let (slot, _) = f.create("passphrase-only");
    let (salt, slot_id) = (hex(&c["salt"]), hex(&c["slotId"]));
    let password = normalize_passphrase(f.passphrase("ascii")).unwrap();
    let input = Argon2Input {
        password: &password,
        salt: &salt,
        m: 19456,
        t: 2,
        p: 1,
        length: 32,
        secret: &[],
        ad: &[],
    };
    let a = argon2id(&input).unwrap();
    let kek = hkdf(&a, &[&f.vault[..], &slot_id].concat(), "aparte/1/kek|passphrase");
    let k_commit = hkdf(&kek, &f.vault, "aparte/1/commit");
    assert_eq!(
        slot.commit,
        hmac_sha256(&k_commit, &[b"aparte/1/commit|", &f.vault, &slot_id])
    );
    assert!(matches!(slot.kdf, Kdf::Passphrase { secret_key: false, .. }));
}

#[test]
fn recovery_and_passkey_slots() {
    let f = fixture();
    let (slot, _) = f.create("recovery");
    let slot_id = hex(&f.case("recovery")["slotId"]);
    assert_eq!(slot.kdf, Kdf::Recovery);
    let kek = hkdf(&f.recovery, &[&f.vault[..], &slot_id].concat(), "aparte/1/kek|recovery");
    let k_wrap: [u8; 32] = hkdf(&kek, &f.vault, "aparte/1/wrap").try_into().unwrap();
    let aad = format!(
        "aparte/1|keyslot|{}|{}|recovery|{{\"alg\":\"recovery\"}}",
        slot.vault(),
        slot.slot()
    );
    assert_eq!(slot.aad(), aad.as_bytes());
    assert_eq!(
        &aes_gcm_decrypt(&k_wrap, &slot.wrap_iv, &slot.wrap_ct, aad.as_bytes()).unwrap()[..],
        &f.mk
    );

    let c = f.case("passkey");
    let (slot, _) = f.create("passkey");
    let Kdf::Passkey {
        credential_id,
        rp_id,
        prf_salt,
    } = &slot.kdf
    else {
        panic!("a passkey kdf")
    };
    assert_eq!(credential_id, &hex(&c["credentialId"]));
    assert_eq!(rp_id, "aparte.example");
    assert_eq!(&prf_salt[..], &hex(&c["prfSalt"])[..]);
    let kek = hkdf(
        &hex(&c["prfOutput"]),
        &[&f.vault[..], &hex(&c["slotId"])].concat(),
        "aparte/1/kek|passkey",
    );
    let k_wrap: [u8; 32] = hkdf(&kek, &f.vault, "aparte/1/wrap").try_into().unwrap();
    assert_eq!(
        &aes_gcm_decrypt(&k_wrap, &slot.wrap_iv, &slot.wrap_ct, &slot.aad()).unwrap()[..],
        &f.mk
    );
}

#[test]
fn creating_refuses_bad_inputs() {
    let f = fixture();
    let refuse = |new: NewKeyslot<'_>| code(create_keyslot(&f.mk, &f.vault, &new, &mut OsRng, None));
    assert_eq!(
        refuse(NewKeyslot::Passphrase {
            passphrase: "",
            secret_key: Some(&f.sk),
            params: f.params
        }),
        "invalid-input"
    );
    for params in [
        Argon2Params { m: 19455, t: 2, p: 1 },
        Argon2Params { m: 19456, t: 1, p: 1 },
        Argon2Params { m: 19456, t: 2, p: 5 },
    ] {
        assert_eq!(
            refuse(NewKeyslot::Passphrase {
                passphrase: "x",
                secret_key: Some(&f.sk),
                params
            }),
            "invalid-input"
        );
    }
    let prf = [0u8; 32];
    for (credential, rp) in [(&[0u8; 15][..], "a"), (&[0u8; 16][..], "A"), (&[0u8; 16][..], "")] {
        let new = NewKeyslot::Passkey {
            prf_output: &prf,
            credential_id: credential,
            rp_id: rp,
            prf_salt: &prf,
        };
        assert_eq!(refuse(new), "invalid-input");
    }
    // Inputs are checked before anything is drawn.
    let mut rng = QueueRng::new([vec![0u8; 16]]);
    let new = NewKeyslot::Passphrase {
        passphrase: "",
        secret_key: None,
        params: f.params,
    };
    assert!(create_keyslot(&f.mk, &f.vault, &new, &mut rng, None).is_err());
    assert_eq!(rng.remaining(), 1);
}

#[test]
fn every_kind_round_trips_its_file_and_opens() {
    let f = fixture();
    for case in f.inputs["keyslots"].as_array().unwrap() {
        let (slot, _) = f.create(case["id"].as_str().unwrap());
        let bytes = slot.serialize();
        assert_eq!(Keyslot::parse(&bytes, Some(&slot.name())).unwrap(), slot);
    }
    let (pass, _) = f.create("passphrase-secret-key");
    let secret = SlotSecret::Passphrase {
        passphrase: f.passphrase("unicode"),
        secret_key: Some(&f.sk),
    };
    assert_eq!(*f.open(&pass, &secret).unwrap(), f.mk);
    let equivalent = SlotSecret::Passphrase {
        passphrase: f.passphrase("unicodeEquivalent"),
        secret_key: Some(&f.sk),
    };
    assert_eq!(*f.open(&pass, &equivalent).unwrap(), f.mk);
    let (only, _) = f.create("passphrase-only");
    let secret = SlotSecret::Passphrase {
        passphrase: f.passphrase("ascii"),
        secret_key: None,
    };
    assert_eq!(*f.open(&only, &secret).unwrap(), f.mk);
    let (recovery, _) = f.create("recovery");
    assert_eq!(
        *f.open(&recovery, &SlotSecret::Recovery { key: &f.recovery }).unwrap(),
        f.mk
    );
    let (passkey, _) = f.create("passkey");
    let prf: [u8; 32] = hex(&f.case("passkey")["prfOutput"]).try_into().unwrap();
    assert_eq!(
        *f.open(&passkey, &SlotSecret::Passkey { prf_output: &prf }).unwrap(),
        f.mk
    );
}

#[test]
fn wrong_secrets_and_wrong_kinds() {
    let f = fixture();
    let (pass, _) = f.create("passphrase-secret-key");
    let wrong = SlotSecret::Passphrase {
        passphrase: f.passphrase("wrong"),
        secret_key: Some(&f.sk),
    };
    assert_eq!(code(f.open(&pass, &wrong)), "wrong-secret");
    let mut other_sk = f.sk;
    other_sk[0] ^= 1;
    let wrong_sk = SlotSecret::Passphrase {
        passphrase: f.passphrase("unicode"),
        secret_key: Some(&other_sk),
    };
    assert_eq!(code(f.open(&pass, &wrong_sk)), "wrong-secret");
    let no_sk = SlotSecret::Passphrase {
        passphrase: f.passphrase("unicode"),
        secret_key: None,
    };
    assert_eq!(code(f.open(&pass, &no_sk)), "invalid-input");
    let empty = SlotSecret::Passphrase {
        passphrase: "",
        secret_key: Some(&f.sk),
    };
    assert_eq!(code(f.open(&pass, &empty)), "invalid-input");

    let (recovery, _) = f.create("recovery");
    let mut other_r = f.recovery;
    other_r[31] ^= 1;
    assert_eq!(
        code(f.open(&recovery, &SlotSecret::Recovery { key: &other_r })),
        "wrong-secret"
    );
    let ascii = SlotSecret::Passphrase {
        passphrase: f.passphrase("ascii"),
        secret_key: Some(&f.sk),
    };
    assert_eq!(code(f.open(&recovery, &ascii)), "invalid-input");

    let (passkey, _) = f.create("passkey");
    assert_eq!(
        code(f.open(&passkey, &SlotSecret::Passkey { prf_output: &[0; 32] })),
        "wrong-secret"
    );

    let other_vault: [u8; 16] = hex(&f.inputs["otherVaultId"]).try_into().unwrap();
    let opened = open_keyslot(
        &recovery,
        &SlotSecret::Recovery { key: &f.recovery },
        &other_vault,
        None,
    );
    assert_eq!(code(opened), "corrupt");
}

#[test]
fn the_commitment_is_checked_before_the_wrap_is_decrypted() {
    let f = fixture();
    let (slot, _) = f.create("passphrase-secret-key");
    let right = SlotSecret::Passphrase {
        passphrase: f.passphrase("unicode"),
        secret_key: Some(&f.sk),
    };
    let wrong = SlotSecret::Passphrase {
        passphrase: f.passphrase("wrong"),
        secret_key: Some(&f.sk),
    };

    let changed_commit = Keyslot {
        commit: [9; 32],
        ..slot.clone()
    };
    assert_eq!(code(f.open(&changed_commit, &right)), "wrong-secret");
    let garbage_wrap = Keyslot {
        wrap_ct: [0; 48],
        ..slot.clone()
    };
    assert_eq!(code(f.open(&garbage_wrap, &wrong)), "wrong-secret");
    let mut damaged = slot.wrap_ct;
    damaged[0] ^= 1;
    assert_eq!(
        code(f.open(
            &Keyslot {
                wrap_ct: damaged,
                ..slot.clone()
            },
            &right
        )),
        "tampered"
    );
    assert_eq!(
        code(f.open(
            &Keyslot {
                mk_check: [0; 32],
                ..slot.clone()
            },
            &right
        )),
        "tampered"
    );
    let mut iv = slot.wrap_iv;
    iv[0] ^= 1;
    assert_eq!(
        code(f.open(
            &Keyslot {
                wrap_iv: iv,
                ..slot.clone()
            },
            &right
        )),
        "tampered"
    );
    let t3 = Kdf::Passphrase {
        params: Argon2Params { t: 3, ..f.params },
        salt: [0x22; 16],
        secret_key: true,
    };
    assert_eq!(
        code(f.open(
            &Keyslot {
                kdf: t3,
                ..slot.clone()
            },
            &right
        )),
        "wrong-secret"
    );
}

#[test]
fn hostile_parameters_are_rejected_before_argon2_runs() {
    let f = fixture();
    let base_id = f.inputs["maliciousKeyslots"]["base"].as_str().unwrap();
    let (base, _) = f.create(base_id);
    let right = SlotSecret::Passphrase {
        passphrase: f.passphrase("unicode"),
        secret_key: Some(&f.sk),
    };
    let cases = f.inputs["maliciousKeyslots"]["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 19);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let bytes = mutated(&base, |o| {
            let path: Vec<&str> = case["path"].as_str().unwrap().split('.').collect();
            let (last, parents) = path.split_last().unwrap();
            let mut target = o;
            for key in parents {
                target = target.get_mut(*key).unwrap().as_object_mut().unwrap();
            }
            if case["delete"] == true {
                target.remove(*last);
            } else {
                target.insert((*last).to_owned(), case["value"].clone());
            }
        });
        assert_eq!(code(Keyslot::parse(&bytes, None)), "unsupported-keyslot", "{id}");
    }

    // A slot built by hand with a parameter out of bounds never reaches Argon2 either.
    let calls = Cell::new(0);
    let counting = |input: &Argon2Input<'_>| -> Result<Zeroizing<Vec<u8>>> {
        calls.set(calls.get() + 1);
        argon2id(input)
    };
    for params in [
        Argon2Params { m: 19455, ..f.params },
        Argon2Params { m: 262_145, ..f.params },
        Argon2Params {
            m: u32::MAX,
            ..f.params
        },
        Argon2Params { t: 1, ..f.params },
        Argon2Params { t: 11, ..f.params },
        Argon2Params { p: 0, ..f.params },
        Argon2Params { p: 5, ..f.params },
    ] {
        let slot = Keyslot {
            kdf: Kdf::Passphrase {
                params,
                salt: [0x22; 16],
                secret_key: true,
            },
            ..base.clone()
        };
        assert_eq!(
            code(open_keyslot(&slot, &right, &f.vault, Some(&counting))),
            "unsupported-keyslot"
        );
    }
    assert_eq!(calls.get(), 0);
    assert_eq!(*open_keyslot(&base, &right, &f.vault, Some(&counting)).unwrap(), f.mk);
    assert_eq!(calls.get(), 1);
}

#[test]
fn passkey_slots_with_bad_credentials_are_unsupported() {
    let f = fixture();
    let (passkey, _) = f.create("passkey");
    for (member, value) in [
        ("rpId", json!("Aparte.Example")),
        ("credentialId", json!("")),
        ("prfSalt", json!("AAAA")),
    ] {
        let bytes = mutated(&passkey, |o| {
            o["kdf"].as_object_mut().unwrap().insert(member.to_owned(), value);
        });
        assert_eq!(code(Keyslot::parse(&bytes, None)), "unsupported-keyslot", "{member}");
    }
}

#[test]
fn corrupt_files() {
    let f = fixture();
    let (base, _) = f.create("passphrase-secret-key");
    let canonical = base.serialize();
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("not UTF-8", vec![0xff, 0xfe, 0x7b]),
        ("not JSON", b"not json\n".to_vec()),
        ("an array", b"[]\n".to_vec()),
        (
            "an extra member",
            mutated(&base, |o| {
                o.insert("label".into(), json!("phone"));
            }),
        ),
        (
            "a missing member",
            mutated(&base, |o| {
                o.remove("mkCheck");
            }),
        ),
        (
            "the wrong type",
            mutated(&base, |o| {
                o.insert("type".into(), json!("key"));
            }),
        ),
        (
            "a bad base64url commit",
            mutated(&base, |o| {
                o.insert("commit".into(), json!("not+base64url"));
            }),
        ),
        (
            "a short commit",
            mutated(&base, |o| {
                o.insert("commit".into(), json!(base64url_encode(&[0; 31])));
            }),
        ),
        (
            "a short wrap",
            mutated(&base, |o| {
                o["wrap"].as_object_mut().unwrap().insert("ct".into(), json!("AAAA"));
            }),
        ),
        (
            "a non-canonical slot id",
            mutated(&base, |o| {
                o.insert("slot".into(), json!(format!("{}f", &base.slot()[..25])));
            }),
        ),
        (
            "pretty-printed",
            [
                serde_json::to_vec_pretty(&serde_json::from_slice::<Value>(&canonical).unwrap()).unwrap(),
                b"\n".to_vec(),
            ]
            .concat(),
        ),
        ("without the final line feed", canonical[..canonical.len() - 1].to_vec()),
        ("members reordered", {
            let text = String::from_utf8(canonical.clone()).unwrap();
            text.replacen(
                "\"format\":\"aparte/1\",\"type\":\"keyslot\"",
                "\"type\":\"keyslot\",\"format\":\"aparte/1\"",
                1,
            )
            .into_bytes()
        }),
    ];
    for (what, bytes) in cases {
        assert_eq!(code(Keyslot::parse(&bytes, None)), "corrupt", "{what}");
    }
    assert_eq!(
        code(Keyslot::parse(
            &canonical,
            Some(&format!("keys/{}.json", "a".repeat(26)))
        )),
        "corrupt"
    );
    // The mutation helper keeps the writer order: an unchanged file parses.
    assert!(Keyslot::parse(&mutated(&base, |_| {}), None).is_ok());
}
