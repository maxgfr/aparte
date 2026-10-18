//! A custom agent built from the crates: a real provider, two of the built-in tools, a hook that keeps the agent
//! inside a budget of tool calls, and a system prompt of its own.
//!
//! `ANTHROPIC_API_KEY=... cargo run -p aparte --example custom_agent -- "Where is the agent loop defined?"`

use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use aparte_agent::{Agent, AgentConfig, AgentEvent, ApprovalMode, BeforeTool, Hooks, ToolCall};
use aparte_llm::providers::preset;
use aparte_llm::{ApiKey, Client, Effort, ProviderConfig};
use aparte_tools::{BlobStore, ToolsConfig};

/// Blocks tool calls past a budget, so a question cannot turn into a long exploration.
struct Budget {
    used: AtomicU32,
    max: u32,
}

impl Hooks for Budget {
    fn before_tool_call(&self, call: &ToolCall) -> BeforeTool {
        let n = self.used.fetch_add(1, Ordering::SeqCst) + 1;
        eprintln!("tool call {n}: {} {}", call.name, call.input);
        if n > self.max {
            BeforeTool::Block(format!("the budget of {} tool calls is spent; answer now", self.max))
        } else {
            BeforeTool::Continue
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let question = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "What does this project do?".into());
    let Some(key) = std::env::var("ANTHROPIC_API_KEY").ok().and_then(ApiKey::new) else {
        eprintln!("set ANTHROPIC_API_KEY to run this example");
        return Ok(());
    };
    let anthropic = preset("anthropic").ok_or("no anthropic preset")?;
    let client = Client::new(ProviderConfig::from_preset(anthropic, Some(key)))?;

    let blobs = Arc::new(BlobStore::new()?);
    let tools = aparte_tools::builtin(
        &ToolsConfig {
            only: Some(vec!["grep".into(), "read".into()]),
            ..ToolsConfig::default()
        },
        blobs,
    )?;

    let mut cfg = AgentConfig::new("claude-opus-5-5", std::env::current_dir()?);
    cfg.system = "You answer questions about the code in the working directory. Search with grep, read what \
                  you find, then answer in a few sentences with file paths."
        .into();
    cfg.effort = Some(Effort::Medium);
    cfg.max_turns = 12;
    // Both tools are read-only: nothing here ever needs approval.
    cfg.approval = ApprovalMode::Deny;

    let mut agent = Agent::new(Arc::new(client), cfg)
        .with_tools(tools)
        .with_hooks(Arc::new(Budget {
            used: AtomicU32::new(0),
            max: 8,
        }))
        .on_event(Arc::new(|ev: &AgentEvent| {
            if let AgentEvent::TextDelta { text } = ev {
                print!("{text}");
                let _ = std::io::stdout().flush();
            }
        }));
    let out = agent.prompt(question).await;
    println!();
    eprintln!("ended: {:?}, usage {:?}", out.reason, out.usage);
    Ok(())
}
