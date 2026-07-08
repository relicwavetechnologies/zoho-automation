use std::fs;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;

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
const DIVO_SESSION_CHANGED_EVENT: &str = "divo-session-changed";
const DIVO_OCR_IMAGE_DIR: &str = "divo/ocr-images";
const MAX_BACKEND_OCR_IMAGE_BYTES: u64 = 1_250_000;
const OCR_IMAGE_MAX_EDGE_STEPS: [u32; 5] = [1800, 1500, 1200, 1000, 850];
const OCR_IMAGE_JPEG_QUALITY_STEPS: [u8; 4] = [85, 75, 65, 55];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedImageAttachment {
    path: String,
    file_name: String,
    mime_type: String,
    size: u64,
    normalized: bool,
}

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
    sync_pi_divo_env(app)?;
    emit_divo_session_changed(app, false);
    Ok(())
}

fn expired_session_message() -> String {
    "Divo session expired. Reconnect Divo in Settings > Divo, then retry.".to_string()
}

fn emit_divo_session_changed<R: Runtime>(app: &AppHandle<R>, configured: bool) {
    if let Err(err) = app.emit(
        DIVO_SESSION_CHANGED_EVENT,
        json!({
            "configured": configured,
        }),
    ) {
        log::warn!("divo.session_changed.emit_failed error={err}");
    }
}

fn image_mime_from_name(name: &str) -> Option<&'static str> {
    match Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("gif") => Some("image/gif"),
        Some("jpeg") | Some("jpg") => Some("image/jpeg"),
        Some("png") => Some("image/png"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

fn is_backend_ocr_supported_mime(mime_type: &str) -> bool {
    matches!(
        mime_type.to_ascii_lowercase().as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/webp" | "image/gif"
    )
}

fn safe_stem(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("image");
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    cleaned
        .trim_matches('-')
        .chars()
        .take(60)
        .collect::<String>()
}

fn parse_data_url(data_url: &str) -> Result<(&str, &[u8]), String> {
    let (header, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "Invalid image data URL".to_string())?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return Err("Image data URL must be base64 encoded image data".to_string());
    }
    Ok((header, encoded.as_bytes()))
}

fn decode_base64_image(data_url: &str) -> Result<Vec<u8>, String> {
    let (_, encoded) = parse_data_url(data_url)?;
    general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Failed to decode image data URL: {e}"))
}

fn load_image_bytes(bytes: &[u8]) -> Result<DynamicImage, String> {
    image::load_from_memory(bytes)
        .map_err(|e| format!("Failed to decode image for OCR normalization: {e}"))
}

fn load_image_path(source_path: &Path) -> Result<DynamicImage, String> {
    image::ImageReader::open(source_path)
        .map_err(|e| format!("Failed to open image for OCR normalization: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Failed to detect image format for OCR normalization: {e}"))?
        .decode()
        .map_err(|e| format!("Failed to decode image for OCR normalization: {e}"))
}

fn resize_for_max_edge(image: &DynamicImage, max_edge: u32) -> DynamicImage {
    let (width, height) = image.dimensions();
    let longest_edge = width.max(height);

    if longest_edge <= max_edge || longest_edge == 0 {
        return image.clone();
    }

    let scale = max_edge as f32 / longest_edge as f32;
    let resized_width = ((width as f32 * scale).round() as u32).max(1);
    let resized_height = ((height as f32 * scale).round() as u32).max(1);

    image.resize(resized_width, resized_height, FilterType::Lanczos3)
}

fn write_jpeg(image: &DynamicImage, dest: &Path, quality: u8) -> Result<u64, String> {
    let file = File::create(dest).map_err(|e| format!("Failed to create normalized JPEG: {e}"))?;
    let mut writer = BufWriter::new(file);
    {
        let mut encoder = JpegEncoder::new_with_quality(&mut writer, quality);
        encoder
            .encode_image(image)
            .map_err(|e| format!("Failed to write normalized JPEG: {e}"))?;
    }
    writer
        .flush()
        .map_err(|e| format!("Failed to flush normalized JPEG: {e}"))?;

    fs::metadata(dest)
        .map(|metadata| metadata.len())
        .map_err(|e| format!("Failed to stat normalized image: {e}"))
}

fn save_image_for_backend_ocr(
    image: DynamicImage,
    out_dir: &Path,
    original_file_name: &str,
) -> Result<NormalizedImageAttachment, String> {
    let out_name = format!(
        "{}-{}.jpg",
        safe_stem(original_file_name),
        Uuid::new_v4().simple()
    );
    let out_path = out_dir.join(&out_name);
    let mut last_size = 0;

    for max_edge in OCR_IMAGE_MAX_EDGE_STEPS {
        let resized = resize_for_max_edge(&image, max_edge);
        for quality in OCR_IMAGE_JPEG_QUALITY_STEPS {
            let size = write_jpeg(&resized, &out_path, quality)?;
            last_size = size;
            if size <= MAX_BACKEND_OCR_IMAGE_BYTES {
                return Ok(NormalizedImageAttachment {
                    path: out_path.to_string_lossy().to_string(),
                    file_name: out_name,
                    mime_type: "image/jpeg".to_string(),
                    size,
                    normalized: true,
                });
            }
        }
    }

    Err(format!(
        "Image could not be compressed below {} bytes for OCR; smallest normalized size was {} bytes",
        MAX_BACKEND_OCR_IMAGE_BYTES, last_size
    ))
}

#[tauri::command]
pub fn divo_normalize_image_attachment<R: Runtime>(
    app: AppHandle<R>,
    source_path: Option<String>,
    data_url: Option<String>,
    file_name: String,
    mime_type: Option<String>,
) -> Result<NormalizedImageAttachment, String> {
    let source_path = source_path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    let source_mime = mime_type
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .or_else(|| image_mime_from_name(&file_name))
        .unwrap_or("application/octet-stream")
        .to_string();

    if let Some(path) = source_path.as_deref() {
        if is_backend_ocr_supported_mime(&source_mime) {
            let metadata = fs::metadata(path).map_err(|e| format!("Failed to stat image: {e}"))?;
            if metadata.len() <= MAX_BACKEND_OCR_IMAGE_BYTES {
                return Ok(NormalizedImageAttachment {
                    path: path.to_string(),
                    file_name,
                    mime_type: if source_mime == "image/jpg" {
                        "image/jpeg".to_string()
                    } else {
                        source_mime
                    },
                    size: metadata.len(),
                    normalized: false,
                });
            }
        }
    }

    let data_folder = get_jan_data_folder_path(app);
    let out_dir = data_folder.join(DIVO_OCR_IMAGE_DIR);
    fs::create_dir_all(&out_dir).map_err(|e| format!("Failed to create OCR image cache: {e}"))?;

    let image = if let Some(path) = source_path {
        load_image_path(Path::new(&path))?
    } else if let Some(data_url) = data_url {
        let bytes = decode_base64_image(&data_url)?;
        load_image_bytes(&bytes)?
    } else {
        return Err("Image normalization requires sourcePath or dataUrl".to_string());
    };

    save_image_for_backend_ocr(image, &out_dir, &file_name)
}

async fn best_effort_backend_logout<R: Runtime>(app: &AppHandle<R>) {
    let Ok(Some(session)) = load_divo_session(app) else {
        return;
    };
    let url = format!(
        "{}/api/desktop/auth/logout",
        session.backend_url.trim_end_matches('/')
    );

    match reqwest::Client::new()
        .post(url)
        .bearer_auth(&session.member_token)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() || response.status().as_u16() == 401 => {}
        Ok(response) => {
            log::warn!("divo.logout.backend_failed status={}", response.status());
        }
        Err(err) => {
            log::warn!("divo.logout.backend_failed error={err}");
        }
    }
}

async fn divo_desktop_json_request<R: Runtime>(
    app: &AppHandle<R>,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    label: &str,
) -> Result<Value, String> {
    let session =
        load_divo_session(app)?.ok_or_else(|| "No Divo session configured".to_string())?;
    let url = format!(
        "{}/api/desktop/auth{}",
        session.backend_url.trim_end_matches('/'),
        path
    );
    log::info!("divo.desktop_request.start label={label}");

    let client = reqwest::Client::new();
    let mut request = client
        .request(method, url)
        .bearer_auth(&session.member_token);
    if let Some(body) = body {
        request = request.json(&body);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("{label} request failed: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("{label} response read failed: {e}"))?;
    log::debug!("divo.desktop_request.response label={label} status={status}");

    let parsed: Value = serde_json::from_str(&text)
        .map_err(|e| format!("{label} returned non-JSON (HTTP {status}): {e}"))?;

    if !status.is_success() {
        if status.as_u16() == 401 {
            clear_expired_session(app)?;
            return Err(expired_session_message());
        }
        return Err(format!("{label} returned HTTP {status}: {parsed}"));
    }

    Ok(parsed)
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
    emit_divo_session_changed(&app, true);

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
    best_effort_backend_logout(&app).await;
    clear_divo_session(&app)?;
    sync_pi_divo_env(&app)?;
    emit_divo_session_changed(&app, false);
    Ok(())
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
    emit_divo_session_changed(&app, true);

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

/// Read users/departments/roles and active grants for one Google connection.
#[tauri::command]
pub async fn divo_google_manage_access<R: Runtime>(
    app: AppHandle<R>,
    connection_id: String,
) -> Result<Value, String> {
    let connection_id = connection_id.trim();
    if connection_id.is_empty() {
        return Err("connectionId is required".into());
    }

    divo_desktop_json_request(
        &app,
        reqwest::Method::GET,
        &format!("/google/connections/{connection_id}/manage"),
        None,
        "Google manage access",
    )
    .await
}

/// Grant a user, department, role, or company access to a Google connection.
#[tauri::command]
pub async fn divo_google_grant_access<R: Runtime>(
    app: AppHandle<R>,
    connection_id: String,
    grantee_type: String,
    grantee_id: String,
    access: String,
) -> Result<Value, String> {
    let connection_id = connection_id.trim();
    if connection_id.is_empty() {
        return Err("connectionId is required".into());
    }

    divo_desktop_json_request(
        &app,
        reqwest::Method::POST,
        &format!("/google/connections/{connection_id}/grants"),
        Some(json!({
            "granteeType": grantee_type,
            "granteeId": grantee_id,
            "access": access,
        })),
        "Google grant access",
    )
    .await
}

/// Revoke a grant from a Google connection.
#[tauri::command]
pub async fn divo_google_revoke_access<R: Runtime>(
    app: AppHandle<R>,
    connection_id: String,
    grant_id: String,
) -> Result<Value, String> {
    let connection_id = connection_id.trim();
    let grant_id = grant_id.trim();
    if connection_id.is_empty() || grant_id.is_empty() {
        return Err("connectionId and grantId are required".into());
    }

    divo_desktop_json_request(
        &app,
        reqwest::Method::DELETE,
        &format!("/google/connections/{connection_id}/grants/{grant_id}"),
        None,
        "Google revoke access",
    )
    .await
}

/// Start Zoho OAuth for the stored Divo member session.
#[tauri::command]
pub async fn divo_zoho_authorize_url<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let parsed = divo_desktop_json_request(
        &app,
        reqwest::Method::GET,
        "/zoho/authorize-url",
        None,
        "Zoho authorize URL",
    )
    .await?;

    let authorize_url = parsed
        .get("data")
        .and_then(|data| data.get("authorizeUrl"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("Zoho authorize URL response missing data.authorizeUrl: {parsed}")
        })?;

    Ok(authorize_url.to_string())
}

/// Read Zoho connection status for the stored Divo member session.
#[tauri::command]
pub async fn divo_zoho_status<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    divo_desktop_json_request(
        &app,
        reqwest::Method::GET,
        "/zoho/status",
        None,
        "Zoho status",
    )
    .await
}

/// Disconnect the company Zoho connection.
#[tauri::command]
pub async fn divo_zoho_unlink<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    divo_desktop_json_request(
        &app,
        reqwest::Method::POST,
        "/zoho/unlink",
        None,
        "Zoho unlink",
    )
    .await
}

/// Read users/departments/roles and active grants for one Zoho connection.
#[tauri::command]
pub async fn divo_zoho_manage_access<R: Runtime>(
    app: AppHandle<R>,
    connection_id: String,
) -> Result<Value, String> {
    let connection_id = connection_id.trim();
    if connection_id.is_empty() {
        return Err("connectionId is required".into());
    }

    divo_desktop_json_request(
        &app,
        reqwest::Method::GET,
        &format!("/zoho/connections/{connection_id}/manage"),
        None,
        "Zoho manage access",
    )
    .await
}

/// Grant a user, department, role, or company access to a Zoho connection.
#[tauri::command]
pub async fn divo_zoho_grant_access<R: Runtime>(
    app: AppHandle<R>,
    connection_id: String,
    grantee_type: String,
    grantee_id: String,
    access: String,
) -> Result<Value, String> {
    let connection_id = connection_id.trim();
    if connection_id.is_empty() {
        return Err("connectionId is required".into());
    }

    divo_desktop_json_request(
        &app,
        reqwest::Method::POST,
        &format!("/zoho/connections/{connection_id}/grants"),
        Some(json!({
            "granteeType": grantee_type,
            "granteeId": grantee_id,
            "access": access,
        })),
        "Zoho grant access",
    )
    .await
}

/// Revoke a grant from a Zoho connection.
#[tauri::command]
pub async fn divo_zoho_revoke_access<R: Runtime>(
    app: AppHandle<R>,
    connection_id: String,
    grant_id: String,
) -> Result<Value, String> {
    let connection_id = connection_id.trim();
    let grant_id = grant_id.trim();
    if connection_id.is_empty() || grant_id.is_empty() {
        return Err("connectionId and grantId are required".into());
    }

    divo_desktop_json_request(
        &app,
        reqwest::Method::DELETE,
        &format!("/zoho/connections/{connection_id}/grants/{grant_id}"),
        None,
        "Zoho revoke access",
    )
    .await
}
