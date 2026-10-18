//! A custom tool plugged into the agent, run offline against a scripted model.
//!
//! `cargo run -p aparte --example custom_tool`
//!
//! The tool derives its input schema with `schemars`, says through its annotations that it only reads (so it never
//! needs approval), and returns `content` for the model and `details` for the interface.

use std::sync::Arc;

use aparte_agent::scripted::ScriptedModel;
use aparte_agent::{
    Agent, AgentConfig, AgentEvent, Annotations, BoxFuture, ToolContext, ToolError, ToolOutput, TypedTool, typed,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

/// Input of `word_count`.
#[derive(Debug, Deserialize, JsonSchema)]
struct WordCountInput {
    /// The text to count the words of.
    text: String,
}

/// Counts words.
struct WordCount;

impl TypedTool for WordCount {
    type Input = WordCountInput;

    fn name(&self) -> &str {
        "word_count"
    }

    fn description(&self) -> &str {
        "Counts the words of a text."
    }

    fn annotations(&self) -> Annotations {
        Annotations::READ_ONLY
    }

    fn run<'a>(&'a self, _ctx: &'a ToolContext, input: WordCountInput) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            let n = input.text.split_whitespace().count();
            Ok(ToolOutput::text(format!("{n} words")).with_details(json!({ "words": n })))
        })
    }
}

#[tokio::main]
async fn main() {
    // A model that first calls the tool, then answers with what it read.
    let model = Arc::new(ScriptedModel::new(vec![
        ScriptedModel::tool_calls(&[("call_1", "word_count", json!({"text": "the quick brown fox"}))]),
        ScriptedModel::text("The text has 4 words."),
    ]));
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut agent = Agent::new(model.clone(), AgentConfig::new("scripted", cwd))
        .with_tool(typed(WordCount))
        .on_event(Arc::new(|ev: &AgentEvent| match ev {
            AgentEvent::ToolEnd { name, output, .. } => println!("[{name}] {}", output.content),
            AgentEvent::TextDelta { text } => println!("{text}"),
            _ => {}
        }));
    let out = agent.prompt("How many words in 'the quick brown fox'?").await;
    println!("ended: {:?}, {} model calls", out.reason, model.requests().len());
}
