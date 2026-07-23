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
use manager::{
    default_runtime_pool_capacity, PiManager, MAX_RUNTIME_POOL_CAPACITY, MIN_RUNTIME_POOL_CAPACITY,
};
use permissions::{load_runtime_pool_capacity, save_runtime_pool_capacity};
use runtime::PiRuntimeMode;
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
    runtime_mode: Option<String>,
) -> Result<(), String> {
    let runtime_mode = PiRuntimeMode::parse(runtime_mode.as_deref())?;
    if runtime_mode == PiRuntimeMode::Company {
        divo_sync_pi_env(app.clone()).await?;
    }
    if let Some(capacity) = load_runtime_pool_capacity(&app)? {
        // A lower saved limit never interrupts a live run. If pi_start is
        // called during active work, it remains pending until a clean restart.
        let _ = state.manager.set_runtime_pool_capacity(capacity).await?;
    }
    let data_folder = get_jan_data_folder_path(app.clone());
    let scratch_dir = data_folder.join(PI_SCRATCH_DIR);
    let workspace_dir = resolve_workspace_dir_for_app(&app, workspace_path)?;
    state
        .manager
        .start(
            app,
            data_folder,
            scratch_dir,
            workspace_dir,
            runtime_mode,
            thread_id,
        )
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
    thinking_level: Option<String>,
    profile: Option<String>,
    teach_session_id: Option<String>,
    department_id: Option<String>,
) -> Result<(), String> {
    state
        .manager
        .prompt_with_model(
            thread_id,
            run_id,
            message,
            provider,
            model_id,
            thinking_level,
            profile,
            teach_session_id,
            department_id,
        )
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

/// Read the persisted desired physical-worker limit and the manager's current
/// effective ceiling. Logical chats remain independent even when workers wait.
#[tauri::command]
pub async fn pi_get_parallelism(
    state: State<'_, PiState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "configuredCapacity": load_runtime_pool_capacity(&app)?,
        "effectiveCapacity": state.manager.runtime_pool_capacity().await,
        "defaultCapacity": default_runtime_pool_capacity(),
        "minCapacity": MIN_RUNTIME_POOL_CAPACITY,
        "maxCapacity": MAX_RUNTIME_POOL_CAPACITY,
    }))
}

/// Persist a bounded Pi-worker ceiling. Raising capacity applies immediately;
/// lowering it waits for a clean restart if any agent is currently active.
#[tauri::command]
pub async fn pi_set_parallelism(
    state: State<'_, PiState>,
    app: AppHandle,
    capacity: usize,
) -> Result<serde_json::Value, String> {
    save_runtime_pool_capacity(&app, capacity)?;
    let applied = state.manager.set_runtime_pool_capacity(capacity).await?;
    Ok(serde_json::json!({
        "configuredCapacity": capacity,
        "effectiveCapacity": state.manager.runtime_pool_capacity().await,
        "applied": applied,
        "restartRequired": !applied,
        "minCapacity": MIN_RUNTIME_POOL_CAPACITY,
        "maxCapacity": MAX_RUNTIME_POOL_CAPACITY,
    }))
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
    always_allow_full_access: Option<bool>,
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
            always_allow_full_access.unwrap_or(false),
        )
        .await
}

/// Clear in-memory local approval choices when their owning chat is deleted.
#[tauri::command]
pub async fn pi_forget_chat_approvals(
    state: State<'_, PiState>,
    thread_id: String,
) -> Result<(), String> {
    state.manager.forget_chat_approvals(&thread_id).await
}

pub fn init() -> PiState {
    PiState {
        manager: Arc::new(PiManager::new()),
    }
}
