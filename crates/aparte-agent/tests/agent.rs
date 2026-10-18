//! The loop against a scripted model: tool calls and results, approvals, hooks, steering and follow-up, refusals,
//! parallel execution and abort.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aparte_agent::scripted::ScriptedModel;
use aparte_agent::{
    Agent, AgentConfig, AgentEvent, AgentHandle, Annotations, Approval, ApprovalMode, ApprovalRequest, Approver,
    BeforeTool, BoxFuture, EndReason, Hooks, Tool, ToolCall, ToolContext, ToolError, ToolOutput, TurnControl,
    TurnSummary,
};
use aparte_llm::{ChatEvent, Part, Refusal, Request, Role, StopReason};
use serde_json::{Value, json};

/// A tool that echoes its input, with chosen annotations, and an optional action while it runs.
struct Echo {
    name: &'static str,
    annotations: Annotations,
    barrier: Option<Arc<tokio::sync::Barrier>>,
    during: Option<Box<dyn Fn() + Send + Sync>>,
    calls: AtomicUsize,
}

impl Echo {
    fn new(name: &'static str, annotations: Annotations) -> Echo {
        Echo {
            name,
            annotations,
            barrier: None,
            during: None,
            calls: AtomicUsize::new(0),
        }
    }
}

impl Tool for Echo {
    fn name(&self) -> &str {
        self.name
    }
    fn description(&self) -> &str {
        "Echoes its input."
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }
    fn annotations(&self) -> Annotations {
        self.annotations
    }
    fn execute<'a>(&'a self, _ctx: &'a ToolContext, input: Value) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(b) = &self.barrier {
                b.wait().await;
            }
            if let Some(f) = &self.during {
                f();
            }
            Ok(ToolOutput::text(format!("{}:{input}", self.name)))
        })
    }
}

const WRITE: Annotations = Annotations {
    read_only: false,
    destructive: true,
    idempotent: false,
    open_world: false,
};

fn agent(model: Arc<ScriptedModel>) -> (Agent, Arc<Mutex<Vec<AgentEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let a = Agent::new(model, AgentConfig::new("claude-opus-5-5", "/tmp")).on_event(Arc::new(move |e| {
        sink.lock().expect("events").push(e.clone());
    }));
    (a, events)
}

fn results(req: &Request) -> Vec<(String, String, bool)> {
    req.messages
        .last()
        .map(|m| {
            m.content
                .iter()
                .filter_map(|p| match p {
                    Part::ToolResult {
                        call_id,
                        content,
                        is_error,
                        ..
                    } => Some((call_id.clone(), content.clone(), *is_error)),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn a_plain_answer_ends_the_run() {
    let model = Arc::new(ScriptedModel::new(vec![ScriptedModel::text("hello")]));
    let (mut a, events) = agent(model.clone());
    let out = a.prompt("hi").await;
    assert_eq!(out.reason, EndReason::Done);
    assert_eq!(out.text, "hello");
    assert_eq!(out.usage.input, Some(10));
    assert_eq!(a.messages().len(), 2);
    let ev = events.lock().expect("events");
    assert!(matches!(ev.first(), Some(AgentEvent::AgentStart)));
    assert!(matches!(
        ev.last(),
        Some(AgentEvent::AgentEnd {
            reason: EndReason::Done,
            ..
        })
    ));
}

#[tokio::test]
async fn tool_results_go_back_to_the_model() {
    let model = Arc::new(ScriptedModel::new(vec![
        ScriptedModel::tool_calls(&[("c1", "echo", json!({"x": 1})), ("c2", "missing", json!({}))]),
        ScriptedModel::text("done"),
    ]));
    let (a, _) = agent(model.clone());
    let mut a = a.with_tool(Arc::new(Echo::new("echo", Annotations::READ_ONLY)));
    let out = a.prompt("go").await;
    assert_eq!(out.reason, EndReason::Done);
    let reqs = model.requests();
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0].tools.len(), 1);
    let r = results(&reqs[1]);
    assert_eq!(r[0], ("c1".into(), r#"echo:{"x":1}"#.into(), false));
    assert_eq!(r[1].0, "c2");
    assert!(r[1].2 && r[1].1.contains("unknown tool"));
}

struct Recorder {
    answer: Approval,
    asked: Mutex<Vec<ApprovalRequest>>,
}

impl Approver for Recorder {
    fn approve<'a>(&'a self, req: &'a ApprovalRequest) -> BoxFuture<'a, Approval> {
        self.asked.lock().expect("asked").push(req.clone());
        let a = self.answer.clone();
        Box::pin(async move { a })
    }
}

#[tokio::test]
async fn destructive_calls_are_denied_without_anyone_to_ask() {
    let model = Arc::new(ScriptedModel::new(vec![
        ScriptedModel::tool_calls(&[("c1", "write", json!({}))]),
        ScriptedModel::text("ok"),
    ]));
    let (mut a, _) = agent(model.clone());
    a.config_mut().approval = ApprovalMode::Deny;
    let tool = Arc::new(Echo::new("write", WRITE));
    let mut a = a.with_tool(tool.clone());
    a.prompt("go").await;
    assert_eq!(tool.calls.load(Ordering::SeqCst), 0);
    let r = results(&model.requests()[1]);
    assert!(r[0].2 && r[0].1.contains("denied"), "{r:?}");
}

#[tokio::test]
async fn allow_always_asks_once_per_tool() {
    let model = Arc::new(ScriptedModel::new(vec![
        ScriptedModel::tool_calls(&[("c1", "write", json!({})), ("c2", "write", json!({}))]),
        ScriptedModel::text("ok"),
    ]));
    let approver = Arc::new(Recorder {
        answer: Approval::AllowAlways,
        asked: Mutex::new(Vec::new()),
    });
    let (a, _) = agent(model);
    let tool = Arc::new(Echo::new("write", WRITE));
    let mut a = a.with_tool(tool.clone()).with_approver(approver.clone());
    a.prompt("go").await;
    assert_eq!(approver.asked.lock().expect("asked").len(), 1);
    assert_eq!(tool.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn local_reads_never_ask() {
    let model = Arc::new(ScriptedModel::new(vec![
        ScriptedModel::tool_calls(&[("c1", "read", json!({}))]),
        ScriptedModel::text("ok"),
    ]));
    let approver = Arc::new(Recorder {
        answer: Approval::Deny { reason: None },
        asked: Mutex::new(Vec::new()),
    });
    let (a, _) = agent(model);
    let tool = Arc::new(Echo::new("read", Annotations::READ_ONLY));
    let mut a = a.with_tool(tool.clone()).with_approver(approver.clone());
    a.prompt("go").await;
    assert!(approver.asked.lock().expect("asked").is_empty());
    assert_eq!(tool.calls.load(Ordering::SeqCst), 1);
}

#[derive(Default)]
struct TestHooks {
    finished: Mutex<Vec<TurnSummary>>,
}

impl Hooks for TestHooks {
    fn prepare_request(&self, req: &mut Request) {
        req.system = "prepared".into();
    }
    fn before_tool_call(&self, call: &ToolCall) -> BeforeTool {
        match call.call_id.as_str() {
            "blocked" => BeforeTool::Block("not today".into()),
            "rewritten" => BeforeTool::Rewrite(json!({"new": true})),
            _ => BeforeTool::Continue,
        }
    }
    fn after_tool_call(&self, _call: &ToolCall, output: &mut ToolOutput) {
        output.content.push_str(" [seen]");
    }
    fn finish_turn(&self, turn: &TurnSummary) -> TurnControl {
        self.finished.lock().expect("finished").push(turn.clone());
        TurnControl::Continue
    }
}

#[tokio::test]
async fn hooks_see_and_change_requests_and_tool_calls() {
    let model = Arc::new(ScriptedModel::new(vec![
        ScriptedModel::tool_calls(&[("blocked", "echo", json!({})), ("rewritten", "echo", json!({"old": 1}))]),
        ScriptedModel::text("ok"),
    ]));
    let hooks = Arc::new(TestHooks::default());
    let (a, _) = agent(model.clone());
    let mut a = a
        .with_tool(Arc::new(Echo::new("echo", Annotations::READ_ONLY)))
        .with_hooks(hooks.clone());
    a.prompt("go").await;
    let reqs = model.requests();
    assert!(reqs.iter().all(|r| r.system == "prepared"));
    let r = results(&reqs[1]);
    assert!(r[0].2 && r[0].1.contains("not today"));
    assert_eq!(r[1].1, r#"echo:{"new":true} [seen]"#);
    let finished = hooks.finished.lock().expect("finished");
    assert_eq!(finished.len(), 2);
    assert_eq!(finished[0].tool_calls.len(), 2);
    assert_eq!(finished[1].stop, StopReason::End);
}

struct StopAtOnce;
impl Hooks for StopAtOnce {
    fn finish_turn(&self, _turn: &TurnSummary) -> TurnControl {
        TurnControl::Stop
    }
}

#[tokio::test]
async fn finish_turn_can_stop_the_run() {
    let model = Arc::new(ScriptedModel::new(vec![ScriptedModel::tool_calls(&[(
        "c1",
        "echo",
        json!({}),
    )])]));
    let (a, _) = agent(model.clone());
    let tool = Arc::new(Echo::new("echo", Annotations::READ_ONLY));
    let mut a = a.with_tool(tool.clone()).with_hooks(Arc::new(StopAtOnce));
    assert_eq!(a.prompt("go").await.reason, EndReason::Stopped);
    assert_eq!(tool.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn steering_arrives_after_the_tool_batch_and_follow_up_at_the_end() {
    let model = Arc::new(ScriptedModel::new(vec![
        ScriptedModel::tool_calls(&[("c1", "echo", json!({}))]),
        ScriptedModel::text("first"),
        ScriptedModel::text("second"),
    ]));
    let (a, events) = agent(model.clone());
    let handle: AgentHandle = a.handle();
    let steer = handle.clone();
    let mut tool = Echo::new("echo", Annotations::READ_ONLY);
    tool.during = Some(Box::new(move || steer.steer("change of plan")));
    let mut a = a.with_tool(Arc::new(tool));
    handle.follow_up("and then this");
    let out = a.prompt("go").await;
    assert_eq!(out.reason, EndReason::Done);
    assert_eq!(out.text, "second");
    let reqs = model.requests();
    assert_eq!(reqs.len(), 3);
    let last = reqs[1].messages.last().expect("message");
    assert_eq!(last.role, Role::User);
    assert!(matches!(&last.content[0], Part::ToolResult { .. }));
    assert_eq!(
        last.content[1],
        Part::Text {
            text: "change of plan".into()
        }
    );
    assert_eq!(
        reqs[2].messages.last().map(aparte_llm::Message::text),
        Some("and then this".into())
    );
    let ev = events.lock().expect("events");
    assert!(ev.iter().any(|e| matches!(e, AgentEvent::Steer { .. })));
    assert!(ev.iter().any(|e| matches!(e, AgentEvent::FollowUp { .. })));
}

#[tokio::test]
async fn a_refusal_discards_the_partial_answer() {
    let refusal = vec![
        ChatEvent::TextDelta {
            id: "0".into(),
            text: "Here is how".into(),
        },
        ChatEvent::Finish {
            stop: StopReason::Refusal,
            raw: Some("refusal".into()),
            refusal: Some(Refusal {
                category: Some("cyber".into()),
                explanation: None,
            }),
            served_by: None,
        },
    ];
    let model = Arc::new(ScriptedModel::new(vec![refusal]));
    let (mut a, events) = agent(model);
    let out = a.prompt("bad").await;
    assert_eq!(out.reason, EndReason::Refusal);
    assert_eq!(a.messages().len(), 1, "only the user's message is kept");
    let ev = events.lock().expect("events");
    assert!(
        ev.iter()
            .any(|e| matches!(e, AgentEvent::Refusal { category: Some(c), .. } if c == "cyber"))
    );
}

#[tokio::test]
async fn read_only_calls_run_in_parallel() {
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let mut a1 = Echo::new("a", Annotations::READ_ONLY);
    a1.barrier = Some(barrier.clone());
    let mut b1 = Echo::new("b", Annotations::READ_ONLY);
    b1.barrier = Some(barrier);
    let model = Arc::new(ScriptedModel::new(vec![
        ScriptedModel::tool_calls(&[("c1", "a", json!({})), ("c2", "b", json!({}))]),
        ScriptedModel::text("ok"),
    ]));
    let (a, _) = agent(model);
    let mut a = a.with_tool(Arc::new(a1)).with_tool(Arc::new(b1));
    // Sequential execution would wait at the barrier forever.
    let out = tokio::time::timeout(Duration::from_secs(10), a.prompt("go"))
        .await
        .expect("parallel");
    assert_eq!(out.reason, EndReason::Done);
}

#[tokio::test]
async fn abort_cancels_a_running_tool() {
    struct Slow;
    impl Tool for Slow {
        fn name(&self) -> &str {
            "slow"
        }
        fn description(&self) -> &str {
            "Sleeps."
        }
        fn input_schema(&self) -> Value {
            json!({"type": "object"})
        }
        fn annotations(&self) -> Annotations {
            Annotations::READ_ONLY
        }
        fn execute<'a>(&'a self, _ctx: &'a ToolContext, _input: Value) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(600)).await;
                Ok(ToolOutput::text("late"))
            })
        }
    }
    let model = Arc::new(ScriptedModel::new(vec![ScriptedModel::tool_calls(&[(
        "c1",
        "slow",
        json!({}),
    )])]));
    let (a, _) = agent(model);
    let mut a = a.with_tool(Arc::new(Slow));
    let handle = a.handle();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        handle.abort();
    });
    let out = tokio::time::timeout(Duration::from_secs(10), a.prompt("go"))
        .await
        .expect("aborted in time");
    assert_eq!(out.reason, EndReason::Aborted);
    match a.messages().last().map(|m| &m.content[0]) {
        Some(Part::ToolResult { is_error, content, .. }) => assert!(*is_error && content.contains("cancelled")),
        other => panic!("expected a cancelled result, got {other:?}"),
    }
}

#[tokio::test]
async fn max_turns_bounds_a_run() {
    let model = Arc::new(ScriptedModel::new(vec![
        ScriptedModel::tool_calls(&[("c1", "echo", json!({}))]),
        ScriptedModel::tool_calls(&[("c2", "echo", json!({}))]),
    ]));
    let (mut a, _) = agent(model);
    a.config_mut().max_turns = 1;
    let mut a = a.with_tool(Arc::new(Echo::new("echo", Annotations::READ_ONLY)));
    assert_eq!(a.prompt("go").await.reason, EndReason::MaxTurns);
}
