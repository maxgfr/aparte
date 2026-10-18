//! `aparte sync`: end-to-end-encrypted sync of the vault with the stores the web app syncs with (spec/FORMAT.md
//! section 10.5), so a conversation started on one side shows on the other.
//!
//! - `setup <folder|git|github|s3> ...`: adds a destination (kept encrypted on this device), then syncs once.
//! - `now [--dest ID]`: one round with every destination (or one): seal, list and check, download, upload.
//! - `status`: the destinations, their last round, the alarms, what waits to be sealed.
//! - `remove <ID>`: forgets a destination on this device (the store keeps its objects).
//!
//! Credentials: a GitHub token comes from `APARTE_GITHUB_TOKEN`, S3 keys from `AWS_ACCESS_KEY_ID` and
//! `AWS_SECRET_ACCESS_KEY`, else they are asked for without echo; a Git remote uses the user's own `git`
//! credentials (helper, SSH agent).

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, bail};
use aparte_format::names::DocId;
use aparte_sync::{Engine, RoundResult, SystemClock};
use serde_json::json;

use crate::destinations::{self, Destination};
use crate::device;
use crate::{Ctx, exit};

/// Arguments of `aparte sync`.
#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    pub action: Action,
}

/// What to do.
#[derive(Debug, clap::Subcommand)]
pub enum Action {
    /// Add a sync destination and sync once
    Setup {
        #[command(subcommand)]
        dest: DestArgs,
        /// Only save the destination
        #[arg(long)]
        no_sync: bool,
    },
    /// Sync now with every destination
    Now {
        /// Only this destination id (`aparte sync status` lists them)
        #[arg(long, value_name = "ID")]
        dest: Option<String>,
    },
    /// Destinations, last rounds and alarms
    Status,
    /// Forget a destination on this device
    Remove {
        /// The destination id
        id: String,
    },
    /// Dismiss an alarm after reading it
    Dismiss {
        /// The alarm id
        id: String,
    },
}

/// A sync destination on the command line.
#[derive(Debug, Clone, clap::Subcommand)]
pub enum DestArgs {
    /// A folder (shared with the web app's folder destination, or synced by another tool)
    Folder {
        /// The folder
        path: PathBuf,
        /// The name the web app knows the folder by (default: its last component)
        #[arg(long)]
        label: Option<String>,
    },
    /// A Git repository through the `git` binary: any remote, with your git credentials
    Git {
        /// The remote URL or path
        url: String,
        /// The branch (default: the remote's default branch)
        #[arg(long)]
        branch: Option<String>,
        /// The folder of the repository holding the store
        #[arg(long, default_value = "aparte")]
        root: String,
    },
    /// A GitHub repository through the API, as the web app syncs (token from APARTE_GITHUB_TOKEN or asked)
    Github {
        /// owner/repo
        repo: String,
        /// The branch (default: the repository's default branch)
        #[arg(long)]
        branch: Option<String>,
        /// The folder of the repository holding the store
        #[arg(long, default_value = "aparte")]
        root: String,
    },
    /// An S3-compatible bucket (keys from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY or asked)
    S3 {
        /// The endpoint without the bucket (https://<account>.r2.cloudflarestorage.com)
        #[arg(long)]
        endpoint: String,
        /// The bucket
        #[arg(long)]
        bucket: String,
        /// The region (`auto` for R2)
        #[arg(long, default_value = "auto")]
        region: String,
        /// A folder inside the bucket
        #[arg(long)]
        prefix: Option<String>,
    },
}

fn secret_from(var: &str, prompt: &str) -> anyhow::Result<String> {
    if let Ok(v) = std::env::var(var)
        && !v.is_empty()
    {
        return Ok(v);
    }
    let text = device::read_hidden(prompt)?;
    if text.trim().is_empty() {
        bail!("{var} is not set and nothing was typed");
    }
    Ok(text.trim().to_owned())
}

impl DestArgs {
    /// The destination, credentials asked for when needed.
    pub fn resolve(&self) -> anyhow::Result<Destination> {
        Ok(match self {
            DestArgs::Folder { path, label } => {
                let path = if path.is_absolute() {
                    path.clone()
                } else {
                    std::env::current_dir().context("no working directory")?.join(path)
                };
                let label = label.clone().unwrap_or_else(|| {
                    path.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "folder".into())
                });
                Destination::Folder { path, label }
            }
            DestArgs::Git { url, branch, root } => Destination::Git {
                url: url.clone(),
                branch: branch.clone(),
                root: Some(root.clone()),
            },
            DestArgs::Github { repo, branch, root } => {
                let (owner, name) = repo.split_once('/').context("the repository is owner/repo")?;
                if owner.is_empty() || name.is_empty() || name.contains('/') {
                    bail!("the repository is owner/repo");
                }
                Destination::Github {
                    owner: owner.to_owned(),
                    repo: name.to_owned(),
                    branch: branch.clone(),
                    root: Some(root.clone()),
                    token: secret_from("APARTE_GITHUB_TOKEN", "GitHub token (Contents read and write): ")?,
                }
            }
            DestArgs::S3 {
                endpoint,
                bucket,
                region,
                prefix,
            } => {
                aparte_sync::providers::http::check_url(endpoint).map_err(anyhow::Error::msg)?;
                Destination::S3 {
                    endpoint: endpoint.trim_end_matches('/').to_owned(),
                    region: region.clone(),
                    bucket: bucket.clone(),
                    prefix: prefix.clone(),
                    access_key_id: secret_from("AWS_ACCESS_KEY_ID", "Access key id: ")?,
                    secret_access_key: secret_from("AWS_SECRET_ACCESS_KEY", "Secret access key: ")?,
                }
            }
        })
    }
}

/// The async runtime of the sync verbs.
pub fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("cannot start the async runtime")
}

/// One round with a destination, reported.
pub fn round_with(ctx: &Ctx, open: &device::Open, d: &Destination) -> anyhow::Result<RoundResult> {
    let store = d.store(&device::data_dir(ctx)?)?;
    let engine = Engine::new(
        open.unlocked.store.clone(),
        open.vault.clone(),
        std::sync::Arc::new(SystemClock),
    );
    let result = runtime()?.block_on(engine.round(store.as_ref(), false, Some(&open.workspace)))?;
    ctx.ui.emit(
        "sync-round",
        json!({
            "dest": d.id(), "kind": d.kind(), "down": result.down, "up": result.up,
            "deferred": result.deferred, "sealed": result.sealed, "alarms": result.alarms,
        }),
    );
    ctx.ui.say(&format!(
        "{}: {} down, {} up{}{}",
        d.describe(),
        result.down,
        result.up,
        if result.deferred > 0 {
            format!(", {} waiting for their blobs", result.deferred)
        } else {
            String::new()
        },
        if result.sealed > 0 {
            format!(", {} local change(s) sealed", result.sealed)
        } else {
            String::new()
        }
    ));
    for a in &result.alarms {
        eprintln!("aparte: alarm {} ({}): {}", a.kind, a.id, a.detail);
    }
    Ok(result)
}

/// Runs a sync action.
pub fn run(args: Args, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    match args.action {
        Action::Setup { dest, no_sync } => {
            let d = dest.resolve()?;
            if let Destination::Folder { path, .. } = &d {
                aparte_store::fsx::private_dir(path)?;
            }
            let open = device::open(ctx)?;
            destinations::save(&open.unlocked.store, &d)?;
            ctx.ui.emit(
                "sync-destination",
                json!({"id": d.id(), "kind": d.kind(), "added": true}),
            );
            ctx.ui.say(&format!("added {} ({})", d.describe(), d.id()));
            if !no_sync {
                round_with(ctx, &open, &d)?;
            }
            Ok(ExitCode::from(exit::OK))
        }
        Action::Now { dest } => {
            let open = device::open(ctx)?;
            let all = destinations::load(&open.unlocked.store)?;
            let chosen: Vec<&Destination> = all
                .iter()
                .filter(|d| dest.as_deref().is_none_or(|id| d.id() == id))
                .collect();
            if chosen.is_empty() {
                bail!(match dest {
                    Some(id) => format!("no destination {id:?}; `aparte sync status` lists them"),
                    None => "no sync destination: add one with `aparte sync setup`".to_owned(),
                });
            }
            let mut failed = None;
            for d in chosen {
                if let Err(e) = round_with(ctx, &open, d) {
                    ctx.ui
                        .emit("sync-error", json!({"dest": d.id(), "message": format!("{e:#}")}));
                    eprintln!("aparte: {}: {e:#}", d.describe());
                    failed = Some(e);
                }
            }
            match failed {
                Some(e) => Err(e),
                None => Ok(ExitCode::from(exit::OK)),
            }
        }
        Action::Status => status(ctx),
        Action::Remove { id } => {
            let open = device::open(ctx)?;
            let removed = destinations::remove(&open.unlocked.store, &id)?;
            ctx.ui.emit("sync-destination", json!({"id": id, "removed": removed}));
            ctx.ui.say(if removed {
                "forgot the destination"
            } else {
                "no such destination"
            });
            Ok(ExitCode::from(if removed { exit::OK } else { exit::ERROR }))
        }
        Action::Dismiss { id } => {
            let open = device::open(ctx)?;
            let engine = Engine::new(
                open.unlocked.store.clone(),
                open.vault.clone(),
                std::sync::Arc::new(SystemClock),
            );
            engine.dismiss_alarm(&id)?;
            ctx.ui.emit("sync-alarm", json!({"id": id, "dismissed": true}));
            ctx.ui.say("dismissed");
            Ok(ExitCode::from(exit::OK))
        }
    }
}

fn status(ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let open = device::open(ctx)?;
    let engine = Engine::new(
        open.unlocked.store.clone(),
        open.vault.clone(),
        std::sync::Arc::new(SystemClock),
    );
    let state = engine.state()?;
    let dests = destinations::load(&open.unlocked.store)?;
    let pending: usize = DocId::ALL
        .iter()
        .map(|d| open.unlocked.store.pending(*d).map(|q| q.len()).unwrap_or(0))
        .sum();
    let objects = open.unlocked.store.object_names("")?.len();
    ctx.ui.emit(
        "sync-status",
        json!({
            "device": engine.device_tag()?, "objects": objects, "pending": pending,
            "alarms": state.alarms,
        }),
    );
    ctx.ui.say(&format!(
        "this device writes as {}; {objects} objects held, {pending} local update(s) to seal",
        engine.device_tag()?
    ));
    if dests.is_empty() {
        ctx.ui.say("no sync destination: add one with `aparte sync setup`");
    }
    for d in &dests {
        let rec = state.dests.get(&d.id());
        let last = rec.and_then(|r| r.last_ok_at);
        ctx.ui.emit(
            "sync-destination",
            json!({"id": d.id(), "kind": d.kind(), "describe": d.describe(), "lastOkAt": last}),
        );
        ctx.ui.say(&format!(
            "{}  {}  last round {}",
            d.describe(),
            d.id(),
            last.map_or("never".to_owned(), |t| aparte_agent::session::rfc3339(
                t / 1000,
                (t % 1000) as u32
            ))
        ));
    }
    for a in &state.alarms {
        ctx.ui.say(&format!("alarm {} ({}): {}", a.kind, a.id, a.detail));
    }
    Ok(ExitCode::from(exit::OK))
}
