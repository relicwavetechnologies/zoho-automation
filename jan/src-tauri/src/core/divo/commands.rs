use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::pi::env::write_divo_env_file;

use super::session::{
    clear_divo_session, load_divo_session, save_divo_session, DivoDepartment, DivoSession,
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
    expires_at: Option<String>,
    departments: Option<Vec<DivoDepartment>>,
) -> Result<DivoSessionStatus, String> {
    let session = DivoSession {
        backend_url: backend_url.trim().trim_end_matches('/').to_string(),
        member_token: member_token.trim().to_string(),
        department_id: department_id
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        email: email.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        name: name.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        user_id,
        company_id,
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
    let mut session = load_divo_session(&app)?
        .ok_or_else(|| "No Divo session configured".to_string())?;

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
        expires_at: session.expires_at,
        departments: session.departments,
    })
}

/// Re-write `pi-agent/divo.env` from stored session (e.g. before Pi start).
#[tauri::command]
pub async fn divo_sync_pi_env<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    sync_pi_divo_env(&app)
}
