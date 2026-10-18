//! The loop: send the conversation, stream the answer, run the tool calls it asks for, send their results, and
//! repeat until the model answers without tools.
//!
//! - Steering: a message queued with [`AgentHandle::steer`] while tools run is delivered right after the current
//!   batch of tool results, so the model reads it before its next step.
//! - Follow-up: a message queued with [`AgentHandle::follow_up`] is delivered only when the agent would otherwise
//!   stop.
//! - Tool calls of one answer run concurrently when they are all read-only, otherwise one after the other, in the
//!   model's order. Approvals are asked one at a time, before anything runs.
//! - A refusal (`stop_reason: refusal`) discards the partial answer and ends the run.

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use aparte_llm::{ChatError, ChatEvent, ChatModel, Effort, Message, Part, Request, Role, StopReason, ToolSpec, Usage};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::approval::{Approval, ApprovalMode, ApprovalRequest, Approver, DenyAll, needs_approval};
use crate::hooks::{BeforeTool, Hooks, ToolCall, TurnControl, TurnSummary};
use crate::tool::{CancelToken, Tool, ToolContext, ToolError, ToolOutput};

/// Largest tool result sent to the model; tools truncate on their own, this is the last guard.
pub const MAX_RESULT_BYTES: usize = 256 * 1024;

/// How an agent calls its model.
#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub model: String,
    pub system: String,
    pub effort: Option<Effort>,
    pub max_output_tokens: Option<u32>,
    /// Model calls per run before it stops with `max-turns`.
    pub max_turns: u32,
    pub cwd: PathBuf,
    /// Whether the project is trusted (see [`crate::approval`]).
    pub trusted: bool,
    pub approval: ApprovalMode,
}

impl AgentConfig {
    /// A configuration for a model in a directory, asking before anything that needs approval.
    pub fn new(model: impl Into<String>, cwd: impl Into<PathBuf>) -> AgentConfig {
        AgentConfig {
            model: model.into(),
            system: String::new(),
            effort: None,
            max_output_tokens: None,
            max_turns: 50,
            cwd: cwd.into(),
            trusted: false,
            approval: ApprovalMode::Ask,
        }
    }
}

/// Why a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EndReason {
    /// The model answered without asking for tools, and no follow-up was queued.
    Done,
    MaxTurns,
    Aborted,
    Error,
    Refusal,
    /// A `finish_turn` hook stopped it.
    Stopped,
}

/// What happens during a run, in order. Serialized for `--json` and `rpc`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    AgentStart,
    TurnStart {
        turn: u32,
    },
    TextDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ToolCallStart {
        call_id: String,
        name: String,
    },
    /// The assistant message of a turn, as added to the conversation.
    MessageEnd {
        message: Message,
    },
    ToolStart {
        call_id: String,
        name: String,
        input: Value,
    },
    ToolEnd {
        call_id: String,
        name: String,
        output: ToolOutput,
    },
    Usage {
        usage: Usage,
    },
    TurnEnd {
        turn: u32,
        stop: StopReason,
    },
    /// A steering message was delivered.
    Steer {
        text: String,
    },
    /// A follow-up message was delivered.
    FollowUp {
        text: String,
    },
    Refusal {
        category: Option<String>,
        explanation: Option<String>,
    },
    Error {
        error: ChatError,
    },
    AgentEnd {
        reason: EndReason,
        /// Totals of the run.
        usage: Usage,
    },
}

/// What a run returns.
#[derive(Debug, Clone, PartialEq)]
pub struct RunOutcome {
    pub reason: EndReason,
    pub usage: Usage,
    /// The error that ended the run, with `EndReason::Error`.
    pub error: Option<ChatError>,
    /// The text of the last assistant message.
    pub text: String,
}

#[derive(Debug, Default)]
struct Shared {
    steer: Mutex<VecDeque<String>>,
    follow_up: Mutex<VecDeque<String>>,
    cancel: CancelToken,
}

/// Queues and abort of a running agent, usable from another task.
#[derive(Debug, Clone, Default)]
pub struct AgentHandle {
    shared: Arc<Shared>,
}

impl AgentHandle {
    /// Delivers `text` after the current tool batch (or as the next prompt if the agent is idle).
    pub fn steer(&self, text: impl Into<String>) {
        self.shared
            .steer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push_back(text.into());
    }

    /// Delivers `text` when the agent would otherwise stop.
    pub fn follow_up(&self, text: impl Into<String>) {
        self.shared
            .follow_up
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push_back(text.into());
    }

    /// Stops the run: the stream and running tools are cancelled.
    pub fn abort(&self) {
        self.shared.cancel.cancel();
    }

    fn take_steer(&self) -> Vec<String> {
        self.shared
            .steer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain(..)
            .collect()
    }

    fn take_follow_up(&self) -> Option<String> {
        self.shared
            .follow_up
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()
    }
}

/// Receives the events of a run.
pub type EventSink = Arc<dyn Fn(&AgentEvent) + Send + Sync>;

/// An agent: a model, tools, hooks, an approver and a conversation.
pub struct Agent {
    model: Arc<dyn ChatModel>,
    cfg: AgentConfig,
    tools: Vec<Arc<dyn Tool>>,
    hooks: Vec<Arc<dyn Hooks>>,
    approver: Arc<dyn Approver>,
    sink: EventSink,
    messages: Vec<Message>,
    handle: AgentHandle,
    always: HashSet<String>,
}

fn add_usage(total: &mut Usage, u: &Usage) {
    let add = |a: &mut Option<u64>, b: Option<u64>| {
        if let Some(b) = b {
            *a = Some(a.unwrap_or(0) + b);
        }
    };
    add(&mut total.input, u.input);
    add(&mut total.output, u.output);
    add(&mut total.cache_read, u.cache_read);
    add(&mut total.cache_write, u.cache_write);
    add(&mut total.reasoning, u.reasoning);
}

fn cap(mut s: String) -> String {
    if s.len() > MAX_RESULT_BYTES {
        let mut at = MAX_RESULT_BYTES;
        while !s.is_char_boundary(at) {
            at -= 1;
        }
        s.truncate(at);
        s.push_str("\n[output truncated]");
    }
    s
}

/// One call ready to run, after hooks and approval.
struct Prepared {
    call: ToolCall,
    tool: Option<Arc<dyn Tool>>,
    /// Set when the call does not run: the result to send instead.
    instead: Option<ToolOutput>,
}

impl Agent {
    /// An agent with no tools, no hooks, and an approver that denies.
    pub fn new(model: Arc<dyn ChatModel>, cfg: AgentConfig) -> Agent {
        Agent {
            model,
            cfg,
            tools: Vec::new(),
            hooks: Vec::new(),
            approver: Arc::new(DenyAll),
            sink: Arc::new(|_| {}),
            messages: Vec::new(),
            handle: AgentHandle::default(),
            always: HashSet::new(),
        }
    }

    /// Adds a tool; a tool of the same name replaces the earlier one.
    pub fn with_tool(mut self, tool: Arc<dyn Tool>) -> Agent {
        self.tools.retain(|t| t.name() != tool.name());
        self.tools.push(tool);
        self
    }

    /// Adds several tools.
    pub fn with_tools(self, tools: impl IntoIterator<Item = Arc<dyn Tool>>) -> Agent {
        tools.into_iter().fold(self, Agent::with_tool)
    }

    /// Adds a hook, run after the earlier ones.
    pub fn with_hooks(mut self, hooks: Arc<dyn Hooks>) -> Agent {
        self.hooks.push(hooks);
        self
    }

    /// Sets who answers approval requests.
    pub fn with_approver(mut self, approver: Arc<dyn Approver>) -> Agent {
        self.approver = approver;
        self
    }

    /// Sets the event receiver.
    pub fn on_event(mut self, sink: EventSink) -> Agent {
        self.sink = sink;
        self
    }

    /// The queues and abort switch of this agent.
    pub fn handle(&self) -> AgentHandle {
        self.handle.clone()
    }

    /// The conversation so far.
    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    /// Replaces the conversation (to resume a session).
    pub fn set_messages(&mut self, messages: Vec<Message>) {
        self.messages = messages;
    }

    /// The configuration.
    pub fn config(&self) -> &AgentConfig {
        &self.cfg
    }

    /// Changes the configuration between runs (model, effort).
    pub fn config_mut(&mut self) -> &mut AgentConfig {
        &mut self.cfg
    }

    /// The tools as declared to the model.
    pub fn tool_specs(&self) -> Vec<ToolSpec> {
        self.tools
            .iter()
            .map(|t| ToolSpec {
                name: t.name().to_owned(),
                description: t.description().to_owned(),
                input_schema: t.input_schema(),
            })
            .collect()
    }

    fn emit(&self, ev: AgentEvent) {
        (self.sink)(&ev);
    }

    /// Adds a user message and runs until the model is done.
    pub async fn prompt(&mut self, text: impl Into<String>) -> RunOutcome {
        self.messages.push(Message::user(text));
        self.run().await
    }

    /// Runs on the current conversation (whose last message should be the user's).
    pub async fn run(&mut self) -> RunOutcome {
        self.handle.shared.cancel.reset();
        self.emit(AgentEvent::AgentStart);
        let mut total = Usage::default();
        let mut turn = 0u32;
        let mut last_text = String::new();
        let (reason, error) = loop {
            if self.handle.shared.cancel.is_cancelled() {
                break (EndReason::Aborted, None);
            }
            if turn >= self.cfg.max_turns {
                break (EndReason::MaxTurns, None);
            }
            turn += 1;
            self.emit(AgentEvent::TurnStart { turn });
            let step = self.turn(turn, &mut total).await;
            match step {
                Step::End(reason, error) => break (reason, error),
                Step::Answered {
                    text,
                    calls,
                    stop,
                    usage,
                } => {
                    last_text.clone_from(&text);
                    let summary = TurnSummary {
                        turn,
                        stop,
                        text,
                        tool_calls: calls.clone(),
                        usage,
                    };
                    self.emit(AgentEvent::TurnEnd { turn, stop });
                    if self.hooks.iter().any(|h| h.finish_turn(&summary) == TurnControl::Stop) {
                        break (EndReason::Stopped, None);
                    }
                    if !calls.is_empty() {
                        let results = self.run_tools(calls).await;
                        let mut content = results;
                        for text in self.handle.take_steer() {
                            self.emit(AgentEvent::Steer { text: text.clone() });
                            content.push(Part::Text { text });
                        }
                        self.messages.push(Message {
                            role: Role::User,
                            content,
                        });
                        if self.handle.shared.cancel.is_cancelled() {
                            break (EndReason::Aborted, None);
                        }
                        continue;
                    }
                    let steer = self.handle.take_steer();
                    if !steer.is_empty() {
                        for text in steer {
                            self.emit(AgentEvent::Steer { text: text.clone() });
                            self.messages.push(Message::user(text));
                        }
                        continue;
                    }
                    if let Some(text) = self.handle.take_follow_up() {
                        self.emit(AgentEvent::FollowUp { text: text.clone() });
                        self.messages.push(Message::user(text));
                        continue;
                    }
                    break (EndReason::Done, None);
                }
            }
        };
        self.emit(AgentEvent::AgentEnd { reason, usage: total });
        RunOutcome {
            reason,
            usage: total,
            error,
            text: last_text,
        }
    }

    async fn turn(&mut self, turn: u32, total: &mut Usage) -> Step {
        let mut req = Request {
            model: self.cfg.model.clone(),
            system: self.cfg.system.clone(),
            messages: self.messages.clone(),
            tools: self.tool_specs(),
            effort: self.cfg.effort,
            max_output_tokens: self.cfg.max_output_tokens,
            ..Request::default()
        };
        for h in &self.hooks {
            h.prepare_request(&mut req);
        }
        let mut stream = match self.model.stream(&req) {
            Ok(s) => s,
            Err(e) => {
                let error = ChatError::new(aparte_llm::ErrorCode::InvalidRequest, e.to_string(), None);
                self.emit(AgentEvent::Error { error: error.clone() });
                return Step::End(EndReason::Error, Some(error));
            }
        };
        tracing::debug!(turn, messages = req.messages.len(), "model call");
        let mut parts: Vec<Part> = Vec::new();
        let mut text_at: Vec<(String, usize)> = Vec::new();
        let mut reasoning_at: Vec<(String, usize)> = Vec::new();
        let mut usage = Usage::default();
        let cancel = self.handle.shared.cancel.clone();
        let finish = loop {
            let next = tokio::select! {
                ev = stream.next() => ev,
                () = cancel.cancelled() => None,
            };
            let Some(ev) = next else {
                break None;
            };
            match ev {
                ChatEvent::TextDelta { id, text } => {
                    self.emit(AgentEvent::TextDelta { text: text.clone() });
                    match text_at.iter().find(|(i, _)| *i == id) {
                        Some((_, at)) => {
                            if let Some(Part::Text { text: t }) = parts.get_mut(*at) {
                                t.push_str(&text);
                            }
                        }
                        None => {
                            text_at.push((id, parts.len()));
                            parts.push(Part::Text { text });
                        }
                    }
                }
                ChatEvent::ReasoningDelta { id, text } => {
                    self.emit(AgentEvent::ReasoningDelta { text: text.clone() });
                    match reasoning_at.iter().find(|(i, _)| *i == id) {
                        Some((_, at)) => {
                            if let Some(Part::Reasoning { text: t, .. }) = parts.get_mut(*at) {
                                t.push_str(&text);
                            }
                        }
                        None => {
                            reasoning_at.push((id, parts.len()));
                            parts.push(Part::Reasoning {
                                text,
                                provider_meta: None,
                            });
                        }
                    }
                }
                ChatEvent::ReasoningEnd { id, provider_meta } => {
                    let at = reasoning_at.iter().position(|(i, _)| *i == id);
                    match at {
                        Some(k) => {
                            let (_, at) = reasoning_at.remove(k);
                            if let Some(Part::Reasoning { provider_meta: m, .. }) = parts.get_mut(at) {
                                *m = provider_meta;
                            }
                        }
                        // A block with no text (redacted thinking) still has to be replayed.
                        None if provider_meta.is_some() => parts.push(Part::Reasoning {
                            text: String::new(),
                            provider_meta,
                        }),
                        None => {}
                    }
                }
                ChatEvent::ToolCallStart { call_id, name } => {
                    self.emit(AgentEvent::ToolCallStart { call_id, name });
                }
                ChatEvent::ToolCallDelta { .. } => {}
                ChatEvent::ToolCall {
                    call_id,
                    name,
                    input,
                    provider_meta,
                } => parts.push(Part::ToolCall {
                    call_id,
                    name,
                    input,
                    provider_meta,
                }),
                ChatEvent::Usage { usage: u } => {
                    usage = u;
                    self.emit(AgentEvent::Usage { usage: u });
                }
                ChatEvent::Finish { stop, refusal, .. } => break Some(Ok((stop, refusal))),
                ChatEvent::Error { error } => break Some(Err(error)),
            }
        };
        add_usage(total, &usage);
        let text: String = parts
            .iter()
            .filter_map(|p| match p {
                Part::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        match finish {
            None => {
                // Aborted, or a model stream that ended without a finish: keep what was said.
                if !text.is_empty() {
                    self.messages.push(Message::assistant(text));
                }
                if cancel.is_cancelled() {
                    Step::End(EndReason::Aborted, None)
                } else {
                    let error = aparte_llm::errors::truncated();
                    self.emit(AgentEvent::Error { error: error.clone() });
                    Step::End(EndReason::Error, Some(error))
                }
            }
            Some(Err(error)) => {
                self.emit(AgentEvent::Error { error: error.clone() });
                Step::End(EndReason::Error, Some(error))
            }
            Some(Ok((StopReason::Refusal, refusal))) => {
                let (category, explanation) = refusal.map(|r| (r.category, r.explanation)).unwrap_or_default();
                self.emit(AgentEvent::Refusal { category, explanation });
                Step::End(EndReason::Refusal, None)
            }
            Some(Ok((stop, _))) => {
                let calls: Vec<ToolCall> = parts
                    .iter()
                    .filter_map(|p| match p {
                        Part::ToolCall {
                            call_id, name, input, ..
                        } => Some(ToolCall {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        }),
                        _ => None,
                    })
                    .collect();
                let message = Message {
                    role: Role::Assistant,
                    content: parts,
                };
                self.emit(AgentEvent::MessageEnd {
                    message: message.clone(),
                });
                self.messages.push(message);
                Step::Answered {
                    text,
                    calls,
                    stop,
                    usage,
                }
            }
        }
    }

    async fn prepare(&mut self, call: ToolCall) -> Prepared {
        let tool = self.tools.iter().find(|t| t.name() == call.name).cloned();
        let mut call = call;
        let refuse = |call: ToolCall, tool, msg: String| Prepared {
            call,
            tool,
            instead: Some(ToolOutput::error(msg)),
        };
        let Some(t) = tool else {
            let msg = format!("unknown tool {:?}", call.name);
            return refuse(call, None, msg);
        };
        if call.input.is_null() {
            return refuse(call, Some(t), "the tool input was not valid JSON".into());
        }
        for h in &self.hooks {
            match h.before_tool_call(&call) {
                BeforeTool::Continue => {}
                BeforeTool::Rewrite(input) => call.input = input,
                BeforeTool::Block(reason) => return refuse(call, Some(t), format!("blocked: {reason}")),
            }
        }
        let annotations = t.annotations();
        if needs_approval(annotations, self.cfg.trusted) && !self.always.contains(t.name()) {
            let decision = match self.cfg.approval {
                ApprovalMode::Auto => Approval::Allow,
                ApprovalMode::Deny => Approval::Deny {
                    reason: Some("this call needs approval and none can be given in this mode".into()),
                },
                ApprovalMode::Ask => {
                    let req = ApprovalRequest {
                        call_id: call.call_id.clone(),
                        tool: call.name.clone(),
                        input: call.input.clone(),
                        annotations,
                    };
                    self.approver.approve(&req).await
                }
            };
            match decision {
                Approval::Allow => {}
                Approval::AllowAlways => {
                    self.always.insert(t.name().to_owned());
                }
                Approval::Deny { reason } => {
                    let msg = match reason {
                        Some(r) => format!("the user denied this call: {r}"),
                        None => "the user denied this call".into(),
                    };
                    return refuse(call, Some(t), msg);
                }
            }
        }
        Prepared {
            call,
            tool: Some(t),
            instead: None,
        }
    }

    async fn execute(&self, p: Prepared) -> (ToolCall, ToolOutput) {
        let Prepared { call, tool, instead } = p;
        self.emit(AgentEvent::ToolStart {
            call_id: call.call_id.clone(),
            name: call.name.clone(),
            input: call.input.clone(),
        });
        let mut output = match (instead, tool) {
            (Some(o), _) => o,
            (None, None) => ToolOutput::error("unknown tool"),
            (None, Some(tool)) => {
                let ctx = ToolContext {
                    cwd: self.cfg.cwd.clone(),
                    call_id: call.call_id.clone(),
                    cancel: self.handle.shared.cancel.clone(),
                };
                let cancel = self.handle.shared.cancel.clone();
                let result = tokio::select! {
                    r = tool.execute(&ctx, call.input.clone()) => r,
                    () = cancel.cancelled() => Err(ToolError::Cancelled),
                };
                match result {
                    Ok(o) => o,
                    Err(e) => ToolOutput::error(e.to_string()),
                }
            }
        };
        for h in &self.hooks {
            h.after_tool_call(&call, &mut output);
        }
        output.content = cap(std::mem::take(&mut output.content));
        self.emit(AgentEvent::ToolEnd {
            call_id: call.call_id.clone(),
            name: call.name.clone(),
            output: output.clone(),
        });
        (call, output)
    }

    async fn run_tools(&mut self, calls: Vec<ToolCall>) -> Vec<Part> {
        let mut prepared = Vec::with_capacity(calls.len());
        for c in calls {
            prepared.push(self.prepare(c).await);
        }
        let parallel = prepared
            .iter()
            .all(|p| p.instead.is_some() || p.tool.as_ref().is_some_and(|t| t.annotations().read_only));
        let this = &*self;
        let done: Vec<(ToolCall, ToolOutput)> = if parallel {
            futures_util::future::join_all(prepared.into_iter().map(|p| this.execute(p))).await
        } else {
            let mut out = Vec::new();
            for p in prepared {
                out.push(this.execute(p).await);
            }
            out
        };
        done.into_iter()
            .map(|(call, output)| Part::ToolResult {
                call_id: call.call_id,
                name: call.name,
                content: output.content,
                is_error: output.is_error,
            })
            .collect()
    }
}

enum Step {
    End(EndReason, Option<ChatError>),
    Answered {
        text: String,
        calls: Vec<ToolCall>,
        stop: StopReason,
        usage: Usage,
    },
}
