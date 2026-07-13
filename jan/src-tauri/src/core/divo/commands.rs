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

use super::runtime_context::{
    clear_runtime_context, runtime_context_path, write_runtime_context, DivoRuntimeContext,
};
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
        let runtime_context = runtime_context_path(&agent_dir);
        write_divo_env_file(
            &agent_dir,
            &session.backend_url,
            &session.member_token,
            session.department_id.as_deref(),
            &runtime_context,
        )?;
    } else {
        if agent_dir.join("divo.env").exists() {
            fs::remove_file(agent_dir.join("divo.env")).map_err(|e| e.to_string())?;
        }
        clear_runtime_context(&runtime_context_path(&agent_dir))?;
    }

    Ok(())
}

fn clear_cached_runtime_context<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let data_folder = get_jan_data_folder_path(app.clone());
    clear_runtime_context(&runtime_context_path(&pi_agent_dir(&data_folder)))
}

fn member_department_names(session: &DivoSession) -> Vec<String> {
    let mut names = Vec::new();
    for department in &session.departments {
        let name = department.name.trim();
        if !name.is_empty() && !names.iter().any(|existing| existing == name) {
            names.push(name.to_string());
        }
    }
    names
}

fn member_departments_runtime_context(session: &DivoSession) -> DivoRuntimeContext {
    DivoRuntimeContext {
        department_id: None,
        department_name: None,
        persona_prompt: String::new(),
        version: None,
        departments: member_department_names(session),
        capability_bootstrap: None,
    }
}

async fn refresh_runtime_context<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let data_folder = get_jan_data_folder_path(app.clone());
    let context_path = runtime_context_path(&pi_agent_dir(&data_folder));

    let session =
        load_divo_session(app)?.ok_or_else(|| "No Divo session configured".to_string())?;
    let member_context = member_departments_runtime_context(&session);

    let result = async {
        let Some(department_id) = session.department_id.as_deref() else {
            return write_runtime_context(&context_path, &member_context);
        };

        let response = divo_desktop_json_request(
            app,
            reqwest::Method::GET,
            &format!("/runtime-context?departmentId={department_id}"),
            None,
            "Divo runtime context refresh",
        )
        .await?;

        let data = response
            .get("data")
            .cloned()
            .ok_or_else(|| "Divo runtime context response is missing data".to_string())?;
        let mut context: DivoRuntimeContext = serde_json::from_value(data)
            .map_err(|e| format!("Divo runtime context response is invalid: {e}"))?;

        if context.department_id.as_deref() != Some(department_id) {
            return Err(
                "Divo runtime context department does not match the active session department"
                    .to_string(),
            );
        }

        // The department directory is local authenticated-session context, not
        // backend persona data. Keep only names so Pi can use them as recall
        // ranking hints; it never receives department identifiers here.
        context.departments = member_context.departments.clone();
        write_runtime_context(&context_path, &context)
    }
    .await;

    // A cached persona is authority-scoped data. Never keep it after its
    // freshness or department binding can no longer be verified. The
    // authenticated member's department names remain safe local context and
    // must survive so recall can still rank them after a failed persona fetch.
    if result.is_err() {
        write_runtime_context(&context_path, &member_context)?;
    }

    result
}

fn is_runtime_context_access_denied(error: &str) -> bool {
    error.starts_with("Divo runtime context refresh returned HTTP 403")
        || error.starts_with("Divo runtime context refresh returned non-JSON (HTTP 403")
}

async fn clear_unavailable_department<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(mut session) = load_divo_session(app)? else {
        return Ok(());
    };

    let Some(department_id) = session.department_id.take() else {
        return Ok(());
    };

    session
        .departments
        .retain(|department| department.id != department_id);
    save_divo_session(app, &session)?;
    refresh_runtime_context(app).await?;
    sync_pi_divo_env(app)
}

fn clear_expired_session<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    clear_divo_session(app)?;
    sync_pi_divo_env(app)?;
    emit_divo_session_changed(app, false);
    Ok(())
}

fn expired_session_message() -> String {
    "Divo session expired. Sign in again to continue.".to_string()
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

async fn divo_member_json_request<R: Runtime>(
    app: &AppHandle<R>,
    api_base_path: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    label: &str,
) -> Result<Value, String> {
    let session =
        load_divo_session(app)?.ok_or_else(|| "No Divo session configured".to_string())?;
    let url = format!(
        "{}{}{}",
        session.backend_url.trim_end_matches('/'),
        api_base_path,
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

async fn divo_desktop_json_request<R: Runtime>(
    app: &AppHandle<R>,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    label: &str,
) -> Result<Value, String> {
    divo_member_json_request(app, "/api/desktop/auth", method, path, body, label).await
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub departments: Vec<DivoDepartment>,
}

fn disconnected_session_status() -> DivoSessionStatus {
    DivoSessionStatus {
        configured: false,
        backend_url: None,
        department_id: None,
        email: None,
        name: None,
        user_id: None,
        company_id: None,
        role: None,
        expires_at: None,
        avatar_url: None,
        departments: Vec::new(),
    }
}

fn session_status(session: DivoSession) -> DivoSessionStatus {
    DivoSessionStatus {
        configured: true,
        backend_url: Some(session.backend_url),
        department_id: session.department_id,
        email: session.email,
        name: session.name,
        user_id: session.user_id,
        company_id: session.company_id,
        role: session.role,
        expires_at: session.expires_at,
        avatar_url: session.avatar_url,
        departments: session.departments,
    }
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
    avatar_url: Option<String>,
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
        avatar_url: avatar_url
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        departments: departments.unwrap_or_default(),
    };

    if session.backend_url.is_empty() || session.member_token.is_empty() {
        return Err("backendUrl and memberToken are required".into());
    }

    // A newly issued session must never inherit a previous member's persona.
    clear_cached_runtime_context(&app)?;
    save_divo_session(&app, &session)?;
    if let Err(error) = refresh_runtime_context(&app).await {
        log::warn!("divo.runtime_context.refresh_failed after=login error={error}");
    }
    sync_pi_divo_env(&app)?;
    emit_divo_session_changed(&app, true);

    Ok(session_status(session))
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
    Ok(load_divo_session(&app)?
        .map(session_status)
        .unwrap_or_else(disconnected_session_status))
}

/// Verify that the locally stored Divo member session is still accepted by the
/// backend. A 401 clears the local session and notifies the desktop gate.
#[tauri::command]
pub async fn divo_validate_session<R: Runtime>(
    app: AppHandle<R>,
) -> Result<DivoSessionStatus, String> {
    if load_divo_session(&app)?.is_none() {
        return Ok(disconnected_session_status());
    }

    let response = divo_desktop_json_request(
        &app,
        reqwest::Method::GET,
        "/me",
        None,
        "Divo session validation",
    )
    .await?;

    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("Divo session validation returned an unsuccessful response".into());
    }

    if let Err(error) = refresh_runtime_context(&app).await {
        log::warn!("divo.runtime_context.refresh_failed after=session_validation error={error}");
        if is_runtime_context_access_denied(&error) {
            clear_unavailable_department(&app).await?;
            emit_divo_session_changed(&app, true);
        }
    }

    divo_get_session_status(app).await
}

#[cfg(test)]
mod tests {
    use super::{
        department_management_request, is_runtime_context_access_denied,
        member_departments_runtime_context, DepartmentManagementOperation, DivoDepartment,
        DivoSession,
    };
    use serde_json::json;

    #[test]
    fn recognizes_runtime_context_access_denied() {
        assert!(is_runtime_context_access_denied(
            "Divo runtime context refresh returned HTTP 403 Forbidden: {}"
        ));
        assert!(is_runtime_context_access_denied(
            "Divo runtime context refresh returned non-JSON (HTTP 403 Forbidden): invalid response"
        ));
        assert!(!is_runtime_context_access_denied(
            "Divo runtime context refresh returned HTTP 500 Internal Server Error: {}"
        ));
        assert!(!is_runtime_context_access_denied(
            "Divo gateway returned HTTP 403 Forbidden: {}"
        ));
    }

    #[test]
    fn department_management_requests_match_the_constrained_backend_contract() {
        let dept = "finance-id";
        let cases = [
            (
                department_management_request(dept, DepartmentManagementOperation::Snapshot),
                reqwest::Method::GET,
                "/departments/finance-id/manage",
                None,
            ),
            (
                department_management_request(
                    dept,
                    DepartmentManagementOperation::SearchCandidates { query: "Ava & Co" },
                ),
                reqwest::Method::GET,
                "/departments/finance-id/candidates?query=Ava+%26+Co",
                None,
            ),
            (
                department_management_request(
                    dept,
                    DepartmentManagementOperation::CreateRole {
                        name: "Analyst",
                        slug: "ANALYST",
                    },
                ),
                reqwest::Method::POST,
                "/departments/finance-id/roles",
                Some(json!({ "name": "Analyst", "slug": "ANALYST" })),
            ),
            (
                department_management_request(
                    dept,
                    DepartmentManagementOperation::UpdateRole {
                        role_id: "role-id",
                        name: "Senior analyst",
                    },
                ),
                reqwest::Method::PUT,
                "/departments/finance-id/roles/role-id",
                Some(json!({ "name": "Senior analyst" })),
            ),
            (
                department_management_request(
                    dept,
                    DepartmentManagementOperation::DeleteRole { role_id: "role-id" },
                ),
                reqwest::Method::DELETE,
                "/departments/finance-id/roles/role-id",
                None,
            ),
            (
                department_management_request(
                    dept,
                    DepartmentManagementOperation::SaveMember {
                        user_id: "user-id",
                        role_id: "role-id",
                    },
                ),
                reqwest::Method::PUT,
                "/departments/finance-id/memberships",
                Some(json!({ "userId": "user-id", "roleId": "role-id" })),
            ),
            (
                department_management_request(
                    dept,
                    DepartmentManagementOperation::RemoveMember { user_id: "user-id" },
                ),
                reqwest::Method::DELETE,
                "/departments/finance-id/memberships/user-id",
                None,
            ),
        ];
        for ((method, path, body), expected_method, expected_path, expected_body) in cases {
            assert_eq!(method, expected_method);
            assert_eq!(path, expected_path);
            assert_eq!(body, expected_body);
        }
    }

    #[test]
    fn writes_member_department_directory_without_a_selected_department() {
        let session = DivoSession {
            backend_url: "https://example.test".to_string(),
            member_token: "member-token".to_string(),
            department_id: None,
            email: None,
            name: None,
            user_id: None,
            company_id: None,
            role: None,
            expires_at: None,
            avatar_url: None,
            departments: vec![
                DivoDepartment {
                    id: "dept-finance".to_string(),
                    name: " Finance ".to_string(),
                },
                DivoDepartment {
                    id: "dept-operations".to_string(),
                    name: "Operations".to_string(),
                },
                DivoDepartment {
                    id: "dept-finance-copy".to_string(),
                    name: "Finance".to_string(),
                },
            ],
        };

        let context = member_departments_runtime_context(&session);
        assert_eq!(context.department_id, None);
        assert_eq!(context.department_name, None);
        assert!(context.persona_prompt.is_empty());
        assert_eq!(context.departments, vec!["Finance", "Operations"]);
    }
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
    // The previous department's prompt must not survive a failed refresh.
    clear_cached_runtime_context(&app)?;
    if let Err(error) = refresh_runtime_context(&app).await {
        log::warn!("divo.runtime_context.refresh_failed after=department_change error={error}");
    }
    sync_pi_divo_env(&app)?;
    emit_divo_session_changed(&app, true);

    Ok(session_status(session))
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

/// Load the server-authoritative catalogue of tools available to the signed-in member.
#[tauri::command]
pub async fn divo_tools_inventory<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    divo_desktop_json_request(
        &app,
        reqwest::Method::GET,
        "/tools",
        None,
        "Divo tools inventory",
    )
    .await
}

fn require_divo_tool_identifier<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label} is required"));
    }
    Ok(value)
}

enum DepartmentManagementOperation<'a> {
    Snapshot,
    SearchCandidates { query: &'a str },
    CreateRole { name: &'a str, slug: &'a str },
    UpdateRole { role_id: &'a str, name: &'a str },
    DeleteRole { role_id: &'a str },
    SaveMember { user_id: &'a str, role_id: &'a str },
    RemoveMember { user_id: &'a str },
}

/// Builds the only desktop-to-backend contract for department team management.
/// Keeping it pure lets tests pin the method, path, query encoding, and body.
fn department_management_request(
    department_id: &str,
    operation: DepartmentManagementOperation<'_>,
) -> (reqwest::Method, String, Option<Value>) {
    let base = format!("/departments/{department_id}");
    match operation {
        DepartmentManagementOperation::Snapshot => {
            (reqwest::Method::GET, format!("{base}/manage"), None)
        }
        DepartmentManagementOperation::SearchCandidates { query } => {
            let mut url = reqwest::Url::parse("http://localhost/")
                .expect("static candidate-search URL is valid");
            url.set_path(&format!("{base}/candidates"));
            url.query_pairs_mut().append_pair("query", query);
            (
                reqwest::Method::GET,
                format!("{}?{}", url.path(), url.query().unwrap_or_default()),
                None,
            )
        }
        DepartmentManagementOperation::CreateRole { name, slug } => (
            reqwest::Method::POST,
            format!("{base}/roles"),
            Some(json!({ "name": name, "slug": slug })),
        ),
        DepartmentManagementOperation::UpdateRole { role_id, name } => (
            reqwest::Method::PUT,
            format!("{base}/roles/{role_id}"),
            Some(json!({ "name": name })),
        ),
        DepartmentManagementOperation::DeleteRole { role_id } => (
            reqwest::Method::DELETE,
            format!("{base}/roles/{role_id}"),
            None,
        ),
        DepartmentManagementOperation::SaveMember { user_id, role_id } => (
            reqwest::Method::PUT,
            format!("{base}/memberships"),
            Some(json!({ "userId": user_id, "roleId": role_id })),
        ),
        DepartmentManagementOperation::RemoveMember { user_id } => (
            reqwest::Method::DELETE,
            format!("{base}/memberships/{user_id}"),
            None,
        ),
    }
}

/// Load the constrained RBAC-management snapshot for one server-authorised tool scope.
#[tauri::command]
pub async fn divo_tool_manage_snapshot<R: Runtime>(
    app: AppHandle<R>,
    tool_id: String,
    scope: String,
    department_id: Option<String>,
) -> Result<Value, String> {
    let tool_id = require_divo_tool_identifier(&tool_id, "toolId")?;
    let path = match scope.as_str() {
        "global" => format!("/tools/{tool_id}/manage?scope=global"),
        "department" => {
            let department_id = require_divo_tool_identifier(
                department_id.as_deref().unwrap_or_default(),
                "departmentId",
            )?;
            format!("/tools/{tool_id}/manage?scope=department&departmentId={department_id}")
        }
        _ => return Err("scope must be global or department".into()),
    };
    divo_desktop_json_request(
        &app,
        reqwest::Method::GET,
        &path,
        None,
        "Divo tool manage snapshot",
    )
    .await
}

/// Persist one exact global role/action permission and return a fresh scope snapshot.
#[tauri::command]
pub async fn divo_tool_set_global_action<R: Runtime>(
    app: AppHandle<R>,
    tool_id: String,
    role: String,
    action_group: String,
    enabled: bool,
) -> Result<Value, String> {
    let tool_id = require_divo_tool_identifier(&tool_id, "toolId")?;
    let role = require_divo_tool_identifier(&role, "role")?;
    let action_group = require_divo_tool_identifier(&action_group, "actionGroup")?;
    divo_desktop_json_request(
        &app,
        reqwest::Method::PUT,
        &format!("/tools/{tool_id}/global/roles/{role}/actions/{action_group}"),
        Some(json!({ "enabled": enabled })),
        "Divo tool global action update",
    )
    .await
}

/// Persist one exact department role/action permission and return a fresh scope snapshot.
#[tauri::command]
pub async fn divo_tool_set_department_role_action<R: Runtime>(
    app: AppHandle<R>,
    tool_id: String,
    department_id: String,
    role_id: String,
    action_group: String,
    allowed: bool,
) -> Result<Value, String> {
    let tool_id = require_divo_tool_identifier(&tool_id, "toolId")?;
    let department_id = require_divo_tool_identifier(&department_id, "departmentId")?;
    let role_id = require_divo_tool_identifier(&role_id, "roleId")?;
    let action_group = require_divo_tool_identifier(&action_group, "actionGroup")?;
    divo_desktop_json_request(
        &app,
        reqwest::Method::PUT,
        &format!(
            "/tools/{tool_id}/departments/{department_id}/roles/{role_id}/actions/{action_group}"
        ),
        Some(json!({ "allowed": allowed })),
        "Divo tool department role action update",
    )
    .await
}

/// Persist one exact department member/action override and return a fresh scope snapshot.
#[tauri::command]
pub async fn divo_tool_set_department_member_action<R: Runtime>(
    app: AppHandle<R>,
    tool_id: String,
    department_id: String,
    user_id: String,
    action_group: String,
    allowed: bool,
) -> Result<Value, String> {
    let tool_id = require_divo_tool_identifier(&tool_id, "toolId")?;
    let department_id = require_divo_tool_identifier(&department_id, "departmentId")?;
    let user_id = require_divo_tool_identifier(&user_id, "userId")?;
    let action_group = require_divo_tool_identifier(&action_group, "actionGroup")?;
    divo_desktop_json_request(
        &app,
        reqwest::Method::PUT,
        &format!(
            "/tools/{tool_id}/departments/{department_id}/members/{user_id}/actions/{action_group}"
        ),
        Some(json!({ "allowed": allowed })),
        "Divo tool department member action update",
    )
    .await
}

/// Load roles and members for a department the signed-in member is allowed to manage.
#[tauri::command]
pub async fn divo_department_manage_snapshot<R: Runtime>(
    app: AppHandle<R>,
    department_id: String,
) -> Result<Value, String> {
    let department_id = require_divo_tool_identifier(&department_id, "departmentId")?;
    let (method, path, body) =
        department_management_request(department_id, DepartmentManagementOperation::Snapshot);
    divo_member_json_request(
        &app,
        "/api/desktop",
        method,
        &path,
        body,
        "Divo department management snapshot",
    )
    .await
}

/// Search the synced directory for an authorised department-management flow.
#[tauri::command]
pub async fn divo_department_search_candidates<R: Runtime>(
    app: AppHandle<R>,
    department_id: String,
    query: String,
) -> Result<Value, String> {
    let department_id = require_divo_tool_identifier(&department_id, "departmentId")?;
    let query = require_divo_tool_identifier(&query, "query")?;
    let (method, path, body) = department_management_request(
        department_id,
        DepartmentManagementOperation::SearchCandidates { query },
    );
    divo_member_json_request(
        &app,
        "/api/desktop",
        method,
        &path,
        body,
        "Divo department candidate search",
    )
    .await
}

#[tauri::command]
pub async fn divo_department_create_role<R: Runtime>(
    app: AppHandle<R>,
    department_id: String,
    name: String,
    slug: String,
) -> Result<Value, String> {
    let department_id = require_divo_tool_identifier(&department_id, "departmentId")?;
    let (method, path, body) = department_management_request(
        department_id,
        DepartmentManagementOperation::CreateRole {
            name: &name,
            slug: &slug,
        },
    );
    divo_member_json_request(
        &app,
        "/api/desktop",
        method,
        &path,
        body,
        "Divo department role creation",
    )
    .await
}

#[tauri::command]
pub async fn divo_department_update_role<R: Runtime>(
    app: AppHandle<R>,
    department_id: String,
    role_id: String,
    name: String,
) -> Result<Value, String> {
    let department_id = require_divo_tool_identifier(&department_id, "departmentId")?;
    let role_id = require_divo_tool_identifier(&role_id, "roleId")?;
    let (method, path, body) = department_management_request(
        department_id,
        DepartmentManagementOperation::UpdateRole {
            role_id,
            name: &name,
        },
    );
    divo_member_json_request(
        &app,
        "/api/desktop",
        method,
        &path,
        body,
        "Divo department role update",
    )
    .await
}

#[tauri::command]
pub async fn divo_department_delete_role<R: Runtime>(
    app: AppHandle<R>,
    department_id: String,
    role_id: String,
) -> Result<Value, String> {
    let department_id = require_divo_tool_identifier(&department_id, "departmentId")?;
    let role_id = require_divo_tool_identifier(&role_id, "roleId")?;
    let (method, path, body) = department_management_request(
        department_id,
        DepartmentManagementOperation::DeleteRole { role_id },
    );
    divo_member_json_request(
        &app,
        "/api/desktop",
        method,
        &path,
        body,
        "Divo department role deletion",
    )
    .await
}

#[tauri::command]
pub async fn divo_department_save_member<R: Runtime>(
    app: AppHandle<R>,
    department_id: String,
    user_id: String,
    role_id: String,
) -> Result<Value, String> {
    let department_id = require_divo_tool_identifier(&department_id, "departmentId")?;
    let user_id = require_divo_tool_identifier(&user_id, "userId")?;
    let role_id = require_divo_tool_identifier(&role_id, "roleId")?;
    let (method, path, body) = department_management_request(
        department_id,
        DepartmentManagementOperation::SaveMember { user_id, role_id },
    );
    divo_member_json_request(
        &app,
        "/api/desktop",
        method,
        &path,
        body,
        "Divo department membership update",
    )
    .await
}

#[tauri::command]
pub async fn divo_department_remove_member<R: Runtime>(
    app: AppHandle<R>,
    department_id: String,
    user_id: String,
) -> Result<Value, String> {
    let department_id = require_divo_tool_identifier(&department_id, "departmentId")?;
    let user_id = require_divo_tool_identifier(&user_id, "userId")?;
    let (method, path, body) = department_management_request(
        department_id,
        DepartmentManagementOperation::RemoveMember { user_id },
    );
    divo_member_json_request(
        &app,
        "/api/desktop",
        method,
        &path,
        body,
        "Divo department membership removal",
    )
    .await
}
