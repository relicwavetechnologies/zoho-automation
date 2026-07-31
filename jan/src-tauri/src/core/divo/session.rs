use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const STORE_NAME: &str = "divo-session.json";
const SESSION_KEY: &str = "member_session";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DivoDepartment {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DivoSession {
    pub backend_url: String,
    pub member_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub department_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub departments: Vec<DivoDepartment>,
}

pub fn load_divo_session<R: Runtime>(app: &AppHandle<R>) -> Result<Option<DivoSession>, String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    let Some(value) = store.get(SESSION_KEY) else {
        return Ok(None);
    };
    serde_json::from_value(value)
        .map(Some)
        .map_err(|e| e.to_string())
}

pub fn save_divo_session<R: Runtime>(
    app: &AppHandle<R>,
    session: &DivoSession,
) -> Result<(), String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    let value = serde_json::to_value(session).map_err(|e| e.to_string())?;
    store.set(SESSION_KEY, value);
    store.save().map_err(|e| e.to_string())
}

pub fn clear_divo_session<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    store.delete(SESSION_KEY);
    store.save().map_err(|e| e.to_string())
}
