use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_NAME: &str = "divo-settings.json";
const PERSISTENT_BASH_ALLOW_KEY: &str = "pi_persistent_bash_allow";
const RUNTIME_POOL_CAPACITY_KEY: &str = "pi_runtime_pool_capacity";

pub fn load_persistent_bash_allow(app: &AppHandle) -> Result<bool, String> {
    let store = app.store(STORE_NAME).map_err(|error| error.to_string())?;
    Ok(store
        .get(PERSISTENT_BASH_ALLOW_KEY)
        .and_then(|value| value.as_bool())
        .unwrap_or(false))
}

pub fn save_persistent_bash_allow(app: &AppHandle, allowed: bool) -> Result<(), String> {
    let store = app.store(STORE_NAME).map_err(|error| error.to_string())?;
    store.set(PERSISTENT_BASH_ALLOW_KEY, serde_json::json!(allowed));
    store.save().map_err(|error| error.to_string())
}

/// Invalid legacy/manual store values intentionally fall back to the manager's
/// adaptive default rather than allowing a malformed preference to prevent all
/// Pi runs from starting.
pub fn load_runtime_pool_capacity(app: &AppHandle) -> Result<Option<usize>, String> {
    let store = app.store(STORE_NAME).map_err(|error| error.to_string())?;
    Ok(store
        .get(RUNTIME_POOL_CAPACITY_KEY)
        .and_then(|value| value.as_u64())
        .and_then(|value| usize::try_from(value).ok())
        .filter(|capacity| {
            super::manager::validate_runtime_pool_capacity(*capacity).is_ok()
        }))
}

pub fn save_runtime_pool_capacity(app: &AppHandle, capacity: usize) -> Result<(), String> {
    super::manager::validate_runtime_pool_capacity(capacity)?;
    let store = app.store(STORE_NAME).map_err(|error| error.to_string())?;
    store.set(RUNTIME_POOL_CAPACITY_KEY, serde_json::json!(capacity));
    store.save().map_err(|error| error.to_string())
}
