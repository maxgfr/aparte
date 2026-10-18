//! `aparte skills`: the skills found from the working directory (`list`), one skill's fields and instructions
//! (`show`), and the directories searched (`path`). Offline.

use std::process::ExitCode;

use anyhow::Context;
use aparte_skills::{Catalog, Skill};
use serde_json::json;

use crate::{Ctx, exit, setup};

/// Arguments of `aparte skills`.
#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    pub action: Action,
}

/// What to show.
#[derive(Debug, clap::Subcommand)]
pub enum Action {
    /// List the skills found, and whether each is offered to the model
    List {
        /// Also list skills hidden by one of the same name
        #[arg(long)]
        all: bool,
    },
    /// Print a skill's fields, files and instructions
    Show { name: String },
    /// Print the directories searched, in order
    Path,
}

fn offered_label(cat: &Catalog, s: &Skill, trusted: bool) -> &'static str {
    if cat.is_offered(s, trusted) {
        "offered"
    } else if s.disable_model_invocation {
        "by hand only"
    } else {
        "untrusted project"
    }
}

fn skill_json(cat: &Catalog, s: &Skill, trusted: bool) -> serde_json::Value {
    json!({
        "name": s.name,
        "description": s.description,
        "scope": s.scope,
        "dir": s.dir.display().to_string(),
        "path": s.file.display().to_string(),
        "offered": cat.is_offered(s, trusted),
        "disableModelInvocation": s.disable_model_invocation,
        "allowedTools": s.allowed_tools,
        "license": s.license,
        "version": s.version,
    })
}

fn short(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n).collect::<String>())
    } else {
        s.to_owned()
    }
}

/// Runs a skills action.
pub fn run(args: Args, ctx: &Ctx) -> anyhow::Result<ExitCode> {
    let cwd = setup::cwd()?;
    let trusted = setup::trusted(ctx, &cwd)?;
    match args.action {
        Action::Path => {
            let home = aparte_skills::home_dir();
            for (dir, scope) in aparte_skills::roots(&cwd, home.as_deref()) {
                let exists = dir.is_dir();
                ctx.ui.emit(
                    "skills-dir",
                    json!({"path": dir.display().to_string(), "scope": scope, "exists": exists}),
                );
                if !ctx.ui.is_json() {
                    ctx.ui.say(&format!(
                        "{:<8} {}  {}",
                        scope.name(),
                        if exists { "found  " } else { "missing" },
                        dir.display()
                    ));
                }
            }
        }
        Action::List { all } => {
            let cat = setup::skills(&cwd);
            for d in &cat.diagnostics {
                ctx.ui.emit(
                    "skill-warning",
                    json!({"path": d.path.display().to_string(), "message": d.message}),
                );
                if !ctx.global.quiet {
                    eprintln!("aparte: skill: {}", d.message);
                }
            }
            if cat.skills.is_empty() && !ctx.ui.is_json() {
                ctx.ui
                    .say("no skills found; `aparte skills path` shows where they are looked for");
            }
            for s in &cat.skills {
                ctx.ui.emit("skill", skill_json(&cat, s, trusted));
                if !ctx.ui.is_json() {
                    ctx.ui.say(&format!(
                        "{:<24} {:<7} {:<17} {}",
                        s.name,
                        s.scope.name(),
                        offered_label(&cat, s, trusted),
                        short(&s.description, 80)
                    ));
                }
            }
            if all {
                for s in &cat.shadowed {
                    let mut v = skill_json(&cat, s, trusted);
                    v["shadowed"] = json!(true);
                    v["offered"] = json!(false);
                    ctx.ui.emit("skill", v);
                    if !ctx.ui.is_json() {
                        ctx.ui.say(&format!(
                            "{:<24} {:<7} {:<17} {}",
                            s.name,
                            s.scope.name(),
                            "shadowed",
                            s.file.display()
                        ));
                    }
                }
            }
        }
        Action::Show { name } => {
            let cat = setup::skills(&cwd);
            let s = cat
                .get(&name)
                .with_context(|| format!("no skill named {name:?}; `aparte skills list` lists them"))?;
            let body = aparte_skills::discover::body(s)?;
            let files = aparte_skills::tool::files(&s.dir);
            let mut v = skill_json(&cat, s, trusted);
            v["files"] = json!(files);
            v["body"] = json!(body);
            ctx.ui.emit("skill", v);
            if !ctx.ui.is_json() {
                ctx.ui.say(&format!("name:        {}", s.name));
                ctx.ui.say(&format!("description: {}", s.description));
                ctx.ui.say(&format!(
                    "scope:       {} ({})",
                    s.scope.name(),
                    offered_label(&cat, s, trusted)
                ));
                ctx.ui.say(&format!("path:        {}", s.file.display()));
                if !s.allowed_tools.is_empty() {
                    ctx.ui.say(&format!(
                        "allowed:     {} (shown only: every call still follows the approval rules)",
                        s.allowed_tools.join(" ")
                    ));
                }
                if let Some(v) = &s.version {
                    ctx.ui.say(&format!("version:     {v}"));
                }
                if !files.is_empty() {
                    ctx.ui.say(&format!("files:       {}", files.join(", ")));
                }
                ctx.ui.say("");
                ctx.ui.say(&aparte_tui::markdown::sanitize(body.trim_end()));
            }
        }
    }
    Ok(ExitCode::from(exit::OK))
}
