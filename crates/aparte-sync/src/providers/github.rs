//! A GitHub repository as a sync store through the REST API (Git Data API), a port of the web app's provider
//! (web/src/core/sync/providers/github.ts), so both write the same commits.
//!
//! Every object is a file `<root>/<name>` (root `aparte` by default) whose content is the standard base64 of the
//! object's bytes (spec/FORMAT.md section 10.5). `put` stages; `flush` writes everything staged as one commit (one or
//! a few trees, one commit, one fast-forward of the branch), rebuilt on top of a head another device moved. Every
//! content-creating request waits for the pacer (at most 60 a minute, evenly spaced, and 450 an hour), and a 403 or
//! 429 rate-limit answer pauses all writes for the wait the server gave. Commits carry the constant message and
//! author of every device.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::http::{Http, HttpRequest, HttpResponse};
use super::{COMMIT_EMAIL, COMMIT_MESSAGE, COMMIT_NAME, README_TEXT, b64, git_root};
use crate::error::{RemoteError, RemoteErrorKind};
use crate::remote::{DestinationKind, RemoteEntry, RemoteStore};

/// The REST API.
pub const GITHUB_API: &str = "https://api.github.com";
/// The API version every request asks for.
pub const GITHUB_API_VERSION: &str = "2022-11-28";
/// Inline content sent in one tree request at most; a larger batch is split into several trees.
pub const MAX_TREE_BYTES: usize = 4 * 1024 * 1024;
/// Staged content above which `put` writes at once.
pub const MAX_BATCH_BYTES: usize = 16 * 1024 * 1024;
/// Writes a minute.
pub const WRITES_PER_MINUTE: u32 = 60;
/// Writes an hour, below GitHub's 500.
pub const WRITES_PER_HOUR: u32 = 450;
const README: &str = "README.md";
const MAX_REF_RETRIES: usize = 5;

/// Where a GitHub store is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubTarget {
    /// The owner.
    pub owner: String,
    /// The repository.
    pub repo: String,
    /// The branch; `None` for the repository's default branch.
    pub branch: Option<String>,
    /// The folder holding the store; `aparte` when empty.
    pub root: Option<String>,
    /// The API base; `None` for api.github.com.
    pub api_base: Option<String>,
}

/// Same owner, repository, branch and folder, same destination on every device; the web app's id.
pub fn github_store_id(t: &GitHubTarget) -> String {
    let api = t.api_base.as_deref().unwrap_or(GITHUB_API).trim_end_matches('/');
    format!(
        "github:{api}/{}/{}#{}/{}",
        t.owner.trim().to_lowercase(),
        t.repo.trim().to_lowercase(),
        t.branch.as_deref().unwrap_or_default().trim(),
        git_root(t.root.as_deref())
    )
}

/// Write pacing: evenly spaced, a cap per hour, and pauses the server asked for.
#[derive(Debug)]
pub struct Pacer {
    spacing: Duration,
    per_minute: usize,
    per_hour: usize,
    state: tokio::sync::Mutex<PacerState>,
}

#[derive(Debug, Default)]
struct PacerState {
    sent: Vec<Instant>,
    paused_until: Option<Instant>,
}

impl Pacer {
    /// A pacer of `per_minute` evenly spaced writes, at most `per_hour` an hour.
    pub fn new(per_minute: u32, per_hour: u32) -> Pacer {
        let per_minute = per_minute.max(1);
        Pacer {
            spacing: Duration::from_millis(60_000_u64.div_ceil(u64::from(per_minute))),
            per_minute: per_minute as usize,
            per_hour: per_hour.max(1) as usize,
            state: tokio::sync::Mutex::new(PacerState::default()),
        }
    }

    fn next_at(&self, s: &PacerState, now: Instant) -> Instant {
        let mut at = now;
        if let Some(p) = s.paused_until {
            at = at.max(p);
        }
        if let Some(last) = s.sent.last() {
            at = at.max(*last + self.spacing);
        }
        let minute = Duration::from_secs(60);
        let in_minute: Vec<&Instant> = s.sent.iter().filter(|t| at.duration_since(**t) < minute).collect();
        if in_minute.len() >= self.per_minute {
            at = at.max(*in_minute[in_minute.len() - self.per_minute] + minute);
        }
        let hour = Duration::from_secs(3600);
        let in_hour: Vec<&Instant> = s.sent.iter().filter(|t| at.duration_since(**t) < hour).collect();
        if in_hour.len() >= self.per_hour {
            at = at.max(*in_hour[in_hour.len() - self.per_hour] + hour);
        }
        at
    }

    /// Waits until a write may go out, then counts it; callers are served in order.
    pub async fn slot(&self) {
        let mut s = self.state.lock().await;
        loop {
            let now = Instant::now();
            let at = self.next_at(&s, now);
            if at <= now {
                break;
            }
            tokio::time::sleep(at - now).await;
        }
        let now = Instant::now();
        s.sent.push(now);
        s.sent.retain(|t| now.duration_since(*t) < Duration::from_secs(3600));
    }

    /// No write before `ms` from now.
    pub async fn pause(&self, ms: u64) {
        let until = Instant::now() + Duration::from_millis(ms);
        let mut s = self.state.lock().await;
        s.paused_until = Some(s.paused_until.map_or(until, |p| p.max(until)));
    }
}

/// What GitHub said to wait: `retry-after` (seconds), or `x-ratelimit-reset` once `x-ratelimit-remaining` is 0.
fn rate_limit_wait(res: &HttpResponse) -> Option<u64> {
    if let Some(after) = res.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok()) {
        return Some(after * 1000);
    }
    if res.header("x-ratelimit-remaining") == Some("0") {
        let reset = res.header("x-ratelimit-reset")?.trim().parse::<u64>().ok()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        return Some(reset.saturating_sub(now) * 1000);
    }
    None
}

/// A failed answer as a store error: 401 auth, 403/429 rate limit, 404 not found, 413 quota, 5xx network.
pub fn github_error(res: &HttpResponse, what: &str) -> RemoteError {
    let text = String::from_utf8_lossy(&res.body).into_owned();
    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or(text);
    let short: String = message.chars().take(200).collect();
    let detail = format!(
        "GitHub {what}: HTTP {}{}",
        res.status,
        if short.is_empty() {
            String::new()
        } else {
            format!(" {short}")
        }
    );
    let wait = rate_limit_wait(res);
    match res.status {
        401 => RemoteError::new(RemoteErrorKind::Auth, detail),
        429 => RemoteError::new(RemoteErrorKind::RateLimited, detail).retry_after(wait.unwrap_or(60_000)),
        403 if wait.is_some() || message.to_ascii_lowercase().contains("rate limit") => {
            RemoteError::new(RemoteErrorKind::RateLimited, detail).retry_after(wait.unwrap_or(60_000))
        }
        404 => RemoteError::new(RemoteErrorKind::NotFound, detail),
        413 => RemoteError::new(RemoteErrorKind::Quota, detail),
        s if s >= 500 => RemoteError::new(RemoteErrorKind::Network, detail),
        _ => RemoteError::new(RemoteErrorKind::Permission, detail),
    }
}

#[derive(Debug, Clone)]
struct Head {
    commit: String,
    tree: String,
    entries: BTreeMap<String, String>,
}

enum HeadState {
    Head(Head),
    Empty,
    Missing,
}

#[derive(Debug, Default)]
struct Inner {
    branch: Option<String>,
    cache: Option<Head>,
    staged: BTreeMap<String, Option<String>>,
    staged_bytes: usize,
}

/// The GitHub store.
pub struct GitHubStore {
    id: String,
    owner: String,
    repo: String,
    root: String,
    api: String,
    token: String,
    http: Arc<dyn Http>,
    pacer: Arc<Pacer>,
    inner: tokio::sync::Mutex<Inner>,
    /// The last token expiry GitHub reported, as its header text.
    expiry: Mutex<Option<String>>,
}

impl std::fmt::Debug for GitHubStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitHubStore")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

fn enc_path(p: &str) -> String {
    p.split('/').map(percent).collect::<Vec<_>>().join("/")
}

/// `encodeURIComponent`.
fn percent(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl GitHubStore {
    /// A store of `target` with a fine-grained token (this repository only, Contents read and write).
    pub fn new(target: &GitHubTarget, token: &str, http: Arc<dyn Http>, pacer: Arc<Pacer>) -> GitHubStore {
        GitHubStore {
            id: github_store_id(target),
            owner: target.owner.trim().to_owned(),
            repo: target.repo.trim().to_owned(),
            root: git_root(target.root.as_deref()),
            api: target
                .api_base
                .as_deref()
                .unwrap_or(GITHUB_API)
                .trim_end_matches('/')
                .to_owned(),
            token: token.to_owned(),
            http,
            pacer,
            inner: tokio::sync::Mutex::new(Inner {
                branch: target
                    .branch
                    .as_deref()
                    .map(str::trim)
                    .filter(|b| !b.is_empty())
                    .map(str::to_owned),
                ..Inner::default()
            }),
            expiry: Mutex::new(None),
        }
    }

    /// When the token expires, as GitHub reported it (`github-authentication-token-expiration`).
    pub fn token_expiry(&self) -> Option<String> {
        self.expiry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        write: bool,
    ) -> Result<HttpResponse, RemoteError> {
        let repo_url = format!("{}/repos/{}/{}", self.api, percent(&self.owner), percent(&self.repo));
        let url = if path.starts_with('/') {
            format!("{}{path}", self.api)
        } else if path.is_empty() {
            repo_url
        } else {
            format!("{repo_url}/{path}")
        };
        let mut headers = vec![
            ("authorization".to_owned(), format!("Bearer {}", self.token)),
            ("accept".to_owned(), "application/vnd.github+json".to_owned()),
            ("x-github-api-version".to_owned(), GITHUB_API_VERSION.to_owned()),
            ("cache-control".to_owned(), "no-cache".to_owned()),
        ];
        if body.is_some() {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
        }
        if write {
            self.pacer.slot().await;
        }
        let res = self
            .http
            .send(HttpRequest {
                method: method.to_owned(),
                url,
                headers,
                body: body.map(|b| serde_json::to_vec(b).unwrap_or_default()),
            })
            .await
            .map_err(|e| {
                RemoteError::new(
                    RemoteErrorKind::Network,
                    format!("GitHub {method} {path}: no answer ({e})"),
                )
            })?;
        if let Some(exp) = res.header("github-authentication-token-expiration") {
            *self.expiry.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(exp.to_owned());
        }
        if matches!(res.status, 403 | 429)
            && let Some(wait) = rate_limit_wait(&res)
        {
            self.pacer.pause(wait).await;
        }
        Ok(res)
    }

    fn json(res: &HttpResponse, what: &str) -> Result<Value, RemoteError> {
        if !res.ok() {
            return Err(github_error(res, what));
        }
        serde_json::from_slice(&res.body)
            .map_err(|_| RemoteError::new(RemoteErrorKind::Network, format!("GitHub {what}: not JSON")))
    }

    async fn repo_info(&self) -> Result<Value, RemoteError> {
        let res = self.call("GET", "", None, false).await?;
        if res.status == 404 {
            return Err(RemoteError::new(
                RemoteErrorKind::NotFound,
                format!(
                    "GitHub repository {}/{} not found, or the token cannot see it",
                    self.owner, self.repo
                ),
            ));
        }
        Self::json(&res, "repository")
    }

    async fn branch(&self, inner: &mut Inner) -> Result<String, RemoteError> {
        if let Some(b) = &inner.branch {
            return Ok(b.clone());
        }
        let info = self.repo_info().await?;
        let b = info
            .get("default_branch")
            .and_then(Value::as_str)
            .unwrap_or("main")
            .to_owned();
        inner.branch = Some(b.clone());
        Ok(b)
    }

    async fn tree(&self, sha: &str, recursive: bool) -> Result<Value, RemoteError> {
        let path = format!("git/trees/{sha}{}", if recursive { "?recursive=1" } else { "" });
        let res = self.call("GET", &path, None, false).await?;
        Self::json(&res, "tree")
    }

    fn blobs_of(tree: &Value, base: &str, out: &mut BTreeMap<String, String>) {
        for e in tree.get("tree").and_then(Value::as_array).into_iter().flatten() {
            if e.get("type").and_then(Value::as_str) == Some("blob")
                && let (Some(path), Some(sha)) = (
                    e.get("path").and_then(Value::as_str),
                    e.get("sha").and_then(Value::as_str),
                )
            {
                out.insert(format!("{base}{path}"), sha.to_owned());
            }
        }
    }

    /// Every blob under a tree: one recursive call, or a walk of its subtrees when GitHub truncates the answer.
    async fn walk(&self, sha: &str, base: &str, out: &mut BTreeMap<String, String>) -> Result<(), RemoteError> {
        let mut stack = vec![(sha.to_owned(), base.to_owned())];
        while let Some((sha, base)) = stack.pop() {
            let deep = self.tree(&sha, true).await?;
            if deep.get("truncated") != Some(&Value::Bool(true)) {
                Self::blobs_of(&deep, &base, out);
                continue;
            }
            let flat = self.tree(&sha, false).await?;
            Self::blobs_of(&flat, &base, out);
            for e in flat.get("tree").and_then(Value::as_array).into_iter().flatten() {
                if e.get("type").and_then(Value::as_str) == Some("tree")
                    && let (Some(path), Some(sub)) = (
                        e.get("path").and_then(Value::as_str),
                        e.get("sha").and_then(Value::as_str),
                    )
                {
                    stack.push((sub.to_owned(), format!("{base}{path}/")));
                }
            }
        }
        Ok(())
    }

    async fn read_head(&self, commit: &str) -> Result<Head, RemoteError> {
        let top = self.tree(commit, true).await?;
        let tree = top.get("sha").and_then(Value::as_str).unwrap_or_default().to_owned();
        let strip = format!("{}/", self.root);
        let mut entries = BTreeMap::new();
        if top.get("truncated") != Some(&Value::Bool(true)) {
            let mut all = BTreeMap::new();
            Self::blobs_of(&top, "", &mut all);
            for (path, sha) in all {
                if let Some(name) = path.strip_prefix(&strip) {
                    entries.insert(name.to_owned(), sha);
                }
            }
        } else {
            let mut sha = Some(tree.clone());
            for part in self.root.split('/') {
                let Some(current) = sha.take() else { break };
                let t = self.tree(&current, false).await?;
                sha = t
                    .get("tree")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|e| {
                        e.get("type").and_then(Value::as_str) == Some("tree")
                            && e.get("path").and_then(Value::as_str) == Some(part)
                    })
                    .and_then(|e| e.get("sha").and_then(Value::as_str).map(str::to_owned));
            }
            if let Some(sha) = sha {
                self.walk(&sha, "", &mut entries).await?;
            }
        }
        entries.remove(README);
        Ok(Head {
            commit: commit.to_owned(),
            tree,
            entries,
        })
    }

    async fn load_state(&self, inner: &mut Inner) -> Result<HeadState, RemoteError> {
        let b = self.branch(inner).await?;
        let res = self
            .call("GET", &format!("git/ref/heads/{}", enc_path(&b)), None, false)
            .await?;
        if res.status == 409 {
            return Ok(HeadState::Empty);
        }
        if res.status == 404 {
            self.repo_info().await?;
            return Ok(HeadState::Missing);
        }
        let reference = Self::json(&res, "branch")?;
        let sha = reference
            .pointer("/object/sha")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if inner.cache.as_ref().is_none_or(|h| h.commit != sha) {
            inner.cache = Some(self.read_head(&sha).await?);
        }
        Ok(inner.cache.clone().map_or(HeadState::Missing, HeadState::Head))
    }

    fn author() -> Value {
        json!({"name": COMMIT_NAME, "email": COMMIT_EMAIL})
    }

    /// First commit of an empty repository, through the Contents API (the Git Data API refuses empty ones).
    async fn bootstrap(&self, branch: &str) -> Result<(), RemoteError> {
        let body = json!({
            "message": COMMIT_MESSAGE,
            "content": b64::encode(README_TEXT.as_bytes()),
            "branch": branch,
            "author": Self::author(),
            "committer": Self::author(),
        });
        let path = format!("contents/{}", enc_path(&format!("{}/{README}", self.root)));
        let res = self.call("PUT", &path, Some(&body), true).await?;
        // 409/422: another device made it first.
        if !res.ok() && res.status != 409 && res.status != 422 {
            return Err(github_error(&res, "first commit"));
        }
        Ok(())
    }

    /// A configured branch that does not exist yet starts from the default branch.
    async fn create_branch(&self, branch: &str) -> Result<(), RemoteError> {
        let info = self.repo_info().await?;
        let main = info
            .get("default_branch")
            .and_then(Value::as_str)
            .unwrap_or("main")
            .to_owned();
        let res = self
            .call("GET", &format!("git/ref/heads/{}", enc_path(&main)), None, false)
            .await?;
        if res.status == 409 {
            return self.bootstrap(branch).await;
        }
        let reference = Self::json(&res, "default branch")?;
        let sha = reference
            .pointer("/object/sha")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let made = self
            .call(
                "POST",
                "git/refs",
                Some(&json!({"ref": format!("refs/heads/{branch}"), "sha": sha})),
                true,
            )
            .await?;
        if !made.ok() && made.status != 422 {
            return Err(github_error(&made, "create branch"));
        }
        Ok(())
    }

    async fn post_tree(&self, base: &str, items: Vec<Value>) -> Result<String, RemoteError> {
        let res = self
            .call(
                "POST",
                "git/trees",
                Some(&json!({"base_tree": base, "tree": items})),
                true,
            )
            .await?;
        let v = Self::json(&res, "write tree")?;
        Ok(v.get("sha").and_then(Value::as_str).unwrap_or_default().to_owned())
    }

    async fn commit_batch(&self, inner: &mut Inner, batch: &[(String, Option<String>)]) -> Result<(), RemoteError> {
        let mut uploaded: BTreeMap<String, String> = BTreeMap::new();
        for attempt in 0..=MAX_REF_RETRIES {
            let b = self.branch(inner).await?;
            let mut state = self.load_state(inner).await?;
            if !matches!(state, HeadState::Head(_)) {
                if matches!(state, HeadState::Empty) {
                    self.bootstrap(&b).await?;
                } else {
                    self.create_branch(&b).await?;
                }
                state = self.load_state(inner).await?;
            }
            let HeadState::Head(head) = state else {
                return Err(RemoteError::new(
                    RemoteErrorKind::Network,
                    format!("GitHub branch {b} could not be created"),
                ));
            };
            let writes: Vec<&(String, Option<String>)> = batch
                .iter()
                .filter(|(name, s)| {
                    if s.is_none() {
                        head.entries.contains_key(name)
                    } else {
                        !head.entries.contains_key(name)
                    }
                })
                .collect();
            if writes.is_empty() {
                return Ok(());
            }
            let mut tree = head.tree.clone();
            let mut items: Vec<Value> = Vec::new();
            let mut size = 0;
            for (name, staged) in writes {
                let path = format!("{}/{name}", self.root);
                let Some(text) = staged else {
                    items.push(json!({"path": path, "mode": "100644", "type": "blob", "sha": Value::Null}));
                    continue;
                };
                if text.len() > MAX_TREE_BYTES {
                    let sha = match uploaded.get(name) {
                        Some(s) => s.clone(),
                        None => {
                            let res = self
                                .call(
                                    "POST",
                                    "git/blobs",
                                    Some(&json!({"content": text, "encoding": "utf-8"})),
                                    true,
                                )
                                .await?;
                            let sha = Self::json(&res, "write blob")?
                                .get("sha")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned();
                            uploaded.insert(name.clone(), sha.clone());
                            sha
                        }
                    };
                    items.push(json!({"path": path, "mode": "100644", "type": "blob", "sha": sha}));
                    continue;
                }
                if size + text.len() > MAX_TREE_BYTES && !items.is_empty() {
                    tree = self.post_tree(&tree, std::mem::take(&mut items)).await?;
                    size = 0;
                }
                items.push(json!({"path": path, "mode": "100644", "type": "blob", "content": text}));
                size += text.len();
            }
            if !items.is_empty() {
                tree = self.post_tree(&tree, items).await?;
            }
            let commit_body = json!({
                "message": COMMIT_MESSAGE,
                "tree": tree,
                "parents": [head.commit],
                "author": Self::author(),
                "committer": Self::author(),
            });
            let res = self.call("POST", "git/commits", Some(&commit_body), true).await?;
            let commit = Self::json(&res, "write commit")?
                .get("sha")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let res = self
                .call(
                    "PATCH",
                    &format!("git/refs/heads/{}", enc_path(&b)),
                    Some(&json!({"sha": commit, "force": false})),
                    true,
                )
                .await?;
            if res.ok() {
                inner.cache = None;
                return Ok(());
            }
            // 422: not a fast forward, another device pushed. New paths never conflict: rebuild on its head.
            if res.status != 422 {
                return Err(github_error(&res, "update branch"));
            }
            if attempt == MAX_REF_RETRIES {
                return Err(RemoteError::new(
                    RemoteErrorKind::Network,
                    format!("GitHub branch {b} kept moving during {} attempts", attempt + 1),
                ));
            }
        }
        Ok(())
    }

    async fn do_flush(&self, inner: &mut Inner) -> Result<(), RemoteError> {
        if inner.staged.is_empty() {
            return Ok(());
        }
        let batch: Vec<(String, Option<String>)> = inner.staged.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        self.commit_batch(inner, &batch).await?;
        inner.staged.clear();
        inner.staged_bytes = 0;
        Ok(())
    }

    async fn get_blob(&self, sha: &str) -> Result<Option<Vec<u8>>, RemoteError> {
        let res = self.call("GET", &format!("git/blobs/{sha}"), None, false).await?;
        if res.status == 404 {
            return Ok(None);
        }
        let v = Self::json(&res, "read object")?;
        let content = v.get("content").and_then(Value::as_str).unwrap_or_default();
        // The JSON form wraps the stored base64 text in base64 once more.
        let text = match v.get("encoding").and_then(Value::as_str) {
            Some("base64") => String::from_utf8_lossy(&b64::decode(content).unwrap_or_default()).into_owned(),
            _ => content.to_owned(),
        };
        // Not base64: edited outside the app. The bytes then fail authentication downstream.
        Ok(Some(b64::decode(text.trim()).unwrap_or_else(|| text.into_bytes())))
    }
}

#[async_trait]
impl RemoteStore for GitHubStore {
    fn id(&self) -> &str {
        &self.id
    }
    fn kind(&self) -> DestinationKind {
        DestinationKind::Github
    }
    fn keeps_history(&self) -> bool {
        true
    }
    async fn list(&self) -> Result<Vec<RemoteEntry>, RemoteError> {
        let mut inner = self.inner.lock().await;
        match self.load_state(&mut inner).await? {
            HeadState::Head(h) => Ok(h
                .entries
                .into_iter()
                .map(|(name, sha)| RemoteEntry {
                    name,
                    size: None,
                    handle: Some(sha),
                })
                .collect()),
            _ => Ok(Vec::new()),
        }
    }
    async fn get(&self, entry: &RemoteEntry) -> Result<Option<Vec<u8>>, RemoteError> {
        let sha = match &entry.handle {
            Some(h) => h.clone(),
            None => {
                let mut inner = self.inner.lock().await;
                match self.load_state(&mut inner).await? {
                    HeadState::Head(h) => match h.entries.get(&entry.name) {
                        Some(s) => s.clone(),
                        None => return Ok(None),
                    },
                    _ => return Ok(None),
                }
            }
        };
        if !sha.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Ok(None);
        }
        self.get_blob(&sha).await
    }
    async fn put(&self, name: &str, bytes: &[u8]) -> Result<(), RemoteError> {
        let mut inner = self.inner.lock().await;
        let text = b64::encode(bytes);
        inner.staged_bytes += text.len();
        inner.staged.insert(name.to_owned(), Some(text));
        if inner.staged_bytes > MAX_BATCH_BYTES {
            self.do_flush(&mut inner).await?;
        }
        Ok(())
    }
    async fn flush(&self) -> Result<(), RemoteError> {
        let mut inner = self.inner.lock().await;
        self.do_flush(&mut inner).await
    }
    async fn delete(&self, name: &str) -> Result<(), RemoteError> {
        let mut inner = self.inner.lock().await;
        inner.staged.insert(name.to_owned(), None);
        self.do_flush(&mut inner).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_the_web_apps() {
        let t = GitHubTarget {
            owner: "MaxGfr".into(),
            repo: "Aparte-Sync".into(),
            branch: None,
            root: None,
            api_base: None,
        };
        assert_eq!(
            github_store_id(&t),
            "github:https://api.github.com/maxgfr/aparte-sync#/aparte"
        );
    }

    #[test]
    fn errors_follow_the_status() {
        let res = |status, body: &str, headers: Vec<(&str, &str)>| HttpResponse {
            status,
            headers: headers.into_iter().map(|(k, v)| (k.to_owned(), v.to_owned())).collect(),
            body: body.as_bytes().to_vec(),
        };
        assert_eq!(github_error(&res(401, "{}", vec![]), "x").kind, RemoteErrorKind::Auth);
        let limited = github_error(
            &res(
                403,
                r#"{"message":"API rate limit exceeded"}"#,
                vec![("retry-after", "7")],
            ),
            "x",
        );
        assert_eq!(
            (limited.kind, limited.retry_after_ms),
            (RemoteErrorKind::RateLimited, Some(7000))
        );
        assert_eq!(
            github_error(&res(403, "{}", vec![]), "x").kind,
            RemoteErrorKind::Permission
        );
        assert_eq!(
            github_error(&res(404, "{}", vec![]), "x").kind,
            RemoteErrorKind::NotFound
        );
        assert_eq!(github_error(&res(502, "", vec![]), "x").kind, RemoteErrorKind::Network);
        assert_eq!(percent("a b/é"), "a%20b%2F%C3%A9");
    }
}
