//! The common shape of the stream decoders, and a helper that decodes a whole body (used by the tests and by
//! any caller holding a recorded response).

use crate::sse::{SseEvent, SseParser};
use crate::types::{ChatEvent, Protocol};
use crate::{anthropic, gemini, openai, responses};

/// Turns server-sent events of one protocol into [`ChatEvent`]s.
pub trait Decoder: Send {
    /// One event; pushes what it completes.
    fn event(&mut self, ev: &SseEvent, out: &mut Vec<ChatEvent>);
    /// The body ended: pushes the pending finish, or a `truncated` error when the stream stopped early.
    fn end(&mut self, out: &mut Vec<ChatEvent>);
}

/// A decoder for a protocol; `key` is scrubbed from error messages.
pub fn decoder(protocol: Protocol, key: Option<String>) -> Box<dyn Decoder> {
    match protocol {
        Protocol::Anthropic => Box::new(anthropic::AnthropicDecoder::new(key)),
        Protocol::OpenaiChat => Box::new(openai::OpenAiDecoder::new(key)),
        Protocol::OpenaiResponses => Box::new(responses::ResponsesDecoder::new(key)),
        Protocol::Gemini => Box::new(gemini::GeminiDecoder::new(key)),
    }
}

/// Decodes a complete `text/event-stream` body, fed in chunks of the given sizes (cycled), to the end.
pub fn decode_body(protocol: Protocol, body: &[u8], chunk_sizes: &[usize]) -> Vec<ChatEvent> {
    let mut parser = SseParser::new();
    let mut dec = decoder(protocol, None);
    let mut out = Vec::new();
    let mut rest = body;
    let mut sizes = chunk_sizes.iter().copied().filter(|&n| n > 0).cycle();
    while !rest.is_empty() {
        let n = sizes.next().unwrap_or(rest.len()).min(rest.len());
        let (chunk, tail) = rest.split_at(n);
        for ev in parser.feed(chunk) {
            dec.event(&ev, &mut out);
        }
        rest = tail;
    }
    for ev in parser.finish() {
        dec.event(&ev, &mut out);
    }
    dec.end(&mut out);
    out
}
