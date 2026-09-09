use crate::{
    args::Skill,
    client::fail,
    output::{confirm, write_bytes},
};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const SKILL: &str = include_str!("../../../skills/tucano-proxy/SKILL.md");
const AGENTS: [&str; 6] = ["claude", "codex", "opencode", "pi", "oh-my-pi", "agents"];
fn target(base: &Path, agent: &str, project: bool) -> PathBuf {
    let directory = match (agent, project) {
        ("claude", _) => ".claude/skills",
        ("codex", _) => ".agents/skills",
        ("opencode", true) => ".opencode/skills",
        ("opencode", false) => ".config/opencode/skills",
        ("pi", true) => ".pi/skills",
        ("pi", false) => ".pi/agent/skills",
        ("oh-my-pi", true) => ".omp/skills",
        ("oh-my-pi", false) => ".omp/agent/skills",
        _ => ".agents/skills",
    };
    base.join(directory).join("tucano-proxy").join("SKILL.md")
}
fn safe_target(base: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(base)?;
    let mut ancestor = base.to_path_buf();
    for part in relative.components() {
        ancestor.push(part);
        match std::fs::symlink_metadata(&ancestor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(fail(
                    "unsafe_skill_path",
                    format!("Refusing symlink in skill path: {}", ancestor.display()),
                    5,
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
pub fn run(command: Skill) -> Result<Value> {
    let (agent, project, operation, yes) = match command {
        Skill::Install {
            agent,
            project,
            yes,
        } => (agent, project, "install", yes),
        Skill::Status { project } => ("all".into(), project, "status", false),
        Skill::Uninstall {
            agent,
            project,
            yes,
        } => (agent, project, "uninstall", yes),
    };
    if operation == "uninstall" {
        confirm(yes, "Removing installed agent skills")?;
    }
    let base = if project {
        std::env::current_dir()?
    } else {
        dirs::home_dir().context("Cannot locate home directory")?
    };
    let agents: Vec<&str> = if agent == "all" {
        AGENTS.to_vec()
    } else {
        vec![agent.as_str()]
    };
    let mut items = Vec::new();
    // Preflight all paths before an all-agent install, so a conflict does not leave partial coverage.
    for agent in &agents {
        let path = target(&base, agent, project);
        safe_target(&base, &path)?;
        if operation == "install"
            && path.exists()
            && !yes
            && std::fs::read(&path)? != SKILL.as_bytes()
        {
            return Err(fail(
                "confirmation_required",
                format!(
                    "{} already contains a different skill; pass --yes to replace",
                    path.display()
                ),
                7,
            ));
        }
    }
    for agent in agents {
        let path = target(&base, agent, project);
        match operation {
            "install" => {
                std::fs::create_dir_all(path.parent().context("Invalid skill path")?)?;
                safe_target(&base, &path)?;
                if !path.exists() || std::fs::read(&path)? != SKILL.as_bytes() {
                    write_bytes(&path, SKILL.as_bytes(), yes)?;
                }
            }
            "uninstall" if path.exists() => {
                std::fs::remove_file(&path)?;
                // Remove the skill directory only if it is empty; preserve user-added resources.
                match std::fs::remove_dir(path.parent().context("Invalid skill path")?) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                    Err(error) => return Err(error.into()),
                }
            }
            _ => {}
        }
        let installed = path.is_file();
        let current = installed && std::fs::read(&path)? == SKILL.as_bytes();
        items.push(json!({"agent":agent,"path":path,"installed":installed,"current":current}));
    }
    Ok(
        json!({"operation":operation,"project":project,"coverage":items,"note":"Reports skill files only. Does not install agent software or prove automatic discovery; restart your agent and inspect its loaded skills. The agents target is the shared Agent Skills directory, not universal agent support."}),
    )
}
