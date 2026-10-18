//! `aparte-skills`: agent skills for the `aparte` agent, in the Agent Skills format (a directory with a `SKILL.md`:
//! YAML frontmatter with `name` and `description`, then Markdown instructions, plus any files it refers to).
//!
//! - [`discover`]: where skills are found (`.agents/skills` from the working directory up, then `~/.agents/skills`
//!   and `.claude/skills`), and what their frontmatter says (`name`, `description`, `disable-model-invocation`,
//!   `allowed-tools`, `license`, `metadata`).
//! - [`tool`]: progressive disclosure: the `<available_skills>` block of the system prompt, the `skill` tool that
//!   loads a skill's instructions and its files on demand, and `/skill:<name>` invocations by the user.
//! - [`frontmatter`]: the small YAML reader behind it.
//!
//! Skills are instructions, never code this crate runs: a skill's scripts run through the agent's `bash` tool, under
//! its OS sandbox and its approval. `allowed-tools` is read and shown but grants nothing. Project skills, like the
//! project's `AGENTS.md`, reach the model only in a trusted project.

pub mod discover;
pub mod frontmatter;
pub mod tool;

pub use discover::{Catalog, Diagnostic, Scope, Skill, SkillError, discover, home_dir, roots};
pub use tool::{SkillTool, expand_invocation, prompt_block};

/// The `skill` tool over a catalog, ready for an agent.
pub fn skill_tool(catalog: std::sync::Arc<Catalog>, trusted: bool) -> std::sync::Arc<dyn aparte_agent::Tool> {
    aparte_agent::typed(SkillTool { catalog, trusted })
}
