//! An S3-compatible bucket as a sync store (AWS S3, Cloudflare R2, MinIO, Backblaze B2, Garage), a port of the web
//! app's provider (web/src/core/sync/providers/s3.ts) with the same Signature V4 (sigv4.rs). Path-style addressing:
//! `<endpoint>/<bucket>/<prefix><name>`; objects are stored as they are.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use super::http::{Http, HttpRequest, HttpResponse};
use super::sigv4::{SigV4Input, amz_date, encode_key, sign_v4, uri_encode};
use crate::error::{RemoteError, RemoteErrorKind};
use crate::remote::{DestinationKind, RemoteEntry, RemoteStore};

/// Where a bucket is and how to sign for it.
#[derive(Clone, PartialEq, Eq)]
pub struct S3Target {
    /// Base URL without the bucket, such as `https://<account>.r2.cloudflarestorage.com`.
    pub endpoint: String,
    /// `auto` for R2, `us-east-1` for MinIO's default.
    pub region: String,
    /// The bucket.
    pub bucket: String,
    /// A folder inside the bucket.
    pub prefix: Option<String>,
    /// The access key id.
    pub access_key_id: String,
    /// The secret access key.
    pub secret_access_key: String,
}

impl std::fmt::Debug for S3Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Target")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("prefix", &self.prefix)
            .finish_non_exhaustive()
    }
}

fn normalize_prefix(prefix: Option<&str>) -> String {
    let p = prefix.unwrap_or_default().trim().trim_matches('/');
    if p.is_empty() { String::new() } else { format!("{p}/") }
}

/// The web app's id of a bucket store.
pub fn s3_store_id(t: &S3Target) -> String {
    format!(
        "s3:{}/{}/{}",
        t.endpoint.trim_end_matches('/'),
        t.bucket,
        normalize_prefix(t.prefix.as_deref())
    )
}

/// The five XML entities and numeric references.
pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|&e| e <= 12) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let decoded = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            n if n.starts_with("#x") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32),
            n if n.starts_with('#') => n[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The text of the first `<tag>` element of `xml`.
fn tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let mut from = 0;
    while let Some(i) = xml[from..].find(&open) {
        let start = from + i + open.len();
        let after = xml[start..].chars().next()?;
        if after == '>' || after.is_whitespace() {
            let content_start = start + xml[start..].find('>')? + 1;
            let close = format!("</{tag}>");
            let end = content_start + xml[content_start..].find(&close)?;
            return Some(decode_entities(&xml[content_start..end]));
        }
        from = start;
    }
    None
}

/// The bodies of every `<tag>...</tag>`.
fn elements<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let body = &rest[i + open.len()..];
        let Some(j) = body.find(&close) else { break };
        out.push(&body[..j]);
        rest = &body[j + close.len()..];
    }
    out
}

/// One page of a ListObjectsV2 answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListPage {
    /// Keys and sizes.
    pub keys: Vec<(String, u64)>,
    /// More pages follow.
    pub truncated: bool,
    /// The token of the next page.
    pub next_token: Option<String>,
}

/// Parses a ListObjectsV2 answer.
pub fn parse_list_page(xml: &str) -> ListPage {
    let keys = elements(xml, "Contents")
        .into_iter()
        .filter_map(|c| {
            let key = tag_text(c, "Key")?;
            let size = tag_text(c, "Size").and_then(|s| s.trim().parse().ok()).unwrap_or(0);
            Some((key, size))
        })
        .collect();
    ListPage {
        keys,
        truncated: tag_text(xml, "IsTruncated").as_deref() == Some("true"),
        next_token: tag_text(xml, "NextContinuationToken").filter(|t| !t.is_empty()),
    }
}

/// An HTTP failure as a store error kind; the S3 code wins over the status.
pub fn classify(status: u16, code: &str) -> RemoteErrorKind {
    match code {
        "RequestTimeTooSkewed" => RemoteErrorKind::ClockSkew,
        "SlowDown" | "TooManyRequests" => RemoteErrorKind::RateLimited,
        "QuotaExceeded" | "XMinioStorageFull" | "StorageFull" | "EntityTooLarge" => RemoteErrorKind::Quota,
        "InvalidAccessKeyId"
        | "SignatureDoesNotMatch"
        | "ExpiredToken"
        | "InvalidToken"
        | "AuthorizationHeaderMalformed"
        | "PermanentRedirect"
        | "IllegalLocationConstraintException" => RemoteErrorKind::Auth,
        "NoSuchBucket" => RemoteErrorKind::NotFound,
        _ => match status {
            429 | 503 => RemoteErrorKind::RateLimited,
            507 => RemoteErrorKind::Quota,
            401 => RemoteErrorKind::Auth,
            s if s >= 500 => RemoteErrorKind::Network,
            _ => RemoteErrorKind::Permission,
        },
    }
}

/// An S3 store.
pub struct S3Store {
    id: String,
    target: S3Target,
    prefix: String,
    base: String,
    http: Arc<dyn Http>,
    /// Server time minus local time, learnt from a RequestTimeTooSkewed answer.
    skew_ms: Mutex<i64>,
}

impl std::fmt::Debug for S3Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Store").field("id", &self.id).finish_non_exhaustive()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `Fri, 24 May 2013 00:00:00 GMT` or an ISO 8601 time, in Unix milliseconds.
fn parse_http_date(text: &str) -> Option<i64> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let t = text.trim();
    let (y, mo, d, h, mi, s) = if let Some(rest) = t.split_once(", ").map(|(_, r)| r) {
        let parts: Vec<&str> = rest.split([' ', ':']).collect();
        if parts.len() < 6 {
            return None;
        }
        let mo = MONTHS.iter().position(|m| *m == parts[1])? as i64 + 1;
        (
            parts[2].parse().ok()?,
            mo,
            parts[0].parse().ok()?,
            parts[3].parse().ok()?,
            parts[4].parse().ok()?,
            parts[5].parse().ok()?,
        )
    } else {
        let digits: Vec<i64> = t
            .split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .filter_map(|p| p.parse().ok())
            .collect();
        if digits.len() < 6 {
            return None;
        }
        (digits[0], digits[1], digits[2], digits[3], digits[4], digits[5])
    };
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400) + h * 3600 + mi * 60 + s) * 1000)
}

impl S3Store {
    /// A store of `target`.
    pub fn new(target: S3Target, http: Arc<dyn Http>) -> S3Store {
        let prefix = normalize_prefix(target.prefix.as_deref());
        let base = format!(
            "{}/{}",
            target.endpoint.trim_end_matches('/'),
            uri_encode(&target.bucket)
        );
        S3Store {
            id: s3_store_id(&target),
            target,
            prefix,
            base,
            http,
            skew_ms: Mutex::new(0),
        }
    }

    fn skew(&self) -> i64 {
        *self.skew_ms.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    async fn send(&self, method: &str, url: &str, body: Option<&[u8]>) -> Result<HttpResponse, RemoteError> {
        let at = u64::try_from(now_ms() + self.skew()).unwrap_or(0);
        let datetime = amz_date(at);
        let headers: &[(&str, &str)] = if body.is_some() {
            &[("content-type", "application/octet-stream")]
        } else {
            &[]
        };
        let signed = sign_v4(&SigV4Input {
            method,
            url,
            headers,
            body: body.unwrap_or_default(),
            region: &self.target.region,
            service: "s3",
            datetime: &datetime,
            access_key_id: &self.target.access_key_id,
            secret_access_key: &self.target.secret_access_key,
            session_token: None,
        });
        self.http
            .send(HttpRequest {
                method: method.to_owned(),
                url: url.to_owned(),
                headers: signed.headers,
                body: body.map(<[u8]>::to_vec),
            })
            .await
            .map_err(|e| RemoteError::new(RemoteErrorKind::Network, format!("S3 {method}: no answer ({e})")))
    }

    /// One signed request; a RequestTimeTooSkewed answer is retried once with the server's time. 404 is returned.
    async fn request(&self, method: &str, url: &str, body: Option<&[u8]>) -> Result<HttpResponse, RemoteError> {
        for attempt in 0..2 {
            let res = self.send(method, url, body).await?;
            if res.ok() || res.status == 404 {
                return Ok(res);
            }
            let xml = String::from_utf8_lossy(&res.body).into_owned();
            let error = elements(&xml, "Error")
                .first()
                .map(|e| (*e).to_owned())
                .unwrap_or_default();
            let code = tag_text(&error, "Code").unwrap_or_default();
            let kind = classify(res.status, &code);
            if kind == RemoteErrorKind::ClockSkew && attempt == 0 {
                let server = res
                    .header("date")
                    .and_then(parse_http_date)
                    .or_else(|| tag_text(&error, "ServerTime").as_deref().and_then(parse_http_date));
                if let Some(server) = server {
                    *self.skew_ms.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = server - now_ms();
                    continue;
                }
            }
            let message = tag_text(&error, "Message").unwrap_or_default();
            let what = if code.is_empty() {
                format!("HTTP {}", res.status)
            } else if message.is_empty() {
                code.clone()
            } else {
                format!("{code}: {message}")
            };
            let mut err = RemoteError::new(kind, format!("S3 {method}: {what}"));
            if let Some(wait) = res.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok()) {
                err = err.retry_after(wait * 1000);
            }
            return Err(err);
        }
        Err(RemoteError::new(
            RemoteErrorKind::ClockSkew,
            "S3: the clock stays too far from the server's",
        ))
    }

    fn list_url(&self, token: Option<&str>) -> String {
        let mut q = format!("list-type=2&max-keys=1000&prefix={}", uri_encode(&self.prefix));
        if let Some(t) = token {
            q.push_str(&format!("&continuation-token={}", uri_encode(t)));
        }
        format!("{}?{q}", self.base)
    }

    fn object_url(&self, name: &str) -> String {
        format!("{}/{}", self.base, encode_key(&format!("{}{name}", self.prefix)))
    }
}

#[async_trait]
impl RemoteStore for S3Store {
    fn id(&self) -> &str {
        &self.id
    }
    fn kind(&self) -> DestinationKind {
        DestinationKind::S3
    }
    fn keeps_history(&self) -> bool {
        false
    }
    async fn list(&self) -> Result<Vec<RemoteEntry>, RemoteError> {
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let res = self.request("GET", &self.list_url(token.as_deref()), None).await?;
            if res.status == 404 {
                return Err(RemoteError::new(
                    RemoteErrorKind::NotFound,
                    format!("S3 bucket {} not found", self.target.bucket),
                ));
            }
            let page = parse_list_page(&String::from_utf8_lossy(&res.body));
            for (key, size) in page.keys {
                if let Some(name) = key.strip_prefix(&self.prefix) {
                    out.push(RemoteEntry {
                        name: name.to_owned(),
                        size: Some(size),
                        handle: None,
                    });
                }
            }
            if !page.truncated {
                break;
            }
            match page.next_token {
                Some(t) => token = Some(t),
                None => {
                    return Err(RemoteError::new(
                        RemoteErrorKind::Network,
                        "S3 listing truncated without a continuation token",
                    ));
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }
    async fn get(&self, entry: &RemoteEntry) -> Result<Option<Vec<u8>>, RemoteError> {
        let res = self.request("GET", &self.object_url(&entry.name), None).await?;
        Ok((res.status != 404).then_some(res.body))
    }
    async fn put(&self, name: &str, bytes: &[u8]) -> Result<(), RemoteError> {
        let res = self.request("PUT", &self.object_url(name), Some(bytes)).await?;
        if res.status == 404 {
            return Err(RemoteError::new(
                RemoteErrorKind::NotFound,
                format!("S3 bucket {} not found", self.target.bucket),
            ));
        }
        Ok(())
    }
    async fn flush(&self) -> Result<(), RemoteError> {
        Ok(())
    }
    async fn delete(&self, name: &str) -> Result<(), RemoteError> {
        self.request("DELETE", &self.object_url(name), None).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_pages_parse() {
        let xml = "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>p/fmt/1</Key><Size>9</Size></Contents>\
                   <Contents><Key>p/a&amp;b</Key><Size>3</Size></Contents><NextContinuationToken>t1</NextContinuationToken>\
                   </ListBucketResult>";
        let page = parse_list_page(xml);
        assert_eq!(page.keys, vec![("p/fmt/1".to_owned(), 9), ("p/a&b".to_owned(), 3)]);
        assert!(page.truncated);
        assert_eq!(page.next_token.as_deref(), Some("t1"));
        assert_eq!(decode_entities("&lt;&#65;&#x42;&bogus;&"), "<AB&bogus;&");
    }

    #[test]
    fn errors_and_dates() {
        assert_eq!(classify(403, "RequestTimeTooSkewed"), RemoteErrorKind::ClockSkew);
        assert_eq!(classify(403, "SignatureDoesNotMatch"), RemoteErrorKind::Auth);
        assert_eq!(classify(404, "NoSuchBucket"), RemoteErrorKind::NotFound);
        assert_eq!(classify(503, ""), RemoteErrorKind::RateLimited);
        assert_eq!(classify(403, "AccessDenied"), RemoteErrorKind::Permission);
        assert_eq!(
            parse_http_date("Fri, 24 May 2013 00:00:00 GMT"),
            Some(1_369_353_600_000)
        );
        assert_eq!(parse_http_date("2013-05-24T00:00:00Z"), Some(1_369_353_600_000));
        let t = S3Target {
            endpoint: "https://x.r2.cloudflarestorage.com/".into(),
            region: "auto".into(),
            bucket: "b".into(),
            prefix: Some("/vault/".into()),
            access_key_id: "id".into(),
            secret_access_key: "s".into(),
        };
        assert_eq!(s3_store_id(&t), "s3:https://x.r2.cloudflarestorage.com/b/vault/");
        assert!(!format!("{t:?}").contains("secret_access_key"));
    }
}
