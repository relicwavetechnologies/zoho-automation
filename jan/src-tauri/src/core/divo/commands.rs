use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::pi::env::write_divo_env_file;

use super::session::{
    clear_divo_session, load_divo_session, save_divo_session, DivoDepartment, DivoSession,
};
use super::workspace::{
    clear_selected_workspace_path, save_selected_workspace_path, workspace_status,
    DivoWorkspaceStatus,
};

const PI_AGENT_DIR: &str = "pi-agent";

fn pi_agent_dir(data_folder: &std::path::Path) -> PathBuf {
    data_folder.join(PI_AGENT_DIR)
}

fn sync_pi_divo_env<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let data_folder = get_jan_data_folder_path(app.clone());
    let agent_dir = pi_agent_dir(&data_folder);

    if let Some(session) = load_divo_session(app)? {
        write_divo_env_file(
            &agent_dir,
            &session.backend_url,
            &session.member_token,
            session.department_id.as_deref(),
        )?;
    } else if agent_dir.join("divo.env").exists() {
        fs::remove_file(agent_dir.join("divo.env")).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn clear_expired_session<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    clear_divo_session(app)?;
    sync_pi_divo_env(app)
}

fn expired_session_message() -> String {
    "Divo session expired. Reconnect Divo in Settings > Divo, then retry.".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DivoSessionStatus {
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_url: Option<String>,
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
    pub departments: Vec<DivoDepartment>,
}

/// Persist backend member session and sync `pi-agent/divo.env` for bundled Pi.
#[tauri::command]
pub async fn divo_set_session<R: Runtime>(
    app: AppHandle<R>,
    backend_url: String,
    member_token: String,
    department_id: Option<String>,
    email: Option<String>,
    name: Option<String>,
    user_id: Option<String>,
    company_id: Option<String>,
    role: Option<String>,
    expires_at: Option<String>,
    departments: Option<Vec<DivoDepartment>>,
) -> Result<DivoSessionStatus, String> {
    let session = DivoSession {
        backend_url: backend_url.trim().trim_end_matches('/').to_string(),
        member_token: member_token.trim().to_string(),
        department_id: department_id
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        email: email
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        name: name.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        user_id,
        company_id,
        role: role.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        expires_at,
        departments: departments.unwrap_or_default(),
    };

    if session.backend_url.is_empty() || session.member_token.is_empty() {
        return Err("backendUrl and memberToken are required".into());
    }

    save_divo_session(&app, &session)?;
    sync_pi_divo_env(&app)?;

    Ok(DivoSessionStatus {
        configured: true,
        backend_url: Some(session.backend_url),
        department_id: session.department_id,
        email: session.email,
        name: session.name,
        user_id: session.user_id,
        company_id: session.company_id,
        role: session.role,
        expires_at: session.expires_at,
        departments: session.departments,
    })
}

/// Clear stored member session and remove Pi gateway env file.
#[tauri::command]
pub async fn divo_clear_session<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    clear_divo_session(&app)?;
    sync_pi_divo_env(&app)
}

/// Return whether a backend session is configured (token is never returned).
#[tauri::command]
pub async fn divo_get_session_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<DivoSessionStatus, String> {
    let session = load_divo_session(&app)?;
    Ok(match session {
        Some(s) => DivoSessionStatus {
            configured: true,
            backend_url: Some(s.backend_url),
            department_id: s.department_id,
            email: s.email,
            name: s.name,
            user_id: s.user_id,
            company_id: s.company_id,
            role: s.role,
            expires_at: s.expires_at,
            departments: s.departments,
        },
        None => DivoSessionStatus {
            configured: false,
            backend_url: None,
            department_id: None,
            email: None,
            name: None,
            user_id: None,
            company_id: None,
            role: None,
            expires_at: None,
            departments: Vec::new(),
        },
    })
}

/// Change the default department context used by Pi gateway calls.
#[tauri::command]
pub async fn divo_set_department<R: Runtime>(
    app: AppHandle<R>,
    department_id: Option<String>,
) -> Result<DivoSessionStatus, String> {
    let mut session =
        load_divo_session(&app)?.ok_or_else(|| "No Divo session configured".to_string())?;

    let next_department_id = department_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    if let Some(ref id) = next_department_id {
        let known_departments = !session.departments.is_empty();
        let is_known = session.departments.iter().any(|dept| dept.id == *id);
        if known_departments && !is_known {
            return Err("Unknown Divo department".into());
        }
    }

    session.department_id = next_department_id;
    save_divo_session(&app, &session)?;
    sync_pi_divo_env(&app)?;

    Ok(DivoSessionStatus {
        configured: true,
        backend_url: Some(session.backend_url),
        department_id: session.department_id,
        email: session.email,
        name: session.name,
        user_id: session.user_id,
        company_id: session.company_id,
        role: session.role,
        expires_at: session.expires_at,
        departments: session.departments,
    })
}

/// Re-write `pi-agent/divo.env` from stored session (e.g. before Pi start).
#[tauri::command]
pub async fn divo_sync_pi_env<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    sync_pi_divo_env(&app)
}

/// Return the Divo home/workspace layout used by Pi.
#[tauri::command]
pub async fn divo_get_workspace_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<DivoWorkspaceStatus, String> {
    workspace_status(&app)
}

/// Persist the user-selected Pi workspace folder.
#[tauri::command]
pub async fn divo_set_workspace_path<R: Runtime>(
    app: AppHandle<R>,
    workspace_path: String,
) -> Result<DivoWorkspaceStatus, String> {
    save_selected_workspace_path(&app, workspace_path)
}

/// Clear the user-selected workspace and fall back to `~/.divo/workspace`.
#[tauri::command]
pub async fn divo_clear_workspace_path<R: Runtime>(
    app: AppHandle<R>,
) -> Result<DivoWorkspaceStatus, String> {
    clear_selected_workspace_path(&app)
}

/// Call the Divo gateway with the stored member session. The web layer never
/// receives the member token; it only receives the backend's structured result.
#[tauri::command]
pub async fn divo_gateway_request<R: Runtime>(
    app: AppHandle<R>,
    op: String,
    department_id: Option<String>,
    payload: Option<Value>,
) -> Result<Value, String> {
    let session =
        load_divo_session(&app)?.ok_or_else(|| "No Divo session configured".to_string())?;

    let mut body = json!({
        "op": op,
        "payload": payload.unwrap_or_else(|| json!({})),
    });
    if let Some(id) = department_id
        .or_else(|| session.department_id.clone())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        body["departmentId"] = Value::String(id);
    }

    let url = format!("{}/api/gateway", session.backend_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(session.member_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Divo gateway request failed: {e}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Divo gateway response read failed: {e}"))?;
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Divo gateway returned non-JSON (HTTP {status}): {e}"))?;

    if !status.is_success() {
        if status.as_u16() == 401 {
            clear_expired_session(&app)?;
            return Err(expired_session_message());
        }
        return Err(format!("Divo gateway returned HTTP {status}: {parsed}"));
    }

    Ok(parsed)
}

/// Start Google OAuth for the stored Divo member session. The web layer receives
/// only the public Google authorize URL; the backend member token stays in Rust.
#[tauri::command]
pub async fn divo_google_authorize_url<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let session =
        load_divo_session(&app)?.ok_or_else(|| "No Divo session configured".to_string())?;

    let url = format!(
        "{}/api/desktop/auth/google/authorize-url",
        session.backend_url.trim_end_matches('/')
    );
    log::info!("divo.google_authorize_url.start");

    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(&session.member_token)
        .send()
        .await
        .map_err(|e| format!("Google authorize URL request failed: {e}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Google authorize URL response read failed: {e}"))?;
    log::debug!("divo.google_authorize_url.response status={status}");

    let parsed: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Google authorize URL returned non-JSON (HTTP {status}): {e}"))?;

    if !status.is_success() {
        if status.as_u16() == 401 {
            clear_expired_session(&app)?;
            return Err(expired_session_message());
        }
        return Err(format!(
            "Google authorize URL returned HTTP {status}: {parsed}"
        ));
    }

    let authorize_url = parsed
        .get("data")
        .and_then(|data| data.get("authorizeUrl"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("Google authorize URL response missing data.authorizeUrl: {parsed}")
        })?;

    log::info!("divo.google_authorize_url.ok");
    Ok(authorize_url.to_string())
}

/// Read Google connection status for the stored Divo member session.
#[tauri::command]
pub async fn divo_google_status<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    let session =
        load_divo_session(&app)?.ok_or_else(|| "No Divo session configured".to_string())?;

    let url = format!(
        "{}/api/desktop/auth/google/status",
        session.backend_url.trim_end_matches('/')
    );
    log::info!("divo.google_status.start");

    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(&session.member_token)
        .send()
        .await
        .map_err(|e| format!("Google status request failed: {e}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Google status response read failed: {e}"))?;
    log::debug!("divo.google_status.response status={status}");

    let parsed: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Google status returned non-JSON (HTTP {status}): {e}"))?;

    if !status.is_success() {
        if status.as_u16() == 401 {
            clear_expired_session(&app)?;
            return Err(expired_session_message());
        }
        return Err(format!("Google status returned HTTP {status}: {parsed}"));
    }

    log::info!("divo.google_status.ok");
    Ok(parsed)
}
