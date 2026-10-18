//! Finding skills: a skill is a directory holding a `SKILL.md`, inside a skills root.
//!
//! Roots, searched in this order (the first skill of a name wins, later ones are reported as shadowed):
//!
//! 1. from the working directory up to the filesystem root, in each directory `.agents/skills` then
//!    `.claude/skills` (project skills);
//! 2. `~/.agents/skills`, then `~/.claude/skills` (user skills).
//!
//! This is where `npx skills add` installs (`.agents/skills/<name>` in a project, `~/.agents/skills/<name>` with
//! `-g`), and the symbolic links it makes for other agents are followed: a skill reached twice through links is
//! listed once.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::frontmatter::{self, Value};

/// Largest `SKILL.md` read; a larger one is skipped.
pub const MAX_SKILL_BYTES: u64 = 512 * 1024;
/// Longest name, after the Agent Skills format.
pub const MAX_NAME: usize = 64;
/// Longest description, after the Agent Skills format.
pub const MAX_DESCRIPTION: usize = 1024;

/// Where a skill comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    /// Under the working directory or one of its ancestors: offered to the model only in a trusted project.
    Project,
    /// Under the home directory.
    User,
}

impl Scope {
    /// A name for listings.
    pub fn name(self) -> &'static str {
        match self {
            Scope::Project => "project",
            Scope::User => "user",
        }
    }
}

/// A skill found on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// The skill directory (canonical).
    pub dir: PathBuf,
    /// Its `SKILL.md`.
    pub file: PathBuf,
    pub scope: Scope,
    /// The skills root it was found in, as searched (not canonicalized).
    pub root: PathBuf,
    /// Only the user may invoke it (`/skill:<name>`); it is not offered to the model.
    pub disable_model_invocation: bool,
    /// The `allowed-tools` field, as written. Shown, never used to skip an approval.
    pub allowed_tools: Vec<String>,
    pub license: Option<String>,
    /// The `metadata.version` field, if any.
    pub version: Option<String>,
}

/// A skill that was skipped, or a field that was off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    pub path: PathBuf,
    pub message: String,
}

/// Every skill found, and what went wrong on the way.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Catalog {
    pub skills: Vec<Skill>,
    /// Skills hidden by an earlier one of the same name.
    pub shadowed: Vec<Skill>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Why a `SKILL.md` was not loaded.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SkillError {
    #[error("cannot read {path}: {message}")]
    Io { path: PathBuf, message: String },
    #[error("{path} has no YAML frontmatter (a first line `---`, the fields, then `---`)")]
    NoFrontmatter { path: PathBuf },
    #[error("{path}: {source}")]
    Yaml {
        path: PathBuf,
        #[source]
        source: frontmatter::YamlError,
    },
    #[error("{path}: {message}")]
    Invalid { path: PathBuf, message: String },
    #[error("no skill named {0:?}")]
    Unknown(String),
}

/// The roots searched from `cwd`, with their scope, in order.
pub fn roots(cwd: &Path, home: Option<&Path>) -> Vec<(PathBuf, Scope)> {
    let home_c = home.map(|h| h.canonicalize().unwrap_or_else(|_| h.to_path_buf()));
    let mut out = Vec::new();
    for dir in cwd.ancestors() {
        let dir_c = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        if home_c.as_deref() == Some(dir_c.as_path()) {
            // The home directory's skills are user skills, searched last.
            continue;
        }
        out.push((dir.join(".agents/skills"), Scope::Project));
        out.push((dir.join(".claude/skills"), Scope::Project));
    }
    if let Some(h) = home {
        out.push((h.join(".agents/skills"), Scope::User));
        out.push((h.join(".claude/skills"), Scope::User));
    }
    out
}

/// The home directory of this process (`HOME`, or `USERPROFILE` on Windows).
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// Finds the skills of `cwd`.
pub fn discover(cwd: &Path, home: Option<&Path>) -> Catalog {
    discover_in(&roots(cwd, home))
}

/// Finds the skills under these roots.
pub fn discover_in(roots: &[(PathBuf, Scope)]) -> Catalog {
    let mut cat = Catalog::default();
    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();
    let mut seen_roots: HashSet<PathBuf> = HashSet::new();
    for (root, scope) in roots {
        let Ok(root_c) = root.canonicalize() else {
            continue;
        };
        if !seen_roots.insert(root_c) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).collect();
        dirs.sort();
        for dir in dirs {
            let hidden = dir.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'));
            let file = dir.join("SKILL.md");
            if hidden || !file.is_file() {
                continue;
            }
            let Ok(dir_c) = dir.canonicalize() else {
                continue;
            };
            if !seen_dirs.insert(dir_c.clone()) {
                continue;
            }
            match load(&dir_c, root, *scope) {
                Ok((skill, warnings)) => {
                    cat.diagnostics.extend(warnings);
                    if cat.skills.iter().any(|s| s.name == skill.name) {
                        cat.shadowed.push(skill);
                    } else {
                        cat.skills.push(skill);
                    }
                }
                Err(e) => cat.diagnostics.push(Diagnostic {
                    path: file,
                    message: e.to_string(),
                }),
            }
        }
    }
    cat
}

/// Whether a name follows the format: lowercase letters, digits and single hyphens, not at either end.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::List(items)) => items.iter().filter_map(|i| i.as_str().map(str::to_owned)).collect(),
        Some(Value::Str(s)) => split_tools(s),
        _ => Vec::new(),
    }
}

/// Splits `Bash(git status:*), Read Write` on commas and spaces outside parentheses.
fn split_tools(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0usize;
    for c in s.chars() {
        match c {
            '(' => {
                depth += 1;
                cur.push(c);
            }
            ')' => {
                depth = depth.saturating_sub(1);
                cur.push(c);
            }
            ',' | ' ' | '\t' if depth == 0 => {
                if !cur.trim().is_empty() {
                    out.push(cur.trim().to_owned());
                }
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_owned());
    }
    out
}

/// Reads a skill directory's `SKILL.md`: the skill, and warnings about fields that are off but not fatal.
pub fn load(dir: &Path, root: &Path, scope: Scope) -> Result<(Skill, Vec<Diagnostic>), SkillError> {
    let file = dir.join("SKILL.md");
    let io = |e: std::io::Error| SkillError::Io {
        path: file.clone(),
        message: e.to_string(),
    };
    let meta = std::fs::metadata(&file).map_err(io)?;
    if meta.len() > MAX_SKILL_BYTES {
        return Err(SkillError::Invalid {
            path: file,
            message: format!("larger than {} KiB", MAX_SKILL_BYTES / 1024),
        });
    }
    let text = std::fs::read_to_string(&file).map_err(io)?;
    let (fm, _) = frontmatter::split(&text).ok_or_else(|| SkillError::NoFrontmatter { path: file.clone() })?;
    let v = frontmatter::parse(fm).map_err(|source| SkillError::Yaml {
        path: file.clone(),
        source,
    })?;
    let mut warnings = Vec::new();
    let mut warn = |message: String| {
        warnings.push(Diagnostic {
            path: file.clone(),
            message,
        });
    };
    let dir_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = match v.get("name").and_then(Value::as_str) {
        Some(n) => n.trim().to_owned(),
        None => {
            warn(format!("no `name` field: named after its directory, {dir_name:?}"));
            dir_name.clone()
        }
    };
    if !valid_name(&name) {
        return Err(SkillError::Invalid {
            path: file,
            message: format!("the name {name:?} is not 1 to {MAX_NAME} lowercase letters, digits and single hyphens"),
        });
    }
    if name != dir_name {
        warn(format!("the name {name:?} differs from its directory {dir_name:?}"));
    }
    let description = v
        .get("description")
        .and_then(Value::as_str)
        .map(|d| d.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|d| !d.is_empty())
        .ok_or_else(|| SkillError::Invalid {
            path: file.clone(),
            message: "no `description` field: the model could not tell when to use it".into(),
        })?;
    if description.chars().count() > MAX_DESCRIPTION {
        warn(format!("the description is longer than {MAX_DESCRIPTION} characters"));
    }
    let disable = v.get("disable-model-invocation");
    let disable_model_invocation = match disable {
        None | Some(Value::Null) => false,
        Some(x) => x.as_bool().unwrap_or_else(|| {
            warn("`disable-model-invocation` is not true or false: taken as true".into());
            true
        }),
    };
    let allowed_tools = string_list(v.get("allowed-tools").or_else(|| v.get("allowed_tools")));
    let skill = Skill {
        name,
        description,
        dir: dir.to_path_buf(),
        file,
        scope,
        root: root.to_path_buf(),
        disable_model_invocation,
        allowed_tools,
        license: v.get("license").and_then(Value::as_str).map(str::to_owned),
        version: v
            .get("metadata")
            .and_then(|m| m.get("version"))
            .or_else(|| v.get("version"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    Ok((skill, warnings))
}

impl Catalog {
    /// A skill by name.
    pub fn get(&self, name: &str) -> Option<&Skill> {
        self.skills.iter().find(|s| s.name == name)
    }

    /// The skills the model may load: not `disable-model-invocation`, and project skills only in a trusted project.
    pub fn offered(&self, trusted: bool) -> impl Iterator<Item = &Skill> {
        self.skills
            .iter()
            .filter(move |s| !s.disable_model_invocation && (trusted || s.scope == Scope::User))
    }

    /// Whether the model may load this skill.
    pub fn is_offered(&self, skill: &Skill, trusted: bool) -> bool {
        !skill.disable_model_invocation && (trusted || skill.scope == Scope::User)
    }
}

/// The body of a `SKILL.md` (after the frontmatter).
pub fn body(skill: &Skill) -> Result<String, SkillError> {
    let text = std::fs::read_to_string(&skill.file).map_err(|e| SkillError::Io {
        path: skill.file.clone(),
        message: e.to_string(),
    })?;
    Ok(match frontmatter::split(&text) {
        Some((_, body)) => body.trim_start_matches(['\r', '\n']).to_owned(),
        None => text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, dir: &str, frontmatter: &str) -> PathBuf {
        let d = root.join(dir);
        std::fs::create_dir_all(&d).expect("mkdir");
        std::fs::write(d.join("SKILL.md"), format!("---\n{frontmatter}---\n# {dir}\nBody.\n")).expect("write");
        d
    }

    #[test]
    fn names_follow_the_format() {
        assert!(valid_name("ultrasearch") && valid_name("pdf-tools") && valid_name("a1"));
        for bad in ["", "-a", "a-", "a--b", "A", "a_b", "a b", &"x".repeat(65)] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn project_skills_come_first_and_shadow_user_skills() {
        let home = tempfile::tempdir().expect("home");
        let proj = tempfile::tempdir().expect("proj");
        let sub = proj.path().join("src/deep");
        std::fs::create_dir_all(&sub).expect("mkdir");
        write_skill(
            &proj.path().join(".agents/skills"),
            "alpha",
            "name: alpha\ndescription: Project alpha.\n",
        );
        write_skill(
            &home.path().join(".agents/skills"),
            "alpha",
            "name: alpha\ndescription: User alpha.\n",
        );
        write_skill(
            &home.path().join(".claude/skills"),
            "beta",
            "name: beta\ndescription: >\n  User\n  beta.\n",
        );
        write_skill(
            &proj.path().join(".agents/skills"),
            "broken",
            "description: [unclosed\n",
        );
        let cat = discover(&sub, Some(home.path()));
        let names: Vec<_> = cat.skills.iter().map(|s| (s.name.as_str(), s.scope)).collect();
        assert_eq!(names, [("alpha", Scope::Project), ("beta", Scope::User)]);
        assert_eq!(cat.get("alpha").map(|s| s.description.as_str()), Some("Project alpha."));
        assert_eq!(cat.get("beta").map(|s| s.description.as_str()), Some("User beta."));
        assert_eq!(cat.shadowed.len(), 1);
        assert!(cat.diagnostics.iter().any(|d| d.path.ends_with("broken/SKILL.md")));
        let offered: Vec<_> = cat.offered(false).map(|s| s.name.as_str()).collect();
        assert_eq!(offered, ["beta"], "project skills wait for trust");
        assert_eq!(cat.offered(true).count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn linked_skills_are_listed_once() {
        let home = tempfile::tempdir().expect("home");
        let real = write_skill(
            &home.path().join(".agents/skills"),
            "gamma",
            "name: gamma\ndescription: G.\n",
        );
        std::fs::create_dir_all(home.path().join(".claude/skills")).expect("mkdir");
        std::os::unix::fs::symlink(&real, home.path().join(".claude/skills/gamma")).expect("link");
        let elsewhere = tempfile::tempdir().expect("cwd");
        let cat = discover(elsewhere.path(), Some(home.path()));
        assert_eq!(cat.skills.iter().filter(|s| s.name == "gamma").count(), 1);
        assert!(cat.shadowed.is_empty());
    }

    #[test]
    fn fields_are_read_and_checked() {
        let root = tempfile::tempdir().expect("root");
        let d = write_skill(
            root.path(),
            "tools",
            "name: other-name\ndescription: Does things.\ndisable-model-invocation: true\nallowed-tools: Bash(git status:*), Read Write\nlicense: MIT\nmetadata:\n  version: 2.0.0\n",
        );
        let (s, warnings) = load(&d.canonicalize().expect("c"), root.path(), Scope::User).expect("loads");
        assert_eq!(s.name, "other-name");
        assert!(s.disable_model_invocation);
        assert_eq!(s.allowed_tools, ["Bash(git status:*)", "Read", "Write"]);
        assert_eq!(
            (s.license.as_deref(), s.version.as_deref()),
            (Some("MIT"), Some("2.0.0"))
        );
        assert!(
            warnings
                .iter()
                .any(|w| w.message.contains("differs from its directory"))
        );
        assert_eq!(body(&s).expect("body"), "# tools\nBody.\n");

        let d = write_skill(root.path(), "nodesc", "name: nodesc\n");
        assert!(matches!(
            load(&d, root.path(), Scope::User),
            Err(SkillError::Invalid { .. })
        ));
        let d = write_skill(root.path(), "Bad_Name", "description: x\n");
        assert!(matches!(
            load(&d, root.path(), Scope::User),
            Err(SkillError::Invalid { .. })
        ));
    }
}
