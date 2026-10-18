//! `aparte rpc`: the agent over standard input and output, one JSON object per line (LF-delimited), for editors and
//! other programs. Commands come in on stdin; agent events, approval requests and command responses go out on
//! stdout, each as `{"event": ...}`. Logs go to stderr.
//!
//! Commands (`id` is optional and echoed in the response):
//!
//! | `type` | Fields | Does |
//! |---|---|---|
//! | `prompt` | `message` | starts a run (refused while one runs: use `steer` or `follow_up`); `/skill:<name> ...` runs a skill |
//! | `steer` | `message` | delivers a message after the current tool batch |
//! | `follow_up` | `message` | delivers a message when the run would stop |
//! | `abort` | | stops the run |
//! | `approve` | `callId`, `decision` (`allow`, `allow-always`, `deny`), `reason` | answers an `approval-request` |
//! | `get_messages` | | responds with the conversation |
//! | `get_tools` | | responds with the tools offered (`name`, `description`, `inputSchema`) |
//! | `get_skills` | | responds with the skills found and whether each is offered to the model |
//! | `get_mcp` | | responds with the MCP servers and their state |
//! | `set_model` | `model` | changes the model between runs |
//! | `set_effort` | `effort` (or null) | changes the effort between runs |
//! | `export` | `path` | writes the conversation as JSONL |
//! | `quit` | | ends after the current run |
//!
//! The `ready` event carries the provider, the model, the skills offered and the state of each MCP server. End of
//! input aborts a running prompt and exits.

use std::collections::HashMap;
use std::io::Write;
use std::process::ExitCode;
use std::sync::{Arc, Mutex, PoisonError};

use aparte_agent::session::{self, SessionHeader};
use aparte_agent::{
    Agent, AgentEvent, Approval, ApprovalMode, ApprovalRequest, Approver, BoxFuture, EventSink, RunOutcome,
};
use aparte_llm::{ChatModel, Effort};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncBufReadExt;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::cmd::chat::event_json;
use crate::setup::{self, AgentArgs};
use crate::{Ctx, exit};

/// Arguments of `aparte rpc`.
#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(flatten)]
    pub agent: AgentArgs,
}

/// Writes one JSON line on stdout.
fn send(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum Command {
    Prompt {
        message: String,
    },
    Steer {
        message: String,
    },
    FollowUp {
        message: String,
    },
    Abort,
    Approve {
        call_id: String,
        decision: String,
        reason: Option<String>,
    },
    GetMessages,
    GetTools,
    GetSkills,
    GetMcp,
    SetModel {
        model: String,
    },
    SetEffort {
        effort: Option<String>,
    },
    Export {
        path: String,
    },
    Quit,
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Approval>>>>;

/// Asks the RPC client: an `approval-request` event, answered by an `approve` command.
struct RpcApprover {
    pending: Pending,
}

impl Approver for RpcApprover {
    fn approve<'a>(&'a self, req: &'a ApprovalRequest) -> BoxFuture<'a, Approval> {
        Box::pin(async move {
            let (tx, rx) = oneshot::channel();
            self.pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(req.call_id.clone(), tx);
            let mut ev = serde_json::to_value(req).unwrap_or(Value::Null);
            if let Value::Object(m) = &mut ev {
                m.insert("event".into(), json!("approval-request"));
            }
            send(&ev);
            rx.await.unwrap_or(Approval::Deny {
                reason: Some("the RPC client went away".into()),
            })
        })
    }
}

fn respond(id: Option<&Value>, command: &str, ok: bool, extra: Value) {
    let mut v = json!({"event": "response", "command": command, "success": ok});
    if let (Value::Object(m), Some(id)) = (&mut v, id) {
        m.insert("id".into(), id.clone());
    }
    if let (Value::Object(m), Value::Object(e)) = (&mut v, extra) {
        m.extend(e);
    }
    send(&v);
}

/// Runs the RPC loop.
pub fn run(args: Args, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let (client, preset) = setup::client(&args.agent)?;
    let model: Arc<dyn ChatModel> = Arc::new(client);
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    rt.block_on(serve(args, ctx, model, preset))
}

async fn serve(
    args: Args,
    ctx: &Ctx,
    model: Arc<dyn ChatModel>,
    preset: &'static aparte_llm::providers::Preset,
) -> anyhow::Result<ExitCode> {
    let cwd = setup::cwd()?;
    let pending: Pending = Arc::default();
    // `agent-end` is held back until the run's task has handed the agent back, so a command sent on seeing it finds
    // the agent free instead of "a run is in progress".
    let ended: Arc<Mutex<Option<Value>>> = Arc::default();
    let held = ended.clone();
    let sink: EventSink = Arc::new(move |ev: &AgentEvent| match ev {
        AgentEvent::AgentEnd { .. } => {
            *held.lock().unwrap_or_else(PoisonError::into_inner) = Some(event_json(ev));
        }
        _ => send(&event_json(ev)),
    });
    let wiring = setup::Wiring {
        approval: ApprovalMode::Ask,
        sink,
        approver: Some(Arc::new(RpcApprover {
            pending: pending.clone(),
        })),
    };
    let built = setup::build(ctx, &args.agent, model, preset, &cwd, wiring).await?;
    let setup::Built {
        agent,
        preset,
        blobs,
        skills,
        mcp,
        recorder,
    } = built;
    let trusted = agent.config().trusted;
    let skills_json: Vec<Value> = skills
        .skills
        .iter()
        .map(|s| {
            json!({
                "name": s.name,
                "description": s.description,
                "scope": s.scope,
                "path": s.file.display().to_string(),
                "offered": skills.is_offered(s, trusted),
                "disableModelInvocation": s.disable_model_invocation,
            })
        })
        .collect();
    let mcp_json = serde_json::to_value(mcp.statuses()).unwrap_or(Value::Null);
    let handle = agent.handle();
    let mut agent: Option<Agent> = Some(agent);
    let mut task: Option<JoinHandle<(Agent, RunOutcome)>> = None;

    let (tx, mut lines) = mpsc::unbounded_channel::<Option<String>>();
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if tx.send(Some(line)).is_err() {
                return;
            }
        }
        let _ = tx.send(None);
    });
    let offered: Vec<&str> = skills.offered(trusted).map(|s| s.name.as_str()).collect();
    send(&json!({
        "event": "ready",
        "provider": preset.id,
        "model": agent.as_ref().map(|a| a.config().model.clone()),
        "skills": offered,
        "mcpServers": mcp_json,
    }));

    let mut quitting = false;
    loop {
        if quitting && task.is_none() {
            break;
        }
        let running = task.is_some();
        tokio::select! {
            line = lines.recv() => {
                let Some(Some(line)) = line else {
                    // End of input: stop what runs, then leave.
                    handle.abort();
                    quitting = true;
                    if task.is_none() {
                        break;
                    }
                    continue;
                };
                if line.trim().is_empty() {
                    continue;
                }
                let raw: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        respond(None, "parse", false, json!({"error": e.to_string()}));
                        continue;
                    }
                };
                let id = raw.get("id").cloned();
                let name = raw.get("type").and_then(Value::as_str).unwrap_or("unknown").to_owned();
                let cmd: Command = match serde_json::from_value(raw) {
                    Ok(c) => c,
                    Err(e) => {
                        respond(id.as_ref(), &name, false, json!({"error": e.to_string()}));
                        continue;
                    }
                };
                match cmd {
                    Command::Prompt { message } => match (agent.take(), setup::expand_prompt(&skills, &message)) {
                        (Some(a), Err(e)) => {
                            agent = Some(a);
                            respond(id.as_ref(), &name, false, json!({"error": format!("{e:#}")}));
                        }
                        (Some(mut a), Ok(message)) => {
                            respond(id.as_ref(), &name, true, json!({}));
                            task = Some(tokio::spawn(async move {
                                let out = a.prompt(message).await;
                                (a, out)
                            }));
                        }
                        (None, _) => respond(id.as_ref(), &name, false, json!({"error": "a run is in progress: use steer or follow_up"})),
                    },
                    Command::GetTools => match &agent {
                        Some(a) => {
                            let tools: Vec<Value> = a
                                .tool_specs()
                                .into_iter()
                                .map(|t| json!({"name": t.name, "description": t.description, "inputSchema": t.input_schema}))
                                .collect();
                            respond(id.as_ref(), &name, true, json!({"tools": tools}));
                        }
                        None => respond(id.as_ref(), &name, false, json!({"error": "a run is in progress"})),
                    },
                    Command::GetSkills => respond(id.as_ref(), &name, true, json!({"skills": skills_json})),
                    Command::GetMcp => respond(id.as_ref(), &name, true, json!({"servers": mcp_json})),
                    Command::Steer { message } => {
                        handle.steer(message);
                        respond(id.as_ref(), &name, true, json!({}));
                    }
                    Command::FollowUp { message } => {
                        handle.follow_up(message);
                        respond(id.as_ref(), &name, true, json!({}));
                    }
                    Command::Abort => {
                        handle.abort();
                        respond(id.as_ref(), &name, true, json!({}));
                    }
                    Command::Approve { call_id, decision, reason } => {
                        let approval = match decision.as_str() {
                            "allow" => Some(Approval::Allow),
                            "allow-always" => Some(Approval::AllowAlways),
                            "deny" => Some(Approval::Deny { reason }),
                            _ => None,
                        };
                        let waiting = pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&call_id);
                        match (approval, waiting) {
                            (Some(a), Some(tx)) => {
                                let _ = tx.send(a);
                                respond(id.as_ref(), &name, true, json!({}));
                            }
                            (None, Some(tx)) => {
                                pending.lock().unwrap_or_else(PoisonError::into_inner).insert(call_id, tx);
                                respond(id.as_ref(), &name, false, json!({"error": "decision is allow, allow-always or deny"}));
                            }
                            (_, None) => respond(id.as_ref(), &name, false, json!({"error": "no approval is waiting for this call"})),
                        }
                    }
                    Command::GetMessages => match &agent {
                        Some(a) => respond(id.as_ref(), &name, true, json!({"messages": a.messages()})),
                        None => respond(id.as_ref(), &name, false, json!({"error": "a run is in progress"})),
                    },
                    Command::SetModel { model } => match agent.as_mut() {
                        Some(a) => {
                            a.config_mut().model = model;
                            respond(id.as_ref(), &name, true, json!({}));
                        }
                        None => respond(id.as_ref(), &name, false, json!({"error": "a run is in progress"})),
                    },
                    Command::SetEffort { effort } => {
                        let parsed = effort.as_deref().map(Effort::parse);
                        match (agent.as_mut(), parsed) {
                            (_, Some(None)) => respond(id.as_ref(), &name, false, json!({"error": "unknown effort level"})),
                            (Some(a), level) => {
                                a.config_mut().effort = level.flatten();
                                respond(id.as_ref(), &name, true, json!({}));
                            }
                            (None, _) => respond(id.as_ref(), &name, false, json!({"error": "a run is in progress"})),
                        }
                    }
                    Command::Export { path } => match &agent {
                        Some(a) => {
                            let header = SessionHeader {
                                kind: "session".into(),
                                version: session::SESSION_VERSION,
                                id: session::new_id(),
                                timestamp: session::now_rfc3339(),
                                cwd: a.config().cwd.display().to_string(),
                                provider: Some(preset.id.to_owned()),
                                model: Some(a.config().model.clone()),
                            };
                            match session::export(std::path::Path::new(&path), &header, a.messages()) {
                                Ok(()) => respond(id.as_ref(), &name, true, json!({})),
                                Err(e) => respond(id.as_ref(), &name, false, json!({"error": e.to_string()})),
                            }
                        }
                        None => respond(id.as_ref(), &name, false, json!({"error": "a run is in progress"})),
                    },
                    Command::Quit => {
                        respond(id.as_ref(), &name, true, json!({}));
                        quitting = true;
                    }
                }
            }
            done = async {
                match task.as_mut() {
                    Some(t) => Some(t.await),
                    None => None,
                }
            }, if running => {
                task = None;
                if let Some(Ok((a, _))) = done {
                    agent = Some(a);
                }
                if let Some(end) = ended.lock().unwrap_or_else(PoisonError::into_inner).take() {
                    send(&end);
                }
            }
        }
    }
    let Some(agent) = agent else {
        mcp.shutdown().await;
        anyhow::bail!("the agent task failed");
    };
    let built = setup::Built {
        agent,
        preset,
        blobs,
        skills,
        mcp,
        recorder,
    };
    setup::finish(&args.agent, built).await?;
    Ok(ExitCode::from(exit::OK))
}
