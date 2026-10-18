//! Provider keys: from the provider's environment variable, else from the OS keychain (the macOS login keychain
//! through `security`, the Secret Service through `secret-tool` on Linux), under the service `aparte` and the
//! provider id as account. A key is never printed, logged or passed on a command line: `security -i` and
//! `secret-tool store` read it from standard input. `APARTE_NO_KEYCHAIN=1` turns the keychain off.

use std::io::Write;
use std::process::{Command, Stdio};

use aparte_llm::ApiKey;
use aparte_llm::providers::Preset;

const SERVICE: &str = "aparte";

/// Where a key came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Env(&'static str),
    Keychain,
}

impl std::fmt::Display for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Source::Env(v) => write!(f, "${v}"),
            Source::Keychain => f.write_str("the OS keychain"),
        }
    }
}

fn disabled() -> bool {
    std::env::var_os("APARTE_NO_KEYCHAIN").is_some_and(|v| !v.is_empty() && v != "0")
}

fn quiet(cmd: &mut Command) -> &mut Command {
    cmd.stdin(Stdio::null()).stderr(Stdio::null())
}

/// Reads a key from the keychain; `None` when there is none or no keychain.
pub fn get(account: &str) -> Option<ApiKey> {
    if disabled() {
        return None;
    }
    let out = if cfg!(target_os = "macos") {
        quiet(Command::new("/usr/bin/security").args(["find-generic-password", "-s", SERVICE, "-a", account, "-w"]))
            .output()
            .ok()?
    } else {
        quiet(Command::new("secret-tool").args(["lookup", "service", SERVICE, "account", account]))
            .output()
            .ok()?
    };
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    ApiKey::new(text.trim_end_matches(['\n', '\r']))
}

fn feed(mut cmd: Command, input: &str) -> anyhow::Result<()> {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes())?;
    }
    let out = child.wait_with_output()?;
    if !out.status.success() {
        anyhow::bail!("the keychain refused: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// Stores a key in the keychain.
pub fn set(account: &str, key: &ApiKey) -> anyhow::Result<()> {
    if disabled() {
        anyhow::bail!("the keychain is turned off (APARTE_NO_KEYCHAIN)");
    }
    let secret = key.expose();
    if cfg!(target_os = "macos") {
        if secret.contains(['"', '\\', '\'']) {
            anyhow::bail!("this key has quote characters the macOS keychain command cannot take");
        }
        // `security -i` reads its commands from stdin, so the key never appears in a process list.
        let line = format!("add-generic-password -U -s {SERVICE} -a \"{account}\" -w \"{secret}\"\n");
        let mut cmd = Command::new("/usr/bin/security");
        cmd.arg("-i");
        feed(cmd, &line)
    } else {
        let mut cmd = Command::new("secret-tool");
        cmd.args([
            "store",
            "--label",
            &format!("aparte {account}"),
            "service",
            SERVICE,
            "account",
            account,
        ]);
        feed(cmd, secret)
    }
}

/// Removes a key from the keychain; true when one was removed.
pub fn delete(account: &str) -> anyhow::Result<bool> {
    if disabled() {
        anyhow::bail!("the keychain is turned off (APARTE_NO_KEYCHAIN)");
    }
    let status = if cfg!(target_os = "macos") {
        quiet(Command::new("/usr/bin/security").args(["delete-generic-password", "-s", SERVICE, "-a", account]))
            .stdout(Stdio::null())
            .status()?
    } else {
        quiet(Command::new("secret-tool").args(["clear", "service", SERVICE, "account", account]))
            .stdout(Stdio::null())
            .status()?
    };
    Ok(status.success())
}

/// The key of a preset: its environment variables in order, then the keychain.
pub fn resolve(preset: &Preset) -> Option<(ApiKey, Source)> {
    for var in preset.env {
        if let Some(k) = std::env::var(var).ok().and_then(ApiKey::new) {
            return Some((k, Source::Env(var)));
        }
    }
    if !preset.needs_key {
        return None;
    }
    get(preset.id).map(|k| (k, Source::Keychain))
}
