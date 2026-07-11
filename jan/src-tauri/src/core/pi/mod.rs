mod browser;
pub mod env;
mod manager;
mod runtime;
pub mod session;

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::divo::commands::divo_sync_pi_env;
use crate::core::divo::workspace::resolve_workspace_dir_for_app;
use manager::PiManager;
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Scratch directory for Pi-internal fork/clone sessions (not per-thread memory).
const PI_SCRATCH_DIR: &str = "pi-sessions";

/// Application state for the Pi bridge
pub struct PiState {
    pub manager: Arc<PiManager>,
}

/// Start the Pi RPC process (idempotent).
#[tauri::command]
pub async fn pi_start(
    state: State<'_, PiState>,
    app: AppHandle,
    workspace_path: Option<String>,
    thread_id: Option<String>,
) -> Result<(), String> {
    let _ = divo_sync_pi_env(app.clone()).await;
    let data_folder = get_jan_data_folder_path(app.clone());
    let scratch_dir = data_folder.join(PI_SCRATCH_DIR);
    let workspace_dir = resolve_workspace_dir_for_app(&app, workspace_path)?;
    state
        .manager
        .start(app, data_folder, scratch_dir, workspace_dir, thread_id)
        .await
}

/// Ensure a Jan thread has an active Pi session (new or switch).
#[tauri::command]
pub async fn pi_ensure_thread(state: State<'_, PiState>, thread_id: String) -> Result<(), String> {
    state.manager.ensure_thread(thread_id).await
}

/// Send a user prompt to Pi for the given Jan thread.
#[tauri::command]
pub async fn pi_prompt(
    state: State<'_, PiState>,
    thread_id: String,
    message: String,
) -> Result<(), String> {
    state.manager.prompt(thread_id, message).await
}

/// Abort the current Pi agent run.
#[tauri::command]
pub async fn pi_abort(state: State<'_, PiState>) -> Result<(), String> {
    state.manager.abort().await
}

/// Stop the Pi RPC process.
#[tauri::command]
pub async fn pi_stop(state: State<'_, PiState>) -> Result<(), String> {
    state.manager.stop().await;
    Ok(())
}

/// Whether the Pi RPC process is running.
#[tauri::command]
pub async fn pi_is_running(state: State<'_, PiState>) -> Result<bool, String> {
    Ok(state.manager.is_running().await)
}

/// Return Pi session state for debugging.
#[tauri::command]
pub async fn pi_get_state(state: State<'_, PiState>) -> Result<serde_json::Value, String> {
    state.manager.get_state().await
}

/// Resolve a pending named Pi extension UI request for the active Jan thread.
#[tauri::command]
pub async fn pi_extension_ui_respond(
    state: State<'_, PiState>,
    request_id: String,
    thread_id: String,
    confirmed: Option<bool>,
    value: Option<String>,
    cancelled: Option<bool>,
    always_allow_bash: Option<bool>,
) -> Result<(), String> {
    state.manager.extension_ui_response(
        request_id,
        thread_id,
        confirmed,
        value,
        cancelled.unwrap_or(false),
        always_allow_bash.unwrap_or(false),
    )
}

/// Revoke the memory-only Bash grant when the user leaves or stops a task.
#[tauri::command]
pub async fn pi_revoke_bash_approval(
    state: State<'_, PiState>,
    thread_id: String,
) -> Result<(), String> {
    state.manager.revoke_bash_approval(&thread_id);
    Ok(())
}

/// Read the task-scoped local permission rules shown by the desktop composer.
#[tauri::command]
pub async fn pi_get_permission_rules(
    state: State<'_, PiState>,
    thread_id: String,
) -> Result<serde_json::Value, String> {
    if thread_id.trim().is_empty() {
        return Err("A task id is required to read permission rules".into());
    }
    Ok(serde_json::json!({
        "bashAlwaysAllow": state.manager.bash_approval_allowed(&thread_id)
    }))
}

/// Update the Bash rule directly from the explicit Permission Rules UI.
#[tauri::command]
pub async fn pi_set_bash_approval_rule(
    state: State<'_, PiState>,
    thread_id: String,
    allowed: bool,
) -> Result<(), String> {
    if thread_id.trim().is_empty() {
        return Err("A task id is required to update permission rules".into());
    }
    state.manager.set_bash_approval_rule(&thread_id, allowed);
    Ok(())
}

pub fn init() -> PiState {
    PiState {
        manager: Arc::new(PiManager::new()),
    }
}
