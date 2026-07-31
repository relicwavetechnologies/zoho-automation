use std::path::{Path, PathBuf};

const DIVO_HOME_ENV: &str = "DIVO_HOME";
const DIVO_HOME_DIR_NAME: &str = ".divo";
const WORKSPACE_DIR_NAME: &str = "workspace";
const SKILLS_DIR_NAME: &str = "skills";
const COMPANY_SKILLS_DIR_NAME: &str = "company";
const USER_SKILLS_DIR_NAME: &str = "user";
const STATE_DIR_NAME: &str = "state";
const LOGS_DIR_NAME: &str = "logs";
const CACHE_DIR_NAME: &str = "cache";

#[derive(Debug, Clone)]
pub struct DivoHomeLayout {
    pub home_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub company_skills_dir: PathBuf,
    pub user_skills_dir: PathBuf,
    pub state_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub cache_dir: PathBuf,
}

impl DivoHomeLayout {
    pub fn resolve() -> Result<Self, String> {
        let home_dir = resolve_home_dir()?;
        Ok(Self {
            workspace_dir: home_dir.join(WORKSPACE_DIR_NAME),
            company_skills_dir: home_dir.join(SKILLS_DIR_NAME).join(COMPANY_SKILLS_DIR_NAME),
            user_skills_dir: home_dir.join(SKILLS_DIR_NAME).join(USER_SKILLS_DIR_NAME),
            state_dir: home_dir.join(STATE_DIR_NAME),
            logs_dir: home_dir.join(LOGS_DIR_NAME),
            cache_dir: home_dir.join(CACHE_DIR_NAME),
            home_dir,
        })
    }

    pub fn ensure(&self) -> Result<(), String> {
        for dir in [
            &self.home_dir,
            &self.workspace_dir,
            &self.company_skills_dir,
            &self.user_skills_dir,
            &self.state_dir,
            &self.logs_dir,
            &self.cache_dir,
        ] {
            ensure_dir(dir)?;
        }
        Ok(())
    }
}

fn resolve_home_dir() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var(DIVO_HOME_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return absolutize(expand_home(Path::new(trimmed)));
        }
    }

    dirs::home_dir()
        .map(|home| home.join(DIVO_HOME_DIR_NAME))
        .ok_or_else(|| "Could not resolve user home directory for Divo home.".to_string())
}

fn absolutize(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(path);
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .map_err(|e| format!("Could not resolve current directory for Divo home: {e}"))
}

fn expand_home(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw == "~" {
        return dirs::home_dir().unwrap_or_else(|| path.to_path_buf());
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|e| format!("Failed to create Divo directory {}: {e}", path.display()))?;
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("Failed to inspect Divo directory {}: {e}", path.display()))?;
    if !meta.is_dir() {
        return Err(format!("Divo path is not a directory: {}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_uses_child_workspace_under_home() {
        let home = PathBuf::from("/tmp/divo-home-test");
        let layout = DivoHomeLayout {
            workspace_dir: home.join(WORKSPACE_DIR_NAME),
            company_skills_dir: home.join(SKILLS_DIR_NAME).join(COMPANY_SKILLS_DIR_NAME),
            user_skills_dir: home.join(SKILLS_DIR_NAME).join(USER_SKILLS_DIR_NAME),
            state_dir: home.join(STATE_DIR_NAME),
            logs_dir: home.join(LOGS_DIR_NAME),
            cache_dir: home.join(CACHE_DIR_NAME),
            home_dir: home.clone(),
        };

        assert_eq!(layout.workspace_dir, home.join("workspace"));
        assert_ne!(layout.workspace_dir, layout.home_dir);
        assert_eq!(layout.company_skills_dir, home.join("skills/company"));
        assert_eq!(layout.user_skills_dir, home.join("skills/user"));
    }
}
