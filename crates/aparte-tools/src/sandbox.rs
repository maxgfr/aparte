//! The OS sandbox around `bash`: `sandbox-exec` on macOS, bubblewrap on Linux. Inside it a command can read the
//! whole filesystem but write only to the project directory, its private temporary directory and the paths the
//! user added, and it has no network unless the user allowed it. Its environment is rebuilt from an allowlist, so
//! API keys and tokens of the CLI's own environment never reach it.

use std::path::{Path, PathBuf};
use std::process::Stdio;

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Environment variables passed through to commands.
pub const ENV_ALLOWLIST: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TZ",
];

/// The sandbox found on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sandbox {
    /// macOS `sandbox-exec`.
    SandboxExec,
    /// Linux bubblewrap.
    Bwrap,
    /// None: commands would run unconfined.
    None,
}

impl Sandbox {
    /// A name for messages.
    pub fn name(self) -> &'static str {
        match self {
            Sandbox::SandboxExec => "sandbox-exec",
            Sandbox::Bwrap => "bwrap",
            Sandbox::None => "none",
        }
    }
}

/// What commands may do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxPolicy {
    /// Refuse to run commands when no sandbox is found (the default). False runs them unconfined
    /// (`--no-sandbox`).
    pub required: bool,
    /// Allow network access (`--allow-net`).
    pub network: bool,
    /// Writable directories besides the project and the temporary directory.
    pub writable: Vec<PathBuf>,
}

impl Default for SandboxPolicy {
    fn default() -> SandboxPolicy {
        SandboxPolicy {
            required: true,
            network: false,
            writable: Vec::new(),
        }
    }
}

fn quiet(c: &mut std::process::Command) -> bool {
    c.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Finds a working sandbox (a probe run, not only a file check).
pub fn detect() -> Sandbox {
    if cfg!(target_os = "macos")
        && Path::new(SANDBOX_EXEC).exists()
        && quiet(std::process::Command::new(SANDBOX_EXEC).args(["-p", "(version 1)(allow default)", "/usr/bin/true"]))
    {
        return Sandbox::SandboxExec;
    }
    if cfg!(target_os = "linux")
        && quiet(std::process::Command::new("bwrap").args([
            "--ro-bind",
            "/",
            "/",
            "--unshare-net",
            "--unshare-pid",
            "--die-with-parent",
            "true",
        ]))
    {
        return Sandbox::Bwrap;
    }
    Sandbox::None
}

fn canonical(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// The macOS profile: everything allowed except writes outside the given paths and, unless allowed, IP networking.
pub fn macos_profile(network: bool, extra: usize) -> String {
    let mut p = String::from("(version 1)\n(allow default)\n");
    if !network {
        p.push_str(
            "(deny network-outbound (remote ip))\n(deny network-inbound (local ip))\n(deny network-bind (local ip))\n",
        );
    }
    p.push_str(
        "(deny file-write*)\n(allow file-write*\n  (subpath (param \"PROJECT\"))\n  (subpath (param \"TMP\"))\n",
    );
    for i in 0..extra {
        p.push_str(&format!("  (subpath (param \"EXTRA_{i}\"))\n"));
    }
    p.push_str(
        "  (literal \"/dev/null\")\n  (literal \"/dev/zero\")\n  (literal \"/dev/tty\")\n  \
         (literal \"/dev/dtracehelper\")\n  (regex #\"^/dev/fd/\"))\n",
    );
    p
}

/// The command that runs `script` with bash in `cwd` under the sandbox.
pub fn command(
    sandbox: Sandbox,
    policy: &SandboxPolicy,
    cwd: &Path,
    tmp: &Path,
    script: &str,
) -> tokio::process::Command {
    let cwd = canonical(cwd);
    let tmp = canonical(tmp);
    let shell = if Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    };
    let mut c = match sandbox {
        Sandbox::SandboxExec => {
            let mut c = tokio::process::Command::new(SANDBOX_EXEC);
            c.arg("-p").arg(macos_profile(policy.network, policy.writable.len()));
            c.arg("-D").arg(format!("PROJECT={}", cwd.display()));
            c.arg("-D").arg(format!("TMP={}", tmp.display()));
            for (i, dir) in policy.writable.iter().enumerate() {
                c.arg("-D").arg(format!("EXTRA_{i}={}", canonical(dir).display()));
            }
            c.arg(shell).arg("-c").arg(script);
            c
        }
        Sandbox::Bwrap => {
            let mut c = tokio::process::Command::new("bwrap");
            c.args(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]);
            c.arg("--bind").arg(&cwd).arg(&cwd);
            c.arg("--bind").arg(&tmp).arg(&tmp);
            for dir in policy.writable.iter().map(|d| canonical(d)).filter(|d| d.is_dir()) {
                c.arg("--bind").arg(&dir).arg(&dir);
            }
            if !policy.network {
                c.arg("--unshare-net");
            }
            c.args(["--unshare-pid", "--die-with-parent", "--new-session", "--chdir"]);
            c.arg(&cwd).arg("--").arg(shell).arg("-c").arg(script);
            c
        }
        Sandbox::None => {
            let mut c = tokio::process::Command::new(shell);
            c.arg("-c").arg(script);
            c
        }
    };
    c.current_dir(&cwd).env_clear();
    for key in ENV_ALLOWLIST {
        if let Some(v) = std::env::var_os(key) {
            c.env(key, v);
        }
    }
    if std::env::var_os("PATH").is_none() {
        c.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    }
    c.env("TERM", "dumb")
        .env("TMPDIR", &tmp)
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_denies_network_unless_allowed() {
        assert!(macos_profile(false, 0).contains("deny network-outbound"));
        assert!(!macos_profile(true, 0).contains("deny network"));
        assert!(macos_profile(false, 2).contains("EXTRA_1"));
    }

    #[test]
    fn no_secret_variable_is_allowlisted() {
        for key in ENV_ALLOWLIST {
            assert!(!key.contains("KEY") && !key.contains("TOKEN") && !key.contains("SECRET"));
        }
    }
}
