//! What a failed provider call means (the same mapping as `web/src/core/ai/errors.ts`). Every message comes from
//! the provider and is untrusted text: it is cut to a readable length and scrubbed of the API key.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::types::{ChatError, ErrorCode};

const MAX_MESSAGE: usize = 500;

fn named(kind: &str) -> Option<ErrorCode> {
    Some(match kind {
        "authentication_error" | "permission_error" | "UNAUTHENTICATED" | "PERMISSION_DENIED" => ErrorCode::Auth,
        "rate_limit_error" | "insufficient_quota" | "RESOURCE_EXHAUSTED" => ErrorCode::RateLimit,
        "overloaded_error" | "UNAVAILABLE" => ErrorCode::Overloaded,
        "api_error" | "INTERNAL" => ErrorCode::Server,
        "not_found_error" | "NOT_FOUND" => ErrorCode::NotFound,
        "invalid_request_error" | "request_too_large" | "INVALID_ARGUMENT" => ErrorCode::InvalidRequest,
        "context_length_exceeded" => ErrorCode::ContextLength,
        _ => return None,
    })
}

static CONTEXT_LENGTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)prompt is too long|context[ _-]?length|context window|maximum context|too many (input )?tokens|input is too long|exceeds the model'?s? (maximum|context)",
    )
    .expect("regex")
});
static BAD_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)api key not valid|invalid api key|incorrect api key|invalid x-api-key").expect("regex")
});

/// Removes the key from a message and cuts it to a readable length.
pub fn scrub(message: &str, key: Option<&str>) -> String {
    let mut out = match key {
        Some(k) if k.len() >= 4 => message.replace(k, "***"),
        _ => message.to_owned(),
    };
    if out.chars().count() > MAX_MESSAGE {
        out = out.chars().take(MAX_MESSAGE).collect::<String>() + "…";
    }
    out
}

/// The provider's error object in a body: `{error: {type, message}}`, `{type, message}` or `[{error}]`.
fn error_object(data: &Value) -> (Option<String>, Option<String>, Option<String>) {
    let root = match data {
        Value::Array(a) => a.first().unwrap_or(&Value::Null),
        v => v,
    };
    let inner = match root.get("error") {
        Some(e @ Value::Object(_)) => e,
        _ => root,
    };
    let s = |v: Option<&Value>| v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let message = s(inner.get("message"))
        .or_else(|| s(root.get("message")))
        .or_else(|| s(root.get("error")))
        .or_else(|| s(root.get("msg")));
    let kind = s(inner.get("type")).or_else(|| s(inner.get("status")));
    let code = s(inner.get("code"));
    (kind, code, message)
}

fn code_for_status(status: u16, kind: Option<&str>, code: Option<&str>, message: &str) -> ErrorCode {
    let by_name = code.and_then(named).or_else(|| kind.and_then(named));
    if (by_name == Some(ErrorCode::ContextLength) || CONTEXT_LENGTH.is_match(message))
        && (matches!(status, 400 | 413 | 422) || by_name == Some(ErrorCode::ContextLength))
    {
        return ErrorCode::ContextLength;
    }
    match status {
        401 | 403 => ErrorCode::Auth,
        429 if by_name == Some(ErrorCode::Overloaded) => ErrorCode::Overloaded,
        429 => ErrorCode::RateLimit,
        529 | 503 => ErrorCode::Overloaded,
        _ if by_name == Some(ErrorCode::Overloaded) => ErrorCode::Overloaded,
        404 => ErrorCode::NotFound,
        s if s >= 500 => ErrorCode::Server,
        400 | 413 | 422 => {
            // Gemini answers a bad key with 400 INVALID_ARGUMENT, "API key not valid".
            if by_name == Some(ErrorCode::Auth) || BAD_KEY.is_match(message) {
                ErrorCode::Auth
            } else {
                ErrorCode::InvalidRequest
            }
        }
        _ => by_name.unwrap_or(ErrorCode::Unknown),
    }
}

/// An HTTP answer that is not a success, from its status and body.
pub fn from_http(status: u16, body: &str, key: Option<&str>) -> ChatError {
    let data = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    let (kind, code, message) = error_object(&data);
    let message = message.unwrap_or_default();
    let ec = code_for_status(status, kind.as_deref(), code.as_deref(), &message);
    ChatError::new(ec, scrub(&message, key), Some(status))
}

/// An error object sent inside an open stream (`event: error` and the like).
pub fn from_stream(data: &Value, key: Option<&str>) -> ChatError {
    let (kind, code, message) = error_object(data);
    let message = message.unwrap_or_default();
    let ec = kind
        .as_deref()
        .and_then(named)
        .or_else(|| code.as_deref().and_then(named))
        .or_else(|| CONTEXT_LENGTH.is_match(&message).then_some(ErrorCode::ContextLength))
        .unwrap_or(ErrorCode::Unknown);
    ChatError::new(ec, scrub(&message, key), None)
}

/// A success status whose body is not an event stream (a gateway that answers errors as `200` JSON, a wrong base
/// URL). The provider's own message is kept when the body has one, else the start of the body.
pub fn not_a_stream(body: &str, key: Option<&str>) -> ChatError {
    let data = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    let (kind, code, message) = error_object(&data);
    let ec = kind
        .as_deref()
        .and_then(named)
        .or_else(|| code.as_deref().and_then(named))
        .unwrap_or(ErrorCode::Unknown);
    let message = message.unwrap_or_else(|| {
        let start: String = body.trim().chars().take(200).collect();
        if start.is_empty() {
            "the provider answered without an event stream".to_owned()
        } else {
            start
        }
    });
    ChatError::new(ec, scrub(&message, key), None)
}

/// The error of a stream that stopped without its finish event.
pub fn truncated() -> ChatError {
    ChatError::new(ErrorCode::Truncated, "", None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_json_body_on_a_success_status_is_an_error_with_the_providers_message() {
        let e = not_a_stream(r#"{"code":500,"msg":"404 NOT_FOUND","success":false}"#, None);
        assert_eq!(
            (e.code, e.message.as_str(), e.status),
            (ErrorCode::Unknown, "404 NOT_FOUND", None)
        );
        let e = not_a_stream(
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#,
            None,
        );
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::RateLimit, "slow down"));
        assert_eq!(
            not_a_stream("<html>gateway</html>", None).message,
            "<html>gateway</html>"
        );
        assert!(!not_a_stream("", None).message.is_empty());
        let e = not_a_stream(r#"{"error":"bad key sk-secret-xyz"}"#, Some("sk-secret-xyz"));
        assert!(!e.message.contains("sk-secret-xyz"));
    }

    #[test]
    fn statuses_and_types_map_like_the_web_app() {
        let e = from_http(
            401,
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
            None,
        );
        assert_eq!((e.code, e.retryable, e.status), (ErrorCode::Auth, false, Some(401)));
        assert_eq!(from_http(529, "", None).code, ErrorCode::Overloaded);
        assert_eq!(from_http(429, "{}", None).code, ErrorCode::RateLimit);
        assert_eq!(
            from_http(
                400,
                r#"{"error":{"message":"prompt is too long: 1000001 tokens"}}"#,
                None
            )
            .code,
            ErrorCode::ContextLength
        );
        assert_eq!(
            from_http(
                400,
                r#"[{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}]"#,
                None
            )
            .code,
            ErrorCode::Auth
        );
    }

    #[test]
    fn the_key_is_scrubbed_from_messages() {
        let e = from_http(
            401,
            r#"{"error":{"message":"bad key sk-secret-123"}}"#,
            Some("sk-secret-123"),
        );
        assert!(!e.message.contains("sk-secret-123"));
    }
}
