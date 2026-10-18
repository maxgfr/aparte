//! Sync destinations as this device keeps them: one encrypted local record of purpose `sync-credential` per
//! destination (spec/FORMAT.md section 11.3), keyed by the destination's id, holding where it is and its credentials
//! (a GitHub token, S3 keys). Never in a synced document, never on the store.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;
use aparte_store::RecordStore;
use aparte_sync::RemoteStore;
use aparte_sync::providers::folder::FolderStore;
use aparte_sync::providers::git::{GitStore, GitTarget, git_store_id};
use aparte_sync::providers::github::{
    GitHubStore, GitHubTarget, Pacer, WRITES_PER_HOUR, WRITES_PER_MINUTE, github_store_id,
};
use aparte_sync::providers::http::ReqwestHttp;
use aparte_sync::providers::s3::{S3Store, S3Target, s3_store_id};
use serde::{Deserialize, Serialize};

const PURPOSE: &str = "sync-credential";

/// Where a vault syncs, with what it needs to get there.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Destination {
    /// A folder.
    Folder { path: PathBuf, label: String },
    /// A Git repository through the `git` binary.
    Git {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root: Option<String>,
    },
    /// A GitHub repository through the API.
    Github {
        owner: String,
        repo: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root: Option<String>,
        token: String,
    },
    /// An S3-compatible bucket.
    S3 {
        endpoint: String,
        region: String,
        bucket: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix: Option<String>,
        access_key_id: String,
        secret_access_key: String,
    },
}

impl std::fmt::Debug for Destination {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Destination({})", self.id())
    }
}

impl Destination {
    fn git_target(&self) -> Option<GitTarget> {
        match self {
            Destination::Git { url, branch, root } => Some(GitTarget {
                url: url.clone(),
                branch: branch.clone(),
                root: root.clone(),
            }),
            _ => None,
        }
    }

    fn github_target(&self) -> Option<GitHubTarget> {
        match self {
            Destination::Github {
                owner,
                repo,
                branch,
                root,
                ..
            } => Some(GitHubTarget {
                owner: owner.clone(),
                repo: repo.clone(),
                branch: branch.clone(),
                root: root.clone(),
                api_base: None,
            }),
            _ => None,
        }
    }

    fn s3_target(&self) -> Option<S3Target> {
        match self {
            Destination::S3 {
                endpoint,
                region,
                bucket,
                prefix,
                access_key_id,
                secret_access_key,
            } => Some(S3Target {
                endpoint: endpoint.clone(),
                region: region.clone(),
                bucket: bucket.clone(),
                prefix: prefix.clone(),
                access_key_id: access_key_id.clone(),
                secret_access_key: secret_access_key.clone(),
            }),
            _ => None,
        }
    }

    /// The destination's id, the same on every device (never derived from a secret).
    pub fn id(&self) -> String {
        match self {
            Destination::Folder { label, .. } => format!("folder:{label}"),
            Destination::Git { .. } => self.git_target().map(|t| git_store_id(&t)).unwrap_or_default(),
            Destination::Github { .. } => self.github_target().map(|t| github_store_id(&t)).unwrap_or_default(),
            Destination::S3 { .. } => self.s3_target().map(|t| s3_store_id(&t)).unwrap_or_default(),
        }
    }

    /// What it is, for the status (no credential).
    pub fn describe(&self) -> String {
        match self {
            Destination::Folder { path, .. } => format!("folder {}", path.display()),
            Destination::Git { url, branch, .. } => format!(
                "git {}{}",
                aparte_sync::providers::git::redact_url(url),
                branch.as_deref().map(|b| format!(" ({b})")).unwrap_or_default()
            ),
            Destination::Github {
                owner, repo, branch, ..
            } => format!(
                "github {owner}/{repo}{}",
                branch.as_deref().map(|b| format!(" ({b})")).unwrap_or_default()
            ),
            Destination::S3 {
                endpoint,
                bucket,
                prefix,
                ..
            } => format!(
                "s3 {}/{bucket}/{}",
                endpoint.trim_end_matches('/'),
                prefix.as_deref().unwrap_or_default()
            ),
        }
    }

    /// The kind's name.
    pub fn kind(&self) -> &'static str {
        match self {
            Destination::Folder { .. } => "folder",
            Destination::Git { .. } => "git",
            Destination::Github { .. } => "github",
            Destination::S3 { .. } => "s3",
        }
    }

    /// The store, ready for a round. A Git store keeps its bare clone under `<data dir>/git/<hash>`.
    pub fn store(&self, data_dir: &Path) -> anyhow::Result<Box<dyn RemoteStore>> {
        Ok(match self {
            Destination::Folder { path, label } => Box::new(FolderStore::new(path, label)),
            Destination::Git { .. } => {
                let target = self.git_target().context("a git destination")?;
                let id = git_store_id(&target);
                let hash = aparte_format::encoding::to_hex(&aparte_crypto::primitives::sha256(id.as_bytes()));
                Box::new(GitStore::new(&target, data_dir.join("git").join(&hash[..16])))
            }
            Destination::Github { token, .. } => {
                let target = self.github_target().context("a github destination")?;
                let http = Arc::new(ReqwestHttp::new().map_err(anyhow::Error::msg)?);
                let pacer = Arc::new(Pacer::new(WRITES_PER_MINUTE, WRITES_PER_HOUR));
                Box::new(GitHubStore::new(&target, token, http, pacer))
            }
            Destination::S3 { .. } => {
                let target = self.s3_target().context("an s3 destination")?;
                let http = Arc::new(ReqwestHttp::new().map_err(anyhow::Error::msg)?);
                Box::new(S3Store::new(target, http))
            }
        })
    }
}

/// Every destination of this device, by id.
pub fn load(store: &RecordStore) -> anyhow::Result<Vec<Destination>> {
    let mut out = Vec::new();
    for id in store.list(PURPOSE)? {
        let Some(bytes) = store.get(PURPOSE, &id)? else {
            continue;
        };
        match serde_json::from_slice::<Destination>(&bytes) {
            Ok(d) => out.push(d),
            Err(e) => tracing::warn!("a sync destination record does not parse: {e}"),
        }
    }
    Ok(out)
}

/// Keeps a destination (replacing one of the same id).
pub fn save(store: &RecordStore, d: &Destination) -> anyhow::Result<()> {
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(d).context("cannot encode the destination")?);
    store.put(PURPOSE, &d.id(), &bytes)?;
    Ok(())
}

/// Forgets a destination; true when one was removed.
pub fn remove(store: &RecordStore, id: &str) -> anyhow::Result<bool> {
    let present = store.get(PURPOSE, id)?.is_some();
    store.delete(PURPOSE, id)?;
    Ok(present)
}
