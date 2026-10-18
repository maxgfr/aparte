//! `web_fetch`: downloads a page over http(s) and returns it as text (HTML reduced to its readable text). The
//! page is untrusted input for the model; the approval rules ask before any network access in an untrusted
//! project.

use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;

use aparte_agent::{Annotations, BoxFuture, ToolContext, ToolError, ToolOutput, TypedTool};
use futures_util::StreamExt;
use regex::Regex;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use crate::output::{BlobStore, Keep};

/// Largest body read.
const MAX_BODY: usize = 5 * 1024 * 1024;

/// Input of `web_fetch`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct WebFetchInput {
    /// An http or https URL.
    pub url: String,
}

/// Fetches web pages.
#[derive(Debug, Clone)]
pub struct WebFetch {
    pub blobs: Arc<BlobStore>,
    http: reqwest::Client,
}

impl WebFetch {
    /// A fetcher with its own HTTP client (5 redirects at most, 30 s deadline).
    pub fn new(blobs: Arc<BlobStore>) -> Result<WebFetch, String> {
        aparte_llm::client::install_tls_provider();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(concat!("aparte/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(WebFetch { blobs, http })
    }
}

static DROP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<(script|style|noscript|svg|head)\b[^>]*>.*?</(script|style|noscript|svg|head)\s*>|<!--.*?-->")
        .expect("regex")
});
static BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)</?(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|pre|blockquote)\b[^>]*>")
        .expect("regex")
});
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").expect("regex"));
static BLANKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n[ \t]*(\n[ \t]*)+").expect("regex"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+").expect("regex"));

/// The readable text of an HTML document.
pub fn html_to_text(html: &str) -> String {
    let s = DROP.replace_all(html, "");
    let s = BLOCK.replace_all(&s, "\n");
    let s = TAG.replace_all(&s, "");
    let s = s
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    let s = SPACES.replace_all(&s, " ");
    BLANKS.replace_all(&s, "\n\n").trim().to_owned()
}

impl TypedTool for WebFetch {
    type Input = WebFetchInput;
    fn name(&self) -> &str {
        "web_fetch"
    }
    fn description(&self) -> &str {
        "Fetches an http(s) URL and returns its text (HTML reduced to readable text), cut at 50 KiB."
    }
    fn annotations(&self) -> Annotations {
        Annotations {
            read_only: true,
            destructive: false,
            idempotent: true,
            open_world: true,
        }
    }
    fn run<'a>(&'a self, _ctx: &'a ToolContext, input: WebFetchInput) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            let url = input.url.trim();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err(ToolError::InvalidInput("only http and https URLs are fetched".into()));
            }
            let resp = self
                .http
                .get(url)
                .send()
                .await
                .map_err(|e| ToolError::Failed(format!("fetch failed: {e}")))?;
            let status = resp.status();
            let ctype = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_lowercase();
            let textual = ctype.is_empty()
                || ctype.starts_with("text/")
                || ctype.contains("json")
                || ctype.contains("xml")
                || ctype.contains("javascript");
            if !textual {
                return Err(ToolError::Failed(format!("{url} is {ctype}, not text")));
            }
            let mut body = Vec::new();
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| ToolError::Failed(format!("fetch failed: {e}")))?;
                body.extend_from_slice(&chunk);
                if body.len() >= MAX_BODY {
                    body.truncate(MAX_BODY);
                    break;
                }
            }
            let raw = String::from_utf8_lossy(&body);
            let text = if ctype.contains("html") || (ctype.is_empty() && raw.trim_start().starts_with('<')) {
                html_to_text(&raw)
            } else {
                raw.into_owned()
            };
            let (shown, saved) = self.blobs.fit("web", &text, Keep::Head);
            Ok(ToolOutput {
                content: shown,
                details: Some(json!({ "status": status.as_u16(), "contentType": ctype, "saved": saved })),
                is_error: !status.is_success(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::html_to_text;

    #[test]
    fn html_becomes_readable_text() {
        let html = "<html><head><title>x</title><style>p{}</style></head><body><h1>Title</h1>\
                    <p>One &amp; <b>two</b></p><script>alert(1)</script><!-- c --><p>Three</p></body></html>";
        assert_eq!(html_to_text(html), "Title\n\nOne & two\n\nThree");
    }
}
