//! Anthropic Messages: the request body and the stream decoder.
//!
//! Reasoning is asked for in its readable form, adaptive thinking with `display: "summarized"`, and effort goes in
//! `output_config.effort` (`low` to `max`, `xhigh` included). Models before Claude 4.6 take a thinking budget
//! instead. Claude 4.7 and the 5 generation take no sampling parameter and no assistant prefill: such a request is
//! refused before any network call. A thinking block's signature is surfaced as `providerMeta.anthropic` and
//! replayed byte for byte.

use serde_json::{Map, Value, json};

use crate::LlmError;
use crate::caps::{self, Maker};
use crate::decode::Decoder;
use crate::errors;
use crate::sse::SseEvent;
use crate::types::{ChatEvent, Effort, Part, Refusal, Request, Role, StopReason, Usage};

/// The `anthropic-version` header value.
pub const VERSION: &str = "2023-06-01";

fn meta_of(meta: Option<&Value>) -> Option<&Map<String, Value>> {
    meta?.get("anthropic")?.as_object()
}

fn content_of(part: &Part) -> Option<Value> {
    match part {
        Part::Text { text } if text.is_empty() => None,
        Part::Text { text } => Some(json!({"type": "text", "text": text})),
        Part::Reasoning { text, provider_meta } => {
            // Only a block this provider signed is replayed; another provider's reasoning is display-only.
            let own = meta_of(provider_meta.as_ref())?;
            match own.get("type").and_then(Value::as_str) {
                Some("thinking") => Some(json!({
                    "type": "thinking",
                    "thinking": text,
                    "signature": own.get("signature").cloned().unwrap_or(Value::Null),
                })),
                Some("redacted_thinking") => Some(json!({
                    "type": "redacted_thinking",
                    "data": own.get("data").cloned().unwrap_or(Value::Null),
                })),
                _ => None,
            }
        }
        Part::ToolCall {
            call_id, name, input, ..
        } => Some(json!({
            "type": "tool_use",
            "id": call_id,
            "name": name,
            "input": if input.is_object() { input.clone() } else { json!({}) },
        })),
        Part::ToolResult {
            call_id,
            content,
            is_error,
            ..
        } => Some(json!({
            "type": "tool_result",
            "tool_use_id": call_id,
            "content": content,
            "is_error": is_error,
        })),
    }
}

/// The JSON body of a streaming Messages call; `InvalidInput` for a request the model refuses.
pub fn body(req: &Request) -> Result<Value, LlmError> {
    let caps = caps::anthropic_caps(&req.model);
    let levels = caps::effort_levels(Maker::Anthropic, &req.model);
    if req.sampling.is_set() && !caps.sampling {
        return Err(LlmError::InvalidInput(format!(
            "{} takes no sampling parameter (temperature, top_p, top_k)",
            req.model
        )));
    }
    if !caps.prefill && req.messages.last().is_some_and(|m| m.role == Role::Assistant) {
        return Err(LlmError::InvalidInput(format!(
            "{} takes no assistant prefill: the last message must be the user's",
            req.model
        )));
    }
    if let Some(e) = req.effort
        && !levels.contains(&e)
    {
        return Err(LlmError::InvalidInput(format!(
            "{} does not take effort {e}",
            req.model
        )));
    }

    let messages: Vec<Value> = req
        .messages
        .iter()
        .filter_map(|m| {
            let content: Vec<Value> = m.content.iter().filter_map(content_of).collect();
            (!content.is_empty()).then(|| {
                json!({
                    "role": if m.role == Role::User { "user" } else { "assistant" },
                    "content": content,
                })
            })
        })
        .collect();

    let mut max_tokens = req.max_output_tokens.unwrap_or(caps.max_output);
    let mut body = Map::new();
    body.insert("model".into(), json!(req.model));
    body.insert("stream".into(), json!(true));
    body.insert("messages".into(), Value::Array(messages));
    if !req.system.is_empty() {
        body.insert("system".into(), json!(req.system));
    }
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                    "eager_input_streaming": true,
                })
            })
            .collect();
        body.insert("tools".into(), Value::Array(tools));
    }
    if let Some(t) = req.sampling.temperature {
        body.insert("temperature".into(), json!(t));
    }
    if let Some(p) = req.sampling.top_p {
        body.insert("top_p".into(), json!(p));
    }
    if let Some(k) = req.sampling.top_k {
        body.insert("top_k".into(), json!(k));
    }
    if !levels.is_empty() {
        if caps.budgeted {
            if let Some(budget) = req.effort.and_then(caps::anthropic_budget) {
                if req.sampling.is_set() {
                    return Err(LlmError::InvalidInput(
                        "a thinking budget cannot be combined with sampling parameters".into(),
                    ));
                }
                max_tokens = max_tokens.max(budget + 1024);
                body.insert("thinking".into(), json!({"type": "enabled", "budget_tokens": budget}));
            }
        } else {
            if !req.sampling.is_set() {
                body.insert("thinking".into(), json!({"type": "adaptive", "display": "summarized"}));
            }
            if let Some(e) = req.effort.filter(|e| !matches!(e, Effort::None | Effort::Minimal)) {
                body.insert("output_config".into(), json!({"effort": e.as_str()}));
            }
        }
    }
    body.insert("max_tokens".into(), json!(max_tokens));
    Ok(Value::Object(body))
}

#[derive(Debug)]
enum Block {
    Text,
    Thinking {
        signature: String,
    },
    Redacted {
        data: String,
    },
    Tool {
        call_id: String,
        name: String,
        json: String,
    },
    Other,
}

/// Turns Messages stream events into [`ChatEvent`]s.
#[derive(Debug, Default)]
pub struct AnthropicDecoder {
    blocks: Vec<(u64, Block)>,
    usage: Usage,
    model: Option<String>,
    stop: Option<(StopReason, String, Option<Refusal>)>,
    done: bool,
    key: Option<String>,
}

impl AnthropicDecoder {
    /// A decoder that scrubs `key` from error messages.
    pub fn new(key: Option<String>) -> AnthropicDecoder {
        AnthropicDecoder {
            key,
            ..AnthropicDecoder::default()
        }
    }

    fn take_block(&mut self, index: u64) -> Option<Block> {
        let at = self.blocks.iter().position(|(i, _)| *i == index)?;
        Some(self.blocks.remove(at).1)
    }

    fn block_mut(&mut self, index: u64) -> Option<&mut Block> {
        self.blocks.iter_mut().find(|(i, _)| *i == index).map(|(_, b)| b)
    }

    fn read_usage(&mut self, u: &Value) {
        let n = |k: &str| u.get(k).and_then(Value::as_u64);
        let (base, read, write) = (
            n("input_tokens"),
            n("cache_read_input_tokens"),
            n("cache_creation_input_tokens"),
        );
        if base.is_some() || read.is_some() || write.is_some() {
            let read = read.or(self.usage.cache_read).unwrap_or(0);
            let write = write.or(self.usage.cache_write).unwrap_or(0);
            self.usage.input = Some(base.unwrap_or(0) + read + write);
            self.usage.cache_read = Some(read);
            self.usage.cache_write = Some(write);
        }
        if let Some(o) = n("output_tokens") {
            self.usage.output = Some(o);
        }
    }
}

fn stop_of(raw: &str) -> StopReason {
    match raw {
        "end_turn" => StopReason::End,
        "max_tokens" | "model_context_window_exceeded" => StopReason::Length,
        "tool_use" => StopReason::ToolCalls,
        "stop_sequence" => StopReason::StopSequence,
        "refusal" => StopReason::Refusal,
        "pause_turn" => StopReason::Pause,
        _ => StopReason::Other,
    }
}

impl Decoder for AnthropicDecoder {
    fn event(&mut self, ev: &SseEvent, out: &mut Vec<ChatEvent>) {
        if self.done {
            return;
        }
        let Ok(data) = serde_json::from_str::<Value>(&ev.data) else {
            return;
        };
        let kind = data.get("type").and_then(Value::as_str).unwrap_or(ev.event.as_str());
        let index = data.get("index").and_then(Value::as_u64).unwrap_or(0);
        match kind {
            "message_start" => {
                let msg = &data["message"];
                self.model = msg.get("model").and_then(Value::as_str).map(str::to_owned);
                if let Some(u) = msg.get("usage") {
                    self.read_usage(u);
                }
            }
            "content_block_start" => {
                let cb = &data["content_block"];
                let s = |k: &str| cb.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
                let block = match cb.get("type").and_then(Value::as_str) {
                    Some("text") => Block::Text,
                    Some("thinking") => Block::Thinking {
                        signature: s("signature"),
                    },
                    Some("redacted_thinking") => Block::Redacted { data: s("data") },
                    Some("tool_use") => {
                        let (call_id, name) = (s("id"), s("name"));
                        out.push(ChatEvent::ToolCallStart {
                            call_id: call_id.clone(),
                            name: name.clone(),
                        });
                        Block::Tool {
                            call_id,
                            name,
                            json: String::new(),
                        }
                    }
                    _ => Block::Other,
                };
                self.blocks.push((index, block));
            }
            "content_block_delta" => {
                let delta = &data["delta"];
                let text = |k: &str| delta.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
                let id = index.to_string();
                match (delta.get("type").and_then(Value::as_str), self.block_mut(index)) {
                    (Some("text_delta"), _) => out.push(ChatEvent::TextDelta { id, text: text("text") }),
                    (Some("thinking_delta"), _) => out.push(ChatEvent::ReasoningDelta {
                        id,
                        text: text("thinking"),
                    }),
                    (Some("signature_delta"), Some(Block::Thinking { signature })) => {
                        signature.push_str(&text("signature"));
                    }
                    (Some("input_json_delta"), Some(Block::Tool { call_id, json, .. })) => {
                        let piece = text("partial_json");
                        json.push_str(&piece);
                        let call_id = call_id.clone();
                        out.push(ChatEvent::ToolCallDelta { call_id, delta: piece });
                    }
                    _ => {}
                }
            }
            "content_block_stop" => match self.take_block(index) {
                Some(Block::Thinking { signature }) => out.push(ChatEvent::ReasoningEnd {
                    id: index.to_string(),
                    provider_meta: (!signature.is_empty())
                        .then(|| json!({"anthropic": {"type": "thinking", "signature": signature}})),
                }),
                Some(Block::Redacted { data }) => out.push(ChatEvent::ReasoningEnd {
                    id: index.to_string(),
                    provider_meta: Some(json!({"anthropic": {"type": "redacted_thinking", "data": data}})),
                }),
                Some(Block::Tool { call_id, name, json }) => {
                    let input = if json.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&json).unwrap_or(Value::Null)
                    };
                    out.push(ChatEvent::ToolCall {
                        call_id,
                        name,
                        input,
                        provider_meta: None,
                    });
                }
                _ => {}
            },
            "message_delta" => {
                if let Some(u) = data.get("usage") {
                    self.read_usage(u);
                }
                let delta = &data["delta"];
                if let Some(raw) = delta.get("stop_reason").and_then(Value::as_str) {
                    let refusal = (raw == "refusal").then(|| {
                        let d = &delta["stop_details"];
                        Refusal {
                            category: d.get("category").and_then(Value::as_str).map(str::to_owned),
                            explanation: d.get("explanation").and_then(Value::as_str).map(str::to_owned),
                        }
                    });
                    self.stop = Some((stop_of(raw), raw.to_owned(), refusal));
                }
                out.push(ChatEvent::Usage { usage: self.usage });
            }
            "message_stop" => {
                let (stop, raw, refusal) = self.stop.take().unwrap_or((StopReason::Other, String::new(), None));
                out.push(ChatEvent::Finish {
                    stop,
                    raw: (!raw.is_empty()).then_some(raw),
                    refusal,
                    served_by: self.model.clone(),
                });
                self.done = true;
            }
            "error" => {
                out.push(ChatEvent::Error {
                    error: errors::from_stream(&data, self.key.as_deref()),
                });
                self.done = true;
            }
            _ => {}
        }
    }

    fn end(&mut self, out: &mut Vec<ChatEvent>) {
        if !self.done {
            self.done = true;
            out.push(ChatEvent::Error {
                error: errors::truncated(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Message, Sampling, ToolSpec};

    fn req(model: &str) -> Request {
        Request {
            model: model.into(),
            messages: vec![Message::user("hi")],
            ..Request::default()
        }
    }

    #[test]
    fn claude_5_gets_adaptive_summarized_thinking_and_effort() {
        let mut r = req("claude-opus-5-5");
        r.effort = Some(Effort::Xhigh);
        let b = body(&r).expect("valid");
        assert_eq!(b["thinking"], json!({"type": "adaptive", "display": "summarized"}));
        assert_eq!(b["output_config"]["effort"], "xhigh");
        assert_eq!(b["max_tokens"], 128_000);
        assert!(b.get("temperature").is_none());
    }

    #[test]
    fn claude_5_refuses_sampling_and_prefill() {
        let mut r = req("claude-sonnet-5-5");
        r.sampling = Sampling {
            temperature: Some(0.2),
            ..Sampling::default()
        };
        assert!(matches!(body(&r), Err(LlmError::InvalidInput(_))));
        let mut r = req("claude-opus-5-5");
        r.messages.push(Message::assistant("Sure,"));
        assert!(matches!(body(&r), Err(LlmError::InvalidInput(_))));
        let mut r = req("claude-haiku-4-5");
        r.messages.push(Message::assistant("Sure,"));
        assert!(body(&r).is_ok());
    }

    #[test]
    fn an_effort_the_model_does_not_take_is_refused() {
        let mut r = req("claude-sonnet-4-6");
        r.effort = Some(Effort::Xhigh);
        assert!(body(&r).is_err());
        r.effort = Some(Effort::Max);
        assert!(body(&r).is_ok());
    }

    #[test]
    fn old_models_take_a_thinking_budget() {
        let mut r = req("claude-haiku-4-5");
        r.effort = Some(Effort::Medium);
        let b = body(&r).expect("valid");
        assert_eq!(b["thinking"]["budget_tokens"], 8192);
        assert!(b.get("output_config").is_none());
    }

    #[test]
    fn signed_thinking_is_replayed_and_foreign_reasoning_dropped() {
        let mut r = req("claude-opus-5-5");
        r.messages.push(Message {
            role: Role::Assistant,
            content: vec![
                Part::Reasoning {
                    text: "t".into(),
                    provider_meta: Some(json!({"anthropic": {"type": "thinking", "signature": "SIG=="}})),
                },
                Part::Reasoning {
                    text: "other".into(),
                    provider_meta: Some(json!({"google": {}})),
                },
                Part::ToolCall {
                    call_id: "toolu_1".into(),
                    name: "read".into(),
                    input: json!({"path": "a"}),
                    provider_meta: None,
                },
            ],
        });
        r.messages.push(Message {
            role: Role::User,
            content: vec![Part::ToolResult {
                call_id: "toolu_1".into(),
                name: "read".into(),
                content: "x".into(),
                is_error: false,
            }],
        });
        r.tools.push(ToolSpec {
            name: "read".into(),
            description: "d".into(),
            input_schema: json!({"type": "object"}),
        });
        let b = body(&r).expect("valid");
        let assistant = &b["messages"][1]["content"];
        assert_eq!(assistant.as_array().map(Vec::len), Some(2));
        assert_eq!(
            assistant[0],
            json!({"type": "thinking", "thinking": "t", "signature": "SIG=="})
        );
        assert_eq!(b["messages"][2]["content"][0]["tool_use_id"], "toolu_1");
        assert_eq!(b["tools"][0]["eager_input_streaming"], true);
    }
}
