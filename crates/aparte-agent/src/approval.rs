//! Approvals, driven by the tools' annotations and the project's trust:
//!
//! | Tool | Untrusted project | Trusted project |
//! |---|---|---|
//! | read-only, local (`read`, `grep`, `ls`, `git status`) | runs | runs |
//! | read-only, network (`web_fetch`) | asks | runs |
//! | writes, not destructive (`edit`) | asks | runs |
//! | destructive (`write`, `bash`) | asks | asks |
//!
//! `--yes` approves everything; without a person to ask (print and JSON modes), a call that needs approval is
//! denied and the model is told so.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::tool::{Annotations, BoxFuture};

/// How calls that need approval are handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    /// Ask the [`Approver`].
    Ask,
    /// Approve every call (`--yes`).
    Auto,
    /// Deny every call that needs approval (no one to ask).
    Deny,
}

/// Whether a call of a tool with these annotations needs the user's approval.
pub fn needs_approval(a: Annotations, trusted: bool) -> bool {
    if a.read_only && !a.open_world {
        return false;
    }
    if trusted && (a.read_only || !a.destructive) {
        return false;
    }
    true
}

/// A question to the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub call_id: String,
    pub tool: String,
    pub input: Value,
    pub annotations: Annotations,
}

/// The user's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "kebab-case")]
pub enum Approval {
    /// Run this call.
    Allow,
    /// Run this call and every later call of the same tool in this session.
    AllowAlways,
    /// Do not run it; the reason, if any, goes to the model.
    Deny { reason: Option<String> },
}

/// Who answers approval requests: the terminal interface, the RPC client, or a test.
pub trait Approver: Send + Sync {
    fn approve<'a>(&'a self, req: &'a ApprovalRequest) -> BoxFuture<'a, Approval>;
}

/// Denies everything: for modes without a person to ask.
#[derive(Debug, Clone, Copy, Default)]
pub struct DenyAll;

impl Approver for DenyAll {
    fn approve<'a>(&'a self, _req: &'a ApprovalRequest) -> BoxFuture<'a, Approval> {
        Box::pin(async {
            Approval::Deny {
                reason: Some("no one is there to approve this call".into()),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEB: Annotations = Annotations {
        read_only: true,
        destructive: false,
        idempotent: true,
        open_world: true,
    };
    const EDIT: Annotations = Annotations {
        read_only: false,
        destructive: false,
        idempotent: false,
        open_world: false,
    };
    const BASH: Annotations = Annotations {
        read_only: false,
        destructive: true,
        idempotent: false,
        open_world: true,
    };

    #[test]
    fn the_table_of_the_module_doc_holds() {
        assert!(!needs_approval(Annotations::READ_ONLY, false));
        assert!(!needs_approval(Annotations::READ_ONLY, true));
        assert!(needs_approval(WEB, false));
        assert!(!needs_approval(WEB, true));
        assert!(needs_approval(EDIT, false));
        assert!(!needs_approval(EDIT, true));
        assert!(needs_approval(BASH, false));
        assert!(needs_approval(BASH, true));
    }
}
