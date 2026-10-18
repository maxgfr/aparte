//! `aparte selftest`: offline checks of this build. It reads no key, opens no file and makes no network request,
//! so it can run anywhere a binary is installed (the release workflow runs it on every target).

use std::process::ExitCode;

use crate::{Ctx, exit};

/// Arguments of `aparte selftest`.
#[derive(Debug, clap::Args)]
pub struct Args {}

/// One offline check: a name, whether it passed, and what was seen.
struct Check {
    name: &'static str,
    ok: bool,
    detail: String,
}

fn checks() -> Vec<Check> {
    let format = aparte_format::FORMAT;
    let json = serde_json::json!({ "format": format });
    let round_trip = serde_json::from_str::<serde_json::Value>(&json.to_string()).ok();
    vec![
        Check {
            name: "format",
            ok: format == "aparte/1",
            detail: format!("reads and writes {format}"),
        },
        Check {
            name: "crypto",
            ok: aparte_crypto::FORMAT == format,
            detail: format!("primitives of {}", aparte_crypto::FORMAT),
        },
        llm_check(),
        Check {
            name: "json",
            ok: round_trip.as_ref() == Some(&json),
            detail: "encodes and decodes events".into(),
        },
    ]
}

/// A recorded Anthropic stream of `spec/sse`, built into the binary.
const SAMPLE: &[u8] = include_bytes!("../../../../spec/sse/anthropic-text.sse");

/// Decodes the built-in stream: the SSE parser and the Anthropic decoder work in this build.
fn llm_check() -> Check {
    use aparte_llm::{ChatEvent, Protocol, StopReason};
    let events = aparte_llm::decode::decode_body(Protocol::Anthropic, SAMPLE, &[7]);
    let text: String = events
        .iter()
        .filter_map(|e| match e {
            ChatEvent::TextDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let finished = events.iter().any(|e| {
        matches!(
            e,
            ChatEvent::Finish {
                stop: StopReason::End,
                ..
            }
        )
    });
    Check {
        name: "llm",
        ok: finished && text == "The capital of France is **Paris**.",
        detail: "decodes a recorded Anthropic stream".into(),
    }
}

/// Runs every check and exits 0 only when all of them pass.
pub fn run(_args: Args, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let results = checks();
    for c in &results {
        ctx.ui.check(c.name, c.ok, &c.detail);
    }
    let ok = results.iter().all(|c| c.ok);
    ctx.ui.emit("selftest", serde_json::json!({ "ok": ok }));
    if ok {
        ctx.ui.say("selftest: all checks passed");
        Ok(ExitCode::from(exit::OK))
    } else {
        ctx.ui.say("selftest: some checks failed");
        Ok(ExitCode::from(exit::ERROR))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_check_passes_in_a_correct_build() {
        for c in super::checks() {
            assert!(c.ok, "{} failed: {}", c.name, c.detail);
        }
    }
}
