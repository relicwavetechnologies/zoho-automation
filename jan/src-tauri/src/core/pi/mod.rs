mod browser;
pub mod env;
mod manager;
mod permissions;
mod run_context;
mod runtime;
pub mod session;

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::divo::commands::divo_sync_pi_env;
use crate::core::divo::workspace::resolve_workspace_dir_for_app;
use manager::PiManager;
use permissions::{load_persistent_bash_allow, save_persistent_bash_allow};
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
    let persistent_bash_allow = load_persistent_bash_allow(&app)?;
    state
        .manager
        .set_persistent_bash_approval(persistent_bash_allow)
        .await;
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

/// Send a user prompt to Pi for a thread/run pair.
///
/// `run_id` is the caller-generated identity for this invocation. Abort and
/// extension-UI responses must reuse the same pair; Rust rejects stale pairs.
#[tauri::command]
pub async fn pi_prompt(
    state: State<'_, PiState>,
    thread_id: String,
    run_id: String,
    message: String,
    provider: Option<String>,
    model_id: Option<String>,
) -> Result<(), String> {
    state
        .manager
        .prompt_with_model(thread_id, run_id, message, provider, model_id)
        .await
}

/// Abort exactly the active Pi thread/run pair.
#[tauri::command]
pub async fn pi_abort(
    state: State<'_, PiState>,
    thread_id: String,
    run_id: String,
) -> Result<(), String> {
    state.manager.abort(thread_id, run_id).await
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

/// Return manager-owned pool diagnostics without changing Pi's get_state RPC shape.
#[tauri::command]
pub async fn pi_get_pool_state(state: State<'_, PiState>) -> Result<serde_json::Value, String> {
    Ok(state.manager.get_pool_state().await)
}

/// Switch the model Pi uses (e.g. deepseek-v4-flash / deepseek-v4-pro). The
/// desktop calls this when the user flips the model toggle and again after each
/// runtime starts, so the preferred model is used on every run.
#[tauri::command]
pub async fn pi_set_model(
    state: State<'_, PiState>,
    provider: String,
    model_id: String,
) -> Result<(), String> {
    state.manager.set_model(provider, model_id).await
}

/// Resolve a pending named Pi extension UI request for its owning thread/run
/// pair. A response for an earlier run is rejected.
#[tauri::command]
pub async fn pi_extension_ui_respond(
    state: State<'_, PiState>,
    request_id: String,
    thread_id: String,
    run_id: String,
    confirmed: Option<bool>,
    value: Option<String>,
    cancelled: Option<bool>,
    always_allow_bash: Option<bool>,
) -> Result<(), String> {
    state
        .manager
        .extension_ui_response(
            request_id,
            thread_id,
            run_id,
            confirmed,
            value,
            cancelled.unwrap_or(false),
            always_allow_bash.unwrap_or(false),
        )
        .await
}

/// Revoke the memory-only Bash grant when the user leaves or stops a task.
#[tauri::command]
pub async fn pi_revoke_bash_approval(
    state: State<'_, PiState>,
    thread_id: String,
) -> Result<(), String> {
    state.manager.revoke_bash_approval(&thread_id).await;
    Ok(())
}

/// Read the persisted device-level permission rules shown by the desktop composer.
#[tauri::command]
pub async fn pi_get_permission_rules(
    state: State<'_, PiState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let bash_always_allow = load_persistent_bash_allow(&app)?;
    state
        .manager
        .set_persistent_bash_approval(bash_always_allow)
        .await;
    Ok(serde_json::json!({
        "bashAlwaysAllow": bash_always_allow,
        "scope": "device"
    }))
}

/// Persist the Bash approval mode until the user explicitly changes it.
#[tauri::command]
pub async fn pi_set_persistent_bash_approval(
    state: State<'_, PiState>,
    app: AppHandle,
    allowed: bool,
) -> Result<(), String> {
    save_persistent_bash_allow(&app, allowed)?;
    state.manager.set_persistent_bash_approval(allowed).await;
    Ok(())
}

/// Update only the temporary active-run Bash rule.
#[tauri::command]
pub async fn pi_set_bash_approval_rule(
    state: State<'_, PiState>,
    thread_id: String,
    allowed: bool,
) -> Result<(), String> {
    if thread_id.trim().is_empty() {
        return Err("A task id is required to update permission rules".into());
    }
    state
        .manager
        .set_bash_approval_rule(&thread_id, allowed)
        .await;
    Ok(())
}

pub fn init() -> PiState {
    PiState {
        manager: Arc::new(PiManager::new()),
    }
}
