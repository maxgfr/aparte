//! Session files in JSON Lines, in the spirit of pi's: a `session` header line, then one `message` entry per line,
//! each pointing at its parent. The file is plaintext and written only when asked (`--export`), atomically and
//! 0600; the encrypted vault of the web app is where conversations are kept.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use aparte_llm::Message;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fsx;

/// Format version of the session files.
pub const SESSION_VERSION: u32 = 1;

/// The first line of a session file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHeader {
    #[serde(rename = "type")]
    pub kind: String,
    pub version: u32,
    pub id: String,
    pub timestamp: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// One message line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub parent_id: Option<String>,
    pub timestamp: String,
    pub message: Message,
}

/// Why a session file could not be written or read.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("cannot read or write the session file: {0}")]
    Io(#[from] std::io::Error),
    #[error("line {line} of the session file is not valid: {message}")]
    Parse { line: usize, message: String },
}

/// A random id of 16 hex digits.
pub fn new_id() -> String {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The current time as RFC 3339 in UTC, to the millisecond.
pub fn now_rfc3339() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    rfc3339(d.as_secs(), d.subsec_millis())
}

/// Seconds since the epoch as RFC 3339 (the civil-from-days algorithm of Howard Hinnant).
pub fn rfc3339(secs: u64, millis: u32) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// The JSONL text of a session.
pub fn to_jsonl(header: &SessionHeader, messages: &[Message]) -> String {
    let mut out = serde_json::to_string(header).unwrap_or_default();
    out.push('\n');
    let mut parent: Option<String> = None;
    for (i, m) in messages.iter().enumerate() {
        let id = format!("{}-{i:04}", header.id);
        let entry = SessionEntry {
            kind: "message".into(),
            id: id.clone(),
            parent_id: parent.replace(id),
            timestamp: header.timestamp.clone(),
            message: m.clone(),
        };
        out.push_str(&serde_json::to_string(&entry).unwrap_or_default());
        out.push('\n');
    }
    out
}

/// Writes a session file atomically, 0600.
pub fn export(path: &Path, header: &SessionHeader, messages: &[Message]) -> Result<(), SessionError> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fsx::private_dir(parent)?;
    }
    fsx::atomic_write(path, to_jsonl(header, messages).as_bytes(), 0o600)?;
    Ok(())
}

/// Reads the messages of a session file, in order; lines of other types are skipped.
pub fn import(text: &str) -> Result<(Option<SessionHeader>, Vec<Message>), SessionError> {
    let mut header = None;
    let mut messages = Vec::new();
    for (n, line) in text.lines().enumerate().filter(|(_, l)| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(line).map_err(|e| SessionError::Parse {
            line: n + 1,
            message: e.to_string(),
        })?;
        let parse = |e: serde_json::Error| SessionError::Parse {
            line: n + 1,
            message: e.to_string(),
        };
        match v.get("type").and_then(Value::as_str) {
            Some("session") => header = Some(serde_json::from_value(v).map_err(parse)?),
            Some("message") => {
                let e: SessionEntry = serde_json::from_value(v).map_err(parse)?;
                messages.push(e.message);
            }
            _ => {}
        }
    }
    Ok((header, messages))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_rfc3339() {
        assert_eq!(rfc3339(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(1_760_700_000, 5), "2025-10-17T11:20:00.005Z");
        assert_eq!(rfc3339(951_782_400, 0), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn a_session_round_trips() {
        let header = SessionHeader {
            kind: "session".into(),
            version: SESSION_VERSION,
            id: new_id(),
            timestamp: now_rfc3339(),
            cwd: "/p".into(),
            provider: Some("anthropic".into()),
            model: None,
        };
        let msgs = vec![Message::user("a"), Message::assistant("b")];
        let text = to_jsonl(&header, &msgs);
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).expect("json")).collect();
        assert_eq!(lines[0]["type"], "session");
        assert_eq!(lines[2]["parentId"], lines[1]["id"]);
        let (h, back) = import(&text).expect("import");
        assert_eq!(h, Some(header));
        assert_eq!(back, msgs);
    }
}
