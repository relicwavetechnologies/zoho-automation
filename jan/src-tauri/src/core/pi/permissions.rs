use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_NAME: &str = "divo-settings.json";
const PERSISTENT_BASH_ALLOW_KEY: &str = "pi_persistent_bash_allow";

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
