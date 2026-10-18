//! The sync state this device keeps between rounds, as one encrypted local record (purpose `hwm`, id `sync`,
//! spec/FORMAT.md sections 10.3 and 11.3), with the fields of the web app's (web/src/core/sync/state.ts): what each
//! destination has listed (for rollback), the gaps and unreturned claims being watched (for withholding), checkpoint
//! coverage, the keyslots known, the alarms raised.
//!
//! Read afresh at the start of every round and written at its end, under the store's `sync` lock. A record that does
//! not parse is replaced by a fresh state: the device then trusts the next listing again, as a new device does
//! (section 10.4).

use std::collections::BTreeMap;

use aparte_store::RecordStore;
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// `stag -> dtag -> seq`.
pub type TagSeqs = BTreeMap<String, BTreeMap<String, u64>>;

/// The id of the state record.
pub const STATE_ID: &str = "sync";

/// What one destination has shown this device.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DestRecord {
    /// Highest seq this destination ever listed, per (stag, dtag): a later listing below it is a rollback.
    pub listed: TagSeqs,
    /// `stag/dtag/seq` of a missing segment below a listed one, and when it was first seen missing.
    pub gaps: BTreeMap<String, u64>,
    /// `stag/dtag/seq` named by a header and not returned, and when it was first seen missing.
    pub unreturned: BTreeMap<String, u64>,
    /// The format marker was read back intact once.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fmt_ok: Option<bool>,
    /// End of the last round that completed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_ok_at: Option<u64>,
}

/// Why a store looks untrustworthy (spec/FORMAT.md section 10.3); nothing local is ever deleted because of one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAlarm {
    /// Stable for one finding, so seeing it again raises nothing new.
    pub id: String,
    /// `rollback`, `withheld`, `unreturned`, `fork` or `tampered`.
    pub kind: String,
    /// The destination it was found on.
    pub dest: String,
    /// The document, when the finding names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    /// Tags and sequence numbers, never content.
    pub detail: String,
    /// When it was raised, Unix milliseconds.
    pub at: u64,
}

/// The state of every destination of this device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncState {
    /// Always 1.
    pub v: u32,
    /// Per (stag, dtag), the coverage of the checkpoints this device holds.
    pub covered: TagSeqs,
    /// Per (stag, dtag), the highest seq a `seen` or `covers` of a header this device read names.
    pub claims: TagSeqs,
    /// Per document, the own seq of this device's last checkpoint.
    pub own_checkpoint: BTreeMap<String, u64>,
    /// Per document, the last pending-queue position sealed into a segment.
    pub sealed: BTreeMap<String, u64>,
    /// Keyslot ids this device has had (to tell a slot another device added from one this device removed).
    pub slots: Vec<String>,
    /// Keyslot ids this device removed and deleted from its destinations once.
    pub removed_slots: Vec<String>,
    /// Per destination id.
    pub dests: BTreeMap<String, DestRecord>,
    /// The alarms raised and not dismissed.
    pub alarms: Vec<SyncAlarm>,
    /// Alarm ids the user dismissed.
    pub dismissed: Vec<String>,
    /// Object name -> failed validations.
    pub bad: BTreeMap<String, u32>,
}

impl Default for SyncState {
    fn default() -> Self {
        SyncState {
            v: 1,
            covered: TagSeqs::new(),
            claims: TagSeqs::new(),
            own_checkpoint: BTreeMap::new(),
            sealed: BTreeMap::new(),
            slots: Vec::new(),
            removed_slots: Vec::new(),
            dests: BTreeMap::new(),
            alarms: Vec::new(),
            dismissed: Vec::new(),
            bad: BTreeMap::new(),
        }
    }
}

impl SyncState {
    /// The stored state, or a fresh one when there is none or it does not parse.
    pub fn load(store: &RecordStore) -> Result<SyncState> {
        let Some(bytes) = store.get("hwm", STATE_ID)? else {
            return Ok(SyncState::default());
        };
        Ok(serde_json::from_slice::<SyncState>(&bytes)
            .ok()
            .filter(|s| s.v == 1)
            .unwrap_or_default())
    }

    /// Writes the state.
    pub fn save(&self, store: &RecordStore) -> Result<()> {
        let bytes = serde_json::to_vec(self).unwrap_or_default();
        store.put("hwm", STATE_ID, &bytes)?;
        Ok(())
    }

    /// The record of a destination, created empty.
    pub fn dest(&mut self, id: &str) -> &mut DestRecord {
        self.dests.entry(id.to_owned()).or_default()
    }
}

/// `map[stag][dtag]`, 0 when absent.
pub fn get_seq(map: &TagSeqs, stag: &str, dtag: &str) -> u64 {
    map.get(stag).and_then(|d| d.get(dtag)).copied().unwrap_or(0)
}

/// Raises `map[stag][dtag]` to `seq`.
pub fn raise_seq(map: &mut TagSeqs, stag: &str, dtag: &str, seq: u64) {
    let inner = map.entry(stag.to_owned()).or_default();
    let entry = inner.entry(dtag.to_owned()).or_insert(0);
    if seq > *entry {
        *entry = seq;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_is_the_web_apps_json() {
        let mut s = SyncState::default();
        raise_seq(&mut s.covered, "s", "d", 3);
        raise_seq(&mut s.covered, "s", "d", 2);
        assert_eq!(get_seq(&s.covered, "s", "d"), 3);
        assert_eq!(get_seq(&s.covered, "s", "x"), 0);
        s.dest("github:x").fmt_ok = Some(true);
        let json = serde_json::to_value(&s).expect("json");
        assert_eq!(json["v"], 1);
        assert_eq!(json["ownCheckpoint"], serde_json::json!({}));
        assert_eq!(json["dests"]["github:x"]["fmtOk"], true);
        assert!(json["dests"]["github:x"].get("lastOkAt").is_none());
        let back: SyncState = serde_json::from_value(json).expect("parse");
        assert_eq!(back, s);
        let partial: SyncState = serde_json::from_str(r#"{"v":1,"slots":["a"]}"#).expect("parse");
        assert_eq!(partial.slots, ["a"]);
    }
}
