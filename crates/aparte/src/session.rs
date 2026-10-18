//! CLI sessions as conversations of the vault (spec/DATA-MODEL.md sections 3.2 and 4): what the agent says is
//! committed as immutable messages of an append-only tree, with the parts the web app reads (`reasoning` and
//! `tool-call` parts keep their `providerMeta` byte for byte), so a chat started here shows in the web app after a
//! sync, and one started there continues here.
//!
//! - A new session creates a conversation whose `system` and `tools` are frozen when its first message is written.
//! - `--session <id>` continues a conversation from its leaf, `--branch-from <message>` from an earlier message (the
//!   new messages become a sibling branch). The request is built from the path with the replay rules of section 5:
//!   errors, refusals and deleted messages are left out, a stopped answer loses its tool calls, a `system` message is
//!   sent as a `<system-update>`, a picture as `[image omitted: name]`.
//! - Each assistant message carries its model (`{provider: <provider entity id>, id}`), its effort, its usage and
//!   why it stopped; the provider entity is found in the vault (or added, without any key) by kind.

use std::sync::{Arc, Mutex, PoisonError};

use anyhow::{Context, bail};
use aparte_agent::{AgentEvent, EndReason, EventSink, RunOutcome, Tool};
use aparte_llm::providers::Preset;
use aparte_llm::{Effort, Message, Part, Protocol, Role, StopReason, Usage};
use aparte_sync::workspace::{ModelRef, NewConversation, NewMessage, Workspace};
use serde_json::{Value, json};

/// The adapter kind and preset of a CLI provider in the vault's terms (spec/DATA-MODEL.md section 3.3).
pub fn provider_kind(preset: &Preset) -> (&'static str, Option<&'static str>) {
    match preset.id {
        "anthropic" => ("anthropic", None),
        "openai" => ("openai", None),
        "google" => ("google", None),
        "mistral" => ("mistral", None),
        "openrouter" => ("openrouter", None),
        other => match preset.protocol {
            Protocol::OpenaiChat | Protocol::OpenaiResponses => ("openai-compatible", Some(other)),
            Protocol::Anthropic => ("anthropic", None),
            Protocol::Gemini => ("google", None),
        },
    }
}

/// The id of the vault's provider entity for `preset`: an existing one of the same kind (and preset), else a new
/// one without any key.
pub fn ensure_provider(ws: &Workspace, preset: &Preset, base_url: Option<&str>) -> anyhow::Result<String> {
    let (kind, sub) = provider_kind(preset);
    for p in ws.providers()? {
        let same_preset = sub.is_none_or(|s| p.fields.get("preset").and_then(Value::as_str) == Some(s));
        if p.kind == kind && same_preset {
            return Ok(p.id);
        }
    }
    let base = (kind == "openai-compatible").then(|| base_url.unwrap_or(preset.base_url));
    Ok(ws.create_provider(kind, preset.label, sub, base)?)
}

/// The fingerprint of a tool (spec/DATA-MODEL.md section 8.2): base64url SHA-256 of the canonical JSON of its
/// name, description, input schema and the three annotation booleans.
pub fn fingerprint(tool: &dyn Tool) -> String {
    let a = tool.annotations();
    let def = json!({
        "name": tool.name(),
        "description": tool.description(),
        "inputSchema": tool.input_schema(),
        "annotations": {"readOnly": a.read_only, "destructive": a.destructive, "openWorld": a.open_world},
    });
    let canonical =
        aparte_format::encoding::canonical_json(&def).unwrap_or_else(|_| aparte_mcp::pins::canonical_json(&def));
    aparte_format::encoding::base64url_encode(&aparte_crypto::primitives::sha256(canonical.as_bytes()))
}

/// The tool snapshot of a conversation (spec/DATA-MODEL.md section 3.2), sorted by name.
pub fn tool_snapshot(tools: &[Arc<dyn Tool>]) -> Value {
    let mut entries: Vec<Value> = tools
        .iter()
        .map(|t| {
            let name = t.name();
            let (source, origin) = if aparte_tools::NAMES.contains(&name) {
                ("builtin", None)
            } else if name == "skill" {
                ("skill", None)
            } else {
                ("mcp", name.strip_prefix("mcp__").and_then(|r| r.split("__").next()))
            };
            let mut e = json!({"name": name, "source": source, "fingerprint": fingerprint(t.as_ref())});
            if let Some(o) = origin {
                e["origin"] = json!(o);
            }
            e
        })
        .collect();
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Value::Array(entries)
}

/// An agent message as the parts and role of a vault message.
pub fn to_vault(m: &Message) -> (&'static str, Vec<Value>) {
    let results = !m.content.is_empty() && m.content.iter().all(|p| matches!(p, Part::ToolResult { .. }));
    let role = match m.role {
        Role::Assistant => "assistant",
        Role::User if results => "tool",
        Role::User => "user",
    };
    let parts = m
        .content
        .iter()
        .map(|p| match p {
            Part::Text { text } => json!({"type": "text", "text": text}),
            Part::Reasoning { text, provider_meta } => {
                let mut v = json!({"type": "reasoning", "text": text});
                if let Some(meta) = provider_meta {
                    v["providerMeta"] = meta.clone();
                }
                v
            }
            Part::ToolCall {
                call_id,
                name,
                input,
                provider_meta,
            } => {
                let mut v = json!({"type": "tool-call", "callId": call_id, "name": name, "input": input});
                if let Some(meta) = provider_meta {
                    v["providerMeta"] = meta.clone();
                }
                v
            }
            Part::ToolResult {
                call_id,
                name,
                content,
                is_error,
            } => {
                let mut v = json!({"type": "tool-result", "callId": call_id, "name": name, "output": content});
                if *is_error {
                    v["isError"] = json!(true);
                }
                v
            }
            Part::Provider { provider, block } => json!({"type": "provider", "provider": provider, "block": block}),
        })
        .collect();
    (role, parts)
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// The agent history of a vault path, with the replay rules of spec/DATA-MODEL.md section 5.
pub fn to_agent(path: &[aparte_sync::Message]) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::new();
    for m in path {
        if m.deleted_at.is_some() || (m.role == "assistant" && matches!(m.status.as_str(), "error" | "refused")) {
            continue;
        }
        let stopped = m.status == "stopped";
        let mut content = Vec::new();
        for p in &m.parts {
            let kind = p.get("type").and_then(Value::as_str).unwrap_or_default();
            let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
            match (m.role.as_str(), kind) {
                (_, "text") => content.push(Part::Text { text: s("text") }),
                ("assistant", "reasoning") => content.push(Part::Reasoning {
                    text: s("text"),
                    provider_meta: p.get("providerMeta").cloned(),
                }),
                ("assistant", "tool-call") if !stopped => content.push(Part::ToolCall {
                    call_id: s("callId"),
                    name: s("name"),
                    input: p.get("input").cloned().unwrap_or(Value::Null),
                    provider_meta: p.get("providerMeta").cloned(),
                }),
                ("assistant", "provider") => content.push(Part::Provider {
                    provider: s("provider"),
                    block: p.get("block").cloned().unwrap_or(Value::Null),
                }),
                ("tool", "tool-result") => content.push(Part::ToolResult {
                    call_id: s("callId"),
                    name: s("name"),
                    content: p.get("output").map(text_of).unwrap_or_default(),
                    is_error: p.get("isError") == Some(&Value::Bool(true)),
                }),
                (_, "image") => content.push(Part::Text {
                    text: format!(
                        "[image omitted: {}]",
                        p.get("name").and_then(Value::as_str).unwrap_or("image")
                    ),
                }),
                (_, "file") => content.push(Part::Text {
                    text: format!("[document omitted: {}]", s("name")),
                }),
                _ => {}
            }
        }
        if m.role == "system" {
            let text: String = content
                .iter()
                .filter_map(|p| match p {
                    Part::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            content = vec![Part::Text {
                text: format!("<system-update>\n{text}\n</system-update>"),
            }];
        }
        if content.is_empty() {
            continue;
        }
        out.push(Message {
            role: if m.role == "assistant" {
                Role::Assistant
            } else {
                Role::User
            },
            content,
        });
    }
    out
}

/// What the events said about each model call: its usage and why it stopped.
#[derive(Debug, Default)]
struct Turns {
    current: Usage,
    done: Vec<(Usage, Option<StopReason>)>,
    refusal: Option<(Option<String>, Option<String>)>,
}

/// Records a session into a conversation of the vault.
pub struct Recorder {
    conv: String,
    parent: Option<String>,
    provider: String,
    model: String,
    effort: Option<Effort>,
    /// Agent messages already in the vault.
    recorded: usize,
    turns: Arc<Mutex<Turns>>,
    titled: bool,
}

impl Recorder {
    /// A recorder for a new conversation, or for `session` continued from its leaf (or from `branch_from`).
    /// Returns it with the history to give the agent, and the frozen system prompt of a continued conversation.
    pub fn start(
        ws: &Workspace,
        session: Option<&str>,
        branch_from: Option<&str>,
        provider: String,
        model: String,
        effort: Option<Effort>,
    ) -> anyhow::Result<(Recorder, Vec<Message>, Option<String>)> {
        let (conv, parent, history, system, titled) = match session {
            Some(id) => {
                let c = ws
                    .conversation(id)?
                    .with_context(|| format!("no conversation {id} in the vault"))?;
                if c.purged_at.is_some() || c.deleted_at.is_some() {
                    bail!("the conversation {id} is in the trash");
                }
                let leaf = match branch_from {
                    Some(m) => Some(m.to_owned()),
                    None => c.leaf.clone(),
                };
                let path = ws.path(id, leaf.as_deref())?;
                let system = (!c.system.is_empty()).then(|| c.system.clone());
                (c.id.clone(), leaf, to_agent(&path), system, !c.title.is_empty())
            }
            None => {
                if branch_from.is_some() {
                    bail!("--branch-from needs --session");
                }
                (String::new(), None, Vec::new(), None, false)
            }
        };
        let recorded = history.len();
        Ok((
            Recorder {
                conv,
                parent,
                provider,
                model,
                effort,
                recorded,
                turns: Arc::new(Mutex::new(Turns::default())),
                titled,
            },
            history,
            system,
        ))
    }

    /// The conversation id (empty until the first commit of a new session).
    pub fn conversation(&self) -> &str {
        &self.conv
    }

    /// Wraps the agent's event sink to learn each call's usage and stop reason.
    pub fn sink(&self, inner: EventSink) -> EventSink {
        let turns = self.turns.clone();
        Arc::new(move |ev: &AgentEvent| {
            {
                let mut t = turns.lock().unwrap_or_else(PoisonError::into_inner);
                match ev {
                    AgentEvent::Usage { usage } => t.current = *usage,
                    AgentEvent::TurnEnd { stop, .. } => {
                        let usage = std::mem::take(&mut t.current);
                        t.done.push((usage, Some(*stop)));
                    }
                    AgentEvent::Refusal { category, explanation } => {
                        t.refusal = Some((category.clone(), explanation.clone()));
                    }
                    _ => {}
                }
            }
            inner(ev);
        })
    }

    /// Commits the messages the agent added since the last commit, chained from the current parent, and moves the
    /// leaf to the last one (unless another device moved it meanwhile). A run that ended in an error or a refusal
    /// without an answer leaves an `error` or `refused` assistant message, as the web app does.
    pub fn commit(
        &mut self,
        ws: &Workspace,
        system: &str,
        tools: &Value,
        messages: &[Message],
        outcome: Option<&RunOutcome>,
    ) -> anyhow::Result<usize> {
        let fresh = messages.get(self.recorded..).unwrap_or_default();
        let ended_badly = outcome.is_some_and(|o| matches!(o.reason, EndReason::Error | EndReason::Refusal));
        if fresh.is_empty() && !ended_badly {
            return Ok(0);
        }
        if self.conv.is_empty() {
            self.conv = ws.create_conversation(NewConversation {
                title: None,
                model: Some(self.model_ref()),
                effort: self.effort.map(|e| e.as_str().to_owned()),
                system: Some(system.to_owned()),
                tools: Some(tools.clone()),
            })?;
        }
        let before_leaf = ws.conversation(&self.conv)?.and_then(|c| c.leaf);
        let mut turns = {
            let mut t = self.turns.lock().unwrap_or_else(PoisonError::into_inner);
            std::mem::take(&mut t.done).into_iter()
        };
        let mut written = 0;
        let mut last_was_answer = false;
        for m in fresh {
            let (role, parts) = to_vault(m);
            let id = ws.new_id()?;
            let mut nm = NewMessage::new(&id, self.parent.clone(), role, parts);
            if role == "assistant" {
                let (usage, stop) = turns.next().unwrap_or_default();
                nm.model = Some(self.model_ref());
                nm.effort = self.effort.map(|e| e.as_str().to_owned());
                nm.usage = usage_json(&usage);
                nm.stop = stop
                    .and_then(|s| serde_json::to_value(s).ok())
                    .and_then(|v| v.as_str().map(str::to_owned));
                last_was_answer = true;
            } else {
                last_was_answer = false;
            }
            if !self.titled
                && role == "user"
                && let Some(text) = m.content.iter().find_map(|p| match p {
                    Part::Text { text } => Some(text.as_str()),
                    _ => None,
                })
            {
                ws.set_title(&self.conv, &title_of(text))?;
                self.titled = true;
            }
            ws.commit_message(&self.conv, &nm)?;
            self.parent = Some(id);
            written += 1;
        }
        if let Some(o) = outcome
            && ended_badly
            && !last_was_answer
        {
            let id = ws.new_id()?;
            let mut nm = NewMessage::new(&id, self.parent.clone(), "assistant", Vec::new());
            nm.model = Some(self.model_ref());
            nm.effort = self.effort.map(|e| e.as_str().to_owned());
            if o.reason == EndReason::Refusal {
                let (category, explanation) = self
                    .turns
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .refusal
                    .take()
                    .unwrap_or_default();
                nm.status = "refused".into();
                nm.stop = Some("refusal".into());
                let mut r = json!({"category": category});
                if let Some(e) = explanation {
                    r["explanation"] = json!(e);
                }
                nm.refusal = Some(r);
            } else {
                nm.status = "error".into();
                let (code, message) = o.error.as_ref().map_or(("unknown".to_owned(), String::new()), |e| {
                    (
                        serde_json::to_value(e.code)
                            .ok()
                            .and_then(|v| v.as_str().map(str::to_owned))
                            .unwrap_or_else(|| "unknown".into()),
                        e.message.clone(),
                    )
                });
                nm.error = Some(json!({"code": code, "message": message}));
            }
            ws.commit_message(&self.conv, &nm)?;
            self.parent = Some(id);
            written += 1;
        }
        // Another device (or a branch switch in the web app) that moved the leaf meanwhile wins.
        if let Some(leaf) = &self.parent {
            ws.set_leaf(&self.conv, Some(leaf), Some(before_leaf.as_deref()))?;
        }
        self.recorded = messages.len();
        Ok(written)
    }

    fn model_ref(&self) -> ModelRef {
        ModelRef {
            provider: self.provider.clone(),
            id: self.model.clone(),
        }
    }
}

fn usage_json(u: &Usage) -> Option<Value> {
    let v = serde_json::to_value(u).ok()?;
    v.as_object().is_some_and(|o| !o.is_empty()).then_some(v)
}

/// A title from the first user message: its first line, at most 60 characters.
pub fn title_of(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if line.chars().count() > 60 {
        format!("{}…", line.chars().take(59).collect::<String>())
    } else {
        line.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_messages_map_to_vault_parts_and_back() {
        let answer = Message {
            role: Role::Assistant,
            content: vec![
                Part::Reasoning {
                    text: "hmm".into(),
                    provider_meta: Some(json!({"anthropic": {"type": "thinking", "signature": "sig"}})),
                },
                Part::Text {
                    text: "Let me look.".into(),
                },
                Part::ToolCall {
                    call_id: "c1".into(),
                    name: "read".into(),
                    input: json!({"path": "a"}),
                    provider_meta: None,
                },
            ],
        };
        let results = Message {
            role: Role::User,
            content: vec![Part::ToolResult {
                call_id: "c1".into(),
                name: "read".into(),
                content: "text".into(),
                is_error: false,
            }],
        };
        let (role, parts) = to_vault(&answer);
        assert_eq!(role, "assistant");
        assert_eq!(parts[0]["providerMeta"]["anthropic"]["signature"], "sig");
        assert_eq!(parts[2]["type"], "tool-call");
        let (role, parts) = to_vault(&results);
        assert_eq!(role, "tool");
        assert_eq!(parts[0]["output"], "text");
        assert_eq!(title_of("\n  Hello there\nsecond"), "Hello there");
        assert_eq!(title_of(&"x".repeat(80)).chars().count(), 60);
    }
}
