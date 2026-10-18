//! AWS Signature Version 4 for S3 requests, written here as in the web app (web/src/core/sync/providers/sigv4.ts) and
//! checked against the same worked examples of the S3 documentation.

use aparte_crypto::primitives::{hmac_sha256, sha256};
use aparte_format::encoding::to_hex;

/// What one request needs signed.
#[derive(Debug, Clone)]
pub struct SigV4Input<'a> {
    /// `GET`, `PUT`...
    pub method: &'a str,
    /// The full URL; the path is used as sent (S3 does not encode it a second time).
    pub url: &'a str,
    /// Headers to send and sign besides host and the x-amz ones.
    pub headers: &'a [(&'a str, &'a str)],
    /// The body.
    pub body: &'a [u8],
    /// The region (`auto` for R2).
    pub region: &'a str,
    /// The service, `s3`.
    pub service: &'a str,
    /// `YYYYMMDDTHHMMSSZ`.
    pub datetime: &'a str,
    /// The access key id.
    pub access_key_id: &'a str,
    /// The secret access key.
    pub secret_access_key: &'a str,
    /// A session token, for temporary credentials.
    pub session_token: Option<&'a str>,
}

/// The signature and every header to send (Authorization included, Host left to the HTTP client).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signed {
    /// Lowercase names.
    pub headers: Vec<(String, String)>,
    /// The canonical request.
    pub canonical_request: String,
    /// The string to sign.
    pub string_to_sign: String,
    /// The hex signature.
    pub signature: String,
}

/// RFC 3986 percent-encoding, as SigV4 wants it.
pub fn uri_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// An S3 key as a URL path: each segment encoded, the slashes kept.
pub fn encode_key(key: &str) -> String {
    key.split('/').map(uri_encode).collect::<Vec<_>>().join("/")
}

/// `20130524T000000Z` for a Unix time in milliseconds.
pub fn amz_date(ms: u64) -> String {
    let secs = ms / 1000;
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn decode_component(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'+', _) => out.push(b' '),
            (b'%', Some(v)) => {
                out.push(v);
                i += 2;
            }
            (c, _) => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Host, path and query of a URL.
fn split_url(url: &str) -> (String, String, String) {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest.split('#').next().unwrap_or_default();
    let (authority, path_query) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let (path, query) = path_query.split_once('?').unwrap_or((path_query, ""));
    let path = if path.is_empty() { "/" } else { path };
    (authority.to_owned(), path.to_owned(), query.to_owned())
}

/// Signs one request.
pub fn sign_v4(input: &SigV4Input<'_>) -> Signed {
    let (host, path, query) = split_url(input.url);
    let payload_hash = to_hex(&sha256(input.body));
    let date = &input.datetime[..8.min(input.datetime.len())];
    let scope = format!("{date}/{}/{}/aws4_request", input.region, input.service);

    let mut send: Vec<(String, String)> = input
        .headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), (*v).to_owned()))
        .collect();
    send.push(("x-amz-content-sha256".into(), payload_hash.clone()));
    send.push(("x-amz-date".into(), input.datetime.to_owned()));
    if let Some(token) = input.session_token {
        send.push(("x-amz-security-token".into(), token.to_owned()));
    }
    let mut signing = send.clone();
    signing.push(("host".into(), host));
    signing.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_headers: String = signing
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.split_whitespace().collect::<Vec<_>>().join(" ")))
        .collect();
    let signed_headers = signing.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");

    let mut pairs: Vec<(String, String)> = query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (uri_encode(&decode_component(k)), uri_encode(&decode_component(v)))
        })
        .collect();
    pairs.sort();
    let canonical_query = pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_request = [
        input.method.to_ascii_uppercase(),
        path,
        canonical_query,
        canonical_headers,
        signed_headers.clone(),
        payload_hash,
    ]
    .join("\n");
    let string_to_sign = [
        "AWS4-HMAC-SHA256".to_owned(),
        input.datetime.to_owned(),
        scope.clone(),
        to_hex(&sha256(canonical_request.as_bytes())),
    ]
    .join("\n");
    let mut key = hmac_sha256(
        format!("AWS4{}", input.secret_access_key).as_bytes(),
        &[date.as_bytes()],
    );
    for part in [input.region, input.service, "aws4_request"] {
        key = hmac_sha256(&key, &[part.as_bytes()]);
    }
    let signature = to_hex(&hmac_sha256(&key, &[string_to_sign.as_bytes()]));
    send.push((
        "authorization".into(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            input.access_key_id
        ),
    ));
    Signed {
        headers: send,
        canonical_request,
        string_to_sign,
        signature,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The worked examples of the Amazon S3 documentation, "Signature Calculations for the Authorization Header:
    // Transferring Payload in a Single Chunk": its published example credentials, bucket examplebucket, us-east-1.
    const KEY_ID: &str = "AKIAIOSFODNN7EXAMPLE";
    const SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    fn input<'a>(method: &'a str, url: &'a str, headers: &'a [(&'a str, &'a str)], body: &'a [u8]) -> SigV4Input<'a> {
        SigV4Input {
            method,
            url,
            headers,
            body,
            region: "us-east-1",
            service: "s3",
            datetime: "20130524T000000Z",
            access_key_id: KEY_ID,
            secret_access_key: SECRET,
            session_token: None,
        }
    }

    #[test]
    fn get_object() {
        let signed = sign_v4(&input(
            "GET",
            "https://examplebucket.s3.amazonaws.com/test.txt",
            &[("Range", "bytes=0-9")],
            b"",
        ));
        assert_eq!(
            to_hex(&sha256(signed.canonical_request.as_bytes())),
            "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972"
        );
        assert_eq!(
            signed.signature,
            "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
        let auth = signed
            .headers
            .iter()
            .find(|(k, _)| k == "authorization")
            .map(|(_, v)| v.as_str());
        assert_eq!(
            auth,
            Some(
                "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
                 SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
                 Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
            )
        );
    }

    #[test]
    fn get_bucket() {
        let signed = sign_v4(&input(
            "GET",
            "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
            &[],
            b"",
        ));
        assert_eq!(
            signed.signature,
            "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
    }

    #[test]
    fn put_object() {
        let url = format!(
            "https://examplebucket.s3.amazonaws.com/{}",
            uri_encode("test$file.text")
        );
        let headers = [
            ("Date", "Fri, 24 May 2013 00:00:00 GMT"),
            ("x-amz-storage-class", "REDUCED_REDUNDANCY"),
        ];
        let signed = sign_v4(&input("PUT", &url, &headers, b"Welcome to Amazon S3."));
        assert_eq!(
            signed.signature,
            "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    }

    #[test]
    fn dates_and_encoding() {
        assert_eq!(amz_date(1_369_353_600_000), "20130524T000000Z");
        assert_eq!(uri_encode("a b!'()*~"), "a%20b%21%27%28%29%2A~");
        assert_eq!(encode_key("d/x y/z"), "d/x%20y/z");
    }
}
