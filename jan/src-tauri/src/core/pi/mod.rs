mod browser;
pub mod env;
mod manager;
mod runtime;
mod session;

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::divo::commands::divo_sync_pi_env;
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
pub async fn pi_start(state: State<'_, PiState>, app: AppHandle) -> Result<(), String> {
    let _ = divo_sync_pi_env(app.clone()).await;
    let data_folder = get_jan_data_folder_path(app.clone());
    let scratch_dir = data_folder.join(PI_SCRATCH_DIR);
    state.manager.start(app, data_folder, scratch_dir).await
}

/// Ensure a Jan thread has an active Pi session (new or switch).
#[tauri::command]
pub async fn pi_ensure_thread(
    state: State<'_, PiState>,
    thread_id: String,
) -> Result<(), String> {
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
pub async fn pi_get_state(
    state: State<'_, PiState>,
) -> Result<serde_json::Value, String> {
    state.manager.get_state().await
}

pub fn init() -> PiState {
    PiState {
        manager: Arc::new(PiManager::new()),
    }
}
