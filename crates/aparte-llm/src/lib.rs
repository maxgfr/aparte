//! `aparte-llm`: one streaming event model over three provider protocols, Anthropic Messages, OpenAI chat
//! completions (and every server that speaks it) and Gemini.
//!
//! - [`types`]: the conversation sent ([`Request`], [`Message`], [`Part`]) and the events streamed back
//!   ([`ChatEvent`]), in the JSON shapes of the web app's contract.
//! - [`sse`]: an incremental `text/event-stream` parser.
//! - [`anthropic`], [`openai`], [`gemini`]: request bodies and stream decoders.
//! - [`caps`]: what each model accepts (effort levels, sampling, prefill).
//! - [`client`]: the HTTP client and the [`ChatModel`] trait an agent calls.
//! - [`providers`]: built-in provider presets.
//!
//! The decoders are tested against the recorded streams of `spec/sse`, the same bytes the web app's tests read.

pub mod anthropic;
pub mod caps;
pub mod client;
pub mod decode;
pub mod errors;
pub mod gemini;
pub mod openai;
pub mod providers;
pub mod sse;
pub mod types;

pub use client::{ChatModel, Client, EventStream, ProviderConfig};
pub use types::{
    ApiKey, ChatError, ChatEvent, Effort, ErrorCode, Message, Part, Protocol, Refusal, Request, Role, Sampling,
    StopReason, ToolSpec, Usage,
};

/// A call that cannot be made: refused before any network request.
#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    /// The request asks for something the model does not take (a sampling parameter, an effort level, a prefill).
    #[error("invalid request: {0}")]
    InvalidInput(String),
    /// The provider configuration is unusable (base URL, key).
    #[error("invalid provider configuration: {0}")]
    Config(String),
}
