//! The provider-neutral model: conversations sent, and the events streamed back. The names and JSON shapes follow
//! the web app's `ChatEvent` contract (`web/src/core/contracts/ai.ts`), so that `spec/sse/index.json` describes
//! both implementations.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The wire protocol a provider speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    /// Anthropic Messages (`POST /v1/messages`).
    Anthropic,
    /// OpenAI chat completions (`POST /chat/completions`), spoken by most servers other than OpenAI's own.
    OpenaiChat,
    /// OpenAI Responses (`POST /responses`), OpenAI's own models.
    OpenaiResponses,
    /// Gemini `streamGenerateContent`.
    Gemini,
}

impl fmt::Display for Protocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Protocol::Anthropic => "anthropic",
            Protocol::OpenaiChat => "openai-chat",
            Protocol::OpenaiResponses => "openai-responses",
            Protocol::Gemini => "gemini",
        })
    }
}

/// How much a reasoning model thinks before it answers, weakest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    /// Every level, weakest first.
    pub const ALL: [Effort; 7] = [
        Effort::None,
        Effort::Minimal,
        Effort::Low,
        Effort::Medium,
        Effort::High,
        Effort::Xhigh,
        Effort::Max,
    ];

    /// The name used on the wire and on the command line.
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::None => "none",
            Effort::Minimal => "minimal",
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Xhigh => "xhigh",
            Effort::Max => "max",
        }
    }

    /// Parses a level name.
    pub fn parse(s: &str) -> Option<Effort> {
        Effort::ALL.into_iter().find(|e| e.as_str() == s)
    }
}

impl fmt::Display for Effort {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Who wrote a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

/// One piece of a message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Part {
    Text {
        text: String,
    },
    /// Reasoning the model showed. Only a block with `provider_meta` of the provider called is replayed, byte for
    /// byte; the others are display-only.
    Reasoning {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_meta: Option<Value>,
    },
    ToolCall {
        call_id: String,
        name: String,
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_meta: Option<Value>,
    },
    ToolResult {
        call_id: String,
        name: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
    /// A block of a provider's own (Anthropic's server-side web search call and results), sent back verbatim to that
    /// provider only.
    Provider {
        provider: String,
        block: Value,
    },
}

/// One message of a conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<Part>,
}

impl Message {
    /// A user message of one text part.
    pub fn user(text: impl Into<String>) -> Message {
        Message {
            role: Role::User,
            content: vec![Part::Text { text: text.into() }],
        }
    }

    /// An assistant message of one text part.
    pub fn assistant(text: impl Into<String>) -> Message {
        Message {
            role: Role::Assistant,
            content: vec![Part::Text { text: text.into() }],
        }
    }

    /// The concatenated text parts.
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|p| match p {
                Part::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}

/// A tool as declared to the provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the input (an object schema).
    pub input_schema: Value,
}

/// Sampling parameters; a request refuses any the model does not take.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sampling {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u32>,
}

impl Sampling {
    /// Whether any parameter is set.
    pub fn is_set(&self) -> bool {
        self.temperature.is_some() || self.top_p.is_some() || self.top_k.is_some()
    }
}

/// One provider call.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Request {
    pub model: String,
    /// Empty means no system prompt is sent.
    pub system: String,
    /// Oldest first.
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    /// Sent when the model takes effort; a level the model does not take is refused.
    pub effort: Option<Effort>,
    pub max_output_tokens: Option<u32>,
    pub sampling: Sampling,
}

/// Why a response ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StopReason {
    End,
    Length,
    ToolCalls,
    StopSequence,
    /// Anthropic's `refusal`: a safety classifier or the model declined; the partial output is discarded.
    Refusal,
    ContentFilter,
    Pause,
    Other,
}

/// Token counts as reported: `input` counts every input token, `output` every output token including reasoning;
/// the others are parts of those totals.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<u64>,
}

/// The details of a refusal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Refusal {
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
}

/// What failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// The key was refused (401, 403) or is missing.
    Auth,
    /// No answer at all: DNS, refused connection, TLS failure, timeout.
    Network,
    RateLimit,
    /// Anthropic `overloaded_error`, HTTP 529 or 503.
    Overloaded,
    ContextLength,
    InvalidRequest,
    NotFound,
    Server,
    /// The stream ended without a finish event.
    Truncated,
    Unknown,
}

impl ErrorCode {
    /// Whether retrying the same request may succeed.
    pub fn retryable(self) -> bool {
        matches!(
            self,
            ErrorCode::Network
                | ErrorCode::RateLimit
                | ErrorCode::Overloaded
                | ErrorCode::Server
                | ErrorCode::Truncated
        )
    }
}

/// A failed call, as the user sees it. The message comes from the provider: untrusted text, never the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub retryable: bool,
}

impl ChatError {
    /// An error of a code, with its retry flag.
    pub fn new(code: ErrorCode, message: impl Into<String>, status: Option<u16>) -> ChatError {
        ChatError {
            code,
            message: message.into(),
            status,
            retryable: code.retryable(),
        }
    }
}

impl fmt::Display for ChatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = serde_json::to_value(self.code)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        match (self.status, self.message.is_empty()) {
            (Some(s), false) => write!(f, "{code} (HTTP {s}): {}", self.message),
            (Some(s), true) => write!(f, "{code} (HTTP {s})"),
            (None, false) => write!(f, "{code}: {}", self.message),
            (None, true) => f.write_str(&code),
        }
    }
}

/// The stream a call yields, in arrival order. Ids tie the deltas of one block together. Exactly one `Finish` or
/// one `Error` ends a stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ChatEvent {
    TextDelta {
        id: String,
        text: String,
    },
    ReasoningDelta {
        id: String,
        text: String,
    },
    /// A reasoning block is complete; `provider_meta` holds what replay needs, keyed by provider.
    ReasoningEnd {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_meta: Option<Value>,
    },
    /// A tool call began streaming its input.
    ToolCallStart {
        call_id: String,
        name: String,
    },
    /// A piece of the input JSON of a tool call.
    ToolCallDelta {
        call_id: String,
        delta: String,
    },
    /// A complete tool call. `input` is `null` when the model sent JSON that does not parse.
    ToolCall {
        call_id: String,
        name: String,
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_meta: Option<Value>,
    },
    /// A page the answer drew on (a web search result, a citation).
    Source {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// A block of the provider's own, kept verbatim for replay (see [`Part::Provider`]).
    ProviderBlock {
        provider: String,
        block: Value,
    },
    /// Latest totals; the last one wins.
    Usage {
        usage: Usage,
    },
    Finish {
        stop: StopReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refusal: Option<Refusal>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        served_by: Option<String>,
    },
    Error {
        error: ChatError,
    },
}

/// An API key. Its `Debug` and `Display` never show it, so it cannot leak through a log line or an error.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    /// Wraps a key; `None` for an empty one or one with surrounding whitespace or control characters.
    pub fn new(key: impl Into<String>) -> Option<ApiKey> {
        let key = key.into();
        if key.is_empty() || key.trim() != key || key.chars().any(char::is_control) {
            return None;
        }
        Some(ApiKey(key))
    }

    /// The secret, for the request header only.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(***)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_like_the_web_contract() {
        let ev = ChatEvent::ReasoningEnd {
            id: "0".into(),
            provider_meta: Some(serde_json::json!({"anthropic": {"type": "thinking", "signature": "s"}})),
        };
        let v = serde_json::to_value(&ev).expect("json");
        assert_eq!(v["type"], "reasoning-end");
        assert_eq!(v["providerMeta"]["anthropic"]["signature"], "s");
        let back: ChatEvent = serde_json::from_value(v).expect("parse");
        assert_eq!(back, ev);
    }

    #[test]
    fn an_api_key_never_prints() {
        let k = ApiKey::new("sk-ant-secret").expect("valid");
        assert!(!format!("{k:?}").contains("secret"));
        assert!(ApiKey::new(" sk").is_none());
        assert!(ApiKey::new("").is_none());
    }

    #[test]
    fn effort_names_round_trip() {
        for e in Effort::ALL {
            assert_eq!(Effort::parse(e.as_str()), Some(e));
        }
    }
}
