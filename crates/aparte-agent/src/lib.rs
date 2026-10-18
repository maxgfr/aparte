//! `aparte-agent`: the agent loop of the `aparte` CLI, as a library.
//!
//! - [`tool`]: the [`Tool`] trait (schemas from `schemars`, `content` for the model and `details` for the
//!   interface, annotations) and its context.
//! - [`agent`]: the loop, its events, and the steering and follow-up queues of [`AgentHandle`].
//! - [`hooks`]: `prepare_request`, `before_tool_call`, `after_tool_call` and `finish_turn`.
//! - [`approval`]: approvals decided by the tools' annotations and the project's trust ([`trust`]).
//! - [`session`]: JSONL session export and import.
//! - [`context`]: the system prompt and the project's `AGENTS.md`.
//! - [`scripted`]: a scripted model for tests and offline examples.

pub mod agent;
pub mod approval;
pub mod context;
pub mod fsx;
pub mod hooks;
pub mod scripted;
pub mod session;
pub mod tool;
pub mod trust;

pub use agent::{Agent, AgentConfig, AgentEvent, AgentHandle, EndReason, EventSink, RunOutcome};
pub use approval::{Approval, ApprovalMode, ApprovalRequest, Approver, DenyAll};
pub use hooks::{BeforeTool, Hooks, ToolCall, TurnControl, TurnSummary};
pub use tool::{
    Annotations, BoxFuture, CancelToken, Tool, ToolContext, ToolError, ToolOutput, Typed, TypedTool, parse_input,
    schema_for, typed,
};
