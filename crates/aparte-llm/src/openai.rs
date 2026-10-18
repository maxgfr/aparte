//! OpenAI chat completions, the protocol OpenAI and most other servers speak (Groq, DeepSeek, xAI, Mistral,
//! OpenRouter, Ollama, LM Studio, vLLM): the request body and the stream decoder. Reasoning arrives as
//! `reasoning_content` (DeepSeek's field) or `reasoning`; effort is sent as `reasoning_effort` to OpenAI's own models
//! only, since another server may refuse a parameter it does not know.

use serde_json::{Map, Value, json};

use crate::LlmError;
use crate::caps::{self, Maker};
use crate::decode::Decoder;
use crate::errors;
use crate::sse::SseEvent;
use crate::types::{ChatEvent, Part, Request, Role, StopReason, Usage};

/// The JSON body of a streaming chat completions call.
pub fn body(req: &Request, maker: Maker) -> Result<Value, LlmError> {
    let levels = caps::effort_levels(maker, &req.model);
    if let Some(e) = req.effort
        && !levels.contains(&e)
    {
        return Err(LlmError::InvalidInput(format!(
            "{} does not take effort {e} here",
            req.model
        )));
    }
    if req.sampling.top_k.is_some() {
        return Err(LlmError::InvalidInput("chat completions take no top_k".into()));
    }
    let mut messages = Vec::new();
    if !req.system.is_empty() {
        messages.push(json!({"role": "system", "content": req.system}));
    }
    for m in &req.messages {
        let mut text = String::new();
        let mut calls = Vec::new();
        for p in &m.content {
            match p {
                Part::Text { text: t } => text.push_str(t),
                Part::ToolCall {
                    call_id, name, input, ..
                } => calls.push(json!({
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": input.to_string()},
                })),
                Part::ToolResult { call_id, content, .. } => messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": content,
                })),
                Part::Reasoning { .. } | Part::Provider { .. } => {}
            }
        }
        match m.role {
            Role::User if !text.is_empty() => messages.push(json!({"role": "user", "content": text})),
            Role::User => {}
            Role::Assistant => {
                if text.is_empty() && calls.is_empty() {
                    continue;
                }
                let mut a = Map::new();
                a.insert("role".into(), json!("assistant"));
                a.insert(
                    "content".into(),
                    if text.is_empty() { Value::Null } else { json!(text) },
                );
                if !calls.is_empty() {
                    a.insert("tool_calls".into(), Value::Array(calls));
                }
                messages.push(Value::Object(a));
            }
        }
    }
    let mut body = Map::new();
    body.insert("model".into(), json!(req.model));
    body.insert("messages".into(), Value::Array(messages));
    body.insert("stream".into(), json!(true));
    body.insert("stream_options".into(), json!({"include_usage": true}));
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {"name": t.name, "description": t.description, "parameters": t.input_schema},
                })
            })
            .collect();
        body.insert("tools".into(), Value::Array(tools));
    }
    if let Some(max) = req.max_output_tokens {
        let field = if maker == Maker::OpenAi {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        body.insert(field.into(), json!(max));
    }
    if let Some(t) = req.sampling.temperature {
        body.insert("temperature".into(), json!(t));
    }
    if let Some(p) = req.sampling.top_p {
        body.insert("top_p".into(), json!(p));
    }
    if let Some(e) = req.effort {
        body.insert("reasoning_effort".into(), json!(e.as_str()));
    }
    Ok(Value::Object(body))
}

#[derive(Debug, Default)]
struct PendingCall {
    id: String,
    name: String,
    args: String,
}

/// Turns chat completion chunks into [`ChatEvent`]s.
#[derive(Debug, Default)]
pub struct OpenAiDecoder {
    key: Option<String>,
    reasoning_open: bool,
    calls: Vec<(u64, PendingCall)>,
    finish: Option<String>,
    usage: Option<Usage>,
    model: Option<String>,
    done: bool,
}

impl OpenAiDecoder {
    /// A decoder that scrubs `key` from error messages.
    pub fn new(key: Option<String>) -> OpenAiDecoder {
        OpenAiDecoder {
            key,
            ..OpenAiDecoder::default()
        }
    }

    fn close_reasoning(&mut self, out: &mut Vec<ChatEvent>) {
        if self.reasoning_open {
            self.reasoning_open = false;
            out.push(ChatEvent::ReasoningEnd {
                id: "reasoning".into(),
                provider_meta: None,
            });
        }
    }

    fn complete(&mut self, out: &mut Vec<ChatEvent>) {
        self.close_reasoning(out);
        let calls = std::mem::take(&mut self.calls);
        let had_calls = !calls.is_empty();
        for (_, c) in calls {
            let input = if c.args.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&c.args).unwrap_or(Value::Null)
            };
            out.push(ChatEvent::ToolCall {
                call_id: c.id,
                name: c.name,
                input,
                provider_meta: None,
            });
        }
        if let Some(u) = self.usage {
            out.push(ChatEvent::Usage { usage: u });
        }
        let raw = self.finish.take().unwrap_or_default();
        let stop = match raw.as_str() {
            "stop" if had_calls => StopReason::ToolCalls,
            "stop" => StopReason::End,
            "length" => StopReason::Length,
            "tool_calls" | "function_call" => StopReason::ToolCalls,
            "content_filter" => StopReason::ContentFilter,
            _ => StopReason::Other,
        };
        out.push(ChatEvent::Finish {
            stop,
            raw: (!raw.is_empty()).then_some(raw),
            refusal: None,
            served_by: self.model.clone(),
        });
        self.done = true;
    }
}

impl Decoder for OpenAiDecoder {
    fn event(&mut self, ev: &SseEvent, out: &mut Vec<ChatEvent>) {
        if self.done {
            return;
        }
        if ev.data.trim() == "[DONE]" {
            if self.finish.is_some() {
                self.complete(out);
            }
            return;
        }
        let Ok(data) = serde_json::from_str::<Value>(&ev.data) else {
            return;
        };
        if data.get("error").is_some() {
            out.push(ChatEvent::Error {
                error: errors::from_stream(&data, self.key.as_deref()),
            });
            self.done = true;
            return;
        }
        if let Some(m) = data.get("model").and_then(Value::as_str) {
            self.model = Some(m.to_owned());
        }
        if let Some(u) = data.get("usage").filter(|u| u.is_object()) {
            let n = |v: &Value| v.as_u64();
            self.usage = Some(Usage {
                input: u.get("prompt_tokens").and_then(n),
                output: u.get("completion_tokens").and_then(n),
                cache_read: Some(
                    u.pointer("/prompt_tokens_details/cached_tokens")
                        .and_then(n)
                        .unwrap_or(0),
                ),
                cache_write: None,
                reasoning: Some(
                    u.pointer("/completion_tokens_details/reasoning_tokens")
                        .and_then(n)
                        .unwrap_or(0),
                ),
            });
        }
        let Some(choice) = data.get("choices").and_then(Value::as_array).and_then(|c| c.first()) else {
            return;
        };
        let delta = &choice["delta"];
        let reasoning = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !reasoning.is_empty() {
            self.reasoning_open = true;
            out.push(ChatEvent::ReasoningDelta {
                id: "reasoning".into(),
                text: reasoning.to_owned(),
            });
        }
        if let Some(text) = delta.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            self.close_reasoning(out);
            out.push(ChatEvent::TextDelta {
                id: "text".into(),
                text: text.to_owned(),
            });
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            self.close_reasoning(out);
            for c in calls {
                let index = c.get("index").and_then(Value::as_u64).unwrap_or(0);
                let at = match self.calls.iter().position(|(i, _)| *i == index) {
                    Some(at) => at,
                    None => {
                        self.calls.push((index, PendingCall::default()));
                        self.calls.len() - 1
                    }
                };
                let pending = &mut self.calls[at].1;
                if let Some(id) = c.get("id").and_then(Value::as_str) {
                    pending.id = id.to_owned();
                }
                if let Some(name) = c.pointer("/function/name").and_then(Value::as_str) {
                    pending.name.push_str(name);
                    out.push(ChatEvent::ToolCallStart {
                        call_id: pending.id.clone(),
                        name: pending.name.clone(),
                    });
                }
                if let Some(args) = c.pointer("/function/arguments").and_then(Value::as_str) {
                    pending.args.push_str(args);
                    if !args.is_empty() {
                        out.push(ChatEvent::ToolCallDelta {
                            call_id: pending.id.clone(),
                            delta: args.to_owned(),
                        });
                    }
                }
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish = Some(reason.to_owned());
        }
    }

    fn end(&mut self, out: &mut Vec<ChatEvent>) {
        if self.done {
            return;
        }
        if self.finish.is_some() {
            // Some servers close the body without `data: [DONE]`.
            self.complete(out);
        } else {
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
    use crate::types::{Effort, Message};

    #[test]
    fn tool_results_become_tool_messages() {
        let req = Request {
            model: "gpt-5.5".into(),
            system: "be brief".into(),
            messages: vec![
                Message::user("hi"),
                Message {
                    role: Role::Assistant,
                    content: vec![Part::ToolCall {
                        call_id: "c1".into(),
                        name: "ls".into(),
                        input: json!({"path": "."}),
                        provider_meta: None,
                    }],
                },
                Message {
                    role: Role::User,
                    content: vec![Part::ToolResult {
                        call_id: "c1".into(),
                        name: "ls".into(),
                        content: "a\nb".into(),
                        is_error: false,
                    }],
                },
            ],
            effort: Some(Effort::High),
            ..Request::default()
        };
        let b = body(&req, Maker::OpenAi).expect("valid");
        let m = b["messages"].as_array().expect("array");
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[2]["tool_calls"][0]["function"]["arguments"], r#"{"path":"."}"#);
        assert_eq!(m[3]["role"], "tool");
        assert_eq!(b["reasoning_effort"], "high");
        assert!(body(&req, Maker::Other).is_err(), "no effort on an unknown server");
    }
}
