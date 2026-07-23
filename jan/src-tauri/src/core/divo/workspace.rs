use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

use super::home::DivoHomeLayout;

const STORE_NAME: &str = "divo-settings.json";
const WORKSPACE_PATH_KEY: &str = "workspace_path";
const DIVO_INTERNAL_DIR_NAME: &str = ".divo";
const THREADS_DIR_NAME: &str = "threads";
const RUNS_DIR_NAME: &str = "runs";
const TMP_DIR_NAME: &str = "tmp";
const SCRIPTS_DIR_NAME: &str = "scripts";
const ARTIFACTS_DIR_NAME: &str = "artifacts";
const LOGS_DIR_NAME: &str = "logs";
const LOCAL_EXCLUDE_ENTRY: &str = ".divo/";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DivoWorkspaceStatus {
    pub home_path: String,
    pub default_workspace_path: String,
    pub effective_workspace_path: String,
    pub selected_workspace_path: Option<String>,
    pub divo_path: String,
    pub divo_tmp_path: String,
    pub divo_scripts_path: String,
    pub divo_artifacts_path: String,
    pub divo_logs_path: String,
    pub company_skills_path: String,
    pub user_skills_path: String,
}

#[derive(Debug, Clone)]
pub struct DivoWorkspaceRunLayout {
    pub run_id: String,
    pub thread_id: String,
    pub divo_dir: PathBuf,
    pub thread_dir: PathBuf,
    pub run_dir: PathBuf,
    pub tmp_dir: PathBuf,
    pub scripts_dir: PathBuf,
    pub artifacts_dir: PathBuf,
    pub logs_dir: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkspace {
    path: String,
}

pub fn workspace_status<R: Runtime>(app: &AppHandle<R>) -> Result<DivoWorkspaceStatus, String> {
    let layout = DivoHomeLayout::resolve()?;
    layout.ensure()?;
    let selected = load_selected_workspace_path(app)?;
    let effective = resolve_workspace_dir(
        selected
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
    )?;
    let divo_layout = ensure_workspace_internal_layout(&effective)?;
    let workspace_artifacts_dir = effective.join(ARTIFACTS_DIR_NAME);
    fs::create_dir_all(&workspace_artifacts_dir).map_err(|e| {
        format!(
            "Failed to create workspace artifacts directory {}: {e}",
            workspace_artifacts_dir.display()
        )
    })?;

    Ok(DivoWorkspaceStatus {
        home_path: layout.home_dir.to_string_lossy().to_string(),
        default_workspace_path: layout.workspace_dir.to_string_lossy().to_string(),
        effective_workspace_path: effective.to_string_lossy().to_string(),
        selected_workspace_path: selected.map(|path| path.to_string_lossy().to_string()),
        divo_path: divo_layout.divo_dir.to_string_lossy().to_string(),
        divo_tmp_path: divo_layout.tmp_dir.to_string_lossy().to_string(),
        divo_scripts_path: divo_layout.scripts_dir.to_string_lossy().to_string(),
        divo_artifacts_path: workspace_artifacts_dir.to_string_lossy().to_string(),
        divo_logs_path: divo_layout.logs_dir.to_string_lossy().to_string(),
        company_skills_path: layout.company_skills_dir.to_string_lossy().to_string(),
        user_skills_path: layout.user_skills_dir.to_string_lossy().to_string(),
    })
}

pub fn save_selected_workspace_path<R: Runtime>(
    app: &AppHandle<R>,
    workspace_path: String,
) -> Result<DivoWorkspaceStatus, String> {
    let selected = normalize_existing_workspace(Path::new(workspace_path.trim()))?;
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    store.set(
        WORKSPACE_PATH_KEY,
        serde_json::to_value(StoredWorkspace {
            path: selected.to_string_lossy().to_string(),
        })
        .map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    workspace_status(app)
}

pub fn clear_selected_workspace_path<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<DivoWorkspaceStatus, String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    store.delete(WORKSPACE_PATH_KEY);
    store.save().map_err(|e| e.to_string())?;
    workspace_status(app)
}

pub fn resolve_workspace_dir(workspace_path: Option<String>) -> Result<PathBuf, String> {
    let layout = DivoHomeLayout::resolve()?;
    layout.ensure()?;

    let selected = workspace_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    match selected {
        Some(path) => normalize_existing_workspace(Path::new(&path)),
        None => normalize_default_workspace(&layout.workspace_dir),
    }
}

pub fn load_selected_workspace_path<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<PathBuf>, String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    let Some(value) = store.get(WORKSPACE_PATH_KEY) else {
        return Ok(None);
    };
    let stored: StoredWorkspace = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let trimmed = stored.path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(normalize_existing_workspace(Path::new(trimmed))?))
}

pub fn resolve_workspace_dir_for_app<R: Runtime>(
    app: &AppHandle<R>,
    workspace_path: Option<String>,
) -> Result<PathBuf, String> {
    if workspace_path
        .as_ref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return resolve_workspace_dir(workspace_path);
    }
    resolve_workspace_dir(
        load_selected_workspace_path(app)?.map(|p| p.to_string_lossy().to_string()),
    )
}

pub fn prepare_workspace_run_layout(
    workspace_dir: &Path,
    thread_id: &str,
) -> Result<DivoWorkspaceRunLayout, String> {
    let layout = ensure_workspace_internal_layout(workspace_dir)?;
    let thread_dir = layout.thread_dir(thread_id)?;
    let run_id = Uuid::new_v4().to_string();
    let run_dir = thread_dir.join(RUNS_DIR_NAME).join(&run_id);
    let run_tmp_dir = run_dir.join(TMP_DIR_NAME);
    let run_scripts_dir = run_dir.join(SCRIPTS_DIR_NAME);
    let run_logs_dir = run_dir.join(LOGS_DIR_NAME);
    // Durable, user-visible deliverables live at {workspace}/artifacts — not
    // under the ephemeral per-run tree.
    let workspace_artifacts_dir = workspace_dir.join(ARTIFACTS_DIR_NAME);
    for dir in [
        &run_dir,
        &run_tmp_dir,
        &run_scripts_dir,
        &run_logs_dir,
        &workspace_artifacts_dir,
    ] {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create Divo run directory {}: {e}", dir.display()))?;
    }

    Ok(DivoWorkspaceRunLayout {
        run_id,
        thread_id: thread_id.to_string(),
        divo_dir: layout.divo_dir,
        thread_dir,
        run_dir,
        tmp_dir: run_tmp_dir,
        scripts_dir: run_scripts_dir,
        artifacts_dir: workspace_artifacts_dir,
        logs_dir: run_logs_dir,
    })
}

pub fn cleanup_workspace_thread_layout(
    workspace_dir: &Path,
    thread_id: &str,
) -> Result<(), String> {
    let layout = DivoWorkspaceInternalLayout::from_workspace(workspace_dir);
    let thread_dir = layout.thread_dir(thread_id)?;
    if thread_dir.exists() {
        fs::remove_dir_all(&thread_dir).map_err(|e| {
            format!(
                "Failed to delete Divo thread state {}: {e}",
                thread_dir.display()
            )
        })?;
    }
    Ok(())
}

fn normalize_default_workspace(path: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(path).map_err(|e| {
        format!(
            "Failed to create default Divo workspace {}: {e}",
            path.display()
        )
    })?;
    normalize_existing_workspace(path)
}

fn normalize_existing_workspace(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("Workspace folder cannot be empty.".into());
    }
    let canonical = std::fs::canonicalize(path).map_err(|e| {
        format!(
            "Workspace does not exist or cannot be read ({}): {e}",
            path.display()
        )
    })?;
    let meta = std::fs::metadata(&canonical).map_err(|e| {
        format!(
            "Workspace cannot be inspected ({}): {e}",
            canonical.display()
        )
    })?;
    if !meta.is_dir() {
        return Err(format!(
            "Workspace is not a folder: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

struct DivoWorkspaceInternalLayout {
    divo_dir: PathBuf,
    threads_dir: PathBuf,
    tmp_dir: PathBuf,
    scripts_dir: PathBuf,
    artifacts_dir: PathBuf,
    logs_dir: PathBuf,
}

impl DivoWorkspaceInternalLayout {
    fn from_workspace(workspace_dir: &Path) -> Self {
        let divo_dir = workspace_dir.join(DIVO_INTERNAL_DIR_NAME);
        Self {
            threads_dir: divo_dir.join(THREADS_DIR_NAME),
            tmp_dir: divo_dir.join(TMP_DIR_NAME),
            scripts_dir: divo_dir.join(SCRIPTS_DIR_NAME),
            artifacts_dir: divo_dir.join(ARTIFACTS_DIR_NAME),
            logs_dir: divo_dir.join(LOGS_DIR_NAME),
            divo_dir,
        }
    }

    fn thread_dir(&self, thread_id: &str) -> Result<PathBuf, String> {
        validate_thread_id_path_component(thread_id)?;
        Ok(self.threads_dir.join(thread_id))
    }
}

fn ensure_workspace_internal_layout(
    workspace_dir: &Path,
) -> Result<DivoWorkspaceInternalLayout, String> {
    let layout = DivoWorkspaceInternalLayout::from_workspace(workspace_dir);

    for dir in [
        &layout.divo_dir,
        &layout.threads_dir,
        &layout.tmp_dir,
        &layout.scripts_dir,
        &layout.artifacts_dir,
        &layout.logs_dir,
    ] {
        fs::create_dir_all(dir).map_err(|e| {
            format!(
                "Failed to create Divo workspace directory {}: {e}",
                dir.display()
            )
        })?;
    }

    let _ = ensure_local_git_exclude(workspace_dir);
    Ok(layout)
}

fn validate_thread_id_path_component(thread_id: &str) -> Result<(), String> {
    let trimmed = thread_id.trim();
    if trimmed.is_empty() {
        return Err("Divo thread id cannot be empty.".to_string());
    }
    let path = Path::new(trimmed);
    if path.components().count() != 1 || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(format!(
            "Invalid Divo thread id path component: {thread_id}"
        ));
    }
    Ok(())
}

fn ensure_local_git_exclude(workspace_dir: &Path) -> Result<(), String> {
    let Some(exclude_path) = resolve_git_info_exclude_path(workspace_dir)? else {
        return Ok(());
    };
    if let Some(parent) = exclude_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create git info directory {}: {e}",
                parent.display()
            )
        })?;
    }

    let raw = fs::read_to_string(&exclude_path).unwrap_or_default();
    if raw.lines().any(|line| line.trim() == LOCAL_EXCLUDE_ENTRY) {
        return Ok(());
    }

    let mut next = raw;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# Divo local agent state\n");
    next.push_str(LOCAL_EXCLUDE_ENTRY);
    next.push('\n');

    fs::write(&exclude_path, next).map_err(|e| {
        format!(
            "Failed to update git exclude file {}: {e}",
            exclude_path.display()
        )
    })
}

fn resolve_git_info_exclude_path(workspace_dir: &Path) -> Result<Option<PathBuf>, String> {
    let git_path = workspace_dir.join(".git");
    let Ok(meta) = fs::metadata(&git_path) else {
        return Ok(None);
    };

    if meta.is_dir() {
        return Ok(Some(git_path.join("info").join("exclude")));
    }

    if !meta.is_file() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&git_path).map_err(|e| {
        format!(
            "Failed to read git pointer file {}: {e}",
            git_path.display()
        )
    })?;
    let Some(gitdir) = raw
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:").map(str::trim))
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let gitdir_path = Path::new(gitdir);
    let resolved = if gitdir_path.is_absolute() {
        gitdir_path.to_path_buf()
    } else {
        workspace_dir.join(gitdir_path)
    };
    Ok(Some(resolved.join("info").join("exclude")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_workspace_must_exist() {
        let missing =
            std::env::temp_dir().join(format!("divo-missing-workspace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);

        let err = normalize_existing_workspace(&missing)
            .expect_err("missing selected workspace should fail");
        assert!(err.contains("Workspace does not exist"));
    }

    #[test]
    fn default_workspace_is_created() {
        let root =
            std::env::temp_dir().join(format!("divo-default-workspace-{}", std::process::id()));
        let workspace = root.join("workspace");
        let _ = std::fs::remove_dir_all(&root);

        let resolved = normalize_default_workspace(&workspace).unwrap();
        assert!(resolved.is_dir());
        assert!(resolved.ends_with("workspace"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prepare_workspace_run_layout_creates_divo_dirs_and_git_exclude() {
        let root =
            std::env::temp_dir().join(format!("divo-workspace-layout-{}", std::process::id()));
        let workspace = root.join("workspace");
        let git_info = workspace.join(".git/info");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&git_info).unwrap();

        let layout = prepare_workspace_run_layout(&workspace, "thread-1").unwrap();

        assert!(layout.divo_dir.ends_with(".divo"));
        assert!(layout.thread_dir.ends_with(".divo/threads/thread-1"));
        assert!(layout.run_dir.is_dir());
        assert!(layout.tmp_dir.is_dir());
        assert!(layout.scripts_dir.is_dir());
        assert!(layout.artifacts_dir.is_dir());
        assert!(layout.logs_dir.is_dir());
        assert!(layout.tmp_dir.starts_with(&layout.run_dir));
        assert!(layout.scripts_dir.starts_with(&layout.run_dir));
        assert!(layout.logs_dir.starts_with(&layout.run_dir));
        // Deliverables are durable at the workspace root, not under the run tree.
        assert_eq!(layout.artifacts_dir, workspace.join("artifacts"));
        assert!(!layout.artifacts_dir.starts_with(&layout.run_dir));

        let exclude = std::fs::read_to_string(git_info.join("exclude")).unwrap();
        assert!(exclude.lines().any(|line| line.trim() == ".divo/"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cleanup_workspace_thread_layout_removes_only_thread_state() {
        let root = std::env::temp_dir().join(format!("divo-thread-cleanup-{}", std::process::id()));
        let workspace = root.join("workspace");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&workspace).unwrap();

        let target = prepare_workspace_run_layout(&workspace, "thread-a").unwrap();
        let other = prepare_workspace_run_layout(&workspace, "thread-b").unwrap();
        std::fs::write(target.run_dir.join("tmp/file.txt"), "scratch").unwrap();

        cleanup_workspace_thread_layout(&workspace, "thread-a").unwrap();

        assert!(!target.thread_dir.exists());
        assert!(other.thread_dir.exists());
        assert!(workspace.join(".divo").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn divo_thread_id_rejects_path_traversal() {
        let root = std::env::temp_dir().join(format!("divo-thread-invalid-{}", std::process::id()));
        let workspace = root.join("workspace");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&workspace).unwrap();

        let err = prepare_workspace_run_layout(&workspace, "../outside")
            .expect_err("path traversal thread id should fail");
        assert!(err.contains("Invalid Divo thread id"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn git_worktree_pointer_uses_pointed_info_exclude() {
        let root =
            std::env::temp_dir().join(format!("divo-worktree-exclude-{}", std::process::id()));
        let workspace = root.join("workspace");
        let gitdir = root.join("gitdir/worktrees/workspace");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(gitdir.join("info")).unwrap();
        std::fs::write(
            workspace.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();

        prepare_workspace_run_layout(&workspace, "thread-1").unwrap();

        let exclude = std::fs::read_to_string(gitdir.join("info/exclude")).unwrap();
        assert!(exclude.lines().any(|line| line.trim() == ".divo/"));

        let _ = std::fs::remove_dir_all(&root);
    }
}
