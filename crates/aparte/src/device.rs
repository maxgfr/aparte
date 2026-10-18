//! The vault of this device as the verbs use it: where it lives, how its secrets are asked for, and unlocking it.
//!
//! - The store is `<data dir>/vault` (spec/FORMAT.md section 11, as files: see the `aparte-store` crate).
//! - The passphrase comes from `APARTE_PASSPHRASE`, else it is asked for on the terminal without echo.
//! - The Secret Key comes from `APARTE_SECRET_KEY`, else from the OS keychain (service `aparte`, account
//!   `secret-key:<vault id>`) when this device keeps it there, else it is asked for. It is never written to a file.
//! - `APARTE_ARGON2_COSTS=m,t,p` sets the Argon2id costs of new passphrase slots within the format's bounds (for
//!   tests); the default is the fixed 64 MiB, 3 passes, 1 lane every device uses.

use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, bail};
use aparte_crypto::OsRng;
use aparte_crypto::text::{format_secret_key, parse_secret_key};
use aparte_format::keyslot::{Argon2Params, KeyslotKind};
use aparte_store::{Credential, Unlocked, Vault, VaultState};
use aparte_sync::{SystemClock, Workspace};
use zeroize::Zeroizing;

use crate::{Ctx, keychain, paths};

/// The data directory, or an error naming the flag.
pub fn data_dir(ctx: &Ctx) -> anyhow::Result<PathBuf> {
    paths::data_dir(ctx.global.data_dir.as_ref()).context("no data directory: set HOME or --data-dir")
}

/// The vault of this device (it may be absent).
pub fn vault(ctx: &Ctx) -> anyhow::Result<Vault> {
    let mut v = Vault::new(data_dir(ctx)?.join("vault"));
    if let Some(params) = argon2_override()? {
        v = v.with_argon2(params);
    }
    Ok(v)
}

fn argon2_override() -> anyhow::Result<Option<Argon2Params>> {
    let Ok(text) = std::env::var("APARTE_ARGON2_COSTS") else {
        return Ok(None);
    };
    let parts: Vec<u32> = text
        .split(',')
        .map(|p| p.trim().parse())
        .collect::<Result<_, _>>()
        .context("APARTE_ARGON2_COSTS is m,t,p")?;
    let [m, t, p] = parts[..] else {
        bail!("APARTE_ARGON2_COSTS is m,t,p");
    };
    let params = Argon2Params { m, t, p };
    if !params.in_bounds() {
        bail!("APARTE_ARGON2_COSTS is outside the bounds of aparte/1");
    }
    Ok(Some(params))
}

/// Reads one line on the terminal without echo (stdin when it is not a terminal), with the prompt on stderr.
pub fn read_hidden(prompt: &str) -> anyhow::Result<Zeroizing<String>> {
    let stdin = std::io::stdin();
    let tty = stdin.is_terminal();
    if tty {
        eprint!("{prompt}");
        let _ = std::io::stderr().flush();
        let _ = std::process::Command::new("stty").arg("-echo").status();
    }
    let mut line = Zeroizing::new(String::new());
    let read = stdin.lock().read_line(&mut line);
    if tty {
        let _ = std::process::Command::new("stty").arg("echo").status();
        eprintln!();
    }
    read.context("cannot read from the terminal")?;
    let trimmed = Zeroizing::new(line.trim_end_matches(['\n', '\r']).to_owned());
    Ok(trimmed)
}

/// The passphrase: `APARTE_PASSPHRASE`, else asked for. `None` when it cannot be asked (no terminal).
pub fn passphrase(prompt: &str) -> anyhow::Result<Option<Zeroizing<String>>> {
    if let Ok(p) = std::env::var("APARTE_PASSPHRASE") {
        return Ok(Some(Zeroizing::new(p)));
    }
    if !std::io::stdin().is_terminal() {
        return Ok(None);
    }
    read_hidden(prompt).map(Some)
}

/// A new passphrase: `APARTE_NEW_PASSPHRASE`, else asked for twice.
pub fn new_passphrase() -> anyhow::Result<Zeroizing<String>> {
    if let Ok(p) = std::env::var("APARTE_NEW_PASSPHRASE") {
        return Ok(Zeroizing::new(p));
    }
    if !std::io::stdin().is_terminal() {
        bail!("no terminal to ask for the new passphrase: set APARTE_NEW_PASSPHRASE");
    }
    let first = read_hidden("New passphrase: ")?;
    let again = read_hidden("The new passphrase again: ")?;
    if *first != *again {
        bail!("the two passphrases differ");
    }
    if first.trim().is_empty() {
        bail!("the passphrase is empty");
    }
    Ok(first)
}

/// The keychain account of a vault's Secret Key.
pub fn secret_key_account(vault: &str) -> String {
    format!("secret-key:{vault}")
}

/// The Secret Key, when one can be found without asking: `APARTE_SECRET_KEY`, else the keychain.
pub fn known_secret_key(vault: &str) -> anyhow::Result<Option<Zeroizing<[u8; 16]>>> {
    if let Ok(text) = std::env::var("APARTE_SECRET_KEY") {
        return Ok(Some(
            parse_secret_key(&text).context("APARTE_SECRET_KEY is not a Secret Key")?,
        ));
    }
    match keychain::get_secret(&secret_key_account(vault)) {
        Some(text) => Ok(parse_secret_key(&text).ok()),
        None => Ok(None),
    }
}

/// Keeps the Secret Key in the OS keychain, so later unlocks need only the passphrase.
pub fn remember_secret_key(vault: &str, key: &[u8; 16]) -> anyhow::Result<()> {
    keychain::set_secret(&secret_key_account(vault), &format_secret_key(key))
}

/// Whether the vault's slots need the Secret Key.
fn needs_secret_key(v: &Vault) -> anyhow::Result<bool> {
    Ok(v.slot_infos()?
        .iter()
        .any(|s| s.kind == KeyslotKind::Passphrase && s.secret_key))
}

/// The Secret Key: known, else asked for (Emergency Kit text). `None` when the vault does not use one.
pub fn secret_key(v: &Vault) -> anyhow::Result<Option<Zeroizing<[u8; 16]>>> {
    if !needs_secret_key(v)? {
        return Ok(None);
    }
    let id = v.vault()?;
    if let Some(k) = known_secret_key(&id)? {
        return Ok(Some(k));
    }
    if !std::io::stdin().is_terminal() {
        bail!("this vault needs the Secret Key of the Emergency Kit: set APARTE_SECRET_KEY");
    }
    let text = read_hidden("Secret Key (A1-...): ")?;
    Ok(Some(
        parse_secret_key(&text).context("not a Secret Key (A1- and 30 characters)")?,
    ))
}

/// Raised when there is no way to ask for the passphrase.
#[derive(Debug)]
pub struct NoPassphrase;

impl std::fmt::Display for NoPassphrase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("no terminal to ask for the vault passphrase: set APARTE_PASSPHRASE")
    }
}

impl std::error::Error for NoPassphrase {}

/// Unlocks the vault of this device with its passphrase (and Secret Key).
pub fn unlock(v: &Vault) -> anyhow::Result<Unlocked> {
    if v.state()? == VaultState::Absent {
        bail!("no vault on this device: `aparte vault create` or `aparte vault join`");
    }
    let sk = secret_key(v)?;
    let pass = passphrase("Vault passphrase: ")?.ok_or(NoPassphrase)?;
    let unlocked = v.unlock(
        &Credential::Passphrase {
            passphrase: &pass,
            secret_key: sk.as_deref(),
        },
        Box::new(OsRng),
    )?;
    Ok(unlocked)
}

/// An unlocked vault with its documents.
pub struct Open {
    pub vault: Arc<Vault>,
    pub unlocked: Unlocked,
    pub workspace: Workspace,
}

/// Unlocks the vault and opens its documents.
pub fn open(ctx: &Ctx) -> anyhow::Result<Open> {
    let vault = Arc::new(vault(ctx)?);
    let unlocked = unlock(&vault)?;
    let workspace = Workspace::open(unlocked.store.clone(), Arc::new(SystemClock))?;
    Ok(Open {
        vault,
        unlocked,
        workspace,
    })
}
