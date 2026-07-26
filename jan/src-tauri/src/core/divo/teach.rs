use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
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

use super::commands::{divo_member_json_request, refresh_runtime_context};
use super::session::load_divo_session;

const TEACH_RECORDING_DIR: &str = "divo/teach-recordings";
const TEACH_UPLOAD_PROGRESS_EVENT: &str = "divo-teach-upload-progress";
const TEACH_UPLOAD_ATTEMPTS: u8 = 3;

/// The live `screencapture` child, if one is running.
///
/// `discarded` separates the two ways a recording ends. Stopping saves the
/// file; cancelling throws it away. Both have to interrupt the same process,
/// so the intent is recorded here before the signal is sent and read back when
/// the child exits.
struct ActiveTeachRecording {
    pid: u32,
    path: PathBuf,
    started_at: String,
    discarded: bool,
}

static ACTIVE_TEACH_RECORDING: Mutex<Option<ActiveTeachRecording>> = Mutex::new(None);
/// Session ids with an upload streaming right now. Held in Rust rather than in
/// the webview because a page reload clears JavaScript state while the upload
/// future keeps running — which previously let a reload start a second
/// concurrent upload of the same recording.
static ACTIVE_TEACH_UPLOADS: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[cfg(target_os = "macos")]
const MACOS_TEACH_RECORDING_ARGS: &[&str] = &["-v", "-D1", "-g", "-k", "-x"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeachRecordingFile {
    path: String,
    file_name: String,
    mime_type: String,
    size: u64,
    local_owned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeachLocalRecording {
    path: String,
    file_name: String,
    mime_type: String,
    size: u64,
    local_owned: bool,
    session_id: Option<String>,
    state: String,
    last_error: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeachLocalRecordingMetadata {
    session_id: Option<String>,
    state: String,
    last_error: Option<String>,
    created_at: String,
    updated_at: String,
}

/// What the native recorder is doing, independent of any open Teach screen.
///
/// The React route is a mode toggle inside the home screen, so it unmounts the
/// moment the manager clicks anything else. Without a queryable recorder state
/// they could come back to an idle-looking Teach page while `screencapture`
/// was still running, and the next "Record" press failed with "already open".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeachRecorderStatus {
    recording: bool,
    started_at: Option<String>,
    file_name: Option<String>,
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

fn recording_metadata_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.teach.json", path.to_string_lossy()))
}

fn read_recording_metadata(path: &Path) -> Option<TeachLocalRecordingMetadata> {
    serde_json::from_slice(&fs::read(recording_metadata_path(path)).ok()?).ok()
}

fn write_recording_metadata(
    path: &Path,
    session_id: Option<String>,
    state: &str,
    last_error: Option<String>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let existing = read_recording_metadata(path);
    let metadata = TeachLocalRecordingMetadata {
        session_id,
        state: state.to_string(),
        last_error,
        created_at: existing
            .as_ref()
            .map(|value| value.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
    };
    let bytes = serde_json::to_vec_pretty(&metadata)
        .map_err(|error| format!("Could not encode Teach recording metadata: {error}"))?;
    fs::write(recording_metadata_path(path), bytes)
        .map_err(|error| format!("Could not save Teach recording metadata: {error}"))
}

fn checked_local_recording_path<R: Runtime>(
    app: &AppHandle<R>,
    value: &str,
) -> Result<PathBuf, String> {
    let directory = recording_dir(app);
    // Created first so a fresh install — or a folder the user cleared out from
    // Finder — reports "recording not found" instead of "folder not found".
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create recording folder: {error}"))?;
    let directory = directory
        .canonicalize()
        .map_err(|error| format!("Could not open Teach recording folder: {error}"))?;
    let path = PathBuf::from(value)
        .canonicalize()
        .map_err(|error| format!("Could not open local Teach recording: {error}"))?;
    if !path.starts_with(&directory) || recording_mime(&path).is_none() {
        return Err("Teach recording path is outside Divo's local recording folder".to_string());
    }
    Ok(path)
}

/// Delete a recording and its sidecar, tolerating either already being gone.
///
/// A cancelled recording may never have produced a video, and a partially
/// written session leaves a sidecar with no movie beside it. Neither should
/// surface as a failure to the manager — the requested end state is "gone".
fn remove_local_recording_files(path: &Path) -> Result<(), String> {
    for target in [path.to_path_buf(), recording_metadata_path(path)] {
        if let Err(error) = fs::remove_file(&target) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("Could not delete local Teach recording: {error}"));
            }
        }
    }
    Ok(())
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

/// A recording is only worth keeping if a real, non-empty video landed on disk.
///
/// `screencapture` reports a non-zero exit for an interrupted capture even when
/// it has flushed a perfectly good file, so exit status alone must never decide
/// whether the manager's demonstration survives. The file on disk decides.
fn finished_recording(path: &Path) -> Option<TeachRecordingFile> {
    recording_file(path, true).ok()
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn divo_teach_record_screen<R: Runtime>(
    app: AppHandle<R>,
) -> Result<TeachRecordingFile, String> {
    {
        let active = ACTIVE_TEACH_RECORDING
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
    let started_at = Utc::now().to_rfc3339();

    // Record the main display directly. macOS rejects both `-v -i` and the
    // seemingly documented `-i -Jvideo` combination on current releases.
    let mut child = Command::new("/usr/sbin/screencapture")
        .args(MACOS_TEACH_RECORDING_ARGS)
        .arg(&output_path)
        // Kept so shutting Divo down can never leave a screen recorder running
        // invisibly. Graceful stops go through SIGINT long before this matters.
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not open the macOS screen recorder: {error}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "Could not track the macOS screen recorder".to_string())?;
    {
        let mut active = ACTIVE_TEACH_RECORDING
            .lock()
            .map_err(|_| "Could not track the active recording".to_string())?;
        *active = Some(ActiveTeachRecording {
            pid,
            path: output_path.clone(),
            started_at: started_at.clone(),
            discarded: false,
        });
    }

    let wait_result = child
        .wait()
        .await
        .map_err(|error| format!("The macOS screen recorder stopped unexpectedly: {error}"));

    // Read the discard intent back out under the same lock that cleared the
    // slot, so a cancel that arrives while the child is exiting is not lost.
    let discarded = match ACTIVE_TEACH_RECORDING.lock() {
        Ok(mut active) => {
            let matches = active
                .as_ref()
                .map(|current| current.pid == pid)
                .unwrap_or(false);
            if matches {
                active.take().map(|current| current.discarded).unwrap_or(false)
            } else {
                false
            }
        }
        Err(_) => false,
    };

    if discarded {
        let _ = remove_local_recording_files(&output_path);
        return Err("Screen recording was cancelled".to_string());
    }

    // Deliberately checked before `wait_result`. A stop signal makes the child
    // exit non-zero, and the finished video is the thing the manager cares
    // about — deleting it because of an exit code was pure data loss.
    if let Some(recording) = finished_recording(&output_path) {
        write_recording_metadata(&output_path, None, "ready", None)?;
        return Ok(recording);
    }

    let _ = remove_local_recording_files(&output_path);
    wait_result?;
    Err("The screen recording did not produce a video file".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn divo_teach_record_screen<R: Runtime>(
    _app: AppHandle<R>,
) -> Result<TeachRecordingFile, String> {
    Err("Teach screen recording is currently available on macOS".to_string())
}

/// Whether a native recording is running, for a Teach screen that just mounted.
#[tauri::command]
pub async fn divo_teach_recording_status() -> Result<TeachRecorderStatus, String> {
    let active = ACTIVE_TEACH_RECORDING
        .lock()
        .map_err(|_| "Could not inspect the active recording".to_string())?;
    Ok(match active.as_ref() {
        Some(current) => TeachRecorderStatus {
            recording: true,
            started_at: Some(current.started_at.clone()),
            file_name: current
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string),
        },
        None => TeachRecorderStatus {
            recording: false,
            started_at: None,
            file_name: None,
        },
    })
}

/// Signal the running recorder, marking the discard intent first when needed.
///
/// `SIGINT` is what `screencapture -v` handles as "stop now and flush the
/// movie". `SIGTERM` ends the process without finalising the container, which
/// is why even a discard goes through `SIGINT` and deletes the completed file
/// afterwards rather than leaving a truncated one behind.
fn signal_active_recording(discard: bool) -> Result<bool, String> {
    let pid = {
        let mut active = ACTIVE_TEACH_RECORDING
            .lock()
            .map_err(|_| "Could not inspect the active recording".to_string())?;
        match active.as_mut() {
            Some(current) => {
                if discard {
                    current.discarded = true;
                }
                current.pid
            }
            None => return Ok(false),
        }
    };

    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        kill(Pid::from_raw(pid as i32), Signal::SIGINT)
            .map_err(|error| format!("Could not signal the screen recorder: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = pid;
    Ok(true)
}

/// Stop recording and keep the video.
#[tauri::command]
pub async fn divo_teach_stop_recording() -> Result<bool, String> {
    signal_active_recording(false)
}

#[tauri::command]
pub async fn divo_teach_cancel_recording() -> Result<(), String> {
    signal_active_recording(true)?;
    Ok(())
}

#[tauri::command]
pub async fn divo_teach_pick_recording<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<TeachRecordingFile>, String> {
    let selected = AsyncFileDialog::new()
        .add_filter("Screen recordings", &["mp4", "mov", "webm"])
        .pick_file()
        .await;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let source = selected.path();
    recording_file(source, false)?;

    // Imports are copied into Divo's managed retry inbox before upload. The
    // original remains untouched, while the managed copy survives navigation,
    // refreshes, network failures, and backend restarts until Teach succeeds.
    let directory = recording_dir(&app);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create recording folder: {error}"))?;
    let original_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("teaching.mov");
    let destination = directory.join(format!(
        "teach-upload-{}-{original_name}",
        Uuid::new_v4().simple()
    ));
    tokio::fs::copy(source, &destination)
        .await
        .map_err(|error| format!("Could not save a retryable copy of the recording: {error}"))?;
    let recording = match recording_file(&destination, true) {
        Ok(recording) => recording,
        Err(error) => {
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
    };
    if let Err(error) = write_recording_metadata(&destination, None, "ready", None) {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    Ok(Some(recording))
}

#[tauri::command]
pub async fn divo_teach_list_local_recordings<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<TeachLocalRecording>, String> {
    let directory = recording_dir(&app);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create recording folder: {error}"))?;
    let mut recordings = Vec::new();
    let entries = fs::read_dir(&directory)
        .map_err(|error| format!("Could not list local Teach recordings: {error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if recording_mime(&path).is_none() {
            continue;
        }
        let Ok(recording) = recording_file(&path, true) else {
            continue;
        };
        let metadata = read_recording_metadata(&path).unwrap_or_else(|| {
            let now = Utc::now().to_rfc3339();
            TeachLocalRecordingMetadata {
                session_id: None,
                state: "ready".to_string(),
                last_error: None,
                created_at: now.clone(),
                updated_at: now,
            }
        });
        recordings.push(TeachLocalRecording {
            path: recording.path,
            file_name: recording.file_name,
            mime_type: recording.mime_type,
            size: recording.size,
            local_owned: true,
            session_id: metadata.session_id,
            state: metadata.state,
            last_error: metadata.last_error,
            created_at: metadata.created_at,
            updated_at: metadata.updated_at,
        });
    }
    recordings.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(recordings)
}

#[tauri::command]
pub async fn divo_teach_delete_local_recording<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<(), String> {
    let path = checked_local_recording_path(&app, &path)?;
    remove_local_recording_files(&path)
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
    let data = response_data(response, "Teach session create")?;
    if recording.local_owned {
        if let Some(session_id) = data.get("id").and_then(Value::as_str) {
            write_recording_metadata(
                Path::new(&recording.path),
                Some(session_id.to_string()),
                "uploading",
                None,
            )?;
        }
    }
    Ok(data)
}

/// Holds a session's upload slot for as long as the upload is in flight.
///
/// Releasing on `Drop` means an early return, a cancelled command future, or a
/// panic all free the slot — a leaked entry would otherwise make the recording
/// permanently un-retryable and look stuck forever.
struct TeachUploadSlot(String);

impl TeachUploadSlot {
    fn acquire(session_id: &str) -> Result<Self, String> {
        let mut active = ACTIVE_TEACH_UPLOADS
            .lock()
            .map_err(|_| "Could not inspect Teach uploads".to_string())?;
        if active.iter().any(|current| current == session_id) {
            return Err("This Teach recording is already uploading".to_string());
        }
        active.push(session_id.to_string());
        Ok(Self(session_id.to_string()))
    }
}

impl Drop for TeachUploadSlot {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_TEACH_UPLOADS.lock() {
            active.retain(|current| current != &self.0);
        }
    }
}

/// Whether retrying could plausibly succeed, or the upload is simply refused.
enum TeachUploadFailure {
    /// Network drop, timeout, or a server-side error. Worth another attempt.
    Transient(String),
    /// Rejected input or auth. Retrying just wastes the manager's bandwidth.
    Permanent(String),
}

#[tauri::command]
pub async fn divo_teach_upload_active(session_id: String) -> Result<bool, String> {
    let active = ACTIVE_TEACH_UPLOADS
        .lock()
        .map_err(|_| "Could not inspect Teach uploads".to_string())?;
    Ok(active.iter().any(|current| current == &session_id))
}

async fn teach_upload_attempt<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    member_token: &str,
    session_id: &str,
    source_path: &Path,
    recording: &TeachRecordingFile,
) -> Result<Value, TeachUploadFailure> {
    let file = File::open(source_path).await.map_err(|error| {
        TeachUploadFailure::Permanent(format!("Could not open recording for upload: {error}"))
    })?;
    let total_bytes = recording.size;
    let event_app = app.clone();
    let event_session_id = session_id.to_string();
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
        .bearer_auth(member_token)
        .header(reqwest::header::CONTENT_TYPE, &recording.mime_type)
        .header(reqwest::header::CONTENT_LENGTH, recording.size)
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(|error| {
            TeachUploadFailure::Transient(format!("Teach recording upload failed: {error}"))
        })?;

    let status = response.status();
    let text = response.text().await.map_err(|error| {
        TeachUploadFailure::Transient(format!("Teach upload response could not be read: {error}"))
    })?;

    if !status.is_success() {
        let message = format!("Teach upload returned HTTP {status}");
        return Err(if status.is_server_error() || status.as_u16() == 429 {
            TeachUploadFailure::Transient(message)
        } else {
            TeachUploadFailure::Permanent(message)
        });
    }

    let parsed: Value = serde_json::from_str(&text).map_err(|error| {
        TeachUploadFailure::Transient(format!("Teach upload returned non-JSON: {error}"))
    })?;
    response_data(parsed, "Teach upload").map_err(TeachUploadFailure::Permanent)
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

    let _slot = TeachUploadSlot::acquire(&session_id)?;

    let session =
        load_divo_session(&app)?.ok_or_else(|| "No Divo session configured".to_string())?;
    let url = format!(
        "{}/api/desktop/teach/sessions/{session_id}/video",
        session.backend_url.trim_end_matches('/')
    );

    // A dropped connection on hotel wifi is the single most common way a
    // finished recording used to strand itself. Retrying here recovers it
    // without the manager ever being shown a failure.
    let mut last_error = "Teach recording upload failed".to_string();
    for attempt in 1..=TEACH_UPLOAD_ATTEMPTS {
        match teach_upload_attempt(
            &app,
            &url,
            &session.member_token,
            &session_id,
            &source_path,
            &checked,
        )
        .await
        {
            Ok(data) => {
                if checked.local_owned {
                    write_recording_metadata(
                        &source_path,
                        Some(session_id.clone()),
                        "processing",
                        None,
                    )?;
                }
                return Ok(data);
            }
            Err(TeachUploadFailure::Permanent(message)) => {
                last_error = message;
                break;
            }
            Err(TeachUploadFailure::Transient(message)) => {
                last_error = message;
                if attempt < TEACH_UPLOAD_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_secs(2_u64.pow(attempt.into())))
                        .await;
                }
            }
        }
    }

    // The video is untouched and the session keeps its id, so the reconciler
    // (or the manager) can pick this up again later from exactly here.
    if checked.local_owned {
        let _ = write_recording_metadata(
            &source_path,
            Some(session_id),
            "retryable",
            Some(last_error.clone()),
        );
    }
    Err(last_error)
}

#[tauri::command]
pub async fn divo_teach_finalize_local_recording<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    session_id: String,
) -> Result<(), String> {
    let session_id = validate_identifier(&session_id, "sessionId")?;
    let path = checked_local_recording_path(&app, &path)?;
    let metadata = read_recording_metadata(&path)
        .ok_or_else(|| "Local Teach recording metadata is missing".to_string())?;
    if metadata.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Local Teach recording does not belong to this session".to_string());
    }
    let response = teach_json_request(
        &app,
        reqwest::Method::GET,
        &format!("/sessions/{session_id}"),
        None,
        "Teach local recording finalize",
    )
    .await?;
    let data = response_data(response, "Teach local recording finalize")?;
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(status, "completed" | "persona_updated" | "no_learning") {
        return Err("Local Teach recording is retained until processing succeeds".to_string());
    }
    remove_local_recording_files(&path)?;
    if let Err(error) = refresh_runtime_context(&app).await {
        log::warn!("divo.teach.runtime_context_refresh_failed error={error}");
    }
    Ok(())
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
pub async fn divo_teach_list_recent_learnings<R: Runtime>(
    app: AppHandle<R>,
    department_id: String,
    limit: Option<u8>,
) -> Result<Value, String> {
    let department_id = validate_identifier(&department_id, "departmentId")?;
    let limit = limit.unwrap_or(10).clamp(1, 50);
    let response = teach_json_request(
        &app,
        reqwest::Method::GET,
        &format!("/sessions?departmentId={department_id}&limit={limit}"),
        None,
        "Teach recent learnings",
    )
    .await?;
    response_data(response, "Teach recent learnings")
}

#[tauri::command]
pub async fn divo_teach_get_persona_tree<R: Runtime>(
    app: AppHandle<R>,
    department_id: String,
) -> Result<Value, String> {
    let department_id = validate_identifier(&department_id, "departmentId")?;
    let response = teach_json_request(
        &app,
        reqwest::Method::GET,
        &format!("/persona/{department_id}"),
        None,
        "Manager persona tree",
    )
    .await?;
    response_data(response, "Manager persona tree")
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

/// Ask the backend to re-queue an ingestion that stopped making progress.
#[tauri::command]
pub async fn divo_teach_resume_session<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<Value, String> {
    let session_id = validate_identifier(&session_id, "sessionId")?;
    let response = teach_json_request(
        &app,
        reqwest::Method::POST,
        &format!("/sessions/{session_id}/resume"),
        None,
        "Teach session resume",
    )
    .await?;
    response_data(response, "Teach session resume")
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
    use super::{
        finished_recording, read_recording_metadata, recording_metadata_path, recording_mime,
        remove_local_recording_files, validate_identifier, write_recording_metadata,
        TeachUploadSlot,
    };
    use std::path::Path;
    use tempfile::tempdir;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_recording_uses_main_display_video_mode_without_interactive_flags() {
        assert!(MACOS_TEACH_RECORDING_ARGS.contains(&"-v"));
        assert!(MACOS_TEACH_RECORDING_ARGS.contains(&"-D1"));
        assert!(!MACOS_TEACH_RECORDING_ARGS.contains(&"-i"));
        assert!(!MACOS_TEACH_RECORDING_ARGS
            .iter()
            .any(|argument| argument.starts_with("-J")));
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

    #[test]
    fn local_recording_metadata_tracks_retry_state_without_touching_video() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("teach.mov");
        std::fs::write(&path, b"video").expect("video fixture");

        write_recording_metadata(
            &path,
            Some("teach-session-1".to_string()),
            "retryable",
            Some("network unavailable".to_string()),
        )
        .expect("metadata write");

        let metadata = read_recording_metadata(&path).expect("metadata read");
        assert_eq!(metadata.session_id.as_deref(), Some("teach-session-1"));
        assert_eq!(metadata.state, "retryable");
        assert!(
            path.exists(),
            "retry metadata must never delete the recording"
        );
        assert!(recording_metadata_path(&path).exists());
    }

    #[test]
    fn a_written_video_survives_a_non_zero_recorder_exit() {
        // Stopping `screencapture` makes it exit non-zero even though it
        // flushed a complete movie. The file on disk is what decides.
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("teach.mov");
        std::fs::write(&path, b"finished movie bytes").expect("video fixture");

        let recovered = finished_recording(&path).expect("stopped recording is kept");
        assert_eq!(recovered.file_name, "teach.mov");
        assert!(recovered.local_owned);
    }

    #[test]
    fn an_empty_recording_is_not_offered_as_a_teaching() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("teach.mov");
        std::fs::write(&path, b"").expect("empty fixture");

        assert!(finished_recording(&path).is_none());
        assert!(finished_recording(&directory.path().join("missing.mov")).is_none());
    }

    #[test]
    fn deleting_tolerates_a_cancelled_recording_that_never_wrote_a_video() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("teach.mov");
        write_recording_metadata(&path, None, "recording", None).expect("metadata write");

        remove_local_recording_files(&path).expect("cancel cleanup must not fail");
        assert!(!recording_metadata_path(&path).exists());
    }

    #[test]
    fn a_session_cannot_upload_twice_at_once_and_frees_its_slot() {
        let slot = TeachUploadSlot::acquire("teach-session-1").expect("first upload");
        assert!(TeachUploadSlot::acquire("teach-session-1").is_err());
        // A different recording is unaffected by the busy one.
        let other = TeachUploadSlot::acquire("teach-session-2").expect("unrelated upload");

        drop(slot);
        drop(other);
        // Freed on drop, so a retry after a failure is always possible.
        TeachUploadSlot::acquire("teach-session-1").expect("retry after release");
    }

    #[test]
    fn explicit_local_delete_removes_video_and_sidecar() {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("teach.mov");
        std::fs::write(&path, b"video").expect("video fixture");
        write_recording_metadata(&path, None, "ready", None).expect("metadata write");

        remove_local_recording_files(&path).expect("local delete");

        assert!(!path.exists());
        assert!(!recording_metadata_path(&path).exists());
    }
}
