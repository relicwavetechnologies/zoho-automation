use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use futures_util::TryStreamExt;
use rfd::AsyncFileDialog;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::fs::File;
use tokio::process::Command;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::core::app::commands::get_jan_data_folder_path;

use super::commands::divo_member_json_request;
use super::session::load_divo_session;

const TEACH_RECORDING_DIR: &str = "divo/teach-recordings";
const TEACH_UPLOAD_PROGRESS_EVENT: &str = "divo-teach-upload-progress";
static ACTIVE_TEACH_RECORDING_PID: Mutex<Option<u32>> = Mutex::new(None);

#[cfg(target_os = "macos")]
const MACOS_TEACH_RECORDING_ARGS: &[&str] = &["-i", "-Jvideo", "-g", "-k", "-x"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeachRecordingFile {
    path: String,
    file_name: String,
    mime_type: String,
    size: u64,
    local_owned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TeachUploadProgress {
    session_id: String,
    uploaded_bytes: u64,
    total_bytes: u64,
    percent: u8,
}

fn recording_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    get_jan_data_folder_path(app.clone()).join(TEACH_RECORDING_DIR)
}

fn recording_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        _ => None,
    }
}

fn recording_file(path: &Path, local_owned: bool) -> Result<TeachRecordingFile, String> {
    let mime_type = recording_mime(path)
        .ok_or_else(|| "Teach accepts MP4, MOV or WebM recordings".to_string())?;
    let metadata =
        fs::metadata(path).map_err(|error| format!("Could not read recording: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("The selected recording is empty".to_string());
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("teaching.mov")
        .to_string();
    Ok(TeachRecordingFile {
        path: path.to_string_lossy().to_string(),
        file_name,
        mime_type: mime_type.to_string(),
        size: metadata.len(),
        local_owned,
    })
}

fn validate_identifier(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(trimmed.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn divo_teach_record_screen<R: Runtime>(
    app: AppHandle<R>,
) -> Result<TeachRecordingFile, String> {
    {
        let active = ACTIVE_TEACH_RECORDING_PID
            .lock()
            .map_err(|_| "Could not inspect the active recording".to_string())?;
        if active.is_some() {
            return Err("A Teach recording is already open".to_string());
        }
    }

    let dir = recording_dir(&app);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create recording folder: {error}"))?;
    let output_path = dir.join(format!("teach-{}.mov", Uuid::new_v4().simple()));

    // `-Jvideo` opens macOS' interactive video selector. Do not combine `-i`
    // with `-v`: screencapture rejects that pair instead of opening the UI.
    let mut child = Command::new("/usr/sbin/screencapture")
        .args(MACOS_TEACH_RECORDING_ARGS)
        .arg(&output_path)
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not open the macOS screen recorder: {error}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "Could not track the macOS screen recorder".to_string())?;
    {
        let mut active = ACTIVE_TEACH_RECORDING_PID
            .lock()
            .map_err(|_| "Could not track the active recording".to_string())?;
        *active = Some(pid);
    }

    let status = child
        .wait()
        .await
        .map_err(|error| format!("The macOS screen recorder stopped unexpectedly: {error}"));
    if let Ok(mut active) = ACTIVE_TEACH_RECORDING_PID.lock() {
        if *active == Some(pid) {
            *active = None;
        }
    }

    let status = status?;
    if !status.success() || !output_path.exists() {
        let _ = fs::remove_file(&output_path);
        return Err("Screen recording was cancelled".to_string());
    }
    recording_file(&output_path, true)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn divo_teach_record_screen<R: Runtime>(
    _app: AppHandle<R>,
) -> Result<TeachRecordingFile, String> {
    Err("Teach screen recording is currently available on macOS".to_string())
}

#[tauri::command]
pub async fn divo_teach_cancel_recording() -> Result<(), String> {
    let pid = ACTIVE_TEACH_RECORDING_PID
        .lock()
        .map_err(|_| "Could not inspect the active recording".to_string())?
        .take();
    let Some(pid) = pid else {
        return Ok(());
    };

    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        kill(Pid::from_raw(pid as i32), Signal::SIGTERM)
            .map_err(|error| format!("Could not cancel screen recording: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn divo_teach_pick_recording() -> Result<Option<TeachRecordingFile>, String> {
    let selected = AsyncFileDialog::new()
        .add_filter("Screen recordings", &["mp4", "mov", "webm"])
        .pick_file()
        .await;
    selected
        .map(|file| recording_file(file.path(), false))
        .transpose()
}

async fn teach_json_request<R: Runtime>(
    app: &AppHandle<R>,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    label: &str,
) -> Result<Value, String> {
    divo_member_json_request(app, "/api/desktop/teach", method, path, body, label, true).await
}

fn response_data(response: Value, label: &str) -> Result<Value, String> {
    response
        .get("data")
        .cloned()
        .ok_or_else(|| format!("{label} response is missing data"))
}

#[tauri::command]
pub async fn divo_teach_create_session<R: Runtime>(
    app: AppHandle<R>,
    department_id: String,
    source: String,
    recording: TeachRecordingFile,
) -> Result<Value, String> {
    let department_id = validate_identifier(&department_id, "departmentId")?;
    let source = match source.trim() {
        "recording" => "recording",
        "upload" => "upload",
        _ => return Err("Teach source must be recording or upload".to_string()),
    };
    let response = teach_json_request(
        &app,
        reqwest::Method::POST,
        "/sessions",
        Some(json!({
            "departmentId": department_id,
            "source": source,
            "originalFileName": recording.file_name,
            "mimeType": recording.mime_type,
            "fileSize": recording.size,
        })),
        "Teach session create",
    )
    .await?;
    response_data(response, "Teach session create")
}

#[tauri::command]
pub async fn divo_teach_upload_recording<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    recording: TeachRecordingFile,
) -> Result<Value, String> {
    let session_id = validate_identifier(&session_id, "sessionId")?;
    let source_path = PathBuf::from(&recording.path);
    let checked = recording_file(&source_path, recording.local_owned)?;
    if checked.size != recording.size || checked.mime_type != recording.mime_type {
        return Err("The recording changed after it was selected".to_string());
    }

    let session =
        load_divo_session(&app)?.ok_or_else(|| "No Divo session configured".to_string())?;
    let url = format!(
        "{}/api/desktop/teach/sessions/{session_id}/video",
        session.backend_url.trim_end_matches('/')
    );
    let file = File::open(&source_path)
        .await
        .map_err(|error| format!("Could not open recording for upload: {error}"))?;
    let total_bytes = checked.size;
    let event_app = app.clone();
    let event_session_id = session_id.clone();
    let mut uploaded_bytes = 0_u64;
    let stream = ReaderStream::new(file).map_ok(move |chunk| {
        uploaded_bytes = uploaded_bytes.saturating_add(chunk.len() as u64);
        let percent = if total_bytes == 0 {
            0
        } else {
            ((uploaded_bytes.saturating_mul(100) / total_bytes).min(100)) as u8
        };
        let _ = event_app.emit(
            TEACH_UPLOAD_PROGRESS_EVENT,
            TeachUploadProgress {
                session_id: event_session_id.clone(),
                uploaded_bytes,
                total_bytes,
                percent,
            },
        );
        chunk
    });

    let response = reqwest::Client::new()
        .put(url)
        .bearer_auth(&session.member_token)
        .header(reqwest::header::CONTENT_TYPE, &checked.mime_type)
        .header(reqwest::header::CONTENT_LENGTH, checked.size)
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(|error| format!("Teach recording upload failed: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Teach upload response could not be read: {error}"))?;
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|error| format!("Teach upload returned non-JSON (HTTP {status}): {error}"))?;
    if !status.is_success() {
        return Err(format!("Teach upload returned HTTP {status}: {parsed}"));
    }

    if checked.local_owned {
        if let Err(error) = fs::remove_file(&source_path) {
            log::warn!("divo.teach.local_cleanup_failed error={error}");
        }
    }
    response_data(parsed, "Teach upload")
}

#[tauri::command]
pub async fn divo_teach_get_session<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<Value, String> {
    let session_id = validate_identifier(&session_id, "sessionId")?;
    let response = teach_json_request(
        &app,
        reqwest::Method::GET,
        &format!("/sessions/{session_id}"),
        None,
        "Teach session status",
    )
    .await?;
    response_data(response, "Teach session status")
}

#[tauri::command]
pub async fn divo_teach_cancel_session<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<Value, String> {
    let session_id = validate_identifier(&session_id, "sessionId")?;
    let response = teach_json_request(
        &app,
        reqwest::Method::POST,
        &format!("/sessions/{session_id}/cancel"),
        None,
        "Teach session cancel",
    )
    .await?;
    response_data(response, "Teach session cancel")
}

#[tauri::command]
pub async fn divo_teach_undo_persona<R: Runtime>(
    app: AppHandle<R>,
    department_id: String,
) -> Result<Value, String> {
    let department_id = validate_identifier(&department_id, "departmentId")?;
    let response = teach_json_request(
        &app,
        reqwest::Method::POST,
        &format!("/persona/{department_id}/undo"),
        None,
        "Manager persona undo",
    )
    .await?;
    response_data(response, "Manager persona undo")
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::MACOS_TEACH_RECORDING_ARGS;
    use super::{recording_mime, validate_identifier};
    use std::path::Path;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_recording_uses_interactive_video_mode_without_conflicting_flag() {
        assert!(MACOS_TEACH_RECORDING_ARGS.contains(&"-i"));
        assert!(MACOS_TEACH_RECORDING_ARGS.contains(&"-Jvideo"));
        assert!(!MACOS_TEACH_RECORDING_ARGS.contains(&"-v"));
    }

    #[test]
    fn accepts_supported_recording_extensions() {
        assert_eq!(
            recording_mime(Path::new("demo.mov")),
            Some("video/quicktime")
        );
        assert_eq!(recording_mime(Path::new("demo.mp4")), Some("video/mp4"));
        assert_eq!(recording_mime(Path::new("demo.webm")), Some("video/webm"));
        assert_eq!(recording_mime(Path::new("demo.avi")), None);
    }

    #[test]
    fn identifiers_cannot_escape_backend_paths() {
        assert!(validate_identifier("safe-id-123", "id").is_ok());
        assert!(validate_identifier("../unsafe", "id").is_err());
        assert!(validate_identifier("id?x=1", "id").is_err());
    }
}
