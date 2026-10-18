//! A model that plays back scripted answers, for tests and offline examples. Each call takes the next answer and
//! records the request it was given.

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};

use aparte_llm::{ChatEvent, ChatModel, EventStream, LlmError, Request, StopReason, Usage};
use serde_json::Value;

/// Plays back one list of events per call.
#[derive(Debug, Default)]
pub struct ScriptedModel {
    answers: Mutex<VecDeque<Vec<ChatEvent>>>,
    requests: Mutex<Vec<Request>>,
}

impl ScriptedModel {
    /// A model that gives these answers, in order; a call after the last one gets a `truncated` error.
    pub fn new(answers: Vec<Vec<ChatEvent>>) -> ScriptedModel {
        ScriptedModel {
            answers: Mutex::new(answers.into()),
            requests: Mutex::new(Vec::new()),
        }
    }

    /// The requests received so far.
    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// An answer of text that ends the turn.
    pub fn text(text: &str) -> Vec<ChatEvent> {
        vec![
            ChatEvent::TextDelta {
                id: "0".into(),
                text: text.into(),
            },
            ChatEvent::Usage {
                usage: Usage {
                    input: Some(10),
                    output: Some(5),
                    ..Usage::default()
                },
            },
            finish(StopReason::End),
        ]
    }

    /// An answer that calls tools: `(call id, tool name, input)`.
    pub fn tool_calls(calls: &[(&str, &str, Value)]) -> Vec<ChatEvent> {
        let mut out: Vec<ChatEvent> = calls
            .iter()
            .map(|(id, name, input)| ChatEvent::ToolCall {
                call_id: (*id).into(),
                name: (*name).into(),
                input: input.clone(),
                provider_meta: None,
            })
            .collect();
        out.push(finish(StopReason::ToolCalls));
        out
    }
}

fn finish(stop: StopReason) -> ChatEvent {
    ChatEvent::Finish {
        stop,
        raw: None,
        refusal: None,
        served_by: None,
    }
}

impl ChatModel for ScriptedModel {
    fn stream(&self, req: &Request) -> Result<EventStream, LlmError> {
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(req.clone());
        let events = self
            .answers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()
            .unwrap_or_else(|| {
                vec![ChatEvent::Error {
                    error: aparte_llm::errors::truncated(),
                }]
            });
        Ok(Box::pin(futures_util::stream::iter(events)))
    }
}
