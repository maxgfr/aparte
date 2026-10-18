//! `aparte sessions`: the conversations of the vault, the CLI's and the web app's alike.
//!
//! - `list`: every conversation not in the trash, pinned first, then the most recently changed.
//! - `show <id>`: the active branch, oldest first.
//! - `export <id> [--output FILE]`: the conversation as JSON Lines in the spirit of pi's session files: a `session`
//!   line, then one `message` line per message of the whole tree (every branch), each with its `parentId`, its parts
//!   exactly as stored (provider metadata included) and its metadata. The file is plaintext: written only when asked,
//!   atomically, 0600.
//!
//! Continue a conversation in the terminal with `aparte --session <id>`.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Context;
use serde_json::{Value, json};

use crate::{Ctx, device, exit};

/// Arguments of `aparte sessions`.
#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    pub action: Action,
}

/// What to do.
#[derive(Debug, clap::Subcommand)]
pub enum Action {
    /// The conversations of the vault
    List,
    /// The active branch of a conversation
    Show {
        /// The conversation id
        id: String,
    },
    /// Write a conversation as JSON Lines (stdout without --output)
    Export {
        /// The conversation id
        id: String,
        /// The file to write (0600)
        #[arg(short, long, value_name = "FILE")]
        output: Option<PathBuf>,
    },
}

fn time(ms: u64) -> String {
    aparte_agent::session::rfc3339(ms / 1000, (ms % 1000) as u32)
}

/// The text a part shows in a terminal.
fn part_text(p: &Value) -> Option<String> {
    let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    match p.get("type").and_then(Value::as_str)? {
        "text" => Some(s("text")),
        "reasoning" => None,
        "tool-call" => Some(format!(
            "▸ {} {}",
            s("name"),
            p.get("input").map(Value::to_string).unwrap_or_default()
        )),
        "tool-result" => Some(format!(
            "  {} → {}",
            s("name"),
            s("output").lines().next().unwrap_or_default()
        )),
        "image" => Some(format!(
            "[image {}]",
            p.get("name").and_then(Value::as_str).unwrap_or("")
        )),
        "file" => Some(format!("[file {}]", s("name"))),
        "source" => Some(format!("[source {}]", s("url"))),
        other => Some(format!("[{other}]")),
    }
}

/// Runs a sessions action.
pub fn run(args: Args, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let open = device::open(ctx)?;
    let ws = &open.workspace;
    match args.action {
        Action::List => {
            let list = ws.conversations()?;
            if list.is_empty() {
                ctx.ui.say("no conversation in the vault yet");
            }
            for c in list {
                let count = ws.messages(&c.id).map(|m| m.len()).unwrap_or(0);
                ctx.ui.emit(
                    "session",
                    json!({
                        "id": c.id, "title": c.title, "updatedAt": c.updated_at, "createdAt": c.created_at,
                        "messages": count, "pinned": c.pinned, "archived": c.archived, "model": c.model,
                    }),
                );
                if !ctx.ui.is_json() {
                    let title = if c.title.is_empty() {
                        "(untitled)"
                    } else {
                        c.title.as_str()
                    };
                    ctx.ui.say(&format!(
                        "{}  {}  {:>3} msg  {}",
                        c.id,
                        time(c.updated_at),
                        count,
                        aparte_tui::markdown::sanitize(title)
                    ));
                }
            }
        }
        Action::Show { id } => {
            let c = ws
                .conversation(&id)?
                .with_context(|| format!("no conversation {id} in the vault"))?;
            let path = ws.path(&id, None)?;
            ctx.ui.emit("session", serde_json::to_value(&c).unwrap_or(Value::Null));
            if !ctx.ui.is_json() {
                ctx.ui.say(&format!("# {}", aparte_tui::markdown::sanitize(&c.title)));
            }
            for m in &path {
                ctx.ui.emit("message", serde_json::to_value(m).unwrap_or(Value::Null));
                if ctx.ui.is_json() || m.deleted_at.is_some() {
                    continue;
                }
                let body: Vec<String> = m.parts.iter().filter_map(part_text).collect();
                let status = if m.status == "done" {
                    String::new()
                } else {
                    format!(" ({})", m.status)
                };
                ctx.ui.say(&format!(
                    "\n[{}{status}] {}\n{}",
                    m.role,
                    time(m.created_at),
                    aparte_tui::markdown::sanitize(&body.join("\n"))
                ));
            }
        }
        Action::Export { id, output } => {
            let c = ws
                .conversation(&id)?
                .with_context(|| format!("no conversation {id} in the vault"))?;
            let mut out = serde_json::to_string(&json!({
                "type": "session", "version": 1, "id": c.id, "title": c.title,
                "timestamp": time(c.created_at), "system": c.system, "tools": c.tools,
                "model": c.model, "effort": c.effort, "leaf": c.leaf,
            }))?;
            out.push('\n');
            for m in ws.messages(&id)? {
                let mut entry = json!({
                    "type": "message", "id": m.id, "parentId": m.parent, "timestamp": time(m.created_at),
                    "message": {"role": m.role, "content": m.parts},
                    "status": m.status,
                });
                for (k, v) in [
                    ("model", serde_json::to_value(&m.model)?),
                    ("usage", serde_json::to_value(&m.usage)?),
                    ("stop", serde_json::to_value(&m.stop)?),
                    ("effort", serde_json::to_value(&m.effort)?),
                    ("error", serde_json::to_value(&m.error)?),
                    ("refusal", serde_json::to_value(&m.refusal)?),
                ] {
                    if !v.is_null() {
                        entry[k] = v;
                    }
                }
                out.push_str(&serde_json::to_string(&entry)?);
                out.push('\n');
            }
            match output {
                Some(path) => {
                    aparte_store::fsx::atomic_write(&path, out.as_bytes())?;
                    ctx.ui
                        .emit("session-export", json!({"id": id, "file": path.display().to_string()}));
                    ctx.ui.say(&format!("wrote {}", path.display()));
                }
                None => {
                    use std::io::Write;
                    std::io::stdout().lock().write_all(out.as_bytes())?;
                }
            }
        }
    }
    Ok(ExitCode::from(exit::OK))
}
