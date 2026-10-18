//! OAuth 2.1 for HTTP servers: authorization code with PKCE (S256), the server's metadata discovered from its
//! protected-resource document, dynamic client registration unless a client id is preset, and a redirect to a
//! loopback listener (`http://127.0.0.1:<random port>/callback`) that lives only for the login.
//!
//! Tokens are kept encrypted: `<config>/mcp-auth/<server>.bin` holds AES-256-GCM ciphertext of the credentials, and
//! its 256-bit key lives in the OS keychain (a [`SecretVault`]) under the account `mcp-oauth:<server>`. The keychain
//! commands cap the size of a secret, which a pair of tokens can exceed; a key never does. Nothing readable is left on
//! disk, and removing the keychain entry makes the file useless.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use rmcp::transport::auth::{
    AuthError, AuthorizationCallback, AuthorizationManager, AuthorizationRequest, CredentialStore, OAuthState,
    StoredCredentials,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::McpError;

/// How long a login waits for the browser to come back.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Where secrets are kept: the OS keychain in the binary, memory in tests.
pub trait SecretVault: Send + Sync {
    /// The secret of an account, if any.
    fn get(&self, account: &str) -> Option<String>;
    /// Stores a secret.
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    /// Removes a secret; true when there was one.
    fn delete(&self, account: &str) -> Result<bool, String>;
}

/// A vault in memory, for tests and for sessions without a keychain.
#[derive(Debug, Default)]
pub struct MemoryVault(Mutex<HashMap<String, String>>);

impl SecretVault for MemoryVault {
    fn get(&self, account: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(account)
            .cloned()
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<bool, String> {
        Ok(self
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(account)
            .is_some())
    }
}

const AAD_PREFIX: &str = "aparte-mcp-oauth/1:";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// The OAuth credentials of one server, encrypted on disk under a key from the vault.
#[derive(Clone)]
pub struct TokenStore {
    server: String,
    path: PathBuf,
    vault: Arc<dyn SecretVault>,
}

impl std::fmt::Debug for TokenStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenStore")
            .field("server", &self.server)
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

fn store_err(e: impl std::fmt::Display) -> AuthError {
    AuthError::CredentialStoreError(e.to_string())
}

impl TokenStore {
    /// The store of `server` under `<config_dir>/mcp-auth`.
    pub fn new(config_dir: &Path, server: &str, vault: Arc<dyn SecretVault>) -> TokenStore {
        TokenStore {
            server: server.to_owned(),
            path: config_dir.join("mcp-auth").join(format!("{server}.bin")),
            vault,
        }
    }

    fn account(&self) -> String {
        format!("mcp-oauth:{}", self.server)
    }

    fn aad(&self) -> Vec<u8> {
        format!("{AAD_PREFIX}{}", self.server).into_bytes()
    }

    /// Whether credentials are stored.
    pub fn exists(&self) -> bool {
        self.path.is_file()
    }

    fn key(&self, create: bool) -> Result<Option<[u8; 32]>, AuthError> {
        if let Some(k) = self.vault.get(&self.account()).and_then(|h| unhex(&h)) {
            let key: [u8; 32] = k
                .try_into()
                .map_err(|_| store_err("the keychain entry is not a 256-bit key"))?;
            return Ok(Some(key));
        }
        if !create {
            return Ok(None);
        }
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).map_err(store_err)?;
        self.vault
            .set(&self.account(), &hex(&key))
            .map_err(|e| store_err(format!("cannot keep the token key in the OS keychain: {e}")))?;
        Ok(Some(key))
    }

    /// Reads the credentials; `None` when there are none or the key is gone.
    pub fn read(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(store_err(e)),
        };
        let Some(key) = self.key(false)? else {
            return Ok(None);
        };
        if bytes.len() < 12 + 16 {
            return Err(store_err("the token file is truncated"));
        }
        let (iv, sealed) = bytes.split_at(12);
        let iv: [u8; 12] = iv.try_into().map_err(store_err)?;
        let plain = aparte_crypto::primitives::aes_gcm_decrypt(&key, &iv, sealed, &self.aad())
            .map_err(|_| store_err("the token file does not decrypt with the keychain key"))?;
        serde_json::from_slice(&plain).map(Some).map_err(store_err)
    }

    /// Writes the credentials.
    pub fn write(&self, creds: &StoredCredentials) -> Result<(), AuthError> {
        let key = self.key(true)?.ok_or_else(|| store_err("no key"))?;
        let plain = zeroize::Zeroizing::new(serde_json::to_vec(creds).map_err(store_err)?);
        let mut iv = [0u8; 12];
        getrandom::fill(&mut iv).map_err(store_err)?;
        let sealed = aparte_crypto::primitives::aes_gcm_encrypt(&key, &iv, &plain, &self.aad()).map_err(store_err)?;
        let mut out = iv.to_vec();
        out.extend_from_slice(&sealed);
        if let Some(parent) = self.path.parent() {
            aparte_agent::fsx::private_dir(parent).map_err(store_err)?;
        }
        aparte_agent::fsx::atomic_write(&self.path, &out, 0o600).map_err(store_err)
    }

    /// Removes the file and the key; true when something was removed.
    pub fn remove(&self) -> Result<bool, AuthError> {
        let file = match std::fs::remove_file(&self.path) {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(store_err(e)),
        };
        let key = self.vault.delete(&self.account()).unwrap_or(false);
        Ok(file || key)
    }
}

#[async_trait::async_trait]
impl CredentialStore for TokenStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.read())
            .await
            .map_err(store_err)?
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.write(&credentials))
            .await
            .map_err(store_err)?
    }

    async fn clear(&self) -> Result<(), AuthError> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.remove().map(|_| ()))
            .await
            .map_err(store_err)?
    }
}

/// An authorization manager for `url` with the stored credentials, when there are some.
pub async fn authorized_manager(
    url: &str,
    store: TokenStore,
    http: reqwest::Client,
) -> Result<Option<AuthorizationManager>, McpError> {
    if !store.exists() {
        return Ok(None);
    }
    let mut manager = AuthorizationManager::new(url).await.map_err(auth)?;
    manager.with_client(http).map_err(auth)?;
    manager.set_credential_store(store);
    if manager.initialize_from_store().await.map_err(auth)? {
        Ok(Some(manager))
    } else {
        Ok(None)
    }
}

fn auth(e: AuthError) -> McpError {
    McpError::Auth(e.to_string())
}

/// What a login needs besides the server.
pub struct Login<'a> {
    /// A preset client id (else the client registers itself).
    pub client_id: Option<String>,
    pub scopes: Vec<String>,
    /// Shown the authorization URL to open (the binary prints it and starts the browser).
    pub open: &'a (dyn Fn(&str) + Send + Sync),
    pub timeout: Duration,
}

/// Runs the authorization code flow for the server at `url`, and stores the tokens.
pub async fn login(url: &str, store: TokenStore, http: reqwest::Client, opts: Login<'_>) -> Result<(), McpError> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let mut manager = AuthorizationManager::new(url).await.map_err(auth)?;
    manager.with_client(http).map_err(auth)?;
    manager.set_credential_store(store);
    let mut state = OAuthState::Unauthorized(manager);
    let mut req = AuthorizationRequest::new(redirect.clone()).with_client_name("aparte");
    if let Some(id) = &opts.client_id {
        req = req.with_preregistered_client(id.clone());
    }
    if !opts.scopes.is_empty() {
        req = req.with_scopes(opts.scopes.iter().cloned());
    }
    state.start_authorization(req).await.map_err(auth)?;
    let auth_url = state.get_authorization_url().await.map_err(auth)?;
    (opts.open)(&auth_url);
    let callback = tokio::time::timeout(opts.timeout, wait_callback(&listener, port))
        .await
        .map_err(|_| McpError::Auth("the login timed out waiting for the browser".into()))??;
    let cb = AuthorizationCallback::from_redirect_url(&callback).map_err(auth)?;
    state
        .handle_callback_with_issuer(&cb.code, &cb.csrf_token, cb.issuer.as_deref())
        .await
        .map_err(auth)?;
    Ok(())
}

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>aparte</title><p>Signed in. You can close this tab \
                       and go back to the terminal.";
const PAGE_ERR: &str = "<!doctype html><meta charset=utf-8><title>aparte</title><p>The sign-in did not complete. \
                        Go back to the terminal for details.";

/// Waits for the redirect on the loopback listener; returns the full callback URL.
async fn wait_callback(listener: &tokio::net::TcpListener, port: u16) -> Result<String, McpError> {
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let head = loop {
            let n = sock.read(&mut chunk).await?;
            if n == 0 {
                break None;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break Some(String::from_utf8_lossy(&buf[..end]).into_owned());
            }
            if buf.len() > 64 * 1024 {
                break None;
            }
        };
        let Some(head) = head else {
            continue;
        };
        let target = head
            .lines()
            .next()
            .and_then(|l| l.strip_prefix("GET "))
            .and_then(|l| l.split(' ').next())
            .unwrap_or_default()
            .to_owned();
        if !target.starts_with("/callback") {
            let _ = sock
                .write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                .await;
            continue;
        }
        let url = format!("http://127.0.0.1:{port}{target}");
        let failed = url_param(&url, "error");
        let page = if failed.is_some() { PAGE_ERR } else { PAGE_OK };
        let reply = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\ncache-control: \
             no-store\r\nconnection: close\r\n\r\n{page}",
            page.len()
        );
        let _ = sock.write_all(reply.as_bytes()).await;
        let _ = sock.shutdown().await;
        if let Some(e) = failed {
            let detail = url_param(&url, "error_description").unwrap_or_default();
            return Err(McpError::Auth(
                format!("the authorization server refused: {e} {detail}")
                    .trim()
                    .to_owned(),
            ));
        }
        return Ok(url);
    }
}

/// A query parameter, percent-decoded.
pub fn url_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1.split('#').next()?;
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(k) == name).then(|| percent_decode(v))
    })
}

/// Decodes `%XX` and `+` (form encoding).
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' => match s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(v) => {
                    out.push(v);
                    i += 3;
                    continue;
                }
                None => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_encrypted_under_a_vault_key() {
        let dir = tempfile::tempdir().expect("dir");
        let vault: Arc<dyn SecretVault> = Arc::new(MemoryVault::default());
        let store = TokenStore::new(dir.path(), "srv", vault.clone());
        assert!(store.read().expect("read").is_none());
        let creds = StoredCredentials::new("client-1".into(), None, vec!["mcp".into()], Some(1));
        store.write(&creds).expect("write");
        let raw = std::fs::read(dir.path().join("mcp-auth/srv.bin")).expect("file");
        assert!(
            !String::from_utf8_lossy(&raw).contains("client-1"),
            "nothing readable on disk"
        );
        let back = store.read().expect("read").expect("some");
        assert_eq!(back.client_id, "client-1");
        assert_eq!(vault.get("mcp-oauth:srv").map(|k| k.len()), Some(64));
        // Another server's file under this key does not open (the server name is authenticated).
        std::fs::copy(
            dir.path().join("mcp-auth/srv.bin"),
            dir.path().join("mcp-auth/other.bin"),
        )
        .expect("copy");
        vault
            .set("mcp-oauth:other", &vault.get("mcp-oauth:srv").expect("key"))
            .expect("set");
        assert!(TokenStore::new(dir.path(), "other", vault.clone()).read().is_err());
        assert!(store.remove().expect("remove"));
        assert!(store.read().expect("read").is_none() && vault.get("mcp-oauth:srv").is_none());
    }

    #[test]
    fn query_parameters_decode() {
        let u = "http://127.0.0.1:1/callback?code=a%2Fb+c&state=xyz&error_description=Access%20denied";
        assert_eq!(url_param(u, "code").as_deref(), Some("a/b c"));
        assert_eq!(url_param(u, "state").as_deref(), Some("xyz"));
        assert_eq!(url_param(u, "error_description").as_deref(), Some("Access denied"));
        assert_eq!(url_param(u, "missing"), None);
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(unhex("0aff"), Some(vec![10, 255]));
        assert_eq!(unhex("0g"), None);
    }
}
