//! Progressive disclosure: the system prompt lists each skill's name and description in an `<available_skills>`
//! block; the model loads a skill's instructions with the `skill` tool when a task matches, and reads the files the
//! instructions point to on demand (with the same tool's `path`, or `read`). Nothing a skill ships is run by this
//! crate: its scripts go through the `bash` tool, which is sandboxed and always asks before it runs.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use aparte_agent::{Annotations, BoxFuture, ToolContext, ToolError, ToolOutput, TypedTool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use crate::discover::{Catalog, Skill, SkillError, body};

/// Largest skill file returned by the `skill` tool's `path`.
pub const MAX_FILE_BYTES: usize = 100 * 1024;
/// Files listed with a skill's instructions.
const MAX_LISTED: usize = 60;

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The `<available_skills>` block of the system prompt, or an empty string when no skill is offered.
pub fn prompt_block(catalog: &Catalog, trusted: bool) -> String {
    let offered: Vec<&Skill> = catalog.offered(trusted).collect();
    if offered.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "\nSkills are packaged instructions for specific tasks. When a task matches a skill's description, call the \
         `skill` tool with its name to load the instructions before you act, then follow them. Load only what the \
         task needs.\n<available_skills>\n",
    );
    for skill in offered {
        s.push_str(&format!(
            "<skill>\n<name>{}</name>\n<description>{}</description>\n<location>{}</location>\n</skill>\n",
            escape(&skill.name),
            escape(&skill.description),
            escape(&skill.file.display().to_string())
        ));
    }
    s.push_str("</available_skills>\n");
    s
}

/// The files of a skill directory, relative, without `SKILL.md`, hidden files and dependency folders.
pub fn files(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        let mut entries: Vec<PathBuf> = rd.filter_map(Result::ok).map(|e| e.path()).collect();
        entries.sort();
        entries.reverse();
        for p in entries {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if name.starts_with('.') || name == "node_modules" || name == "__pycache__" || name == "target" {
                continue;
            }
            if p.is_dir() {
                if depth < 3 {
                    stack.push((p, depth + 1));
                }
            } else if let Ok(rel) = p.strip_prefix(dir)
                && rel != Path::new("SKILL.md")
            {
                out.push(rel.display().to_string());
            }
        }
    }
    out.sort();
    out
}

/// A skill's instructions as given to the model: its location, how to reach its files, and the body, with the
/// usual base-directory placeholders (`{baseDir}`, `${CLAUDE_SKILL_DIR}`, `<skill-dir>`) filled in.
pub fn render(skill: &Skill) -> Result<String, SkillError> {
    let dir = skill.dir.display().to_string();
    let text = body(skill)?
        .replace("{baseDir}", &dir)
        .replace("${CLAUDE_SKILL_DIR}", &dir)
        .replace("<skill-dir>", &dir);
    let listed = files(&skill.dir);
    let mut s = format!(
        "<skill name=\"{}\" location=\"{}\">\nBase directory: {dir}\nRelative paths in this skill are relative to \
         the base directory. Read its files with the `skill` tool's `path` or with `read`; run its scripts with \
         `bash` (the user approves each command).\n",
        escape(&skill.name),
        escape(&skill.file.display().to_string()),
    );
    if !listed.is_empty() {
        s.push_str("Files:\n");
        for f in listed.iter().take(MAX_LISTED) {
            s.push_str(&format!("- {f}\n"));
        }
        if listed.len() > MAX_LISTED {
            s.push_str(&format!("- ... and {} more\n", listed.len() - MAX_LISTED));
        }
    }
    s.push('\n');
    s.push_str(text.trim_end());
    s.push_str("\n</skill>");
    Ok(s)
}

/// A file inside a skill directory; refuses a path that leaves it, links included.
pub fn read_file(skill: &Skill, rel: &str) -> Result<String, String> {
    let rel = rel.trim();
    let p = Path::new(rel);
    let target = if p.is_absolute() {
        p.to_path_buf()
    } else {
        skill.dir.join(p)
    };
    let target = target
        .canonicalize()
        .map_err(|e| format!("{}: {e}", target.display()))?;
    if !target.starts_with(&skill.dir) {
        return Err(format!("{rel} is outside the skill directory {}", skill.dir.display()));
    }
    if target.is_dir() {
        let inside: Vec<String> = files(&target);
        return Ok(format!("{} is a directory:\n{}", target.display(), inside.join("\n")));
    }
    let bytes = std::fs::read(&target).map_err(|e| format!("{}: {e}", target.display()))?;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err(format!("{} is a binary file", target.display()));
    }
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if text.len() > MAX_FILE_BYTES {
        let mut at = MAX_FILE_BYTES;
        while !text.is_char_boundary(at) {
            at -= 1;
        }
        text.truncate(at);
        text.push_str(&format!(
            "\n[cut at {} KiB; read {} with `read` and an offset for the rest]",
            MAX_FILE_BYTES / 1024,
            target.display()
        ));
    }
    Ok(text)
}

/// Input of `skill`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct SkillInput {
    /// The skill's name, from <available_skills>.
    pub name: String,
    /// A file inside the skill directory, relative to it (for example `references/guide.md`). Without it, the
    /// skill's instructions are returned.
    pub path: Option<String>,
}

/// The `skill` tool.
#[derive(Debug, Clone)]
pub struct SkillTool {
    pub catalog: Arc<Catalog>,
    /// Whether the project is trusted: project skills are refused otherwise.
    pub trusted: bool,
}

impl TypedTool for SkillTool {
    type Input = SkillInput;
    fn name(&self) -> &str {
        "skill"
    }
    fn description(&self) -> &str {
        "Loads a skill listed in <available_skills>: its instructions, or with `path` one of the files inside its \
         directory. Load a skill before doing a task that matches its description."
    }
    fn annotations(&self) -> Annotations {
        Annotations::READ_ONLY
    }
    fn run<'a>(&'a self, _ctx: &'a ToolContext, input: SkillInput) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            let name = input.name.trim();
            let skill = self.catalog.get(name).ok_or_else(|| {
                let known: Vec<&str> = self.catalog.offered(self.trusted).map(|s| s.name.as_str()).collect();
                ToolError::InvalidInput(format!(
                    "no skill named {name:?}; available: {}",
                    if known.is_empty() {
                        "none".into()
                    } else {
                        known.join(", ")
                    }
                ))
            })?;
            if skill.disable_model_invocation {
                return Err(ToolError::Failed(format!(
                    "the skill {name:?} can only be invoked by the user (/skill:{name})"
                )));
            }
            if !self.catalog.is_offered(skill, self.trusted) {
                return Err(ToolError::Failed(format!(
                    "the skill {name:?} belongs to an untrusted project; the user can trust it with `aparte trust`"
                )));
            }
            let skill = skill.clone();
            let path = input.path.clone();
            let out = tokio::task::spawn_blocking(move || match &path {
                Some(p) if !p.trim().is_empty() => read_file(&skill, p).map(|t| (t, Some(p.clone()), skill)),
                _ => render(&skill).map_err(|e| e.to_string()).map(|t| (t, None, skill)),
            })
            .await
            .map_err(|e| ToolError::Failed(e.to_string()))?;
            let (text, path, skill) = out.map_err(ToolError::Failed)?;
            Ok(ToolOutput::text(text).with_details(json!({
                "skill": skill.name,
                "dir": skill.dir.display().to_string(),
                "path": path,
            })))
        })
    }
}

/// The prefix of a user invocation: `/skill:<name> [arguments]`.
pub const INVOKE_PREFIX: &str = "/skill:";

/// Expands a user invocation `/skill:<name> [arguments]` into the prompt sent to the model: the skill's
/// instructions, then the arguments. `None` when `text` is not an invocation. A user may invoke every skill found,
/// those with `disable-model-invocation` and those of an untrusted project included: it is their explicit choice.
pub fn expand_invocation(catalog: &Catalog, text: &str) -> Option<Result<String, SkillError>> {
    let rest = text.trim_start().strip_prefix(INVOKE_PREFIX)?;
    let (name, args) = match rest.find(char::is_whitespace) {
        Some(i) => (&rest[..i], rest[i..].trim()),
        None => (rest, ""),
    };
    let Some(skill) = catalog.get(name) else {
        return Some(Err(SkillError::Unknown(name.to_owned())));
    };
    Some(render(skill).map(|instructions| {
        let mut s = format!(
            "The user invoked the skill {:?}. Follow its instructions.\n\n{instructions}",
            skill.name
        );
        if !args.is_empty() {
            s.push_str("\n\n");
            s.push_str(args);
        }
        s
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discover::{Scope, discover_in};

    fn catalog(root: &Path) -> Catalog {
        let d = root.join("demo");
        std::fs::create_dir_all(d.join("references")).expect("mkdir");
        std::fs::create_dir_all(d.join("scripts")).expect("mkdir");
        std::fs::write(
            d.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo <tasks> & more.\n---\nRun `node <skill-dir>/scripts/run.mjs`.\nSee [guide](references/guide.md).\n",
        )
        .expect("write");
        std::fs::write(d.join("references/guide.md"), "The guide.").expect("write");
        std::fs::write(d.join("scripts/run.mjs"), "console.log('ok')").expect("write");
        let h = root.join("hidden");
        std::fs::create_dir_all(&h).expect("mkdir");
        std::fs::write(
            h.join("SKILL.md"),
            "---\nname: hidden\ndescription: Only by hand.\ndisable-model-invocation: true\n---\nHidden body.\n",
        )
        .expect("write");
        discover_in(&[(root.to_path_buf(), Scope::User)])
    }

    fn ctx(dir: &Path) -> ToolContext {
        ToolContext {
            cwd: dir.to_path_buf(),
            call_id: "c".into(),
            cancel: aparte_agent::CancelToken::new(),
        }
    }

    #[test]
    fn the_prompt_block_lists_only_offered_skills_escaped() {
        let root = tempfile::tempdir().expect("root");
        let cat = catalog(root.path());
        let block = prompt_block(&cat, false);
        assert!(block.contains("<name>demo</name>"));
        assert!(block.contains("Demo &lt;tasks&gt; &amp; more."));
        assert!(!block.contains("hidden"), "disable-model-invocation keeps it out");
        assert_eq!(prompt_block(&Catalog::default(), true), "");
    }

    #[tokio::test]
    async fn the_tool_loads_instructions_and_files_inside_the_skill_only() {
        let root = tempfile::tempdir().expect("root");
        let cat = Arc::new(catalog(root.path()));
        let tool = aparte_agent::typed(SkillTool {
            catalog: cat.clone(),
            trusted: false,
        });
        let c = ctx(root.path());
        let out = tool.execute(&c, json!({"name": "demo"})).await.expect("loads");
        let dir = cat.get("demo").expect("demo").dir.display().to_string();
        assert!(
            out.content.contains(&format!("node {dir}/scripts/run.mjs")),
            "{}",
            out.content
        );
        assert!(out.content.contains("- references/guide.md") && out.content.contains("- scripts/run.mjs"));
        let out = tool
            .execute(&c, json!({"name": "demo", "path": "references/guide.md"}))
            .await
            .expect("reads");
        assert_eq!(out.content, "The guide.");
        let escape = tool
            .execute(&c, json!({"name": "demo", "path": "../hidden/SKILL.md"}))
            .await;
        assert!(escape.is_err_and(|e| e.to_string().contains("outside the skill directory")));
        let hidden = tool.execute(&c, json!({"name": "hidden"})).await;
        assert!(hidden.is_err_and(|e| e.to_string().contains("only be invoked by the user")));
        assert!(tool.execute(&c, json!({"name": "nope"})).await.is_err());
    }

    #[test]
    fn a_user_invocation_expands_to_the_instructions_and_arguments() {
        let root = tempfile::tempdir().expect("root");
        let cat = catalog(root.path());
        let text = expand_invocation(&cat, "/skill:hidden do it now")
            .expect("invocation")
            .expect("found");
        assert!(text.contains("Hidden body.") && text.ends_with("\n\ndo it now"));
        assert!(expand_invocation(&cat, "hello").is_none());
        assert!(matches!(
            expand_invocation(&cat, "/skill:missing"),
            Some(Err(SkillError::Unknown(_)))
        ));
    }
}
