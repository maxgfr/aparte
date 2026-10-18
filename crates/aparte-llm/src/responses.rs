//! OpenAI Responses (`POST /responses`), the protocol of OpenAI's own models, as the web app calls it: `store: false`
//! (nothing is kept on OpenAI's side), so each turn sends the whole conversation, with the reasoning items of earlier
//! turns replayed from their encrypted content (`include: ["reasoning.encrypted_content"]`).
//!
//! - A reasoning item becomes a reasoning block whose `providerMeta.openai` holds `itemId` and
//!   `reasoningEncryptedContent`, the AI SDK's names, so that conversations move between the CLI and the web app.
//! - A function call item becomes a tool call (its `call_id`), with `providerMeta.openai.itemId`.
//! - `url_citation` annotations of the answer become sources; the provider's own web search items need no replay.

use serde_json::{Map, Value, json};

use crate::LlmError;
use crate::caps::{self, Maker};
use crate::decode::Decoder;
use crate::errors;
use crate::sse::SseEvent;
use crate::types::{ChatEvent, Part, Request, Role, StopReason, Usage};

fn own_meta(meta: Option<&Value>) -> Option<&Map<String, Value>> {
    meta?.get("openai")?.as_object()
}

/// The input items of a conversation.
fn input(req: &Request) -> Vec<Value> {
    let mut items = Vec::new();
    for m in &req.messages {
        for p in &m.content {
            match (m.role, p) {
                (_, Part::Text { text }) if text.is_empty() => {}
                (Role::User, Part::Text { text }) => items.push(json!({"role": "user", "content": text})),
                (Role::Assistant, Part::Text { text }) => items.push(json!({"role": "assistant", "content": text})),
                (_, Part::ToolResult { call_id, content, .. }) => items.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": content,
                })),
                (
                    _,
                    Part::ToolCall {
                        call_id,
                        name,
                        input,
                        provider_meta,
                    },
                ) => {
                    let mut item = json!({
                        "type": "function_call",
                        "call_id": call_id,
                        "name": name,
                        "arguments": input.to_string(),
                    });
                    if let Some(id) = own_meta(provider_meta.as_ref())
                        .and_then(|m| m.get("itemId"))
                        .filter(|v| v.is_string())
                    {
                        item["id"] = id.clone();
                    }
                    items.push(item);
                }
                (_, Part::Reasoning { text, provider_meta }) => {
                    // Only this provider's reasoning, with its encrypted content, goes back; the rest is display-only.
                    let Some(own) = own_meta(provider_meta.as_ref()) else {
                        continue;
                    };
                    let (Some(id), Some(enc)) = (
                        own.get("itemId").and_then(Value::as_str),
                        own.get("reasoningEncryptedContent").and_then(Value::as_str),
                    ) else {
                        continue;
                    };
                    let summary = if text.is_empty() {
                        json!([])
                    } else {
                        json!([{"type": "summary_text", "text": text}])
                    };
                    items.push(json!({"type": "reasoning", "id": id, "encrypted_content": enc, "summary": summary}));
                }
                (_, Part::Provider { .. }) => {}
            }
        }
    }
    items
}

/// The JSON body of a streaming Responses call.
pub fn body(req: &Request, maker: Maker) -> Result<Value, LlmError> {
    let levels = caps::effort_levels(maker, &req.model);
    if let Some(e) = req.effort
        && !levels.contains(&e)
    {
        return Err(LlmError::InvalidInput(format!(
            "{} does not take effort {e}",
            req.model
        )));
    }
    if req.sampling.top_k.is_some() {
        return Err(LlmError::InvalidInput("the Responses API takes no top_k".into()));
    }
    let mut body = Map::new();
    body.insert("model".into(), json!(req.model));
    body.insert("input".into(), Value::Array(input(req)));
    body.insert("stream".into(), json!(true));
    body.insert("store".into(), json!(false));
    if !req.system.is_empty() {
        body.insert("instructions".into(), json!(req.system));
    }
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                })
            })
            .collect();
        body.insert("tools".into(), Value::Array(tools));
    }
    if !levels.is_empty() {
        body.insert("include".into(), json!(["reasoning.encrypted_content"]));
        let mut reasoning = json!({"summary": "auto"});
        if let Some(e) = req.effort {
            reasoning["effort"] = json!(e.as_str());
        }
        body.insert("reasoning".into(), reasoning);
    }
    if let Some(max) = req.max_output_tokens {
        body.insert("max_output_tokens".into(), json!(max));
    }
    if let Some(t) = req.sampling.temperature {
        body.insert("temperature".into(), json!(t));
    }
    if let Some(p) = req.sampling.top_p {
        body.insert("top_p".into(), json!(p));
    }
    Ok(Value::Object(body))
}

#[derive(Debug)]
struct Call {
    item_id: String,
    call_id: String,
    name: String,
    args: String,
}

/// Turns Responses stream events into [`ChatEvent`]s.
#[derive(Debug, Default)]
pub struct ResponsesDecoder {
    key: Option<String>,
    model: Option<String>,
    /// Open reasoning items: item id and the last summary index seen.
    reasoning: Vec<(String, Option<u64>)>,
    calls: Vec<Call>,
    had_calls: bool,
    done: bool,
}

impl ResponsesDecoder {
    /// A decoder that scrubs `key` from error messages.
    pub fn new(key: Option<String>) -> ResponsesDecoder {
        ResponsesDecoder {
            key,
            ..ResponsesDecoder::default()
        }
    }

    fn reasoning_delta(&mut self, data: &Value, out: &mut Vec<ChatEvent>) {
        let id = data
            .get("item_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let delta = data.get("delta").and_then(Value::as_str).unwrap_or_default();
        let index = data.get("summary_index").and_then(Value::as_u64);
        let at = match self.reasoning.iter().position(|(i, _)| *i == id) {
            Some(at) => at,
            None => {
                self.reasoning.push((id.clone(), None));
                self.reasoning.len() - 1
            }
        };
        let last = &mut self.reasoning[at].1;
        let mut text = String::new();
        // Summary parts of one item read as paragraphs of one block.
        if let (Some(prev), Some(i)) = (*last, index)
            && i != prev
        {
            text.push_str("\n\n");
        }
        if index.is_some() {
            *last = index;
        }
        text.push_str(delta);
        if !text.is_empty() {
            out.push(ChatEvent::ReasoningDelta { id, text });
        }
    }

    fn finish(&mut self, response: &Value, out: &mut Vec<ChatEvent>, stop: StopReason, raw: Option<String>) {
        for (id, _) in std::mem::take(&mut self.reasoning) {
            out.push(ChatEvent::ReasoningEnd {
                id,
                provider_meta: None,
            });
        }
        if let Some(u) = response.get("usage").filter(|u| u.is_object()) {
            let n = |p: &str| u.pointer(p).and_then(Value::as_u64);
            out.push(ChatEvent::Usage {
                usage: Usage {
                    input: n("/input_tokens"),
                    output: n("/output_tokens"),
                    cache_read: Some(n("/input_tokens_details/cached_tokens").unwrap_or(0)),
                    cache_write: None,
                    reasoning: Some(n("/output_tokens_details/reasoning_tokens").unwrap_or(0)),
                },
            });
        }
        if let Some(m) = response.get("model").and_then(Value::as_str) {
            self.model = Some(m.to_owned());
        }
        out.push(ChatEvent::Finish {
            stop,
            raw,
            refusal: None,
            served_by: self.model.clone(),
        });
        self.done = true;
    }
}

impl Decoder for ResponsesDecoder {
    fn event(&mut self, ev: &SseEvent, out: &mut Vec<ChatEvent>) {
        if self.done {
            return;
        }
        let Ok(data) = serde_json::from_str::<Value>(&ev.data) else {
            return;
        };
        let kind = data.get("type").and_then(Value::as_str).unwrap_or(ev.event.as_str());
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        match kind {
            "response.created" | "response.in_progress" => {
                if let Some(m) = data.pointer("/response/model").and_then(Value::as_str) {
                    self.model = Some(m.to_owned());
                }
            }
            "response.output_item.added" => {
                let item = &data["item"];
                match item.get("type").and_then(Value::as_str) {
                    Some("reasoning") => {
                        let id = s(item, "id");
                        if !self.reasoning.iter().any(|(i, _)| *i == id) {
                            self.reasoning.push((id, None));
                        }
                    }
                    Some("function_call") => {
                        let call = Call {
                            item_id: s(item, "id"),
                            call_id: s(item, "call_id"),
                            name: s(item, "name"),
                            args: s(item, "arguments"),
                        };
                        out.push(ChatEvent::ToolCallStart {
                            call_id: call.call_id.clone(),
                            name: call.name.clone(),
                        });
                        self.calls.push(call);
                    }
                    _ => {}
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                self.reasoning_delta(&data, out);
            }
            "response.output_text.delta" => {
                let text = s(&data, "delta");
                if !text.is_empty() {
                    out.push(ChatEvent::TextDelta {
                        id: s(&data, "item_id"),
                        text,
                    });
                }
            }
            "response.output_text.annotation.added" => {
                let a = &data["annotation"];
                if a.get("type").and_then(Value::as_str) == Some("url_citation") {
                    out.push(ChatEvent::Source {
                        url: s(a, "url"),
                        title: a.get("title").and_then(Value::as_str).map(str::to_owned),
                    });
                }
            }
            "response.function_call_arguments.delta" => {
                let item_id = s(&data, "item_id");
                let delta = s(&data, "delta");
                if let Some(c) = self.calls.iter_mut().find(|c| c.item_id == item_id) {
                    c.args.push_str(&delta);
                    if !delta.is_empty() {
                        out.push(ChatEvent::ToolCallDelta {
                            call_id: c.call_id.clone(),
                            delta,
                        });
                    }
                }
            }
            "response.output_item.done" => {
                let item = &data["item"];
                let id = s(item, "id");
                match item.get("type").and_then(Value::as_str) {
                    Some("reasoning") => {
                        self.reasoning.retain(|(i, _)| *i != id);
                        let mut meta = json!({"itemId": id});
                        if let Some(enc) = item.get("encrypted_content").filter(|v| v.is_string()) {
                            meta["reasoningEncryptedContent"] = enc.clone();
                        }
                        out.push(ChatEvent::ReasoningEnd {
                            id,
                            provider_meta: Some(json!({"openai": meta})),
                        });
                    }
                    Some("function_call") => {
                        let pending = self
                            .calls
                            .iter()
                            .position(|c| c.item_id == id)
                            .map(|at| self.calls.remove(at));
                        let args = item
                            .get("arguments")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .or_else(|| pending.as_ref().map(|c| c.args.clone()))
                            .unwrap_or_default();
                        let input = if args.trim().is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(&args).unwrap_or(Value::Null)
                        };
                        let call_id = item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .or_else(|| pending.as_ref().map(|c| c.call_id.clone()))
                            .unwrap_or_default();
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .or_else(|| pending.as_ref().map(|c| c.name.clone()))
                            .unwrap_or_default();
                        self.had_calls = true;
                        out.push(ChatEvent::ToolCall {
                            call_id,
                            name,
                            input,
                            provider_meta: Some(json!({"openai": {"itemId": id}})),
                        });
                    }
                    _ => {}
                }
            }
            "response.completed" => {
                let stop = if self.had_calls {
                    StopReason::ToolCalls
                } else {
                    StopReason::End
                };
                self.finish(&data["response"], out, stop, None);
            }
            "response.incomplete" => {
                let reason = data
                    .pointer("/response/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .unwrap_or("incomplete")
                    .to_owned();
                let stop = match reason.as_str() {
                    "max_output_tokens" => StopReason::Length,
                    "content_filter" => StopReason::ContentFilter,
                    _ => StopReason::Other,
                };
                self.finish(&data["response"], out, stop, Some(reason));
            }
            "response.failed" => {
                let err = data.pointer("/response/error").cloned().unwrap_or(Value::Null);
                out.push(ChatEvent::Error {
                    error: errors::from_stream(&json!({"error": err}), self.key.as_deref()),
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
    use crate::decode::decode_body;
    use crate::types::{Effort, Message, Protocol, ToolSpec};

    #[test]
    fn a_tool_round_is_sent_back_with_its_encrypted_reasoning() {
        let req = Request {
            model: "gpt-5.5".into(),
            system: "be brief".into(),
            messages: vec![
                Message::user("17 × 24?"),
                Message {
                    role: Role::Assistant,
                    content: vec![
                        Part::Reasoning {
                            text: String::new(),
                            provider_meta: Some(
                                json!({"openai": {"itemId": "rs_1", "reasoningEncryptedContent": "ENC"}}),
                            ),
                        },
                        Part::Reasoning {
                            text: "foreign".into(),
                            provider_meta: Some(json!({"anthropic": {"type": "thinking", "signature": "s"}})),
                        },
                        Part::ToolCall {
                            call_id: "call_1".into(),
                            name: "calculator".into(),
                            input: json!({"expression": "17 * 24"}),
                            provider_meta: Some(json!({"openai": {"itemId": "fc_1"}})),
                        },
                    ],
                },
                Message {
                    role: Role::User,
                    content: vec![Part::ToolResult {
                        call_id: "call_1".into(),
                        name: "calculator".into(),
                        content: "408".into(),
                        is_error: false,
                    }],
                },
            ],
            tools: vec![ToolSpec {
                name: "calculator".into(),
                description: "Computes.".into(),
                input_schema: json!({"type": "object"}),
            }],
            effort: Some(Effort::High),
            ..Request::default()
        };
        let b = body(&req, Maker::OpenAi).expect("valid");
        assert_eq!(b["store"], false);
        assert_eq!(b["instructions"], "be brief");
        assert_eq!(b["reasoning"], json!({"summary": "auto", "effort": "high"}));
        assert_eq!(b["include"], json!(["reasoning.encrypted_content"]));
        assert_eq!(
            b["tools"][0],
            json!({"type": "function", "name": "calculator", "description": "Computes.", "parameters": {"type": "object"}})
        );
        let input = b["input"].as_array().expect("input");
        assert_eq!(input.len(), 4, "the foreign reasoning is not sent: {input:?}");
        assert_eq!(
            input[1],
            json!({"type": "reasoning", "id": "rs_1", "encrypted_content": "ENC", "summary": []})
        );
        assert_eq!(
            input[2],
            json!({"type": "function_call", "call_id": "call_1", "name": "calculator", "arguments": "{\"expression\":\"17 * 24\"}", "id": "fc_1"})
        );
        assert_eq!(
            input[3],
            json!({"type": "function_call_output", "call_id": "call_1", "output": "408"})
        );
        assert!(body(&req, Maker::Other).is_err(), "no effort on a model without it");
    }

    #[test]
    fn summaries_text_citations_and_incomplete_answers_decode() {
        let body = concat!(
            "data: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\"}}\n\n",
            "data: {\"type\":\"response.reasoning_summary_text.delta\",\"item_id\":\"rs_1\",\"summary_index\":0,\"delta\":\"One.\"}\n\n",
            "data: {\"type\":\"response.reasoning_summary_text.delta\",\"item_id\":\"rs_1\",\"summary_index\":1,\"delta\":\"Two.\"}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"encrypted_content\":\"E\"}}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"Hi\"}\n\n",
            "data: {\"type\":\"response.output_text.annotation.added\",\"annotation\":{\"type\":\"url_citation\",\"url\":\"https://e.org\",\"title\":\"E\"}}\n\n",
            "data: {\"type\":\"response.incomplete\",\"response\":{\"model\":\"gpt-5.5\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":3,\"output_tokens\":9}}}\n\n",
        );
        let events = decode_body(Protocol::OpenaiResponses, body.as_bytes(), &[5]);
        let reasoning: String = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::ReasoningDelta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(reasoning, "One.\n\nTwo.");
        assert!(events.contains(&ChatEvent::Source {
            url: "https://e.org".into(),
            title: Some("E".into())
        }));
        assert!(matches!(
            events.last(),
            Some(ChatEvent::Finish { stop: StopReason::Length, raw: Some(r), .. }) if r == "max_output_tokens"
        ));
        let cut = decode_body(Protocol::OpenaiResponses, &body.as_bytes()[..200], &[usize::MAX]);
        assert!(matches!(cut.last(), Some(ChatEvent::Error { .. })));
    }
}
