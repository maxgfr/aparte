//! The vault's Yjs documents as the CLI uses them (spec/DATA-MODEL.md), with the semantics of the web app's workspace
//! (web/src/core/workspace/workspace.ts): the index is loaded at open, a conversation shard when one of its
//! conversations is read; every local transaction appends its v2 update to the document's pending queue, which seals
//! it as a kind-6 envelope; opening a document applies the object mirror (checkpoints, then the segments above them)
//! and then the queue.
//!
//! Entities are nested `Y.Map`s of `Any` values under a top-level map per kind; a message is written once by
//! [`Workspace::commit_message`] and never changed afterwards, except `deletedAt`. Readers keep what they do not
//! understand: parts are kept as JSON, unknown members included, and replayed as they are.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};

use aparte_crypto::names::shard_of;
use aparte_format::encoding::base32_decode_array;
use aparte_format::names::DocId;
use aparte_store::RecordStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use yrs::{Any, Doc, In, Map, MapPrelim, MapRef, Out, ReadTxn, Transact, TransactionMut};

use crate::error::{Result, corrupt, invalid, invalid_state};
use crate::streams::{DocTags, mirrored_updates};
use crate::ydoc::{
    INDEX_MAPS, SHARD_MAPS, any_to_json, apply_update, encode_state, is_id, json_to_any, map_json, new_doc,
};

/// The clock entities are stamped with, Unix milliseconds.
pub trait Clock: Send + Sync {
    /// Now.
    fn now(&self) -> u64;
}

/// The system clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    }
}

const EFFORTS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const ROLES: [&str; 4] = ["user", "assistant", "system", "tool"];
const STATUSES: [&str; 4] = ["done", "stopped", "error", "refused"];
const STOPS: [&str; 8] = [
    "end",
    "length",
    "tool-calls",
    "stop-sequence",
    "refusal",
    "content-filter",
    "pause",
    "other",
];
const USAGE_KEYS: [&str; 5] = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const PROVIDER_KINDS: [&str; 8] = [
    "anthropic",
    "openai",
    "google",
    "mistral",
    "openrouter",
    "openai-compatible",
    "webllm",
    "chrome-ai",
];

/// `{provider: providerId, id: modelId}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    /// The provider entity id.
    pub provider: String,
    /// The model id.
    pub id: String,
}

impl ModelRef {
    fn from_json(v: &Value) -> Option<ModelRef> {
        let provider = v.get("provider")?.as_str().filter(|s| !s.is_empty())?;
        let id = v.get("id")?.as_str().filter(|s| !s.is_empty())?;
        Some(ModelRef {
            provider: provider.to_owned(),
            id: id.to_owned(),
        })
    }

    fn to_json(&self) -> Value {
        json!({"provider": self.provider, "id": self.id})
    }
}

/// A conversation of the index (spec/DATA-MODEL.md section 3.2).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    /// Its id; its shard derives from it.
    pub id: String,
    /// The title, empty until set.
    pub title: String,
    /// The folder id.
    pub folder: Option<String>,
    /// The persona it started with.
    pub persona: Option<String>,
    /// The model new turns use.
    pub model: Option<ModelRef>,
    /// The effort new turns use.
    pub effort: Option<String>,
    /// The active branch's last message.
    pub leaf: Option<String>,
    /// The top-level system prompt, frozen once started.
    pub system: String,
    /// The tool snapshot, frozen once started.
    pub tools: Value,
    /// Pinned to the top.
    pub pinned: bool,
    /// Hidden from the main list.
    pub archived: bool,
    /// Created, Unix milliseconds.
    pub created_at: u64,
    /// Last changed.
    pub updated_at: u64,
    /// When the first message was appended.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    /// In the trash since.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
    /// Emptied for good at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purged_at: Option<u64>,
}

/// A message of a conversation shard (spec/DATA-MODEL.md section 4).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// Its id.
    pub id: String,
    /// The conversation.
    pub conv: String,
    /// The previous message on the branch.
    pub parent: Option<String>,
    /// `user`, `assistant`, `system` or `tool`.
    pub role: String,
    /// The parts, tagged by `type`, kept as JSON (unknown members included).
    pub parts: Vec<Value>,
    /// The model that produced an assistant message.
    pub model: Option<ModelRef>,
    /// Created, Unix milliseconds.
    pub created_at: u64,
    /// `done`, `stopped`, `error` or `refused`.
    pub status: String,
    /// Token counts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    /// `{code, message}` of a failed response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    /// Why an assistant response ended.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<String>,
    /// `{category, explanation?}` of a refusal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal: Option<Value>,
    /// The effort of the response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Hidden from the branch view since.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
}

/// A provider of the index (spec/DATA-MODEL.md section 3.3), as JSON with its unknown members kept.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Provider {
    /// Its id.
    pub id: String,
    /// The adapter kind.
    pub kind: String,
    /// The label.
    pub label: String,
    /// Every field.
    pub fields: Value,
}

/// What a new conversation starts with.
#[derive(Debug, Clone, Default)]
pub struct NewConversation {
    /// The title.
    pub title: Option<String>,
    /// The model new turns use.
    pub model: Option<ModelRef>,
    /// The effort new turns use.
    pub effort: Option<String>,
    /// The system prompt; the synced `defaultSystem` when absent.
    pub system: Option<String>,
    /// The tool snapshot (an array sorted by name).
    pub tools: Option<Value>,
}

/// A message to write once.
#[derive(Debug, Clone)]
pub struct NewMessage {
    /// The id, allocated by the caller (26 base32 characters).
    pub id: String,
    /// The previous message on the branch.
    pub parent: Option<String>,
    /// The role.
    pub role: String,
    /// The parts.
    pub parts: Vec<Value>,
    /// The model that produced an assistant message.
    pub model: Option<ModelRef>,
    /// The status.
    pub status: String,
    /// Token counts.
    pub usage: Option<Value>,
    /// `{code, message}`.
    pub error: Option<Value>,
    /// Why the response ended.
    pub stop: Option<String>,
    /// `{category, explanation?}`.
    pub refusal: Option<Value>,
    /// The effort of the response.
    pub effort: Option<String>,
    /// Defaults to the clock.
    pub created_at: Option<u64>,
}

impl NewMessage {
    /// A `done` message of `role` with `parts`.
    pub fn new(id: impl Into<String>, parent: Option<String>, role: &str, parts: Vec<Value>) -> NewMessage {
        NewMessage {
            id: id.into(),
            parent,
            role: role.to_owned(),
            parts,
            model: None,
            status: "done".into(),
            usage: None,
            error: None,
            stop: None,
            refusal: None,
            effort: None,
            created_at: None,
        }
    }
}

struct Loaded {
    doc: Doc,
    maps: HashMap<&'static str, MapRef>,
}

/// The documents of one unlocked vault on this device.
pub struct Workspace {
    store: Arc<RecordStore>,
    tags: DocTags,
    clock: Arc<dyn Clock>,
    client_id: u32,
    docs: Mutex<BTreeMap<DocId, Arc<Loaded>>>,
}

impl std::fmt::Debug for Workspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Workspace").finish_non_exhaustive()
    }
}

fn num(v: Option<&Value>) -> Option<u64> {
    v.and_then(Value::as_u64)
        .filter(|n| *n <= crate::ydoc::MAX_SAFE_INTEGER as u64)
}

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_owned)
}

fn read_conversation(id: &str, v: &Value) -> Conversation {
    let created_at = num(v.get("createdAt")).unwrap_or(0);
    let purged_at = num(v.get("purgedAt"));
    let effort = text(v.get("effort")).filter(|e| EFFORTS.contains(&e.as_str()));
    Conversation {
        id: id.to_owned(),
        title: text(v.get("title")).unwrap_or_default(),
        folder: text(v.get("folder")),
        persona: text(v.get("persona")),
        model: v.get("model").and_then(ModelRef::from_json),
        effort,
        leaf: text(v.get("leaf")),
        system: text(v.get("system")).unwrap_or_default(),
        tools: v
            .get("tools")
            .filter(|t| t.is_array())
            .cloned()
            .unwrap_or_else(|| json!([])),
        pinned: v.get("pinned") == Some(&Value::Bool(true)),
        archived: v.get("archived") == Some(&Value::Bool(true)),
        created_at,
        updated_at: num(v.get("updatedAt")).unwrap_or(created_at),
        started_at: num(v.get("startedAt")),
        deleted_at: num(v.get("deletedAt")),
        purged_at,
    }
}

fn read_message(id: &str, v: &Value) -> Message {
    let role = text(v.get("role")).filter(|r| ROLES.contains(&r.as_str()));
    let status = text(v.get("status")).filter(|s| STATUSES.contains(&s.as_str()));
    let object = |key: &str| v.get(key).filter(|x| x.is_object()).cloned();
    Message {
        id: id.to_owned(),
        conv: text(v.get("conv")).unwrap_or_default(),
        parent: text(v.get("parent")),
        role: role.unwrap_or_else(|| "user".into()),
        parts: v.get("parts").and_then(Value::as_array).cloned().unwrap_or_default(),
        model: v.get("model").and_then(ModelRef::from_json),
        created_at: num(v.get("createdAt")).unwrap_or(0),
        status: status.unwrap_or_else(|| "done".into()),
        usage: object("usage"),
        error: object("error"),
        stop: text(v.get("stop")).filter(|s| STOPS.contains(&s.as_str())),
        refusal: object("refusal"),
        effort: text(v.get("effort")).filter(|e| EFFORTS.contains(&e.as_str())),
        deleted_at: num(v.get("deletedAt")),
    }
}

fn by_created(a: &Message, b: &Message) -> std::cmp::Ordering {
    a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id))
}

/// The checks of the web app's `validateMessage`; the fields to write, as `Any`.
fn message_fields(conv: &str, m: &NewMessage, now: u64) -> Result<Vec<(&'static str, Any)>> {
    if let Some(p) = &m.parent
        && !is_id(p)
    {
        return Err(invalid("parent must be a message id or null"));
    }
    if !ROLES.contains(&m.role.as_str()) {
        return Err(invalid("unknown role"));
    }
    if !m
        .parts
        .iter()
        .all(|p| p.is_object() && p.get("type").is_some_and(Value::is_string))
    {
        return Err(invalid("a part is an object with a type"));
    }
    if !STATUSES.contains(&m.status.as_str()) {
        return Err(invalid("unknown status"));
    }
    let mut fields: Vec<(&'static str, Any)> = vec![
        ("conv", Any::from(conv)),
        ("parent", m.parent.as_deref().map_or(Any::Null, Any::from)),
        ("role", Any::from(m.role.as_str())),
        ("parts", json_to_any(&Value::Array(m.parts.clone()))?),
        (
            "model",
            m.model.as_ref().map_or(Ok(Any::Null), |r| json_to_any(&r.to_json()))?,
        ),
        ("status", Any::from(m.status.as_str())),
    ];
    if let Some(usage) = &m.usage {
        let map = usage.as_object().ok_or_else(|| invalid("usage must be an object"))?;
        let mut clean = serde_json::Map::new();
        for (k, v) in map {
            if v.is_null() {
                continue;
            }
            if !USAGE_KEYS.contains(&k.as_str()) || num(Some(v)).is_none() {
                return Err(invalid("usage holds token counts only"));
            }
            clean.insert(k.clone(), v.clone());
        }
        fields.push(("usage", json_to_any(&Value::Object(clean))?));
    }
    if let Some(error) = &m.error {
        let (Some(code), Some(message)) = (
            error.get("code").and_then(Value::as_str),
            error.get("message").and_then(Value::as_str),
        ) else {
            return Err(invalid("error must be {code, message}"));
        };
        fields.push(("error", json_to_any(&json!({"code": code, "message": message}))?));
    }
    if let Some(stop) = &m.stop {
        if !STOPS.contains(&stop.as_str()) {
            return Err(invalid("unknown stop reason"));
        }
        fields.push(("stop", Any::from(stop.as_str())));
    }
    if let Some(r) = &m.refusal {
        let category = r.get("category").cloned().unwrap_or(Value::Null);
        if !(category.is_null() || category.is_string()) {
            return Err(invalid("bad refusal category"));
        }
        let mut refusal = json!({ "category": category });
        if let Some(e) = r.get("explanation").and_then(Value::as_str) {
            refusal["explanation"] = json!(e);
        }
        fields.push(("refusal", json_to_any(&refusal)?));
    }
    if let Some(effort) = &m.effort {
        if !EFFORTS.contains(&effort.as_str()) {
            return Err(invalid("unknown effort"));
        }
        fields.push(("effort", Any::from(effort.as_str())));
    }
    let created = m.created_at.unwrap_or(now);
    fields.push(("createdAt", json_to_any(&json!(created))?));
    Ok(fields)
}

fn prelim(fields: Vec<(&'static str, Any)>) -> MapPrelim {
    MapPrelim::from_iter(fields.into_iter().map(|(k, v)| (k, In::Any(v))))
}

fn entity_json<T: ReadTxn>(map: &MapRef, txn: &T, id: &str) -> Option<Value> {
    match map.get(txn, id)? {
        Out::YMap(m) => Some(map_json(&m, txn)),
        _ => None,
    }
}

fn entity_map<T: ReadTxn>(map: &MapRef, txn: &T, id: &str) -> Option<MapRef> {
    match map.get(txn, id)? {
        Out::YMap(m) => Some(m),
        _ => None,
    }
}

impl Workspace {
    /// Opens the workspace of an unlocked vault and loads the index.
    pub fn open(store: Arc<RecordStore>, clock: Arc<dyn Clock>) -> Result<Workspace> {
        let mut id = [0u8; 4];
        store.fill_random(&mut id)?;
        let ws = Workspace {
            tags: DocTags::new(store.subkeys()),
            store,
            clock,
            client_id: u32::from_be_bytes(id),
            docs: Mutex::new(BTreeMap::new()),
        };
        ws.load(DocId::INDEX)?;
        Ok(ws)
    }

    /// The record store.
    pub fn store(&self) -> &Arc<RecordStore> {
        &self.store
    }

    /// The document tags of this vault.
    pub fn tags(&self) -> &DocTags {
        &self.tags
    }

    fn docs(&self) -> MutexGuard<'_, BTreeMap<DocId, Arc<Loaded>>> {
        self.docs.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn now(&self) -> u64 {
        self.clock.now()
    }

    /// Loads a document (once): the object mirror, then the pending queue.
    pub fn load(&self, doc_id: DocId) -> Result<()> {
        self.loaded(doc_id).map(|_| ())
    }

    fn loaded(&self, doc_id: DocId) -> Result<Arc<Loaded>> {
        if let Some(l) = self.docs().get(&doc_id) {
            return Ok(l.clone());
        }
        let doc = new_doc(self.client_id);
        let names: &[&'static str] = if doc_id == DocId::INDEX {
            &INDEX_MAPS
        } else {
            &SHARD_MAPS
        };
        let maps: HashMap<&'static str, MapRef> = names.iter().map(|n| (*n, doc.get_or_insert_map(*n))).collect();
        for update in mirrored_updates(&self.store, &self.tags, doc_id)? {
            // One mirrored update that does not apply must not keep the rest of the document from opening.
            let _ = apply_update(&doc, &update);
        }
        for record in self.store.pending(doc_id)? {
            apply_update(&doc, &record.update)
                .map_err(|_| corrupt("the pending queue of a document does not apply"))?;
        }
        let loaded = Arc::new(Loaded { doc, maps });
        Ok(self.docs().entry(doc_id).or_insert(loaded).clone())
    }

    /// Whether a document is in memory.
    pub fn is_loaded(&self, doc_id: DocId) -> bool {
        self.docs().contains_key(&doc_id)
    }

    /// Applies an update from another device (not appended to the queue); loads the document first.
    pub fn apply_remote(&self, doc_id: DocId, update: &[u8]) -> Result<()> {
        let l = self.loaded(doc_id)?;
        apply_update(&l.doc, update)
    }

    /// The full state of a document as one v2 update; loads it first.
    pub fn state(&self, doc_id: DocId) -> Result<Vec<u8>> {
        Ok(encode_state(&self.loaded(doc_id)?.doc))
    }

    /// The JSON of a document's root maps, as `Y.Map#toJSON` gives them on the web.
    pub fn json(&self, doc_id: DocId) -> Result<Value> {
        let l = self.loaded(doc_id)?;
        let txn = l.doc.transact();
        let mut out = serde_json::Map::new();
        let mut names: Vec<&&str> = l.maps.keys().collect();
        names.sort_unstable();
        for name in names {
            let map = &l.maps[*name];
            let value = map_json(map, &txn);
            if value.as_object().is_some_and(|o| !o.is_empty()) {
                out.insert((*name).to_owned(), value);
            }
        }
        Ok(Value::Object(out))
    }

    /// Runs `f` as one local transaction on a document and appends its update to the pending queue.
    fn write<T>(
        &self,
        doc_id: DocId,
        f: impl FnOnce(&mut TransactionMut<'_>, &HashMap<&'static str, MapRef>) -> T,
    ) -> Result<T> {
        let l = self.loaded(doc_id)?;
        let (out, update) = {
            let mut txn = l.doc.transact_mut();
            let out = f(&mut txn, &l.maps);
            (out, txn.encode_update_v2())
        };
        if update.as_slice() != yrs::Update::EMPTY_V2 {
            self.store.append_pending(doc_id, &update)?;
        }
        Ok(out)
    }

    fn index_map(&self, name: &'static str) -> Result<(Arc<Loaded>, MapRef)> {
        let l = self.loaded(DocId::INDEX)?;
        let map = l
            .maps
            .get(name)
            .cloned()
            .ok_or_else(|| invalid_state("an index map is missing"))?;
        Ok((l, map))
    }

    /// A new random id of 16 bytes in base32.
    pub fn new_id(&self) -> Result<String> {
        let mut bytes = [0u8; 16];
        self.store.fill_random(&mut bytes)?;
        Ok(aparte_format::encoding::base32_encode(&bytes))
    }

    // Conversations

    /// Every never-purged conversation not in the trash: pinned first, then by `updatedAt` descending, then by id.
    pub fn conversations(&self) -> Result<Vec<Conversation>> {
        let (l, map) = self.index_map("conversations")?;
        let txn = l.doc.transact();
        let mut out: Vec<Conversation> = map
            .iter(&txn)
            .filter_map(|(id, v)| match v {
                Out::YMap(m) => Some(read_conversation(id, &map_json(&m, &txn))),
                _ => None,
            })
            .filter(|c| c.purged_at.is_none() && c.deleted_at.is_none())
            .collect();
        out.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then(b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(out)
    }

    /// One conversation, trashed and purged ones included.
    pub fn conversation(&self, id: &str) -> Result<Option<Conversation>> {
        let (l, map) = self.index_map("conversations")?;
        let txn = l.doc.transact();
        Ok(entity_json(&map, &txn, id).map(|v| read_conversation(id, &v)))
    }

    /// The synced `defaultSystem` setting.
    pub fn default_system(&self) -> Result<String> {
        let (l, map) = self.index_map("settings")?;
        let txn = l.doc.transact();
        Ok(match map.get(&txn, "defaultSystem") {
            Some(Out::Any(Any::String(s))) => s.to_string(),
            _ => String::new(),
        })
    }

    /// Creates a conversation and returns its id.
    pub fn create_conversation(&self, input: NewConversation) -> Result<String> {
        if let Some(e) = &input.effort
            && !EFFORTS.contains(&e.as_str())
        {
            return Err(invalid("unknown effort"));
        }
        let tools = input.tools.unwrap_or_else(|| json!([]));
        if !tools.is_array() {
            return Err(invalid("tools must be an array"));
        }
        let system = match input.system {
            Some(s) => s,
            None => self.default_system()?,
        };
        let now = self.now();
        let id = self.new_id()?;
        let fields: Vec<(&'static str, Any)> = vec![
            ("id", Any::from(id.as_str())),
            ("title", Any::from(input.title.unwrap_or_default())),
            ("folder", Any::Null),
            ("persona", Any::Null),
            (
                "model",
                input
                    .model
                    .as_ref()
                    .map_or(Ok(Any::Null), |m| json_to_any(&m.to_json()))?,
            ),
            ("effort", input.effort.map_or(Any::Null, Any::from)),
            ("leaf", Any::Null),
            ("system", Any::from(system)),
            ("tools", json_to_any(&tools)?),
            ("pinned", Any::Bool(false)),
            ("archived", Any::Bool(false)),
            ("createdAt", json_to_any(&json!(now))?),
            ("updatedAt", json_to_any(&json!(now))?),
        ];
        let (_, map) = self.index_map("conversations")?;
        self.write(DocId::INDEX, |txn, _| {
            map.insert(txn, id.as_str(), prelim(fields));
        })?;
        Ok(id)
    }

    /// Sets the title of a conversation.
    pub fn set_title(&self, id: &str, title: &str) -> Result<()> {
        self.patch_conversation(id, vec![("title", Any::from(title))])
    }

    /// Sets the model and effort new turns use.
    pub fn set_model(&self, id: &str, model: Option<&ModelRef>, effort: Option<&str>) -> Result<()> {
        if let Some(e) = effort
            && !EFFORTS.contains(&e)
        {
            return Err(invalid("unknown effort"));
        }
        let model = model.map_or(Ok(Any::Null), |m| json_to_any(&m.to_json()))?;
        self.patch_conversation(
            id,
            vec![("model", model), ("effort", effort.map_or(Any::Null, Any::from))],
        )
    }

    fn patch_conversation(&self, id: &str, writes: Vec<(&'static str, Any)>) -> Result<()> {
        let (l, map) = self.index_map("conversations")?;
        let entity = {
            let txn = l.doc.transact();
            entity_map(&map, &txn, id).ok_or_else(|| invalid("unknown conversation"))?
        };
        if self.conversation(id)?.is_some_and(|c| c.purged_at.is_some()) {
            return Err(invalid_state("the conversation was purged"));
        }
        let now = json_to_any(&json!(self.now()))?;
        self.write(DocId::INDEX, |txn, _| {
            for (k, v) in writes {
                entity.insert(txn, k, v);
            }
            entity.insert(txn, "updatedAt", now);
        })
    }

    /// The shard of a conversation.
    pub fn shard_of(&self, id: &str) -> Result<DocId> {
        let bytes: [u8; 16] = base32_decode_array(id).map_err(|_| invalid("not a conversation id"))?;
        Ok(shard_of(self.store.subkeys(), &bytes))
    }

    fn live_conversation(&self, id: &str) -> Result<Conversation> {
        let c = self.conversation(id)?.ok_or_else(|| invalid("unknown conversation"))?;
        if c.purged_at.is_some() {
            return Err(invalid("the conversation was purged"));
        }
        Ok(c)
    }

    // Messages

    /// Every message of a conversation, deleted ones included, by `createdAt` then id; loads its shard.
    pub fn messages(&self, conv: &str) -> Result<Vec<Message>> {
        self.live_conversation(conv)?;
        let l = self.loaded(self.shard_of(conv)?)?;
        let map = l
            .maps
            .get("messages")
            .cloned()
            .ok_or_else(|| invalid_state("the messages map is missing"))?;
        let txn = l.doc.transact();
        let mut out: Vec<Message> = map
            .iter(&txn)
            .filter_map(|(id, v)| match v {
                Out::YMap(m) => Some(read_message(id, &map_json(&m, &txn))),
                _ => None,
            })
            .filter(|m| m.conv == conv)
            .collect();
        out.sort_by(by_created);
        Ok(out)
    }

    /// The branch from the root to `leaf` (default: the conversation's leaf), oldest first, deleted messages
    /// included; `corrupt` when a parent is missing or the chain has a cycle.
    pub fn path(&self, conv: &str, leaf: Option<&str>) -> Result<Vec<Message>> {
        let c = self.live_conversation(conv)?;
        let Some(target) = leaf.map(str::to_owned).or(c.leaf) else {
            return Ok(Vec::new());
        };
        let all: HashMap<String, Message> = self.messages(conv)?.into_iter().map(|m| (m.id.clone(), m)).collect();
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        let mut at = Some(target);
        while let Some(id) = at {
            if !seen.insert(id.clone()) {
                return Err(corrupt("the message tree has a cycle"));
            }
            let m = all
                .get(&id)
                .ok_or_else(|| corrupt("a message of the branch is missing"))?;
            at = m.parent.clone();
            out.push(m.clone());
        }
        out.reverse();
        Ok(out)
    }

    /// The leaf reached from `id` by following, at each level, the most recently created child.
    pub fn descend(&self, conv: &str, id: &str) -> Result<String> {
        let all = self.messages(conv)?;
        if !all.iter().any(|m| m.id == id) {
            return Err(invalid("not a message of this conversation"));
        }
        let mut at = id.to_owned();
        let mut seen = BTreeSet::new();
        loop {
            seen.insert(at.clone());
            match all.iter().rev().find(|m| m.parent.as_deref() == Some(at.as_str())) {
                Some(next) if !seen.contains(&next.id) => at = next.id.clone(),
                _ => return Ok(at),
            }
        }
    }

    /// Writes a complete message once (spec/DATA-MODEL.md section 4.1): `invalid-input` when its id exists, when
    /// `parent` is not a message of this conversation, or when a field is malformed. Sets the conversation's
    /// `startedAt` with the first message and bumps its `updatedAt`. Does not move the leaf.
    pub fn commit_message(&self, conv: &str, message: &NewMessage) -> Result<()> {
        self.live_conversation(conv)?;
        if !is_id(&message.id) {
            return Err(invalid("a message id is 26 base32 characters"));
        }
        let now = self.now();
        let fields = message_fields(conv, message, now)?;
        let shard = self.shard_of(conv)?;
        let existing = self.messages(conv)?;
        if let Some(parent) = &message.parent
            && !existing.iter().any(|m| &m.id == parent)
        {
            return Err(invalid("the parent is not a message of this conversation"));
        }
        let l = self.loaded(shard)?;
        let map = l
            .maps
            .get("messages")
            .cloned()
            .ok_or_else(|| invalid_state("the messages map is missing"))?;
        let exists = {
            let txn = l.doc.transact();
            map.get(&txn, &message.id).is_some()
        };
        if exists {
            return Err(invalid("this message id exists"));
        }
        self.write(shard, |txn, _| {
            map.insert(txn, message.id.as_str(), prelim(fields));
        })?;
        let (il, conversations) = self.index_map("conversations")?;
        let entity = {
            let txn = il.doc.transact();
            entity_map(&conversations, &txn, conv).ok_or_else(|| invalid("unknown conversation"))?
        };
        let started = {
            let txn = il.doc.transact();
            entity.get(&txn, "startedAt").is_some()
        };
        let stamp = json_to_any(&json!(now))?;
        self.write(DocId::INDEX, |txn, _| {
            if !started {
                entity.insert(txn, "startedAt", stamp.clone());
            }
            entity.insert(txn, "updatedAt", stamp);
        })
    }

    /// Moves the conversation's leaf; with `if_leaf`, only when the current leaf equals it. Returns whether it moved.
    pub fn set_leaf(&self, conv: &str, id: Option<&str>, if_leaf: Option<Option<&str>>) -> Result<bool> {
        let c = self.live_conversation(conv)?;
        if let Some(id) = id
            && !self.messages(conv)?.iter().any(|m| m.id == id)
        {
            return Err(invalid("not a message of this conversation"));
        }
        if let Some(expected) = if_leaf
            && c.leaf.as_deref() != expected
        {
            return Ok(false);
        }
        if c.leaf.as_deref() == id {
            return Ok(true);
        }
        let (l, conversations) = self.index_map("conversations")?;
        let entity = {
            let txn = l.doc.transact();
            entity_map(&conversations, &txn, conv).ok_or_else(|| invalid("unknown conversation"))?
        };
        let value = id.map_or(Any::Null, Any::from);
        self.write(DocId::INDEX, |txn, _| {
            entity.insert(txn, "leaf", value);
        })?;
        Ok(true)
    }

    // Providers

    /// The providers not in the trash, by label then id.
    pub fn providers(&self) -> Result<Vec<Provider>> {
        let (l, map) = self.index_map("providers")?;
        let txn = l.doc.transact();
        let mut out: Vec<Provider> = map
            .iter(&txn)
            .filter_map(|(id, v)| match v {
                Out::YMap(m) => {
                    let fields = map_json(&m, &txn);
                    (fields.get("deletedAt").is_none()).then(|| Provider {
                        id: id.to_owned(),
                        kind: text(fields.get("kind")).unwrap_or_default(),
                        label: text(fields.get("label")).unwrap_or_default(),
                        fields,
                    })
                }
                _ => None,
            })
            .collect();
        out.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    /// Creates a provider entry without any key (`syncKey: false`; keys stay on each device) and returns its id.
    pub fn create_provider(
        &self,
        kind: &str,
        label: &str,
        preset: Option<&str>,
        base_url: Option<&str>,
    ) -> Result<String> {
        if !PROVIDER_KINDS.contains(&kind) {
            return Err(invalid("unknown provider kind"));
        }
        if kind == "openai-compatible" && base_url.is_none() {
            return Err(invalid("an openai-compatible provider needs a base URL"));
        }
        let now = json_to_any(&json!(self.now()))?;
        let id = self.new_id()?;
        let mut fields: Vec<(&'static str, Any)> = vec![
            ("id", Any::from(id.as_str())),
            ("kind", Any::from(kind)),
            ("label", Any::from(label)),
            ("syncKey", Any::Bool(false)),
        ];
        if let Some(p) = preset {
            fields.push(("preset", Any::from(p)));
        }
        if let Some(u) = base_url {
            fields.push(("baseUrl", Any::from(u.trim_end_matches('/'))));
        }
        fields.push(("createdAt", now.clone()));
        fields.push(("updatedAt", now));
        let (_, map) = self.index_map("providers")?;
        self.write(DocId::INDEX, |txn, _| {
            map.insert(txn, id.as_str(), prelim(fields));
        })?;
        Ok(id)
    }

    /// The JSON of an index entity (a folder, a provider...), unknown members included.
    pub fn index_entity(&self, map: &'static str, id: &str) -> Result<Option<Value>> {
        let (l, m) = self.index_map(map)?;
        let txn = l.doc.transact();
        Ok(entity_json(&m, &txn, id))
    }
}

/// `any` as JSON (for callers that read raw values).
pub fn any_json(any: &Any) -> Value {
    any_to_json(any)
}
