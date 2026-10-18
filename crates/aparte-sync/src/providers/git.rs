//! A Git repository as a sync store, through the system `git` binary, so any remote works (a bare repository on a
//! disk, SSH, HTTPS with the user's credential helper). The layout is the web app's GitHub store (spec/FORMAT.md
//! section 10.5): every object is a file `<root>/<name>` (root `aparte` by default) whose content is the padded
//! standard base64 of the object's bytes, and the first commit adds `<root>/README.md`. A repository the PWA syncs
//! through the GitHub API and the CLI syncs through `git` is therefore one store.
//!
//! The CLI keeps a bare clone of its own under its data directory and never touches a working tree. `put` stages; a
//! `flush` writes everything staged as one commit on top of the remote branch, with the constant message
//! `aparte: objects`, author and committer `aparte`, and no signature (a signature would name the device's owner,
//! which the constant author is there to avoid), then pushes it without force; a push that another device beat is
//! rebuilt on the new head (new paths never conflict). `git` never prompts (`GIT_TERMINAL_PROMPT=0`): credentials
//! come from the user's helper or SSH agent, and are never passed on a command line or kept by the CLI.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use aparte_format::names::parse_name;
use aparte_store::fsx;
use async_trait::async_trait;

use super::{COMMIT_EMAIL, COMMIT_MESSAGE, COMMIT_NAME, README_TEXT, b64, git_root};
use crate::error::{RemoteError, RemoteErrorKind};
use crate::remote::{DestinationKind, RemoteEntry, RemoteStore};

/// How many times a flush rebuilds on a branch another device moved before it gives up.
const MAX_PUSH_RETRIES: usize = 5;
const README: &str = "README.md";

/// Where a Git store is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitTarget {
    /// The remote: a URL (`https://`, `ssh://`, `git@host:path`) or a path to a repository.
    pub url: String,
    /// The branch; `None` for the remote's default branch (`main` for an empty repository).
    pub branch: Option<String>,
    /// The folder of the repository that holds the store; `aparte` when empty.
    pub root: Option<String>,
}

/// The remote without its user information (`https://user:token@host/x` gives `https://host/x`), for ids and
/// messages: a credential in a URL never goes further.
pub fn redact_url(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
            let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
            format!("{scheme}://{host}{path}")
        }
        None => url.to_owned(),
    }
}

/// Same remote, branch and folder, same id.
pub fn git_store_id(t: &GitTarget) -> String {
    format!(
        "git:{}#{}/{}",
        redact_url(t.url.trim()),
        t.branch.as_deref().unwrap_or_default().trim(),
        git_root(t.root.as_deref())
    )
}

#[derive(Debug, Default)]
struct Head {
    commit: String,
    /// name (without the root) -> blob id
    entries: BTreeMap<String, String>,
}

#[derive(Debug, Default)]
struct Inner {
    branch: Option<String>,
    head: Option<Head>,
    /// A staged object (its base64 text) or a staged deletion (`None`).
    staged: BTreeMap<String, Option<String>>,
}

/// A Git store over the `git` binary.
#[derive(Debug)]
pub struct GitStore {
    id: String,
    url: String,
    root: String,
    cache: PathBuf,
    git: PathBuf,
    inner: Mutex<Inner>,
}

struct Output {
    status_ok: bool,
    stdout: Vec<u8>,
    stderr: String,
}

/// A failed `git` as a store error: credentials, permission, a missing repository, or the network.
fn classify(what: &str, stderr: &str) -> RemoteError {
    let lower = stderr.to_ascii_lowercase();
    let detail: String = stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .chars()
        .take(300)
        .collect();
    let message = format!("git {what}: {}", redact_url(&detail));
    let kind = if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("terminal prompts disabled")
        || lower.contains("invalid username or password")
    {
        RemoteErrorKind::Auth
    } else if lower.contains("permission denied") || lower.contains("403") || lower.contains("protected branch") {
        RemoteErrorKind::Permission
    } else if lower.contains("not found")
        || lower.contains("does not appear to be a git repository")
        || lower.contains("does not exist")
        || lower.contains("no such file or directory")
    {
        RemoteErrorKind::NotFound
    } else {
        RemoteErrorKind::Network
    };
    RemoteError::new(kind, message)
}

impl GitStore {
    /// A store of `target`, keeping its bare clone in `cache` (created when missing), with the `git` found on the
    /// `PATH`.
    pub fn new(target: &GitTarget, cache: impl Into<PathBuf>) -> GitStore {
        GitStore {
            id: git_store_id(target),
            url: target.url.trim().to_owned(),
            root: git_root(target.root.as_deref()),
            cache: cache.into(),
            git: PathBuf::from("git"),
            inner: Mutex::new(Inner {
                branch: target
                    .branch
                    .as_deref()
                    .map(str::trim)
                    .filter(|b| !b.is_empty())
                    .map(str::to_owned),
                ..Inner::default()
            }),
        }
    }

    /// The bare clone this store keeps.
    pub fn cache(&self) -> &Path {
        &self.cache
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn command(&self, envs: &[(&str, &str)]) -> Command {
        let mut cmd = Command::new(&self.git);
        cmd.arg("-C")
            .arg(&self.cache)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "")
            .env("LC_ALL", "C")
            .env("GIT_AUTHOR_NAME", COMMIT_NAME)
            .env("GIT_AUTHOR_EMAIL", COMMIT_EMAIL)
            .env("GIT_COMMITTER_NAME", COMMIT_NAME)
            .env("GIT_COMMITTER_EMAIL", COMMIT_EMAIL)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in envs {
            cmd.env(k, v);
        }
        cmd
    }

    fn run(&self, args: &[&str], envs: &[(&str, &str)], input: Option<&[u8]>) -> Result<Output, RemoteError> {
        let mut cmd = self.command(envs);
        cmd.args(args);
        if input.is_some() {
            cmd.stdin(Stdio::piped());
        }
        let mut child = cmd.spawn().map_err(|e| {
            RemoteError::new(
                RemoteErrorKind::NotFound,
                format!("cannot run git (is it installed?): {e}"),
            )
        })?;
        if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
            stdin
                .write_all(bytes)
                .map_err(|e| RemoteError::new(RemoteErrorKind::Network, format!("git: {e}")))?;
        }
        let out = child
            .wait_with_output()
            .map_err(|e| RemoteError::new(RemoteErrorKind::Network, format!("git: {e}")))?;
        Ok(Output {
            status_ok: out.status.success(),
            stdout: out.stdout,
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }

    fn ok(
        &self,
        what: &str,
        args: &[&str],
        envs: &[(&str, &str)],
        input: Option<&[u8]>,
    ) -> Result<Vec<u8>, RemoteError> {
        let out = self.run(args, envs, input)?;
        if out.status_ok {
            Ok(out.stdout)
        } else {
            Err(classify(what, &out.stderr))
        }
    }

    fn ensure_cache(&self) -> Result<(), RemoteError> {
        if self.cache.join("HEAD").is_file() {
            return Ok(());
        }
        fsx::private_dir(&self.cache).map_err(|e| RemoteError::new(RemoteErrorKind::Network, e.to_string()))?;
        self.ok("init", &["init", "--bare", "-q"], &[], None)?;
        Ok(())
    }

    /// The branch, resolving the remote's default one the first time.
    fn branch(&self, inner: &mut Inner) -> Result<String, RemoteError> {
        if let Some(b) = &inner.branch {
            return Ok(b.clone());
        }
        let out = self.ok("ls-remote", &["ls-remote", "--symref", &self.url, "HEAD"], &[], None)?;
        let text = String::from_utf8_lossy(&out);
        let branch = text
            .lines()
            .find_map(|l| l.strip_prefix("ref: refs/heads/").and_then(|r| r.split('\t').next()))
            .unwrap_or("main")
            .to_owned();
        inner.branch = Some(branch.clone());
        Ok(branch)
    }

    /// The remote head of the branch, fetched into the clone; `None` for a branch that does not exist yet.
    fn remote_head(&self, inner: &mut Inner) -> Result<Option<String>, RemoteError> {
        self.ensure_cache()?;
        let branch = self.branch(inner)?;
        let refname = format!("refs/heads/{branch}");
        let out = self.ok("ls-remote", &["ls-remote", &self.url, &refname], &[], None)?;
        let text = String::from_utf8_lossy(&out);
        let Some(sha) = text
            .lines()
            .find(|l| l.split('\t').nth(1) == Some(refname.as_str()))
            .and_then(|l| l.split('\t').next())
            .map(str::to_owned)
        else {
            return Ok(None);
        };
        let have = self
            .run(&["cat-file", "-e", &format!("{sha}^{{commit}}")], &[], None)?
            .status_ok;
        if !have {
            let spec = format!("+{refname}:refs/remotes/aparte/{branch}");
            self.ok("fetch", &["fetch", "-q", "--no-tags", &self.url, &spec], &[], None)?;
        }
        Ok(Some(sha))
    }

    fn read_head(&self, commit: &str) -> Result<Head, RemoteError> {
        let prefix = format!("{}/", self.root);
        let out = self.ok(
            "ls-tree",
            &["ls-tree", "-r", "-z", "--full-tree", commit, "--", &prefix],
            &[],
            None,
        )?;
        let mut entries = BTreeMap::new();
        for record in out.split(|&b| b == 0).filter(|r| !r.is_empty()) {
            let line = String::from_utf8_lossy(record);
            let Some((meta, path)) = line.split_once('\t') else {
                continue;
            };
            let mut fields = meta.split(' ');
            let (_, kind, sha) = (fields.next(), fields.next(), fields.next());
            if kind != Some("blob") {
                continue;
            }
            if let (Some(sha), Some(name)) = (sha, path.strip_prefix(&prefix))
                && name != README
            {
                entries.insert(name.to_owned(), sha.to_owned());
            }
        }
        Ok(Head {
            commit: commit.to_owned(),
            entries,
        })
    }

    /// The head, its tree read again only when it moved.
    fn load(&self, inner: &mut Inner) -> Result<(), RemoteError> {
        match self.remote_head(inner)? {
            None => inner.head = None,
            Some(sha) => {
                if inner.head.as_ref().is_none_or(|h| h.commit != sha) {
                    inner.head = Some(self.read_head(&sha)?);
                }
            }
        }
        Ok(())
    }

    /// Writes the staged objects as one commit and pushes it; rebuilds on a head that moved.
    fn commit_and_push(&self, inner: &mut Inner) -> Result<(), RemoteError> {
        for attempt in 0..=MAX_PUSH_RETRIES {
            self.load(inner)?;
            let branch = self.branch(inner)?;
            let head = inner.head.as_ref();
            // Objects never change: one already in the branch is not written again.
            let writes: Vec<(String, Option<String>)> = inner
                .staged
                .iter()
                .filter(|(name, s)| {
                    let present = head.is_some_and(|h| h.entries.contains_key(*name));
                    if s.is_some() { !present } else { present }
                })
                .map(|(n, s)| (n.clone(), s.clone()))
                .collect();
            if writes.is_empty() {
                return Ok(());
            }
            let commit = self.build_commit(head.map(|h| h.commit.as_str()), &writes)?;
            let spec = format!("{commit}:refs/heads/{branch}");
            let out = self.run(&["push", "-q", &self.url, &spec], &[], None)?;
            if out.status_ok {
                inner.head = None;
                return Ok(());
            }
            let lower = out.stderr.to_ascii_lowercase();
            let moved =
                lower.contains("non-fast-forward") || lower.contains("fetch first") || lower.contains("rejected");
            if !moved || attempt == MAX_PUSH_RETRIES {
                return Err(classify("push", &out.stderr));
            }
        }
        Err(RemoteError::new(
            RemoteErrorKind::Network,
            "git: the branch kept moving",
        ))
    }

    fn build_commit(&self, parent: Option<&str>, writes: &[(String, Option<String>)]) -> Result<String, RemoteError> {
        let rnd = aparte_crypto::rng::draw::<8>(&mut aparte_crypto::OsRng).unwrap_or_default();
        let tag: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
        let index = self.cache.join(format!("aparte-index-{tag}"));
        let index_text = index.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", index_text.as_str())];
        let result = (|| {
            match parent {
                Some(p) => self.ok("read-tree", &["read-tree", p], &env, None)?,
                None => self.ok("read-tree", &["read-tree", "--empty"], &env, None)?,
            };
            let mut contents: Vec<(String, Vec<u8>)> = Vec::new();
            if parent.is_none() {
                contents.push((format!("{}/{README}", self.root), README_TEXT.as_bytes().to_vec()));
            }
            let mut lines = String::new();
            for (name, staged) in writes {
                let path = format!("{}/{name}", self.root);
                match staged {
                    Some(text) => contents.push((path, text.as_bytes().to_vec())),
                    None => lines.push_str(&format!("0 {}\t{path}\n", "0".repeat(40))),
                }
            }
            let shas = self.hash_objects(&contents)?;
            for ((path, _), sha) in contents.iter().zip(&shas) {
                lines.push_str(&format!("100644 {sha}\t{path}\n"));
            }
            self.ok(
                "update-index",
                &["update-index", "--index-info"],
                &env,
                Some(lines.as_bytes()),
            )?;
            let tree = self.ok("write-tree", &["write-tree"], &env, None)?;
            let tree = String::from_utf8_lossy(&tree).trim().to_owned();
            let mut args = vec!["commit-tree", tree.as_str(), "--no-gpg-sign", "-m", COMMIT_MESSAGE];
            if let Some(p) = parent {
                args.extend(["-p", p]);
            }
            let commit = self.ok("commit-tree", &args, &env, None)?;
            Ok(String::from_utf8_lossy(&commit).trim().to_owned())
        })();
        let _ = std::fs::remove_file(&index);
        result
    }

    /// Writes blobs into the clone and returns their ids, through one `git hash-object --stdin-paths`.
    fn hash_objects(&self, contents: &[(String, Vec<u8>)]) -> Result<Vec<String>, RemoteError> {
        if contents.is_empty() {
            return Ok(Vec::new());
        }
        let dir = self.cache.join("aparte-staging");
        let _ = fsx::remove_dir_opt(&dir);
        let mut paths = String::new();
        for (i, (_, bytes)) in contents.iter().enumerate() {
            let path = dir.join(i.to_string());
            fsx::atomic_write(&path, bytes).map_err(|e| RemoteError::new(RemoteErrorKind::Network, e.to_string()))?;
            paths.push_str(&path.to_string_lossy());
            paths.push('\n');
        }
        let out = self.ok(
            "hash-object",
            &["hash-object", "-w", "--no-filters", "--stdin-paths"],
            &[],
            Some(paths.as_bytes()),
        );
        let _ = fsx::remove_dir_opt(&dir);
        let shas: Vec<String> = String::from_utf8_lossy(&out?).lines().map(str::to_owned).collect();
        if shas.len() != contents.len() {
            return Err(RemoteError::new(
                RemoteErrorKind::Network,
                "git hash-object returned too few ids",
            ));
        }
        Ok(shas)
    }

    fn read_blob(&self, sha: &str) -> Result<Option<Vec<u8>>, RemoteError> {
        let out = self.run(&["cat-file", "blob", sha], &[], None)?;
        if !out.status_ok {
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&out.stdout);
        // Not base64: edited outside the app. The bytes then fail authentication downstream.
        Ok(Some(b64::decode(text.trim()).unwrap_or(out.stdout)))
    }
}

#[async_trait]
impl RemoteStore for GitStore {
    fn id(&self) -> &str {
        &self.id
    }
    fn kind(&self) -> DestinationKind {
        DestinationKind::Git
    }
    fn keeps_history(&self) -> bool {
        true
    }
    async fn list(&self) -> Result<Vec<RemoteEntry>, RemoteError> {
        let mut inner = self.lock();
        self.load(&mut inner)?;
        Ok(inner.head.as_ref().map_or_else(Vec::new, |h| {
            h.entries
                .iter()
                .map(|(name, sha)| RemoteEntry {
                    name: name.clone(),
                    size: None,
                    handle: Some(sha.clone()),
                })
                .collect()
        }))
    }
    async fn get(&self, entry: &RemoteEntry) -> Result<Option<Vec<u8>>, RemoteError> {
        let sha = match &entry.handle {
            Some(h) => h.clone(),
            None => {
                let mut inner = self.lock();
                self.load(&mut inner)?;
                match inner.head.as_ref().and_then(|h| h.entries.get(&entry.name)) {
                    Some(sha) => sha.clone(),
                    None => return Ok(None),
                }
            }
        };
        if !sha.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Ok(None);
        }
        self.read_blob(&sha)
    }
    async fn put(&self, name: &str, bytes: &[u8]) -> Result<(), RemoteError> {
        if parse_name(name).is_none() {
            return Err(RemoteError::new(RemoteErrorKind::Incompatible, "not an object name"));
        }
        self.lock().staged.insert(name.to_owned(), Some(b64::encode(bytes)));
        Ok(())
    }
    async fn flush(&self) -> Result<(), RemoteError> {
        let mut inner = self.lock();
        if inner.staged.is_empty() {
            return Ok(());
        }
        self.commit_and_push(&mut inner)?;
        inner.staged.clear();
        Ok(())
    }
    async fn delete(&self, name: &str) -> Result<(), RemoteError> {
        if parse_name(name).is_none() {
            return Err(RemoteError::new(RemoteErrorKind::Incompatible, "not an object name"));
        }
        {
            self.lock().staged.insert(name.to_owned(), None);
        }
        self.flush().await
    }
}

/// The paths of the objects a Git checkout holds under `root`, mapped to their decoded bytes: for tools and tests
/// that read a working tree.
pub fn read_checkout(dir: &Path, root: Option<&str>) -> std::io::Result<HashMap<String, Vec<u8>>> {
    let base = dir.join(git_root(root));
    let mut out = HashMap::new();
    for name in fsx::walk(&base).map_err(|e| std::io::Error::other(e.to_string()))? {
        if name == README {
            continue;
        }
        let text = std::fs::read(base.join(&name))?;
        let bytes = b64::decode(String::from_utf8_lossy(&text).trim()).unwrap_or(text);
        out.insert(name, bytes);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_never_reach_an_id() {
        let t = GitTarget {
            url: "https://user:secret@example.com/me/vault.git".into(),
            branch: None,
            root: Some("/sync/".into()),
        };
        let id = git_store_id(&t);
        assert_eq!(id, "git:https://example.com/me/vault.git#/sync");
        assert!(!id.contains("secret"));
        assert_eq!(redact_url("/srv/git/vault.git"), "/srv/git/vault.git");
        assert_eq!(redact_url("ssh://git@host/x"), "ssh://host/x");
    }

    #[test]
    fn git_failures_are_classified() {
        assert_eq!(
            classify("push", "fatal: Authentication failed for 'x'").kind,
            RemoteErrorKind::Auth
        );
        assert_eq!(
            classify("push", "remote: Permission denied").kind,
            RemoteErrorKind::Permission
        );
        assert_eq!(
            classify("ls-remote", "fatal: '/x' does not appear to be a git repository").kind,
            RemoteErrorKind::NotFound
        );
        assert_eq!(
            classify("fetch", "fatal: unable to access: Could not resolve host").kind,
            RemoteErrorKind::Network
        );
    }
}
