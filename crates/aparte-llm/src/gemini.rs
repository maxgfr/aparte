//! Gemini `streamGenerateContent?alt=sse`: the request body and the stream decoder. Thought summaries are asked for
//! (`includeThoughts`); effort is `thinkingLevel` on Gemini 3 and a `thinkingBudget` on 2.5. A function call's
//! `thoughtSignature` is surfaced as `providerMeta.google` and replayed.

use serde_json::{Map, Value, json};

use crate::LlmError;
use crate::caps::{self, Maker};
use crate::decode::Decoder;
use crate::errors;
use crate::sse::SseEvent;
use crate::types::{ChatEvent, Effort, Part, Request, Role, StopReason, Usage};

fn google_meta(meta: Option<&Value>) -> Option<&Value> {
    meta?.get("google")?.get("thoughtSignature")
}

/// The JSON body of a streaming `generateContent` call.
pub fn body(req: &Request) -> Result<Value, LlmError> {
    let levels = caps::effort_levels(Maker::Google, &req.model);
    if let Some(e) = req.effort
        && !levels.contains(&e)
    {
        return Err(LlmError::InvalidInput(format!(
            "{} does not take effort {e}",
            req.model
        )));
    }
    let mut contents = Vec::new();
    for m in &req.messages {
        let parts: Vec<Value> = m
            .content
            .iter()
            .filter_map(|p| match p {
                Part::Text { text } if !text.is_empty() => Some(json!({"text": text})),
                Part::ToolCall {
                    name,
                    input,
                    provider_meta,
                    ..
                } => {
                    let mut part = json!({"functionCall": {"name": name, "args": input}});
                    if let Some(sig) = google_meta(provider_meta.as_ref()) {
                        part["thoughtSignature"] = sig.clone();
                    }
                    Some(part)
                }
                Part::ToolResult {
                    name,
                    content,
                    is_error,
                    ..
                } => Some(json!({
                    "functionResponse": {
                        "name": name,
                        "response": if *is_error { json!({"error": content}) } else { json!({"output": content}) },
                    }
                })),
                _ => None,
            })
            .collect();
        if !parts.is_empty() {
            let role = if m.role == Role::User { "user" } else { "model" };
            contents.push(json!({"role": role, "parts": parts}));
        }
    }
    let mut body = Map::new();
    body.insert("contents".into(), Value::Array(contents));
    if !req.system.is_empty() {
        body.insert("systemInstruction".into(), json!({"parts": [{"text": req.system}]}));
    }
    if !req.tools.is_empty() {
        let decls: Vec<Value> = req
            .tools
            .iter()
            .map(|t| json!({"name": t.name, "description": t.description, "parametersJsonSchema": t.input_schema}))
            .collect();
        body.insert("tools".into(), json!([{"functionDeclarations": decls}]));
    }
    let mut config = Map::new();
    if let Some(max) = req.max_output_tokens {
        config.insert("maxOutputTokens".into(), json!(max));
    }
    if let Some(t) = req.sampling.temperature {
        config.insert("temperature".into(), json!(t));
    }
    if let Some(p) = req.sampling.top_p {
        config.insert("topP".into(), json!(p));
    }
    if let Some(k) = req.sampling.top_k {
        config.insert("topK".into(), json!(k));
    }
    if !levels.is_empty() {
        let mut thinking = Map::new();
        thinking.insert("includeThoughts".into(), json!(true));
        match req.effort {
            Some(e) if caps::gemini_budgeted(&req.model) => {
                if let Some(b) = caps::gemini_budget(e) {
                    thinking.insert("thinkingBudget".into(), json!(b));
                }
            }
            Some(e @ (Effort::Minimal | Effort::Low | Effort::Medium | Effort::High)) => {
                thinking.insert("thinkingLevel".into(), json!(e.as_str()));
            }
            _ => {}
        }
        config.insert("thinkingConfig".into(), Value::Object(thinking));
    }
    if !config.is_empty() {
        body.insert("generationConfig".into(), Value::Object(config));
    }
    Ok(Value::Object(body))
}

/// Turns `GenerateContentResponse` chunks into [`ChatEvent`]s.
#[derive(Debug, Default)]
pub struct GeminiDecoder {
    key: Option<String>,
    reasoning_open: bool,
    calls: u32,
    finish: Option<String>,
    usage: Option<Usage>,
    model: Option<String>,
    done: bool,
}

impl GeminiDecoder {
    /// A decoder that scrubs `key` from error messages.
    pub fn new(key: Option<String>) -> GeminiDecoder {
        GeminiDecoder {
            key,
            ..GeminiDecoder::default()
        }
    }

    fn close_reasoning(&mut self, out: &mut Vec<ChatEvent>) {
        if self.reasoning_open {
            self.reasoning_open = false;
            out.push(ChatEvent::ReasoningEnd {
                id: "thought".into(),
                provider_meta: None,
            });
        }
    }
}

impl Decoder for GeminiDecoder {
    fn event(&mut self, ev: &SseEvent, out: &mut Vec<ChatEvent>) {
        if self.done {
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
        if let Some(m) = data.get("modelVersion").and_then(Value::as_str) {
            self.model = Some(m.to_owned());
        }
        if let Some(u) = data.get("usageMetadata") {
            let n = |k: &str| u.get(k).and_then(Value::as_u64);
            let thoughts = n("thoughtsTokenCount").unwrap_or(0);
            self.usage = Some(Usage {
                input: n("promptTokenCount"),
                output: Some(n("candidatesTokenCount").unwrap_or(0) + thoughts),
                cache_read: Some(n("cachedContentTokenCount").unwrap_or(0)),
                cache_write: None,
                reasoning: Some(thoughts),
            });
        }
        let Some(cand) = data.get("candidates").and_then(Value::as_array).and_then(|c| c.first()) else {
            return;
        };
        for part in cand
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(call) = part.get("functionCall") {
                self.close_reasoning(out);
                self.calls += 1;
                let name = call.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
                let call_id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .map_or_else(|| format!("call_{}", self.calls), str::to_owned);
                out.push(ChatEvent::ToolCallStart {
                    call_id: call_id.clone(),
                    name: name.clone(),
                });
                out.push(ChatEvent::ToolCall {
                    call_id,
                    name,
                    input: call.get("args").cloned().unwrap_or_else(|| json!({})),
                    provider_meta: part
                        .get("thoughtSignature")
                        .map(|s| json!({"google": {"thoughtSignature": s}})),
                });
                continue;
            }
            let Some(text) = part.get("text").and_then(Value::as_str) else {
                continue;
            };
            if part.get("thought").and_then(Value::as_bool) == Some(true) {
                self.reasoning_open = true;
                out.push(ChatEvent::ReasoningDelta {
                    id: "thought".into(),
                    text: text.to_owned(),
                });
            } else if !text.is_empty() {
                self.close_reasoning(out);
                out.push(ChatEvent::TextDelta {
                    id: "text".into(),
                    text: text.to_owned(),
                });
            }
        }
        if let Some(reason) = cand.get("finishReason").and_then(Value::as_str) {
            self.finish = Some(reason.to_owned());
        }
    }

    fn end(&mut self, out: &mut Vec<ChatEvent>) {
        if self.done {
            return;
        }
        self.done = true;
        self.close_reasoning(out);
        let Some(raw) = self.finish.take() else {
            out.push(ChatEvent::Error {
                error: errors::truncated(),
            });
            return;
        };
        if let Some(u) = self.usage {
            out.push(ChatEvent::Usage { usage: u });
        }
        let stop = match raw.as_str() {
            "STOP" if self.calls > 0 => StopReason::ToolCalls,
            "STOP" => StopReason::End,
            "MAX_TOKENS" => StopReason::Length,
            "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" | "IMAGE_SAFETY" => {
                StopReason::ContentFilter
            }
            _ => StopReason::Other,
        };
        out.push(ChatEvent::Finish {
            stop,
            raw: Some(raw),
            refusal: None,
            served_by: self.model.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Message;

    #[test]
    fn gemini_3_takes_a_thinking_level_and_2_5_a_budget() {
        let mut r = Request {
            model: "gemini-3-flash".into(),
            messages: vec![Message::user("hi")],
            effort: Some(Effort::Minimal),
            ..Request::default()
        };
        let b = body(&r).expect("valid");
        assert_eq!(b["generationConfig"]["thinkingConfig"]["thinkingLevel"], "minimal");
        r.model = "gemini-2.5-flash".into();
        r.effort = Some(Effort::Low);
        let b = body(&r).expect("valid");
        assert_eq!(b["generationConfig"]["thinkingConfig"]["thinkingBudget"], 1024);
    }
}
