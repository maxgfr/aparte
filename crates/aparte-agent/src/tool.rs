//! The [`Tool`] trait every tool implements, built-in or custom: a name, a description, a JSON Schema of its input
//! (usually derived with `schemars`), annotations that drive approvals, and an async `execute`.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;

/// A boxed future, so that `Tool` stays object-safe.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a tool may do, after the MCP tool annotations. They decide whether a call needs the user's approval.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotations {
    /// Changes nothing: reading files, listing, searching.
    pub read_only: bool,
    /// May overwrite or delete (a whole-file write, a shell command).
    pub destructive: bool,
    /// Calling it twice with the same input has the effect of calling it once.
    pub idempotent: bool,
    /// Reaches outside the machine (the network).
    pub open_world: bool,
}

impl Annotations {
    /// A tool that only reads local state.
    pub const READ_ONLY: Annotations = Annotations {
        read_only: true,
        destructive: false,
        idempotent: true,
        open_world: false,
    };
}

/// A cancellation signal shared by the agent and the tools it runs.
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl CancelToken {
    /// A token that is not cancelled.
    pub fn new() -> CancelToken {
        CancelToken::default()
    }

    /// Cancels: every waiter wakes up.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// Whether `cancel` was called (and not reset).
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Clears the flag, before a new run.
    pub fn reset(&self) {
        self.flag.store(false, Ordering::SeqCst);
    }

    /// Resolves when cancelled.
    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// What a tool receives besides its input.
#[derive(Debug, Clone)]
pub struct ToolContext {
    /// The project directory: relative paths resolve against it.
    pub cwd: PathBuf,
    /// The call being executed.
    pub call_id: String,
    /// Set when the user aborts; long tools should stop.
    pub cancel: CancelToken,
}

/// What a tool returns: `content` goes back to the model, `details` only to the interface and the session file.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolOutput {
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default)]
    pub is_error: bool,
}

impl ToolOutput {
    /// A successful result of text.
    pub fn text(content: impl Into<String>) -> ToolOutput {
        ToolOutput {
            content: content.into(),
            details: None,
            is_error: false,
        }
    }

    /// A result with details for the interface.
    pub fn with_details(mut self, details: Value) -> ToolOutput {
        self.details = Some(details);
        self
    }

    /// A failed result: the model reads the message and may try again.
    pub fn error(message: impl Into<String>) -> ToolOutput {
        ToolOutput {
            content: message.into(),
            details: None,
            is_error: true,
        }
    }
}

/// Why a tool did not run to completion. The agent turns it into an error result for the model.
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("{0}")]
    Failed(String),
    #[error("cancelled")]
    Cancelled,
}

/// A tool the model can call.
pub trait Tool: Send + Sync {
    /// A unique name, `[a-z0-9_]+`.
    fn name(&self) -> &str;
    /// What the tool does, for the model.
    fn description(&self) -> &str;
    /// JSON Schema of the input object.
    fn input_schema(&self) -> Value;
    /// What the tool may do.
    fn annotations(&self) -> Annotations;
    /// Runs one call.
    fn execute<'a>(&'a self, ctx: &'a ToolContext, input: Value) -> BoxFuture<'a, Result<ToolOutput, ToolError>>;
}

/// A tool with a typed input: the schema is derived from `Input` and the input is parsed before `run`. Wrap it
/// with [`typed`] to get a [`Tool`].
pub trait TypedTool: Send + Sync + 'static {
    /// The input, deserialized from the model's JSON.
    type Input: DeserializeOwned + schemars::JsonSchema + Send;
    /// A unique name, `[a-z0-9_]+`.
    fn name(&self) -> &str;
    /// What the tool does, for the model.
    fn description(&self) -> &str;
    /// What the tool may do.
    fn annotations(&self) -> Annotations;
    /// Runs one call.
    fn run<'a>(&'a self, ctx: &'a ToolContext, input: Self::Input) -> BoxFuture<'a, Result<ToolOutput, ToolError>>;
}

/// A [`TypedTool`] as a [`Tool`].
#[derive(Debug)]
pub struct Typed<T>(pub T);

impl<T: TypedTool> Tool for Typed<T> {
    fn name(&self) -> &str {
        self.0.name()
    }
    fn description(&self) -> &str {
        self.0.description()
    }
    fn input_schema(&self) -> Value {
        schema_for::<T::Input>()
    }
    fn annotations(&self) -> Annotations {
        self.0.annotations()
    }
    fn execute<'a>(&'a self, ctx: &'a ToolContext, input: Value) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        match parse_input::<T::Input>(input) {
            Ok(i) => self.0.run(ctx, i),
            Err(e) => Box::pin(async move { Err(e) }),
        }
    }
}

/// Wraps a typed tool for an agent.
pub fn typed<T: TypedTool>(tool: T) -> Arc<dyn Tool> {
    Arc::new(Typed(tool))
}

/// The JSON Schema of an input type, without the `$schema` and `title` keys some providers refuse.
pub fn schema_for<T: schemars::JsonSchema>() -> Value {
    let mut v = serde_json::to_value(schemars::schema_for!(T)).unwrap_or(Value::Null);
    if let Some(obj) = v.as_object_mut() {
        obj.remove("$schema");
        obj.remove("title");
    }
    v
}

/// Parses a tool input into its type.
pub fn parse_input<T: DeserializeOwned>(input: Value) -> Result<T, ToolError> {
    serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize, schemars::JsonSchema)]
    struct Input {
        /// A path.
        path: String,
        limit: Option<u32>,
    }

    #[test]
    fn schemas_are_plain_object_schemas() {
        let s = schema_for::<Input>();
        assert_eq!(s["type"], "object");
        assert!(s.get("$schema").is_none() && s.get("title").is_none());
        assert_eq!(s["required"], serde_json::json!(["path"]));
        let i: Input = parse_input(serde_json::json!({"path": "a", "limit": 3})).expect("parses");
        assert_eq!((i.path.as_str(), i.limit), ("a", Some(3)));
        assert!(parse_input::<Input>(serde_json::json!({"limit": 3})).is_err());
    }

    #[tokio::test]
    async fn a_cancel_wakes_a_waiter() {
        let t = CancelToken::new();
        let t2 = t.clone();
        let waiter = tokio::spawn(async move { t2.cancelled().await });
        tokio::task::yield_now().await;
        t.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
            .await
            .expect("woken")
            .expect("joined");
    }
}
