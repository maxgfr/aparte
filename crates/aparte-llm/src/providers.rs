//! Built-in providers: where each one listens, which protocol it speaks, where its key comes from, and the models
//! offered by default. `aparte models` prints this table; `--base-url` points any preset elsewhere.

use crate::caps::Maker;
use crate::types::Protocol;

/// One provider preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preset {
    /// The name used with `--provider`.
    pub id: &'static str,
    pub label: &'static str,
    pub protocol: Protocol,
    /// Whose effort table applies.
    pub maker: Maker,
    /// Base URL without a trailing slash.
    pub base_url: &'static str,
    /// Environment variables read for the key, in order.
    pub env: &'static [&'static str],
    /// Whether the provider refuses calls without a key (local servers do not need one).
    pub needs_key: bool,
    pub default_model: &'static str,
    /// Models listed by `aparte models`, the default first.
    pub models: &'static [&'static str],
}

/// Every preset, the default first.
pub const PRESETS: &[Preset] = &[
    Preset {
        id: "anthropic",
        label: "Anthropic",
        protocol: Protocol::Anthropic,
        maker: Maker::Anthropic,
        base_url: "https://api.anthropic.com/v1",
        env: &["ANTHROPIC_API_KEY"],
        needs_key: true,
        default_model: "claude-opus-5-5",
        models: &[
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-5-5",
            "claude-fable-5-1",
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-fable-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-sonnet-4-6",
            "claude-opus-4-6",
            "claude-haiku-4-5",
        ],
    },
    Preset {
        id: "openai",
        label: "OpenAI",
        protocol: Protocol::OpenaiResponses,
        maker: Maker::OpenAi,
        base_url: "https://api.openai.com/v1",
        env: &["OPENAI_API_KEY"],
        needs_key: true,
        default_model: "gpt-5.5",
        models: &[
            "gpt-5.5",
            "gpt-5.5-pro",
            "gpt-5.4-mini",
            "gpt-5.4-nano",
            "gpt-6-sol",
            "gpt-6-luna",
        ],
    },
    Preset {
        id: "google",
        label: "Google Gemini",
        protocol: Protocol::Gemini,
        maker: Maker::Google,
        base_url: "https://generativelanguage.googleapis.com/v1beta",
        env: &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        needs_key: true,
        default_model: "gemini-3.5-flash",
        models: &[
            "gemini-3.5-flash",
            "gemini-4-argon",
            "gemini-3.8-flash",
            "gemini-3.1-flash-lite",
        ],
    },
    Preset {
        id: "groq",
        label: "Groq",
        protocol: Protocol::OpenaiChat,
        maker: Maker::Other,
        base_url: "https://api.groq.com/openai/v1",
        env: &["GROQ_API_KEY"],
        needs_key: true,
        default_model: "llama-3.3-70b-versatile",
        models: &["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant"],
    },
    Preset {
        id: "deepseek",
        label: "DeepSeek",
        protocol: Protocol::OpenaiChat,
        maker: Maker::Other,
        base_url: "https://api.deepseek.com",
        env: &["DEEPSEEK_API_KEY"],
        needs_key: true,
        default_model: "deepseek-v4-pro",
        models: &["deepseek-v4-pro", "deepseek-flash"],
    },
    Preset {
        id: "xai",
        label: "xAI",
        protocol: Protocol::OpenaiChat,
        maker: Maker::Other,
        base_url: "https://api.x.ai/v1",
        env: &["XAI_API_KEY"],
        needs_key: true,
        default_model: "grok-4.7",
        models: &["grok-4.7", "grok-4.5"],
    },
    Preset {
        id: "mistral",
        label: "Mistral",
        protocol: Protocol::OpenaiChat,
        maker: Maker::Other,
        base_url: "https://api.mistral.ai/v1",
        env: &["MISTRAL_API_KEY"],
        needs_key: true,
        default_model: "mistral-large-latest",
        models: &["mistral-large-latest", "codestral-latest", "mistral-small-latest"],
    },
    Preset {
        id: "openrouter",
        label: "OpenRouter",
        protocol: Protocol::OpenaiChat,
        maker: Maker::Other,
        base_url: "https://openrouter.ai/api/v1",
        env: &["OPENROUTER_API_KEY"],
        needs_key: true,
        default_model: "openrouter/auto",
        models: &["openrouter/auto"],
    },
    Preset {
        id: "ollama",
        label: "Ollama (local)",
        protocol: Protocol::OpenaiChat,
        maker: Maker::Other,
        base_url: "http://127.0.0.1:11434/v1",
        env: &[],
        needs_key: false,
        default_model: "llama3.3",
        models: &["llama3.3"],
    },
    Preset {
        id: "lmstudio",
        label: "LM Studio (local)",
        protocol: Protocol::OpenaiChat,
        maker: Maker::Other,
        base_url: "http://127.0.0.1:1234/v1",
        env: &[],
        needs_key: false,
        default_model: "local-model",
        models: &[],
    },
];

/// The preset of a name.
pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// Why a base URL is refused: only https, or http to the loopback (a local server), carries a key or a prompt.
pub fn base_url_problem(url: &str) -> Option<&'static str> {
    let Some((scheme, rest)) = url.split_once("://") else {
        return Some("the URL must start with https://");
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Some("the URL has no host, or carries credentials");
    }
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    match scheme {
        "https" => None,
        "http" if matches!(host, "127.0.0.1" | "localhost" | "::1") => None,
        "http" => Some("plain http is only allowed to the loopback (127.0.0.1, localhost, ::1)"),
        _ => Some("the URL must start with https://"),
    }
}

/// The base URL as used, without a trailing slash, or why it is refused.
pub fn check_base_url(url: &str) -> Result<String, String> {
    match base_url_problem(url) {
        Some(p) => Err(p.into()),
        None => Ok(url.trim_end_matches('/').to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_have_unique_ids_and_valid_urls() {
        let mut ids: Vec<_> = PRESETS.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), PRESETS.len());
        for p in PRESETS {
            assert!(check_base_url(p.base_url).is_ok(), "{}", p.id);
            assert!(p.needs_key == !p.env.is_empty(), "{}", p.id);
        }
    }

    #[test]
    fn only_https_or_loopback_http_is_accepted() {
        assert!(check_base_url("https://api.example.com/v1/").is_ok());
        assert!(check_base_url("http://127.0.0.1:8080").is_ok());
        assert!(check_base_url("http://[::1]:8080/v1").is_ok());
        assert!(check_base_url("http://example.com").is_err());
        assert!(check_base_url("https://user:pw@example.com").is_err());
        assert!(check_base_url("example.com").is_err());
        assert!(check_base_url("file:///etc").is_err());
    }
}
