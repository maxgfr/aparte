//! The HTTP function the GitHub and S3 stores use, as a trait so the tests run them against in-memory fakes (as the
//! web app's providers take an `http` function). The real one is `reqwest` over rustls with the ring provider, no
//! redirects, bounded timeouts; https only, http only on the loopback.

use std::time::Duration;

use async_trait::async_trait;

/// One request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    /// `GET`, `PUT`...
    pub method: String,
    /// The full URL.
    pub url: String,
    /// Headers to send.
    pub headers: Vec<(String, String)>,
    /// The body, if any.
    pub body: Option<Vec<u8>>,
}

impl HttpRequest {
    /// The value of a header (case-insensitive name).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// One response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    /// The status code.
    pub status: u16,
    /// The headers, names lowercased.
    pub headers: Vec<(String, String)>,
    /// The body.
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// The value of a header (case-insensitive name).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Whether the status is 2xx.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Sends requests; an `Err` means no answer (offline, DNS, TLS, timeout), with a detail.
#[async_trait]
pub trait Http: Send + Sync {
    /// Sends one request.
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String>;
}

/// Refuses a URL that is neither https nor http on the loopback.
pub fn check_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    if let Some(rest) = lower.strip_prefix("http://") {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let host = if host.starts_with('[') {
            host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default()
        } else {
            host.split(':').next().unwrap_or_default().to_owned()
        };
        if matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]") {
            return Ok(());
        }
    }
    Err(format!("{url} is neither https nor http on the loopback"))
}

/// `reqwest` over rustls.
#[derive(Debug, Clone)]
pub struct ReqwestHttp {
    client: reqwest::Client,
}

impl ReqwestHttp {
    /// A client: rustls over ring, no redirects, 30 s to connect, 5 minutes per request.
    pub fn new() -> Result<ReqwestHttp, String> {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(300))
            .user_agent(concat!("aparte/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("cannot build the HTTP client: {e}"))?;
        Ok(ReqwestHttp { client })
    }
}

#[async_trait]
impl Http for ReqwestHttp {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        check_url(&request.url)?;
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|e| e.to_string())?;
        let mut builder = self.client.request(method, &request.url);
        for (k, v) in &request.headers {
            builder = builder.header(k, v);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        // The error of reqwest names the URL, which never carries a credential here.
        let response = builder.send().await.map_err(|e| e.without_url().to_string())?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_ascii_lowercase(),
                    v.to_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        let body = response
            .bytes()
            .await
            .map_err(|e| e.without_url().to_string())?
            .to_vec();
        Ok(HttpResponse { status, headers, body })
    }
}

#[cfg(test)]
mod tests {
    use super::check_url;

    #[test]
    fn only_https_or_the_loopback() {
        assert!(check_url("https://api.github.com/x").is_ok());
        assert!(check_url("http://127.0.0.1:9000/b").is_ok());
        assert!(check_url("http://localhost/b").is_ok());
        assert!(check_url("http://[::1]:8080/").is_ok());
        assert!(check_url("http://example.com/").is_err());
        assert!(check_url("http://localhost.example.com/").is_err());
        assert!(check_url("ftp://x").is_err());
    }
}
