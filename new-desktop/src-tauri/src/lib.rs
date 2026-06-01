use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// callIds the user has asked to terminate. The run loop checks this each tick.
fn cancel_requests() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
}

#[tauri::command]
fn get_app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
fn open_url(_url: String) -> Result<(), String> {
    // Renderer opens via tauri-plugin-shell directly. Reserved for native logic.
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalChunk {
    call_id: String,
    data: String,
    stream: String, // "stdout" | "stderr"
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    timed_out: bool,
    cancelled: bool,
}

/// Request termination of a running command by its callId. The run loop kills
/// the child on its next tick.
#[tauri::command]
fn kill_command(call_id: String) {
    if let Ok(mut set) = cancel_requests().lock() {
        set.insert(call_id);
    }
}

/// Streamed reader: forwards each chunk to the renderer as a `terminal://output`
/// event and accumulates the full text (capped). Runs on its own thread.
fn stream_pipe<R: Read>(
    app: &tauri::AppHandle,
    call_id: &str,
    mut pipe: R,
    stream: &str,
) -> String {
    let mut acc = String::new();
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                let _ = app.emit(
                    "terminal://output",
                    TerminalChunk {
                        call_id: call_id.to_string(),
                        data: chunk.clone(),
                        stream: stream.to_string(),
                    },
                );
                if acc.len() < 200_000 {
                    acc.push_str(&chunk);
                }
            }
            Err(_) => break,
        }
    }
    acc
}

/// Run a shell command on the USER's machine and stream its output live.
/// This is the user-facing terminal — execution happens in this Tauri (Rust)
/// process, never on the backend server.
///
/// Async + spawn_blocking so the blocking spawn/poll runs OFF the UI thread —
/// otherwise the main thread is blocked and the streamed `terminal://output`
/// events can't be delivered to the webview until the command finishes.
#[tauri::command]
async fn run_command(
    app: tauri::AppHandle,
    call_id: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_command_blocking(app, call_id, command, cwd, timeout_ms)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn run_command_blocking(
    app: tauri::AppHandle,
    call_id: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000).clamp(1_000, 600_000));

    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(&command);
    if let Some(dir) = cwd.as_ref() {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr = child.stderr.take().ok_or("no stderr pipe")?;

    let app_out = app.clone();
    let cid_out = call_id.clone();
    let h_out = std::thread::spawn(move || stream_pipe(&app_out, &cid_out, stdout, "stdout"));
    let app_err = app.clone();
    let cid_err = call_id.clone();
    let h_err = std::thread::spawn(move || stream_pipe(&app_err, &cid_err, stderr, "stderr"));

    // Clear any stale cancel flag for this id before we start.
    if let Ok(mut set) = cancel_requests().lock() {
        set.remove(&call_id);
    }

    let mut timed_out = false;
    let mut cancelled = false;
    let exit_code = loop {
        // User asked to terminate?
        let kill_requested = cancel_requests()
            .lock()
            .map(|mut set| set.remove(&call_id))
            .unwrap_or(false);
        if kill_requested {
            let _ = child.kill();
            let _ = child.wait();
            cancelled = true;
            break -1;
        }

        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status.code().unwrap_or(-1),
            None => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break -1;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        }
    };

    let stdout_text = h_out.join().unwrap_or_default();
    let stderr_text = h_err.join().unwrap_or_default();

    Ok(ExecResult {
        exit_code,
        stdout: stdout_text,
        stderr: stderr_text,
        duration_ms: start.elapsed().as_millis() as u64,
        timed_out,
        cancelled,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|_app| {
            // Deep-link single-instance registration would go here. For dev
            // builds we rely on the polling fallback in the renderer.
            // DevTools: right-click → Inspect or Cmd+Option+I — do not auto-open.
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_app_info, open_url, run_command, kill_command])
        .run(tauri::generate_context!())
        .expect("error while running Divo Desktop");
}
