//! What a model's API accepts, from the makers' documentation (the same tables as `web/src/core/ai/effort.ts` and
//! `capabilities.ts`). A model nobody documented takes no effort, no sampling and no prefill: guessing risks a
//! request the API refuses, and a request is refused here before any network call rather than silently rewritten.

use std::sync::LazyLock;

use regex::Regex;

use crate::types::Effort;

/// A model id as the tables match it: lower case, `.` folded to `-`, any `:variant` and date suffix dropped.
pub fn model_key(model: &str) -> String {
    static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-\d{8}$|-\d{4}-\d{2}-\d{2}$").expect("regex"));
    let lower = model.to_lowercase();
    let base = lower.split(':').next().unwrap_or_default().replace('.', "-");
    DATE.replace(&base, "").into_owned()
}

const LMH: &[Effort] = &[Effort::Low, Effort::Medium, Effort::High];
const LMHX: &[Effort] = &[Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh];
const LMHXM: &[Effort] = &[Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh, Effort::Max];
const N_LMHX: &[Effort] = &[Effort::None, Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh];
const N_LMH: &[Effort] = &[Effort::None, Effort::Low, Effort::Medium, Effort::High];
const M_LMH: &[Effort] = &[Effort::Minimal, Effort::Low, Effort::Medium, Effort::High];

type Table = Vec<(Regex, &'static [Effort])>;

fn table(rows: &[(&str, &'static [Effort])]) -> Table {
    rows.iter()
        .map(|(re, levels)| (Regex::new(re).expect("effort table regex"), *levels))
        .collect()
}

static ANTHROPIC: LazyLock<Table> = LazyLock::new(|| {
    table(&[
        (
            r"^claude-(fable|mythos)-5(-1)?$|^claude-mythos-preview$|^claude-(opus|sonnet)-5(-5)?$|^claude-haiku-5-5$",
            LMHXM,
        ),
        (r"^claude-opus-4-[78]$", LMHXM),
        (
            r"^claude-(opus|sonnet)-4-6$",
            &[Effort::Low, Effort::Medium, Effort::High, Effort::Max],
        ),
        (
            r"^claude-(opus|sonnet|haiku)-4-5$|^claude-opus-4-1$|^claude-(opus|sonnet)-4$",
            LMH,
        ),
    ])
});

static OPENAI: LazyLock<Table> = LazyLock::new(|| {
    table(&[
        (r"^gpt-6-(sol|luna)$|^gpt-5-6(-(sol|luna|terra))?$", N_LMHX),
        (r"^gpt-6(-\d+)?-(sol|luna|astra)$", LMHX),
        (r"^gpt-5-[2-5]-pro$", &[Effort::Medium, Effort::High, Effort::Xhigh]),
        (r"^gpt-5-[2-5](-mini|-nano)?$", N_LMHX),
        (r"^gpt-5-[2-9]-codex$|^gpt-5-1-codex-max$", LMHX),
        (r"^gpt-5(-1)?-codex(-mini)?$", LMH),
        (r"^gpt-5-1$", N_LMH),
        (r"^gpt-5(-mini|-nano)?$", M_LMH),
        (r"^(o1|o3|o3-mini|o3-pro|o4-mini)$", LMH),
    ])
});

static GOOGLE: LazyLock<Table> = LazyLock::new(|| {
    table(&[
        (r"^gemini-4-argon$", LMH),
        (r"^gemini-3-pro(-preview)?$", &[Effort::Low, Effort::High]),
        (r"^gemini-3-1-pro(-preview)?(-customtools)?$", LMH),
        (r"^gemini-3-[7-9]-flash(-preview)?$", LMH),
        (r"^gemini-3(-[1-6])?-flash(-lite)?(-preview)?$", M_LMH),
        (r"^gemini-2-5-(pro|flash|flash-lite)$", LMH),
    ])
});

fn lookup(table: &Table, model: &str) -> &'static [Effort] {
    let key = model_key(model);
    table
        .iter()
        .find(|(re, _)| re.is_match(&key))
        .map_or(&[], |(_, levels)| *levels)
}

/// Whose effort table applies to a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Maker {
    Anthropic,
    OpenAi,
    Google,
    /// Any other server: it may refuse a parameter it does not know, so no effort is sent.
    Other,
}

/// The effort levels a model takes, weakest first; empty when it takes none.
pub fn effort_levels(maker: Maker, model: &str) -> &'static [Effort] {
    match maker {
        Maker::Anthropic => lookup(&ANTHROPIC, model),
        Maker::OpenAi => lookup(&OPENAI, model),
        Maker::Google => lookup(&GOOGLE, model),
        Maker::Other => &[],
    }
}

/// How an Anthropic model takes its parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnthropicCaps {
    /// `temperature`, `top_p` and `top_k` are accepted (removed from Claude 4.7 and the 5 generation).
    pub sampling: bool,
    /// An assistant message may come last (removed from Claude 4.6 on).
    pub prefill: bool,
    /// Effort is a thinking budget (`thinking.budget_tokens`) rather than `output_config.effort`.
    pub budgeted: bool,
    /// Default and largest `max_tokens`.
    pub max_output: u32,
}

/// The rules of an Anthropic model. Unknown models get the strictest current rules.
pub fn anthropic_caps(model: &str) -> AnthropicCaps {
    static OLD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^claude-(opus|sonnet|haiku)-4-5$|^claude-opus-4-1$|^claude-(opus|sonnet)-4$|^claude-3")
            .expect("regex")
    });
    static FOUR_SIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^claude-(opus|sonnet)-4-6$").expect("regex"));
    let key = model_key(model);
    if OLD.is_match(&key) {
        AnthropicCaps {
            sampling: true,
            prefill: true,
            budgeted: true,
            max_output: 64_000,
        }
    } else if FOUR_SIX.is_match(&key) {
        AnthropicCaps {
            sampling: true,
            prefill: false,
            budgeted: false,
            max_output: 128_000,
        }
    } else {
        AnthropicCaps {
            sampling: false,
            prefill: false,
            budgeted: false,
            max_output: 128_000,
        }
    }
}

/// Thinking budget of the Anthropic models that take one.
pub fn anthropic_budget(effort: Effort) -> Option<u32> {
    match effort {
        Effort::Low => Some(2048),
        Effort::Medium => Some(8192),
        Effort::High => Some(24_576),
        _ => None,
    }
}

/// Gemini 2.5 thinking budgets.
pub fn gemini_budget(effort: Effort) -> Option<u32> {
    match effort {
        Effort::Low => Some(1024),
        Effort::Medium => Some(8192),
        Effort::High => Some(24_576),
        _ => None,
    }
}

/// Whether a Gemini model takes a thinking budget rather than a level.
pub fn gemini_budgeted(model: &str) -> bool {
    model_key(model).starts_with("gemini-2-5-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_drop_variants_dots_and_dates() {
        assert_eq!(model_key("claude-sonnet-4-6-20260115"), "claude-sonnet-4-6");
        assert_eq!(model_key("gemini-2.5-flash"), "gemini-2-5-flash");
        assert_eq!(model_key("GPT-5.1:nitro"), "gpt-5-1");
    }

    #[test]
    fn claude_5_takes_every_level_up_to_max() {
        assert_eq!(effort_levels(Maker::Anthropic, "claude-opus-5-5"), LMHXM);
        assert!(effort_levels(Maker::Anthropic, "claude-sonnet-4-6").contains(&Effort::Max));
        assert!(!effort_levels(Maker::Anthropic, "claude-sonnet-4-6").contains(&Effort::Xhigh));
        assert!(effort_levels(Maker::Anthropic, "claude-unknown-9").is_empty());
        assert!(effort_levels(Maker::Other, "claude-opus-5-5").is_empty());
    }

    #[test]
    fn claude_5_takes_no_sampling_and_no_prefill() {
        let c = anthropic_caps("claude-opus-5-5");
        assert!(!c.sampling && !c.prefill && !c.budgeted);
        let old = anthropic_caps("claude-haiku-4-5-20251001");
        assert!(old.sampling && old.prefill && old.budgeted);
    }

    #[test]
    fn openai_and_gemini_tables_match_the_web_app() {
        assert_eq!(effort_levels(Maker::OpenAi, "gpt-5.5"), N_LMHX);
        assert_eq!(effort_levels(Maker::Google, "gemini-3-flash"), M_LMH);
        assert!(gemini_budgeted("gemini-2.5-pro"));
    }
}
