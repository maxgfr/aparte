//! `aparte vault`: the encrypted vault of this device, the one the web app opens (spec/FORMAT.md section 6):
//!
//! - `create`: a new vault, a passphrase slot combined with a new Secret Key, and a recovery slot; the Emergency Kit
//!   (Secret Key and recovery key) is shown once, and the Secret Key is kept in the OS keychain unless `--no-keychain`.
//! - `join <folder|git|github|s3> ...`: takes the vault a sync store holds (its keyslots), unlocks it with the
//!   passphrase and the Emergency Kit, keeps the destination, and syncs once.
//! - `unlock-test`: opens a slot and reports, nothing else.
//! - `status`: whether a vault is here, its id and its keyslots (offline, nothing secret).
//! - `change-passphrase`: a new passphrase slot (same Secret Key); the old slot is removed here at once and from the
//!   sync stores at the next round (on Git it stays in the history: spec/FORMAT.md section 14).

use std::process::ExitCode;
use std::sync::Arc;

use anyhow::Context;
use aparte_crypto::OsRng;
use aparte_format::keyslot::KeyslotKind;
use aparte_store::{CreateOptions, Credential, VaultState};
use aparte_sync::Workspace;
use aparte_sync::join::read_stored_vault;
use serde_json::json;

use crate::cmd::sync::{DestArgs, round_with, runtime};
use crate::{Ctx, destinations, device, exit, keychain};

/// Arguments of `aparte vault`.
#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    pub action: Action,
}

/// What to do with the vault.
#[derive(Debug, clap::Subcommand)]
pub enum Action {
    /// Create a vault on this device (passphrase from APARTE_NEW_PASSPHRASE or asked twice)
    Create {
        /// Do not combine the passphrase with a Secret Key
        #[arg(long)]
        no_secret_key: bool,
        /// Do not create a recovery key
        #[arg(long)]
        no_recovery_key: bool,
        /// Do not keep the Secret Key in the OS keychain
        #[arg(long)]
        no_keychain: bool,
    },
    /// Take the vault of a sync store (passphrase and Emergency Kit asked, or APARTE_PASSPHRASE and APARTE_SECRET_KEY)
    Join {
        #[command(subcommand)]
        dest: DestArgs,
        /// Do not keep the Secret Key in the OS keychain
        #[arg(long, global = true)]
        no_keychain: bool,
        /// Only take the keyslots; sync later with `aparte sync now`
        #[arg(long, global = true)]
        no_sync: bool,
    },
    /// Check that the passphrase (and Secret Key) open the vault
    UnlockTest,
    /// Whether a vault is here, and its keyslots
    Status,
    /// Replace the passphrase (current from APARTE_PASSPHRASE or asked; new from APARTE_NEW_PASSPHRASE or asked)
    ChangePassphrase,
}

/// Runs a vault action.
pub fn run(args: Args, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    match args.action {
        Action::Create {
            no_secret_key,
            no_recovery_key,
            no_keychain,
        } => create(ctx, !no_secret_key, !no_recovery_key, !no_keychain),
        Action::Join {
            dest,
            no_keychain,
            no_sync,
        } => join(ctx, &dest, !no_keychain, !no_sync),
        Action::UnlockTest => {
            let vault = device::vault(ctx)?;
            let unlocked = device::unlock(&vault)?;
            ctx.ui.emit(
                "vault-unlock",
                json!({"vault": unlocked.vault, "slot": unlocked.slot, "ok": true}),
            );
            ctx.ui
                .say(&format!("the vault {} opens (slot {})", unlocked.vault, unlocked.slot));
            Ok(ExitCode::from(exit::OK))
        }
        Action::Status => status(ctx),
        Action::ChangePassphrase => change_passphrase(ctx),
    }
}

fn keep_secret_key(ctx: &Ctx, vault: &str, key: &[u8; 16]) {
    match device::remember_secret_key(vault, key) {
        Ok(()) => ctx
            .ui
            .say("the Secret Key is kept in the OS keychain: unlocking here needs only the passphrase"),
        Err(e) => eprintln!("aparte: the Secret Key was not kept in the keychain ({e:#}); it will be asked for"),
    }
}

fn create(ctx: &Ctx, secret_key: bool, recovery_key: bool, keychain: bool) -> anyhow::Result<ExitCode> {
    let vault = device::vault(ctx)?;
    if vault.state()? != VaultState::Absent {
        anyhow::bail!("a vault already exists on this device ({})", vault.vault()?);
    }
    let pass = device::new_passphrase()?;
    let created = vault.create(
        &pass,
        CreateOptions {
            secret_key,
            recovery_key,
        },
        &mut OsRng,
        Box::new(OsRng),
    )?;
    let id = created.unlocked.vault.clone();
    ctx.ui.emit(
        "vault-created",
        json!({"vault": id, "secretKey": created.secret_key, "recoveryKey": created.recovery_key}),
    );
    if !ctx.ui.is_json() {
        ctx.ui.say(&format!("created the vault {id}"));
        ctx.ui
            .say("Emergency Kit: write these down now, they are shown once and cannot be recovered.");
        if let Some(sk) = &created.secret_key {
            ctx.ui.say(&format!("  Secret Key:   {sk}"));
        }
        if let Some(rk) = &created.recovery_key {
            ctx.ui.say(&format!("  Recovery key: {rk}"));
        }
    }
    if keychain
        && keychain::KeychainVault::available().is_some()
        && let Some(sk) = created.unlocked.secret_key.as_deref()
    {
        keep_secret_key(ctx, &id, sk);
    }
    Ok(ExitCode::from(exit::OK))
}

fn join(ctx: &Ctx, dest: &DestArgs, keychain: bool, sync: bool) -> anyhow::Result<ExitCode> {
    let vault = Arc::new(device::vault(ctx)?);
    if vault.state()? != VaultState::Absent {
        anyhow::bail!("a vault already exists on this device ({})", vault.vault()?);
    }
    let d = dest.resolve()?;
    let store = d.store(&device::data_dir(ctx)?)?;
    let stored = runtime()?
        .block_on(read_stored_vault(store.as_ref()))
        .with_context(|| format!("cannot read the vault of {}", d.describe()))?;
    vault.join(&stored.vault, &stored.keyslots)?;
    let unlocked = match device::unlock(&vault) {
        Ok(u) => u,
        Err(e) => {
            // A failed first unlock leaves no half-joined vault behind.
            let _ = vault.leave();
            return Err(e);
        }
    };
    ctx.ui
        .emit("vault-joined", json!({"vault": unlocked.vault, "dest": d.id()}));
    ctx.ui
        .say(&format!("joined the vault {} from {}", unlocked.vault, d.describe()));
    if keychain
        && keychain::KeychainVault::available().is_some()
        && device::known_secret_key(&unlocked.vault)?.is_none()
        && let Some(sk) = unlocked.secret_key.as_deref()
    {
        keep_secret_key(ctx, &unlocked.vault, sk);
    }
    destinations::save(&unlocked.store, &d)?;
    if sync {
        let workspace = Workspace::open(unlocked.store.clone(), Arc::new(aparte_sync::SystemClock))?;
        let open = device::Open {
            vault: vault.clone(),
            unlocked,
            workspace,
        };
        round_with(ctx, &open, &d)?;
        let n = open.workspace.conversations()?.len();
        ctx.ui.say(&format!("{n} conversation(s) in the vault"));
    }
    Ok(ExitCode::from(exit::OK))
}

fn status(ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let vault = device::vault(ctx)?;
    let state = vault.state()?;
    if state == VaultState::Absent {
        ctx.ui.emit(
            "vault-status",
            json!({"state": "absent", "dir": vault.root().display().to_string()}),
        );
        ctx.ui
            .say("no vault on this device: `aparte vault create`, or `aparte vault join` one a sync store holds");
        return Ok(ExitCode::from(exit::OK));
    }
    let id = vault.vault()?;
    let slots = vault.slot_infos()?;
    let kept = device::known_secret_key(&id).ok().flatten().is_some();
    let rows: Vec<serde_json::Value> = slots
        .iter()
        .map(|s| json!({"slot": s.slot, "kind": s.kind.as_str(), "secretKey": s.secret_key}))
        .collect();
    ctx.ui.emit(
        "vault-status",
        json!({
            "state": "locked", "vault": id, "dir": vault.root().display().to_string(),
            "slots": rows, "secretKeyOnDevice": kept,
        }),
    );
    ctx.ui
        .say(&format!("vault {id} (locked) in {}", vault.root().display()));
    for s in &slots {
        let note = if s.kind == KeyslotKind::Passphrase && s.secret_key {
            " + Secret Key"
        } else {
            ""
        };
        ctx.ui.say(&format!("  {} {}{note}", s.slot, s.kind.as_str()));
    }
    ctx.ui.say(if kept {
        "the Secret Key is on this device (keychain or APARTE_SECRET_KEY)"
    } else {
        "the Secret Key is not on this device: unlocking asks for the Emergency Kit"
    });
    Ok(ExitCode::from(exit::OK))
}

fn change_passphrase(ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let vault = device::vault(ctx)?;
    let sk = device::secret_key(&vault)?;
    let current = device::passphrase("Current passphrase: ")?.ok_or(device::NoPassphrase)?;
    let next = device::new_passphrase()?;
    let changed = vault.change_passphrase(
        &Credential::Passphrase {
            passphrase: &current,
            secret_key: sk.as_deref(),
        },
        &next,
        &mut OsRng,
    )?;
    ctx.ui.emit(
        "vault-passphrase",
        json!({"added": changed.added, "removed": changed.previous}),
    );
    ctx.ui.say(&format!(
        "the new passphrase opens the vault (slot {}); the old slot {} is removed here, and from the sync stores at \
         the next `aparte sync now` (a Git history keeps it)",
        changed.added, changed.previous
    ));
    Ok(ExitCode::from(exit::OK))
}
