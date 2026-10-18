//! What the CLI needs of Yjs, through `yrs` configured as spec/DATA-MODEL.md section 2 requires (`OffsetKind::Utf16`,
//! the v2 encoding): documents, updates applied and merged, full states, and the conversion between Yjs `Any` values
//! and JSON.
//!
//! Numbers follow the web app's: an integer is written as `Number::Int`, which `yrs` encodes exactly as lib0 does
//! (a variable-length integer up to 31 bits, else a float), so the browser reads back the same JavaScript number; a
//! value outside the safe integers or not finite is refused, as `toAny` refuses it on the web.

use std::collections::{BTreeSet, HashMap};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use serde_json::{Map as JsonMap, Number as JsonNumber, Value};
use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{Any, ClientID, Doc, MapRef, Number, OffsetKind, Options, ReadTxn, StateVector, Transact, Update};

use crate::error::{Result, corrupt, invalid};

/// `2^53 - 1`, the largest integer a JavaScript number holds exactly.
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;
/// Values deeper than this are not walked: a part never nests so far, and a hostile value cannot make us recurse.
const MAX_DEPTH: usize = 32;

/// The root maps of the index document (spec/DATA-MODEL.md section 3).
pub const INDEX_MAPS: [&str; 11] = [
    "conversations",
    "folders",
    "personas",
    "prompts",
    "providers",
    "mcp",
    "skills",
    "knowledge",
    "settings",
    "toolApprovals",
    "keyslots",
];
/// The root map of a conversation shard document (spec/DATA-MODEL.md section 4).
pub const SHARD_MAPS: [&str; 1] = ["messages"];

/// A new document with the options both implementations share; `client_id` is a 32-bit Yjs client id, as the web
/// app draws them.
pub fn new_doc(client_id: u32) -> Doc {
    let mut options = Options::with_client_id(ClientID::new(u64::from(client_id)));
    options.offset_kind = OffsetKind::Utf16;
    Doc::with_options(options)
}

/// Applies one v2 update; `corrupt` when it does not decode or apply. A panic inside `yrs` on hostile bytes is caught
/// in builds that unwind and reported the same way.
pub fn apply_update(doc: &Doc, update: &[u8]) -> Result<()> {
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<()> {
        let decoded = Update::decode_v2(update).map_err(|_| corrupt("a Yjs update does not decode"))?;
        let mut txn = doc.transact_mut();
        txn.apply_update(decoded)
            .map_err(|_| corrupt("a Yjs update does not apply"))
    }));
    outcome.unwrap_or_else(|_| Err(corrupt("a Yjs update does not apply")))
}

/// The full state of a document as one v2 update.
pub fn encode_state(doc: &Doc) -> Vec<u8> {
    doc.transact().encode_state_as_update_v2(&StateVector::default())
}

/// One v2 update holding all of `updates`.
pub fn merge_updates(updates: &[&[u8]]) -> Result<Vec<u8>> {
    match updates {
        [one] => Ok(one.to_vec()),
        _ => match catch_unwind(AssertUnwindSafe(|| yrs::merge_updates_v2(updates.iter().copied()))) {
            Ok(Ok(merged)) => Ok(merged),
            _ => Err(corrupt("Yjs updates do not merge")),
        },
    }
}

// Any and JSON

/// A JSON value as a Yjs `Any`; `invalid-input` for a number that is not a safe integer or a finite float.
pub fn json_to_any(value: &Value) -> Result<Any> {
    json_to_any_at(value, 0)
}

fn json_to_any_at(value: &Value, depth: usize) -> Result<Any> {
    if depth > 64 {
        return Err(invalid("a value nests too deep"));
    }
    Ok(match value {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::String(s) => Any::String(Arc::from(s.as_str())),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) {
                    return Err(invalid("an integer outside the safe integers"));
                }
                Any::Number(Number::Int(i))
            } else if n.as_u64().is_some() {
                return Err(invalid("an integer outside the safe integers"));
            } else {
                let f = n
                    .as_f64()
                    .filter(|f| f.is_finite())
                    .ok_or(invalid("a number that is not finite"))?;
                Any::Number(Number::Float(f))
            }
        }
        Value::Array(items) => Any::Array(
            items
                .iter()
                .map(|v| json_to_any_at(v, depth + 1))
                .collect::<Result<Vec<_>>>()?
                .into(),
        ),
        Value::Object(map) => {
            let mut out = HashMap::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), json_to_any_at(v, depth + 1)?);
            }
            Any::Map(Arc::new(out))
        }
    })
}

/// A Yjs `Any` as JSON: an integral number within the safe integers becomes a JSON integer (whatever lib0 encoding
/// carried it), a byte array an array of its bytes, `undefined` and non-finite numbers `null`.
pub fn any_to_json(any: &Any) -> Value {
    any_to_json_at(any, 0)
}

fn any_to_json_at(any: &Any, depth: usize) -> Value {
    if depth > 64 {
        return Value::Null;
    }
    match any {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => Value::Bool(*b),
        Any::String(s) => Value::String(s.to_string()),
        Any::Number(Number::Int(i)) => Value::Number((*i).into()),
        Any::Number(Number::Float(f)) => {
            if f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER as f64 {
                // Exact: the value is an integer of at most 53 bits.
                Value::Number((*f as i64).into())
            } else {
                JsonNumber::from_f64(*f).map_or(Value::Null, Value::Number)
            }
        }
        Any::Buffer(bytes) => Value::Array(bytes.iter().map(|b| Value::Number((*b).into())).collect()),
        Any::Array(items) => Value::Array(items.iter().map(|v| any_to_json_at(v, depth + 1)).collect()),
        Any::Map(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            let mut out = JsonMap::new();
            for k in keys {
                out.insert(k.clone(), any_to_json_at(&map[k], depth + 1));
            }
            Value::Object(out)
        }
    }
}

/// A shared map as JSON, its nested shared maps included.
pub fn map_json<T: ReadTxn>(map: &MapRef, txn: &T) -> Value {
    any_to_json(&map.to_json(txn))
}

/// The JSON of the named root maps of a document, as `Y.Map#toJSON` gives them on the web.
pub fn doc_json(doc: &Doc, names: &[&str]) -> Value {
    let maps: Vec<(String, MapRef)> = names
        .iter()
        .map(|n| ((*n).to_owned(), doc.get_or_insert_map(*n)))
        .collect();
    let txn = doc.transact();
    let mut out = JsonMap::new();
    for (name, map) in maps {
        out.insert(name, map_json(&map, &txn));
    }
    Value::Object(out)
}

/// Whether `text` is a 26-character base32 id.
pub fn is_id(text: &str) -> bool {
    text.len() == 26
        && text
            .bytes()
            .all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(&c))
}

/// Manifest ids a value references: every string of a `blob` member that is an id (image, file and artifact parts,
/// `ref` parts, avatars, knowledge documents; spec/DATA-MODEL.md section 4.4).
pub fn blob_refs_of(value: &Value, out: &mut BTreeSet<String>) {
    fn walk(value: &Value, depth: usize, out: &mut BTreeSet<String>) {
        if depth > MAX_DEPTH {
            return;
        }
        match value {
            Value::Array(items) => items.iter().for_each(|v| walk(v, depth + 1, out)),
            Value::Object(map) => {
                for (k, v) in map {
                    match v {
                        Value::String(s) if k == "blob" && is_id(s) => {
                            out.insert(s.clone());
                        }
                        _ => walk(v, depth + 1, out),
                    }
                }
            }
            _ => {}
        }
    }
    walk(value, 0, out);
}

/// The blob references of everything a document holds.
pub fn doc_blob_refs(doc: &Doc) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let names: Vec<&str> = INDEX_MAPS.iter().chain(SHARD_MAPS.iter()).copied().collect();
    blob_refs_of(&doc_json(doc, &names), &mut out);
    out
}

/// The blob references `update` adds to a document made of `base`: those of the state after it that the state
/// before did not hold. A reference written again (the same photo in a second message) is already accounted for by
/// the segment that first carried it.
pub fn blob_refs_added(base: &[&[u8]], update: &[u8]) -> BTreeSet<String> {
    let doc = new_doc(0);
    for u in base {
        // One base update that does not apply only makes the difference larger, never wrong to upload after.
        let _ = apply_update(&doc, u);
    }
    let before = doc_blob_refs(&doc);
    if apply_update(&doc, update).is_err() {
        return BTreeSet::new();
    }
    doc_blob_refs(&doc).difference(&before).cloned().collect()
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use serde_json::json;
    use yrs::{In, Map, MapPrelim};

    use super::*;

    #[test]
    fn numbers_round_trip_as_the_web_writes_them() {
        for v in [
            json!(0),
            json!(64),
            json!(-3),
            json!(1_760_000_006_000_i64),
            json!(MAX_SAFE_INTEGER),
            json!(1.5),
        ] {
            assert_eq!(any_to_json(&json_to_any(&v).expect("any")), v);
        }
        assert!(json_to_any(&json!(MAX_SAFE_INTEGER + 1)).is_err());
        assert!(json_to_any(&json!(u64::MAX)).is_err());
        assert_eq!(
            any_to_json(&Any::Number(Number::Float(1_760_000_006_000.0))),
            json!(1_760_000_006_000_i64)
        );
        assert_eq!(any_to_json(&Any::Number(Number::Float(f64::NAN))), Value::Null);
        assert_eq!(any_to_json(&Any::Undefined), Value::Null);
    }

    #[test]
    fn a_document_survives_its_own_encoding() {
        let doc = new_doc(7);
        let map = doc.get_or_insert_map("messages");
        let update = {
            let mut txn = doc.transact_mut();
            let entity = MapPrelim::from_iter([
                ("conv", In::Any(Any::from("c"))),
                (
                    "parts",
                    In::Any(json_to_any(&json!([{"type": "text", "text": "été 🙂"}])).expect("any")),
                ),
                (
                    "createdAt",
                    In::Any(json_to_any(&json!(1_760_000_000_000_i64)).expect("any")),
                ),
            ]);
            map.insert(&mut txn, "m", entity);
            txn.encode_update_v2()
        };
        let copy = new_doc(8);
        apply_update(&copy, &update).expect("apply");
        assert_eq!(doc_json(&copy, &SHARD_MAPS), doc_json(&doc, &SHARD_MAPS));
        let state = encode_state(&doc);
        let again = new_doc(9);
        apply_update(&again, &state).expect("apply state");
        assert_eq!(
            doc_json(&again, &SHARD_MAPS)["messages"]["m"]["parts"][0]["text"],
            json!("été 🙂")
        );
        let merged = merge_updates(&[&update, &state]).expect("merge");
        let last = new_doc(10);
        apply_update(&last, &merged).expect("apply merged");
        assert_eq!(doc_json(&last, &SHARD_MAPS), doc_json(&doc, &SHARD_MAPS));
    }

    #[test]
    fn blob_references_added_by_an_update() {
        let doc = new_doc(1);
        let map = doc.get_or_insert_map("messages");
        let first = {
            let mut txn = doc.transact_mut();
            let parts = json!([{"type": "image", "blob": "aaaaaaaaaaaaaaaaaaaaaaaaaa"}]);
            map.insert(
                &mut txn,
                "a",
                MapPrelim::from_iter([("parts", In::Any(json_to_any(&parts).expect("any")))]),
            );
            txn.encode_update_v2()
        };
        let second = {
            let mut txn = doc.transact_mut();
            let parts =
                json!([{"type": "file", "blob": "bbbbbbbbbbbbbbbbbbbbbbbbbb"}, {"type": "ref", "blob": "not an id"}]);
            map.insert(
                &mut txn,
                "b",
                MapPrelim::from_iter([("parts", In::Any(json_to_any(&parts).expect("any")))]),
            );
            txn.encode_update_v2()
        };
        assert_eq!(
            blob_refs_added(&[], &first).into_iter().collect::<Vec<_>>(),
            ["aaaaaaaaaaaaaaaaaaaaaaaaaa"]
        );
        assert_eq!(
            blob_refs_added(&[&first], &second).into_iter().collect::<Vec<_>>(),
            ["bbbbbbbbbbbbbbbbbbbbbbbbbb"]
        );
    }

    proptest! {
        #[test]
        fn hostile_updates_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..256)) {
            let doc = new_doc(3);
            let _ = apply_update(&doc, &bytes);
            let _ = merge_updates(&[&bytes, &bytes]);
            let _ = blob_refs_added(&[&bytes], &bytes);
        }

        #[test]
        fn json_values_round_trip(value in json_strategy()) {
            prop_assert_eq!(any_to_json(&json_to_any(&value).expect("any")), value);
        }
    }

    fn json_strategy() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).prop_map(|i| json!(i)),
            ".{0,12}".prop_map(Value::String),
        ];
        leaf.prop_recursive(3, 24, 4, |inner| {
            prop_oneof![
                proptest::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
                proptest::collection::btree_map("[a-z]{1,6}", inner, 0..4)
                    .prop_map(|m| Value::Object(m.into_iter().collect())),
            ]
        })
    }
}
