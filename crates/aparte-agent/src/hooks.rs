//! Extension points of the loop. Every method has a default that changes nothing, so a hook implements only what
//! it needs; several hooks run in the order they were added.

use aparte_llm::{Request, StopReason, Usage};
use serde_json::Value;

use crate::tool::ToolOutput;

/// A tool call as the hooks see it.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub input: Value,
}

/// What `before_tool_call` decides.
#[derive(Debug, Clone, PartialEq)]
pub enum BeforeTool {
    /// Run the call as is (approvals still apply).
    Continue,
    /// Run it with another input.
    Rewrite(Value),
    /// Do not run it; the model gets this reason as an error result.
    Block(String),
}

/// What a turn amounted to, for `finish_turn`.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnSummary {
    /// 1 for the first model call of a run.
    pub turn: u32,
    pub stop: StopReason,
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Usage,
}

/// What `finish_turn` decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnControl {
    /// Go on: run the tool calls, or end the run if there are none.
    Continue,
    /// End the run now, even if the model asked for tools.
    Stop,
}

/// Hooks around model calls and tool calls.
pub trait Hooks: Send + Sync {
    /// Changes a request before it is sent (system prompt, tools, effort).
    fn prepare_request(&self, _req: &mut Request) {}

    /// Inspects a tool call before approval and execution.
    fn before_tool_call(&self, _call: &ToolCall) -> BeforeTool {
        BeforeTool::Continue
    }

    /// Changes a tool result before the model sees it.
    fn after_tool_call(&self, _call: &ToolCall, _output: &mut ToolOutput) {}

    /// Runs after each model answer.
    fn finish_turn(&self, _turn: &TurnSummary) -> TurnControl {
        TurnControl::Continue
    }
}
