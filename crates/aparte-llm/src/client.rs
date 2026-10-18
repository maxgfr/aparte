//! The HTTP side: one `reqwest` client over rustls (ring provider, the platform's trust store), a streaming call
//! per request, and the provider's model listing. The key goes in a header marked sensitive, so `reqwest` and
//! `hyper` never print it, and nothing here logs headers or bodies.

use std::collections::VecDeque;
use std::pin::Pin;
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;

use crate::caps::Maker;
use crate::decode::{Decoder, decoder};
use crate::errors;
use crate::providers::{Preset, check_base_url};
use crate::sse::SseParser;
use crate::types::{ApiKey, ChatError, ChatEvent, ErrorCode, Protocol, Request};
use crate::{LlmError, anthropic, gemini, openai};

/// A stream of events; it always ends with one `Finish` or one `Error`.
pub type EventStream = Pin<Box<dyn Stream<Item = ChatEvent> + Send>>;

/// Anything that streams a model's answer: the HTTP [`Client`], or a scripted model in tests.
pub trait ChatModel: Send + Sync {
    /// Starts a call. `InvalidInput` for a request the model refuses, before any network call; provider and
    /// network failures arrive as an `Error` event.
    fn stream(&self, req: &Request) -> Result<EventStream, LlmError>;
}

/// Where and how to call a provider.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    /// The preset name (`anthropic`, `openai`, `ollama`...).
    pub id: String,
    pub protocol: Protocol,
    pub maker: Maker,
    /// Base URL without a trailing slash.
    pub base_url: String,
    pub api_key: Option<ApiKey>,
}

impl ProviderConfig {
    /// A preset's configuration with a key.
    pub fn from_preset(p: &Preset, api_key: Option<ApiKey>) -> ProviderConfig {
        ProviderConfig {
            id: p.id.to_owned(),
            protocol: p.protocol,
            maker: p.maker,
            base_url: p.base_url.to_owned(),
            api_key,
        }
    }
}

const MAX_ERROR_BODY: usize = 64 * 1024;

/// Installs ring as rustls' process-wide provider, once; a provider installed earlier is kept.
pub fn install_tls_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // A concurrent install wins the race; either way a ring provider is in place.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// An HTTP client of one provider.
#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    cfg: ProviderConfig,
}

impl Client {
    /// A client; `Config` for a base URL that is neither https nor loopback http.
    pub fn new(mut cfg: ProviderConfig) -> Result<Client, LlmError> {
        cfg.base_url = check_base_url(&cfg.base_url).map_err(LlmError::Config)?;
        install_tls_provider();
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(600))
            .user_agent(concat!("aparte/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| LlmError::Config(format!("cannot build the HTTP client: {e}")))?;
        Ok(Client { http, cfg })
    }

    /// The configuration in use.
    pub fn config(&self) -> &ProviderConfig {
        &self.cfg
    }

    fn headers(&self) -> Result<HeaderMap, LlmError> {
        let mut h = HeaderMap::new();
        let mut secret = |name: &'static str, value: String| -> Result<(), LlmError> {
            let mut v = HeaderValue::from_str(&value)
                .map_err(|_| LlmError::Config("the API key is not a valid header".into()))?;
            v.set_sensitive(true);
            h.insert(HeaderName::from_static(name), v);
            Ok(())
        };
        if let Some(key) = &self.cfg.api_key {
            match self.cfg.protocol {
                Protocol::Anthropic => secret("x-api-key", key.expose().to_owned())?,
                Protocol::OpenaiChat => secret("authorization", format!("Bearer {}", key.expose()))?,
                Protocol::Gemini => secret("x-goog-api-key", key.expose().to_owned())?,
            }
        }
        if self.cfg.protocol == Protocol::Anthropic {
            h.insert("anthropic-version", HeaderValue::from_static(anthropic::VERSION));
        }
        Ok(h)
    }

    fn endpoint(&self, model: &str) -> String {
        let base = &self.cfg.base_url;
        match self.cfg.protocol {
            Protocol::Anthropic => format!("{base}/messages"),
            Protocol::OpenaiChat => format!("{base}/chat/completions"),
            Protocol::Gemini => format!("{base}/models/{model}:streamGenerateContent?alt=sse"),
        }
    }

    /// The request body a call would send, without sending it.
    pub fn body(&self, req: &Request) -> Result<Value, LlmError> {
        match self.cfg.protocol {
            Protocol::Anthropic => anthropic::body(req),
            Protocol::OpenaiChat => openai::body(req, self.cfg.maker),
            Protocol::Gemini => gemini::body(req),
        }
    }

    /// Lists the provider's models (free: no generation).
    pub async fn list_models(&self) -> Result<Vec<String>, ChatError> {
        let key = self.cfg.api_key.as_ref().map(|k| k.expose().to_owned());
        let url = match self.cfg.protocol {
            Protocol::Anthropic => format!("{}/models?limit=1000", self.cfg.base_url),
            Protocol::OpenaiChat => format!("{}/models", self.cfg.base_url),
            Protocol::Gemini => format!("{}/models?pageSize=1000", self.cfg.base_url),
        };
        let headers = self
            .headers()
            .map_err(|e| ChatError::new(ErrorCode::Auth, e.to_string(), None))?;
        let resp = self
            .http
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| network(&e, key.as_deref()))?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(|e| network(&e, key.as_deref()))?;
        if !(200..300).contains(&status) {
            return Err(errors::from_http(status, &text, key.as_deref()));
        }
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let items = v.get("data").or_else(|| v.get("models")).and_then(Value::as_array);
        let mut ids: Vec<String> = items
            .into_iter()
            .flatten()
            .filter_map(|m| m.get("id").or_else(|| m.get("name")).and_then(Value::as_str))
            .map(|s| s.strip_prefix("models/").unwrap_or(s).to_owned())
            .collect();
        ids.sort();
        Ok(ids)
    }
}

fn network(e: &reqwest::Error, key: Option<&str>) -> ChatError {
    let what = if e.is_timeout() { "timed out" } else { "no answer" };
    ChatError::new(ErrorCode::Network, errors::scrub(&format!("{what}: {e}"), key), None)
}

type ByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, reqwest::Error>> + Send>>;

enum Phase {
    Pending(Box<reqwest::RequestBuilder>),
    Reading(ByteStream),
    Done,
}

struct State {
    phase: Phase,
    queue: VecDeque<ChatEvent>,
    parser: SseParser,
    decoder: Box<dyn Decoder>,
    key: Option<String>,
}

impl State {
    fn fail(&mut self, error: ChatError) {
        self.queue.push_back(ChatEvent::Error { error });
        self.phase = Phase::Done;
    }

    /// Advances until there is an event to yield or the stream is over.
    async fn step(&mut self) {
        while self.queue.is_empty() {
            match std::mem::replace(&mut self.phase, Phase::Done) {
                Phase::Done => return,
                Phase::Pending(builder) => match builder.send().await {
                    Err(e) => self.fail(network(&e, self.key.as_deref())),
                    Ok(resp) if !resp.status().is_success() => {
                        let status = resp.status().as_u16();
                        let mut body = Vec::new();
                        let mut s = resp.bytes_stream();
                        while let Some(Ok(chunk)) = s.next().await {
                            body.extend_from_slice(&chunk);
                            if body.len() > MAX_ERROR_BODY {
                                break;
                            }
                        }
                        let text = String::from_utf8_lossy(&body);
                        self.fail(errors::from_http(status, &text, self.key.as_deref()));
                    }
                    Ok(resp) => {
                        let s = resp.bytes_stream().map(|r| r.map(|b| b.to_vec()));
                        self.phase = Phase::Reading(Box::pin(s));
                    }
                },
                Phase::Reading(mut body) => match body.next().await {
                    Some(Ok(chunk)) => {
                        let mut out = Vec::new();
                        for ev in self.parser.feed(&chunk) {
                            self.decoder.event(&ev, &mut out);
                        }
                        let finished = out
                            .iter()
                            .any(|e| matches!(e, ChatEvent::Finish { .. } | ChatEvent::Error { .. }));
                        self.queue.extend(out);
                        self.phase = if finished { Phase::Done } else { Phase::Reading(body) };
                    }
                    Some(Err(e)) => {
                        let mut out = Vec::new();
                        self.decoder.end(&mut out);
                        // The decoder reports a cut stream as `truncated`; the transport error says why.
                        let error = network(&e, self.key.as_deref());
                        let truncated = out.iter().any(|ev| matches!(ev, ChatEvent::Error { .. }));
                        if truncated {
                            out.retain(|ev| !matches!(ev, ChatEvent::Error { .. }));
                            out.push(ChatEvent::Error { error });
                        }
                        self.queue.extend(out);
                        self.phase = Phase::Done;
                    }
                    None => {
                        let mut out = Vec::new();
                        for ev in self.parser.finish() {
                            self.decoder.event(&ev, &mut out);
                        }
                        self.decoder.end(&mut out);
                        self.queue.extend(out);
                        self.phase = Phase::Done;
                    }
                },
            }
        }
    }
}

impl ChatModel for Client {
    fn stream(&self, req: &Request) -> Result<EventStream, LlmError> {
        let body = self.body(req)?;
        let key = self.cfg.api_key.as_ref().map(|k| k.expose().to_owned());
        let url = self.endpoint(&req.model);
        tracing::debug!(provider = %self.cfg.id, model = %req.model, %url, "provider call");
        let builder = self
            .http
            .post(url)
            .headers(self.headers()?)
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .body(body.to_string());
        let state = State {
            phase: Phase::Pending(Box::new(builder)),
            queue: VecDeque::new(),
            parser: SseParser::new(),
            decoder: decoder(self.cfg.protocol, key.clone()),
            key,
        };
        let stream = futures_util::stream::unfold(state, |mut st| async move {
            st.step().await;
            st.queue.pop_front().map(|ev| (ev, st))
        });
        Ok(Box::pin(stream))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::preset;

    #[test]
    fn a_remote_http_base_url_is_refused() {
        let mut cfg = ProviderConfig::from_preset(preset("openai").expect("preset"), None);
        cfg.base_url = "http://example.com/v1".into();
        assert!(matches!(Client::new(cfg), Err(LlmError::Config(_))));
    }

    #[test]
    fn the_client_debug_output_hides_the_key() {
        let key = ApiKey::new("sk-ant-very-secret").expect("key");
        let cfg = ProviderConfig::from_preset(preset("anthropic").expect("preset"), Some(key));
        let client = Client::new(cfg).expect("client");
        let headers = client.headers().expect("headers");
        assert!(!format!("{client:?} {headers:?}").contains("very-secret"));
        assert!(headers.get("x-api-key").is_some_and(HeaderValue::is_sensitive));
    }
}
