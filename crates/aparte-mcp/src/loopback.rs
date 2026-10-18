//! The loopback HTTP layer of `aparte mcp serve` and `aparte mcp bridge` (`spec/MCP-BRIDGE.md`):
//!
//! - It listens on `127.0.0.1` only; any other address is refused before a socket is opened.
//! - The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (the port listened on): a page whose DNS name
//!   was rebound to the loopback sends its own name and is refused with 421.
//! - A request with an `Origin` must come from the web app (`https://maxgfr.github.io`) or a local development
//!   server (`http://localhost[:port]`, `http://127.0.0.1[:port]`); any other origin is refused with 403 before
//!   anything runs. A request without `Origin` (a native client) passes. Allowed origins get CORS headers, and a
//!   preflight is answered without a token, including Chrome's Private Network Access header.
//! - Every other request needs `Authorization: Bearer <token>`, a 256-bit [`Token`] drawn from the OS CSPRNG and
//!   typed or pasted into the client by the user; it is compared in constant time. A URL with a query is refused,
//!   so a token never travels (or gets logged) in a URL.
//! - Bodies are at most [`MAX_BODY`] bytes, request headers must arrive within [`HEADER_TIMEOUT`], and at most
//!   [`MAX_CONNECTIONS`] connections are open at once.

use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use aparte_agent::BoxFuture;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{Value, json};
use zeroize::Zeroizing;

/// The origin of the web app.
pub const APP_ORIGIN: &str = "https://maxgfr.github.io";
/// The environment variable that may hold a fixed token, for scripted use.
pub const TOKEN_ENV: &str = "APARTE_MCP_TOKEN";
/// Largest request body.
pub const MAX_BODY: usize = 4 * 1024 * 1024;
/// Most connections open at once; more are closed at once.
pub const MAX_CONNECTIONS: usize = 16;
/// How long a client has to send the headers of a request.
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a request may take, approvals included.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The request headers a browser may send.
pub const ALLOWED_HEADERS: &str =
    "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id";
/// The response headers a browser may read.
pub const EXPOSED_HEADERS: &str = "mcp-session-id";
/// The methods a browser may use.
pub const ALLOWED_METHODS: &str = "POST, GET, DELETE, OPTIONS";
/// How long a browser may cache a preflight answer, in seconds.
pub const PREFLIGHT_MAX_AGE: &str = "600";

/// Why the loopback server cannot start.
#[derive(Debug, thiserror::Error)]
pub enum LoopbackError {
    #[error("{0} is not 127.0.0.1:<port>: the server listens on the IPv4 loopback only")]
    NotLoopback(SocketAddr),
    #[error("a token is 256 bits: 52 base32 characters (a-z, 2-7), in groups separated by dashes or not")]
    BadToken,
    #[error("the system random generator failed: {0}")]
    Random(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
const TOKEN_CHARS: usize = 52;

/// A 256-bit bearer token. It is never printed by `Debug`; [`Token::display`] gives the form shown to the user.
pub struct Token(Zeroizing<[u8; 32]>);

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(..)")
    }
}

impl Token {
    /// A fresh token from the OS CSPRNG.
    pub fn generate() -> Result<Token, LoopbackError> {
        let mut bytes = Zeroizing::new([0u8; 32]);
        getrandom::fill(bytes.as_mut()).map_err(|e| LoopbackError::Random(e.to_string()))?;
        Ok(Token(bytes))
    }

    /// Reads a token as shown by [`Token::display`]: 52 base32 characters, case and dashes, spaces and newlines
    /// ignored. The 4 bits past the 256 must be zero, so each token has one spelling.
    pub fn parse(text: &str) -> Result<Token, LoopbackError> {
        let mut bytes = Zeroizing::new([0u8; 32]);
        let mut acc: u32 = 0;
        let mut bits = 0u32;
        let mut at = 0usize;
        let mut chars = 0usize;
        for c in text.bytes() {
            if matches!(c, b'-' | b' ' | b'\t' | b'\r' | b'\n') {
                continue;
            }
            let c = c.to_ascii_lowercase();
            let v = BASE32.iter().position(|&b| b == c).ok_or(LoopbackError::BadToken)?;
            chars += 1;
            if chars > TOKEN_CHARS {
                return Err(LoopbackError::BadToken);
            }
            acc = (acc << 5) | u32::try_from(v).map_err(|_| LoopbackError::BadToken)?;
            bits += 5;
            if bits >= 8 {
                bits -= 8;
                if at < 32 {
                    bytes[at] = ((acc >> bits) & 0xff) as u8;
                    at += 1;
                }
                acc &= (1 << bits) - 1;
            }
        }
        if chars != TOKEN_CHARS || at != 32 || acc != 0 {
            return Err(LoopbackError::BadToken);
        }
        Ok(Token(bytes))
    }

    /// The token as shown to the user and sent by clients: 13 groups of 4 lowercase base32 characters joined by
    /// dashes.
    pub fn display(&self) -> Zeroizing<String> {
        let mut plain = Zeroizing::new(String::with_capacity(TOKEN_CHARS));
        let mut acc: u32 = 0;
        let mut bits = 0u32;
        for &b in self.0.iter() {
            acc = (acc << 8) | u32::from(b);
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                plain.push(char::from(BASE32[((acc >> bits) & 31) as usize]));
            }
            acc &= (1 << bits) - 1;
        }
        if bits > 0 {
            plain.push(char::from(BASE32[((acc << (5 - bits)) & 31) as usize]));
        }
        let mut out = Zeroizing::new(String::with_capacity(TOKEN_CHARS + 12));
        for (i, c) in plain.chars().enumerate() {
            if i > 0 && i % 4 == 0 {
                out.push('-');
            }
            out.push(c);
        }
        out
    }

    /// Whether a presented token is this one (constant time over the 32 bytes).
    pub fn matches(&self, presented: &str) -> bool {
        match Token::parse(presented) {
            Ok(other) => aparte_crypto::primitives::ct_eq(self.0.as_ref(), other.0.as_ref()),
            Err(_) => false,
        }
    }
}

/// Whether a browser origin may use the server: the web app, or a development server on the loopback (any port).
pub fn origin_allowed(origin: &str) -> bool {
    if origin == APP_ORIGIN {
        return true;
    }
    ["http://localhost", "http://127.0.0.1"].iter().any(|prefix| {
        origin
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.strip_prefix(':').is_some_and(valid_port))
    })
}

fn valid_port(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 5
        && !p.starts_with('0')
        && p.bytes().all(|b| b.is_ascii_digit())
        && p.parse::<u16>().is_ok()
}

/// Whether a `Host` header names this server: `127.0.0.1:<port>` or `localhost:<port>` (without the port only when
/// it is 80).
pub fn host_allowed(host: &str, port: u16) -> bool {
    let host = host.to_ascii_lowercase();
    let (name, p) = match host.rsplit_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (host.as_str(), None),
    };
    let port_ok = match p {
        Some(p) => valid_port(p) && p.parse::<u16>().is_ok_and(|n| n == port),
        None => port == 80,
    };
    port_ok && matches!(name, "127.0.0.1" | "localhost")
}

/// The body of every response.
pub type Body = Full<Bytes>;

/// The CORS headers a response carries: those of an allowed origin, or none.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cors(Option<HeaderValue>);

impl Cors {
    /// The allowed origin, if the request had one.
    pub fn origin(&self) -> Option<&str> {
        self.0.as_ref().and_then(|v| v.to_str().ok())
    }

    /// Adds the CORS headers to a response.
    pub fn apply(&self, resp: &mut Response<Body>) {
        let h = resp.headers_mut();
        h.append(header::VARY, HeaderValue::from_static("Origin"));
        if let Some(origin) = &self.0 {
            h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
            h.insert(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                HeaderValue::from_static(EXPOSED_HEADERS),
            );
        }
    }
}

/// What the guard decided about a request.
#[derive(Debug)]
pub enum Verdict {
    /// Answer with this at once: a refusal or a preflight.
    Respond(Response<Body>),
    /// Go on; the response gets these CORS headers.
    Pass(Cors),
}

/// The JSON-RPC error code of a refusal by status (`-32600` invalid request, `-32001` unauthorized, `-32601` not
/// found, `-32603` upstream failures, `-32000` otherwise).
fn rpc_code(status: StatusCode) -> i64 {
    match status {
        StatusCode::UNAUTHORIZED => -32001,
        StatusCode::BAD_REQUEST | StatusCode::PAYLOAD_TOO_LARGE | StatusCode::UNSUPPORTED_MEDIA_TYPE => -32600,
        StatusCode::NOT_FOUND => -32601,
        StatusCode::BAD_GATEWAY | StatusCode::GATEWAY_TIMEOUT => -32603,
        _ => -32000,
    }
}

/// A JSON response.
pub fn json_response(status: StatusCode, body: &Value) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(body.to_string())));
    *r.status_mut() = status;
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// A JSON-RPC error answering `id` (`null` when the request had none or could not be read), with an HTTP status.
pub fn rpc_error(status: StatusCode, id: Option<&Value>, code: i64, message: &str) -> Response<Body> {
    json_response(
        status,
        &json!({"jsonrpc": "2.0", "id": id.cloned().unwrap_or(Value::Null), "error": {"code": code, "message": message}}),
    )
}

/// A refusal: a JSON-RPC error without an id.
pub fn refusal(status: StatusCode, message: &str) -> Response<Body> {
    rpc_error(status, None, rpc_code(status), message)
}

/// An empty response.
pub fn empty(status: StatusCode) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::new()));
    *r.status_mut() = status;
    r
}

/// A 405 naming the methods of an endpoint.
pub fn method_not_allowed(allow: &'static str) -> Response<Body> {
    let mut r = refusal(StatusCode::METHOD_NOT_ALLOWED, "method not allowed on this endpoint");
    r.headers_mut().insert(header::ALLOW, HeaderValue::from_static(allow));
    r
}

fn header_str(headers: &HeaderMap, name: header::HeaderName) -> Result<Option<&str>, ()> {
    let mut values = headers.get_all(&name).iter();
    let Some(first) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    first.to_str().map(Some).map_err(|_| ())
}

/// Checks the Host, Origin, URL and token rules of a request.
#[derive(Debug)]
pub struct Guard {
    port: u16,
    token: Arc<Token>,
}

impl Guard {
    /// A guard for a server listening on `port`.
    pub fn new(port: u16, token: Arc<Token>) -> Guard {
        Guard { port, token }
    }

    /// The rules, in order: Host (421), Origin (403), no query in the URL (400), a preflight answered (204), the
    /// bearer token (401).
    pub fn check<B>(&self, req: &Request<B>) -> Verdict {
        let headers = req.headers();
        let host = header_str(headers, header::HOST).ok().flatten();
        let authority_ok = req
            .uri()
            .authority()
            .is_none_or(|a| host_allowed(a.as_str(), self.port));
        if !host.is_some_and(|h| host_allowed(h, self.port)) || !authority_ok {
            return Verdict::Respond(refusal(
                StatusCode::MISDIRECTED_REQUEST,
                "the Host header must be 127.0.0.1:<port> or localhost:<port>",
            ));
        }
        let cors = match header_str(headers, header::ORIGIN) {
            Err(()) => {
                return Verdict::Respond(refusal(StatusCode::FORBIDDEN, "one Origin header at most"));
            }
            Ok(None) => Cors(None),
            Ok(Some(origin)) if origin_allowed(origin) => Cors(HeaderValue::from_str(origin).ok()),
            Ok(Some(_)) => {
                return Verdict::Respond(refusal(StatusCode::FORBIDDEN, "this origin may not use this server"));
            }
        };
        let respond = |mut r: Response<Body>| {
            cors.apply(&mut r);
            Verdict::Respond(r)
        };
        if req.uri().query().is_some() {
            return respond(refusal(
                StatusCode::BAD_REQUEST,
                "the URL takes no query; the token goes in the Authorization header",
            ));
        }
        if req.method() == Method::OPTIONS {
            if cors.0.is_none() {
                return Verdict::Respond(refusal(StatusCode::FORBIDDEN, "a preflight needs an allowed Origin"));
            }
            let mut r = empty(StatusCode::NO_CONTENT);
            let h = r.headers_mut();
            h.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static(ALLOWED_METHODS),
            );
            h.insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static(ALLOWED_HEADERS),
            );
            h.insert(
                header::ACCESS_CONTROL_MAX_AGE,
                HeaderValue::from_static(PREFLIGHT_MAX_AGE),
            );
            let pna = headers
                .get("access-control-request-private-network")
                .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"true"));
            if pna {
                h.insert("access-control-allow-private-network", HeaderValue::from_static("true"));
            }
            return respond(r);
        }
        let presented = match header_str(headers, header::AUTHORIZATION) {
            Ok(Some(v)) => v
                .split_once(' ')
                .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
                .map(|(_, t)| t.trim()),
            _ => None,
        };
        if !presented.is_some_and(|t| self.token.matches(t)) {
            let mut r = refusal(
                StatusCode::UNAUTHORIZED,
                "a valid token is needed: Authorization: Bearer <token shown by aparte>",
            );
            r.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_static("Bearer realm=\"aparte\", error=\"invalid_token\""),
            );
            return respond(r);
        }
        Verdict::Pass(cors)
    }
}

/// A request that passed the guard, its body read.
#[derive(Debug, Clone)]
pub struct Inbound {
    pub method: Method,
    /// The path, without a query (the guard refuses those).
    pub path: String,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Inbound {
    /// A header as text, if present and valid.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

/// What answers the requests that pass the guard.
pub trait Handler: Send + Sync + 'static {
    fn handle(&self, req: Inbound) -> BoxFuture<'_, Response<Body>>;
}

/// A listener on `127.0.0.1`.
#[derive(Debug)]
pub struct LoopbackServer {
    listener: tokio::net::TcpListener,
    addr: SocketAddr,
}

/// Refuses an address other than `127.0.0.1:<port>`.
pub fn check_bind(addr: SocketAddr) -> Result<(), LoopbackError> {
    match addr {
        SocketAddr::V4(v4) if *v4.ip() == Ipv4Addr::LOCALHOST => Ok(()),
        other => Err(LoopbackError::NotLoopback(other)),
    }
}

impl LoopbackServer {
    /// Listens on `addr`, which must be `127.0.0.1:<port>` (port 0 picks a free one).
    pub async fn bind(addr: SocketAddr) -> Result<LoopbackServer, LoopbackError> {
        check_bind(addr)?;
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let addr = listener.local_addr()?;
        check_bind(addr)?;
        Ok(LoopbackServer { listener, addr })
    }

    /// Listens on `127.0.0.1:<port>`.
    pub async fn bind_port(port: u16) -> Result<LoopbackServer, LoopbackError> {
        LoopbackServer::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await
    }

    /// The address listened on.
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Serves until `shutdown` resolves: each request goes through the [`Guard`], then to `handler`.
    pub async fn serve(
        self,
        token: Arc<Token>,
        handler: Arc<dyn Handler>,
        shutdown: impl Future<Output = ()>,
    ) -> Result<(), LoopbackError> {
        let guard = Arc::new(Guard::new(self.addr.port(), token));
        let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
        tokio::pin!(shutdown);
        loop {
            let (stream, peer) = tokio::select! {
                () = &mut shutdown => return Ok(()),
                accepted = self.listener.accept() => match accepted {
                    Ok(a) => a,
                    Err(e) => {
                        tracing::debug!("accept: {e}");
                        continue;
                    }
                },
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                tracing::debug!("too many connections; closing one");
                continue;
            };
            let guard = guard.clone();
            let handler = handler.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |req: Request<Incoming>| {
                    let guard = guard.clone();
                    let handler = handler.clone();
                    async move { Ok::<_, std::convert::Infallible>(answer(&guard, handler.as_ref(), req).await) }
                });
                let conn = hyper::server::conn::http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(HEADER_TIMEOUT)
                    .max_buf_size(64 * 1024)
                    .serve_connection(TokioIo::new(stream), service);
                if let Err(e) = conn.await {
                    tracing::debug!("connection: {e}");
                }
                drop(permit);
            });
        }
    }
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
}

/// Answers one request: the guard, the body limits, then the handler.
pub async fn answer(guard: &Guard, handler: &dyn Handler, req: Request<Incoming>) -> Response<Body> {
    let cors = match guard.check(&req) {
        Verdict::Respond(r) => return r,
        Verdict::Pass(c) => c,
    };
    let mut resp = read_and_handle(handler, req).await;
    cors.apply(&mut resp);
    resp
}

async fn read_and_handle(handler: &dyn Handler, req: Request<Incoming>) -> Response<Body> {
    let (parts, body) = req.into_parts();
    let declared = parts
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > MAX_BODY as u64) {
        return refusal(StatusCode::PAYLOAD_TOO_LARGE, "the body is larger than 4 MiB");
    }
    if parts.method == Method::POST && !is_json(&parts.headers) {
        return refusal(StatusCode::UNSUPPORTED_MEDIA_TYPE, "the body must be application/json");
    }
    let body = match Limited::new(body, MAX_BODY).collect().await {
        Ok(b) => b.to_bytes(),
        Err(e) if e.is::<http_body_util::LengthLimitError>() => {
            return refusal(StatusCode::PAYLOAD_TOO_LARGE, "the body is larger than 4 MiB");
        }
        Err(_) => return refusal(StatusCode::BAD_REQUEST, "the body could not be read"),
    };
    let inbound = Inbound {
        method: parts.method,
        path: parts.uri.path().to_owned(),
        headers: parts.headers,
        body,
    };
    match tokio::time::timeout(REQUEST_TIMEOUT, handler.handle(inbound)).await {
        Ok(r) => r,
        Err(_) => refusal(StatusCode::GATEWAY_TIMEOUT, "the request took too long"),
    }
}

/// How a JSON-RPC message posted by a client reads.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    /// A request: it gets a response.
    Request { id: Value, method: String },
    /// A notification: no response.
    Notification { method: String },
    /// A response to a request of the server.
    Response { id: Value },
}

/// Reads a posted body as one JSON-RPC message; a batch, or anything that is not JSON-RPC, is an error message.
pub fn classify(body: &[u8]) -> Result<(Value, Message), &'static str> {
    let v: Value = serde_json::from_slice(body).map_err(|_| "the body is not JSON")?;
    if v.is_array() {
        return Err("JSON-RPC batches are not supported; send one message per request");
    }
    let obj = v.as_object().ok_or("a JSON-RPC message is an object")?;
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("not a JSON-RPC 2.0 message");
    }
    let id = obj.get("id").filter(|i| i.is_string() || i.is_number()).cloned();
    let method = obj.get("method").and_then(Value::as_str).map(str::to_owned);
    let msg = match (method, id) {
        (Some(method), Some(id)) => Message::Request { id, method },
        (Some(method), None) if !obj.contains_key("id") => Message::Notification { method },
        (None, Some(id)) if obj.contains_key("result") || obj.contains_key("error") => Message::Response { id },
        _ => return Err("not a JSON-RPC request, notification or response"),
    };
    Ok((v, msg))
}

/// The protocol revisions understood; `MCP-Protocol-Version` must be one of them when present.
pub const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// The refusal of an `MCP-Protocol-Version` header naming a revision this server does not know, if it does.
pub fn check_protocol_header(req: &Inbound) -> Option<Response<Body>> {
    match req.headers.get("mcp-protocol-version") {
        Some(v) if !v.to_str().is_ok_and(|v| PROTOCOL_VERSIONS.contains(&v)) => {
            Some(refusal(StatusCode::BAD_REQUEST, "unsupported MCP-Protocol-Version"))
        }
        _ => None,
    }
}

/// A random session id: 128 bits, hex.
pub fn new_session_id() -> String {
    let mut b = [0u8; 16];
    // A failure leaves zeros; the ids are not secrets (the token is), only names.
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> (Guard, Arc<Token>) {
        let t = Arc::new(Token::generate().expect("token"));
        (Guard::new(4242, t.clone()), t)
    }

    fn req(method: &str, uri: &str, headers: &[(&str, &str)]) -> Request<()> {
        let mut b = Request::builder().method(method).uri(uri);
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        b.body(()).expect("request")
    }

    fn status(v: Verdict) -> StatusCode {
        match v {
            Verdict::Respond(r) => r.status(),
            Verdict::Pass(_) => StatusCode::OK,
        }
    }

    #[test]
    fn tokens_round_trip_and_compare() {
        let t = Token::generate().expect("token");
        let shown = t.display();
        assert_eq!(shown.len(), 52 + 12);
        assert_eq!(shown.split('-').count(), 13);
        assert!(shown.bytes().all(|b| b == b'-' || BASE32.contains(&b)));
        assert!(t.matches(&shown));
        assert!(t.matches(&shown.replace('-', "")));
        assert!(t.matches(&shown.to_ascii_uppercase()));
        let other = Token::generate().expect("token");
        assert!(!t.matches(&other.display()));
        assert!(!t.matches(""));
        assert!(!t.matches(&shown[..shown.len() - 1]));
        assert!(!t.matches(&format!("{}a", shown.as_str())));
        assert!(Token::parse("not a token").is_err());
        assert_eq!(format!("{t:?}"), "Token(..)");
        // The last character carries 1 bit and 4 zero bits: a set padding bit would be a second spelling.
        let zero = Token(Zeroizing::new([0u8; 32]));
        let shown = zero.display();
        assert_eq!(shown.replace('-', ""), "a".repeat(52));
        assert!(zero.matches(&shown));
        assert!(Token::parse(&format!("{}b", "a".repeat(51))).is_err());
        assert!(Token::parse(&format!("{}q", "a".repeat(51))).is_ok());
    }

    #[test]
    fn origins_are_the_app_and_local_development_servers() {
        assert!(origin_allowed("https://maxgfr.github.io"));
        assert!(origin_allowed("http://localhost:5173"));
        assert!(origin_allowed("http://localhost"));
        assert!(origin_allowed("http://127.0.0.1:4173"));
        for bad in [
            "https://maxgfr.github.io.evil.com",
            "https://evil.github.io",
            "http://maxgfr.github.io",
            "https://maxgfr.github.io:8443",
            "http://localhost.evil.com",
            "http://localhost:0",
            "http://localhost:65536",
            "http://localhost:80a",
            "https://localhost:5173",
            "http://[::1]:5173",
            "null",
            "",
        ] {
            assert!(!origin_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn hosts_are_the_loopback_with_the_port() {
        assert!(host_allowed("127.0.0.1:4242", 4242));
        assert!(host_allowed("localhost:4242", 4242));
        assert!(host_allowed("LOCALHOST:4242", 4242));
        assert!(!host_allowed("127.0.0.1:4243", 4242));
        assert!(!host_allowed("127.0.0.1", 4242));
        assert!(host_allowed("127.0.0.1", 80));
        assert!(!host_allowed("evil.com:4242", 4242));
        assert!(!host_allowed("127.0.0.1.evil.com:4242", 4242));
        assert!(!host_allowed("[::1]:4242", 4242));
        assert!(!host_allowed("", 4242));
    }

    #[test]
    fn the_guard_checks_host_origin_url_and_token_in_order() {
        let (g, t) = guard();
        let bearer = format!("Bearer {}", t.display().as_str());
        let host = ("host", "127.0.0.1:4242");
        let ok = |headers: &[(&str, &str)]| g.check(&req("POST", "/mcp", headers));
        assert!(matches!(
            ok(&[host, ("authorization", &bearer)]),
            Verdict::Pass(Cors(None))
        ));
        assert_eq!(
            status(ok(&[("authorization", &bearer)])),
            StatusCode::MISDIRECTED_REQUEST
        );
        assert_eq!(
            status(ok(&[("host", "evil.example:4242"), ("authorization", &bearer)])),
            StatusCode::MISDIRECTED_REQUEST
        );
        assert_eq!(
            status(g.check(&req(
                "POST",
                "http://evil.example:4242/mcp",
                &[host, ("authorization", &bearer)]
            ))),
            StatusCode::MISDIRECTED_REQUEST
        );
        assert_eq!(status(ok(&[host])), StatusCode::UNAUTHORIZED);
        assert_eq!(
            status(ok(&[host, ("authorization", "Bearer wrong")])),
            StatusCode::UNAUTHORIZED
        );
        let other = Token::generate().expect("token");
        let wrong = format!("Bearer {}", other.display().as_str());
        assert_eq!(status(ok(&[host, ("authorization", &wrong)])), StatusCode::UNAUTHORIZED);
        let basic = format!("Basic {}", t.display().as_str());
        assert_eq!(status(ok(&[host, ("authorization", &basic)])), StatusCode::UNAUTHORIZED);
        assert!(matches!(
            ok(&[
                host,
                ("authorization", &format!("bearer {}", t.display().replace('-', "")))
            ]),
            Verdict::Pass(_)
        ));
        let in_query = format!("/mcp?token={}", t.display().replace('-', ""));
        assert_eq!(
            status(g.check(&req("POST", &in_query, &[host]))),
            StatusCode::BAD_REQUEST,
            "a token in the URL is refused"
        );
        assert_eq!(
            status(g.check(&req("POST", "/mcp?x=1", &[host, ("authorization", &bearer)]))),
            StatusCode::BAD_REQUEST,
            "even with the right header"
        );
        let unauthorized = ok(&[host, ("origin", APP_ORIGIN)]);
        let Verdict::Respond(r) = unauthorized else {
            panic!("refused");
        };
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            r.headers().get("access-control-allow-origin").map(|v| v.as_bytes()),
            Some(APP_ORIGIN.as_bytes()),
            "a browser can read the 401"
        );
    }

    #[test]
    fn origins_and_preflights() {
        let (g, t) = guard();
        let bearer = format!("Bearer {}", t.display().as_str());
        let host = ("host", "localhost:4242");
        let Verdict::Pass(cors) = g.check(&req(
            "POST",
            "/mcp",
            &[host, ("origin", APP_ORIGIN), ("authorization", &bearer)],
        )) else {
            panic!("allowed origin");
        };
        assert_eq!(cors.origin(), Some(APP_ORIGIN));
        let mut r = empty(StatusCode::OK);
        cors.apply(&mut r);
        assert_eq!(r.headers()["access-control-expose-headers"], "mcp-session-id");
        assert_eq!(r.headers()["vary"], "Origin");
        let evil = [
            host,
            ("origin", "https://evil.example"),
            ("authorization", bearer.as_str()),
        ];
        let Verdict::Respond(refused) = g.check(&req("POST", "/mcp", &evil)) else {
            panic!("refused origin");
        };
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert!(refused.headers().get("access-control-allow-origin").is_none());
        let preflight = req(
            "OPTIONS",
            "/mcp/files",
            &[
                host,
                ("origin", APP_ORIGIN),
                ("access-control-request-method", "POST"),
                (
                    "access-control-request-headers",
                    "authorization, content-type, mcp-session-id",
                ),
                ("access-control-request-private-network", "true"),
            ],
        );
        let Verdict::Respond(p) = g.check(&preflight) else {
            panic!("preflight answered");
        };
        assert_eq!(p.status(), StatusCode::NO_CONTENT);
        let h = p.headers();
        assert_eq!(h["access-control-allow-origin"], APP_ORIGIN);
        assert_eq!(h["access-control-allow-private-network"], "true");
        assert_eq!(h["access-control-allow-headers"], ALLOWED_HEADERS);
        assert!(
            h["access-control-allow-methods"]
                .to_str()
                .expect("ascii")
                .contains("POST")
        );
        assert!(h.get("access-control-allow-credentials").is_none());
        let no_pna = req("OPTIONS", "/mcp", &[host, ("origin", "http://localhost:5173")]);
        let Verdict::Respond(p) = g.check(&no_pna) else {
            panic!("preflight answered");
        };
        assert!(p.headers().get("access-control-allow-private-network").is_none());
        assert_eq!(
            status(g.check(&req("OPTIONS", "/mcp", &[host, ("origin", "https://evil.example")]))),
            StatusCode::FORBIDDEN
        );
        assert_eq!(status(g.check(&req("OPTIONS", "/mcp", &[host]))), StatusCode::FORBIDDEN);
    }

    #[test]
    fn only_the_ipv4_loopback_is_bound() {
        assert!(check_bind("127.0.0.1:0".parse().expect("addr")).is_ok());
        for bad in ["0.0.0.0:0", "192.168.1.2:80", "127.0.0.2:0", "[::1]:0", "[::]:0"] {
            assert!(check_bind(bad.parse().expect("addr")).is_err(), "{bad}");
        }
    }

    #[test]
    fn messages_are_classified() {
        let c = |s: &str| classify(s.as_bytes()).map(|(_, m)| m);
        assert_eq!(
            c(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#),
            Ok(Message::Request {
                id: json!(1),
                method: "ping".into()
            })
        );
        assert_eq!(
            c(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#),
            Ok(Message::Notification {
                method: "notifications/initialized".into()
            })
        );
        assert_eq!(
            c(r#"{"jsonrpc":"2.0","id":"a","result":{}}"#),
            Ok(Message::Response { id: json!("a") })
        );
        assert!(c(r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#).is_err());
        assert!(c(r#"{"id":1,"method":"ping"}"#).is_err());
        assert!(c(r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#).is_err());
        assert!(c("nope").is_err());
    }
}
