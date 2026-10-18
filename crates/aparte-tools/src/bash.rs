//! `bash`: runs a command in the project directory under the OS sandbox ([`crate::sandbox`]), with a deadline.
//! Standard error is merged into standard output; the end of the output is kept (where errors are) and the whole
//! is saved when cut. A timeout or an abort kills the command's whole process group.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use aparte_agent::{Annotations, BoxFuture, ToolContext, ToolError, ToolOutput, TypedTool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncReadExt;

use crate::output::{BlobStore, Keep};
use crate::sandbox::{self, Sandbox, SandboxPolicy};

/// Default deadline of a command, in seconds.
pub const DEFAULT_TIMEOUT: u64 = 120;
/// Longest deadline a call may ask for.
pub const MAX_TIMEOUT: u64 = 1800;
/// Output kept in memory; the rest is counted and dropped.
const MAX_CAPTURE: usize = 16 * 1024 * 1024;

/// Input of `bash`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct BashInput {
    /// The command line, run by `bash -c` in the working directory.
    pub command: String,
    /// Deadline in seconds (default 120, at most 1800).
    pub timeout: Option<u64>,
}

/// Runs shell commands.
#[derive(Debug, Clone)]
pub struct Bash {
    pub sandbox: Sandbox,
    pub policy: SandboxPolicy,
    pub blobs: Arc<BlobStore>,
    /// The commands' private temporary directory (`TMPDIR`).
    pub tmp: PathBuf,
}

impl Bash {
    /// A tool with the sandbox found on this machine and a temporary directory inside the blob store.
    pub fn new(policy: SandboxPolicy, blobs: Arc<BlobStore>) -> std::io::Result<Bash> {
        let tmp = blobs.dir().join("tmp");
        aparte_agent::fsx::private_dir(&tmp)?;
        Ok(Bash {
            sandbox: sandbox::detect(),
            policy,
            blobs,
            tmp,
        })
    }
}

fn kill_group(pid: u32) {
    // The command runs in its own process group (its id is the shell's pid); killing the group ends its children.
    // killpg(2), not the `kill` program: the procps-ng 4.0.4 `kill` of Ubuntu 24.04 keeps only the first digit of a
    // negative pid, so it would signal another group, or every process of the user.
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(pid)
        && pid > 1
    {
        let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid), nix::sys::signal::Signal::SIGKILL);
    }
    #[cfg(not(unix))]
    let _ = pid;
}

impl TypedTool for Bash {
    type Input = BashInput;
    fn name(&self) -> &str {
        "bash"
    }
    fn description(&self) -> &str {
        "Runs a bash command in the working directory, sandboxed: writes only inside the project and TMPDIR, no \
         network unless allowed. Output is stdout and stderr together, cut to the last 2000 lines."
    }
    fn annotations(&self) -> Annotations {
        Annotations {
            read_only: false,
            destructive: true,
            idempotent: false,
            open_world: self.policy.network,
        }
    }
    fn run<'a>(&'a self, ctx: &'a ToolContext, input: BashInput) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            if self.sandbox == Sandbox::None && self.policy.required {
                return Err(ToolError::Failed(
                    "no OS sandbox is available (sandbox-exec on macOS, bwrap on Linux); install bubblewrap, or \
                     start aparte with --no-sandbox to run commands unconfined"
                        .into(),
                ));
            }
            let timeout = Duration::from_secs(input.timeout.unwrap_or(DEFAULT_TIMEOUT).clamp(1, MAX_TIMEOUT));
            let script = format!("exec 2>&1\n{}", input.command);
            let mut cmd = sandbox::command(self.sandbox, &self.policy, &ctx.cwd, &self.tmp, &script);
            cmd.stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            #[cfg(unix)]
            cmd.process_group(0);
            let mut child = cmd
                .spawn()
                .map_err(|e| ToolError::Failed(format!("cannot start the command: {e}")))?;
            let pid = child.id();
            let mut stdout = child.stdout.take();
            let read = async {
                let mut buf = Vec::new();
                let mut dropped = 0usize;
                if let Some(out) = stdout.as_mut() {
                    let mut chunk = vec![0u8; 64 * 1024];
                    loop {
                        match out.read(&mut chunk).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let room = MAX_CAPTURE.saturating_sub(buf.len());
                                buf.extend_from_slice(&chunk[..n.min(room)]);
                                dropped += n.saturating_sub(room);
                            }
                        }
                    }
                }
                (buf, dropped)
            };
            let run = async {
                let (out, status) = tokio::join!(read, child.wait());
                (out, status)
            };
            let outcome = tokio::select! {
                r = run => Ok(r),
                () = tokio::time::sleep(timeout) => Err("timed out"),
                () = ctx.cancel.cancelled() => Err("cancelled"),
            };
            let ((buf, dropped), status) = match outcome {
                Ok(r) => r,
                Err(why) => {
                    if let Some(pid) = pid {
                        kill_group(pid);
                    }
                    if why == "cancelled" {
                        return Err(ToolError::Cancelled);
                    }
                    return Err(ToolError::Failed(format!(
                        "the command timed out after {}s",
                        timeout.as_secs()
                    )));
                }
            };
            let status = status.map_err(|e| ToolError::Failed(format!("cannot wait for the command: {e}")))?;
            let mut text = String::from_utf8_lossy(&buf).into_owned();
            if dropped > 0 {
                text.push_str(&format!("\n[{dropped} more bytes of output dropped]"));
            }
            let code = status.code();
            let (mut shown, saved) = self.blobs.fit("bash", &text, Keep::Tail);
            if shown.is_empty() {
                shown.push_str("(no output)");
            }
            let ok = status.success();
            if !ok {
                match code {
                    Some(c) => shown.push_str(&format!("\n[exit code {c}]")),
                    None => shown.push_str("\n[killed by a signal]"),
                }
            }
            Ok(ToolOutput {
                content: shown,
                details: Some(json!({
                    "exitCode": code,
                    "sandbox": self.sandbox.name(),
                    "saved": saved,
                })),
                is_error: !ok,
            })
        })
    }
}
