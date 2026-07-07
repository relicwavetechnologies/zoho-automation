use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

use super::browser::{current_browser_cdp_fingerprint, kill_orphan_chrome_devtools_mcp};
use super::env::{apply_divo_gateway_env, apply_divo_workspace_env, apply_provider_env};
use super::runtime::PiRuntimePaths;
use super::session::{ensure_session_workspace_cwd, resolve_session_path};
use crate::core::divo::workspace::{prepare_workspace_run_layout, DivoWorkspaceRunLayout};
use crate::core::threads::utils::ensure_thread_dir_exists;

struct PiProcess {
    child: Child,
    stdin: std::process::ChildStdin,
}

struct SharedState {
    process: Option<PiProcess>,
    data_folder: Option<PathBuf>,
    scratch_dir: Option<PathBuf>,
    workspace_dir: Option<PathBuf>,
    run_thread_id: Option<String>,
    active_thread_id: Option<String>,
    browser_cdp_fingerprint: Option<String>,
    pending: HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>,
    stdout_buffer: String,
}

pub struct PiManager {
    inner: Arc<StdMutex<SharedState>>,
    cmd_tx: mpsc::Sender<String>,
    app: Arc<Mutex<Option<AppHandle>>>,
}

impl Clone for PiManager {
    fn clone(&self) -> Self {
        PiManager {
            inner: self.inner.clone(),
            cmd_tx: self.cmd_tx.clone(),
            app: self.app.clone(),
        }
    }
}

impl PiManager {
    pub fn new() -> Self {
        let inner = Arc::new(StdMutex::new(SharedState {
            process: None,
            data_folder: None,
            scratch_dir: None,
            workspace_dir: None,
            run_thread_id: None,
            active_thread_id: None,
            browser_cdp_fingerprint: None,
            pending: HashMap::new(),
            stdout_buffer: String::new(),
        }));
        let (cmd_tx, cmd_rx) = mpsc::channel::<String>();
        let inner_write = inner.clone();

        std::thread::spawn(move || {
            while let Ok(cmd) = cmd_rx.recv() {
                let mut guard = inner_write.lock().unwrap();
                if let Some(ref mut pi) = guard.process {
                    let _ = writeln!(pi.stdin, "{}", cmd);
                    let _ = pi.stdin.flush();
                }
            }
        });

        PiManager {
            inner,
            cmd_tx,
            app: Arc::new(Mutex::new(None)),
        }
    }

    fn write_stdin(&self, json: &str) -> Result<(), String> {
        self.cmd_tx
            .send(json.to_string())
            .map_err(|e| format!("Failed to queue Pi command: {}", e))
    }

    async fn send_rpc(&self, mut cmd: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        if let Some(obj) = cmd.as_object_mut() {
            obj.insert("id".to_string(), serde_json::Value::String(id.clone()));
        }
        let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;

        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.inner.lock().unwrap();
            if guard.process.is_none() {
                return Err("Pi process is not running".into());
            }
            guard.pending.insert(id.clone(), tx);
        }

        self.write_stdin(&json)?;

        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(Ok(data))) => Ok(data),
            Ok(Ok(Err(e))) => Err(e),
            Ok(Err(_)) => Err("Pi RPC channel closed".into()),
            Err(_) => {
                let mut guard = self.inner.lock().unwrap();
                guard.pending.remove(&id);
                Err("Pi RPC timed out".into())
            }
        }
    }

    async fn wait_until_ready(&self) -> Result<(), String> {
        for attempt in 1..=30 {
            match self
                .send_rpc(serde_json::json!({ "type": "get_state" }))
                .await
            {
                Ok(_) => return Ok(()),
                Err(_) if attempt < 30 => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                Err(e) => return Err(e),
            }
        }
        Err("Pi RPC failed to become ready".into())
    }

    fn divo_workspace_system_prompt(
        workspace_dir: &std::path::Path,
        layout: &DivoWorkspaceRunLayout,
    ) -> String {
        format!(
            "\
Divo workspace policy:
- The selected workspace root is: {workspace}
- The active Jan thread id for this run is: {thread_id}
- Divo-owned scratch state for this run is: {run_dir}
- Put temporary helper scripts, scratch notes, downloaded intermediate files, logs, and generated analysis artifacts under DIVO_RUN_DIR or the matching DIVO_* directory.
- Do not create temporary scripts or scratch files in the workspace root or project folders.
- Only create or edit files outside .divo when they are real project files required by the user's task.
- Do not store credentials, backend tokens, or SaaS tokens in workspace files.",
            workspace = workspace_dir.display(),
            thread_id = layout.thread_id,
            run_dir = layout.run_dir.display(),
        )
    }

    pub async fn start(
        &self,
        app: AppHandle,
        data_folder: PathBuf,
        scratch_dir: PathBuf,
        workspace_dir: PathBuf,
        initial_thread_id: Option<String>,
    ) -> Result<(), String> {
        {
            let mut app_guard = self.app.lock().await;
            *app_guard = Some(app.clone());
        }

        let runtime = PiRuntimePaths::resolve(&app, &data_folder)?;
        let new_fingerprint = runtime.browser_cdp_fingerprint.clone();

        {
            let mut guard = self.inner.lock().unwrap();
            if guard.process.is_some() {
                let workspace_changed = guard
                    .workspace_dir
                    .as_ref()
                    .map(|current| current != &workspace_dir)
                    .unwrap_or(true);
                let run_thread_changed = initial_thread_id
                    .as_ref()
                    .map(|thread_id| guard.run_thread_id.as_ref() != Some(thread_id))
                    .unwrap_or(false);
                let stale =
                    new_fingerprint.is_some() && new_fingerprint != guard.browser_cdp_fingerprint;
                if !stale && !workspace_changed && !run_thread_changed {
                    return Ok(());
                }
                if let Some(mut pi) = guard.process.take() {
                    let _ = pi.child.kill();
                }
                guard.pending.clear();
                guard.active_thread_id = None;
                kill_orphan_chrome_devtools_mcp();
            }
            guard.browser_cdp_fingerprint = new_fingerprint;
        }

        kill_orphan_chrome_devtools_mcp();

        let (stdout, stderr) = {
            let mut guard = self.inner.lock().unwrap();

            std::fs::create_dir_all(&scratch_dir)
                .map_err(|e| format!("Failed to create Pi scratch dir: {}", e))?;
            let run_thread_id = initial_thread_id
                .clone()
                .unwrap_or_else(|| "__process__".to_string());
            let divo_layout = prepare_workspace_run_layout(&workspace_dir, &run_thread_id)?;

            let scratch_dir_str = scratch_dir.to_string_lossy().to_string();
            let agent_dir_str = runtime.agent_dir.to_string_lossy().to_string();
            let divo_prompt = Self::divo_workspace_system_prompt(&workspace_dir, &divo_layout);

            let mut cmd = Command::new(&runtime.bun);
            cmd.arg(&runtime.cli_js)
                .arg("--mode")
                .arg("rpc")
                .arg("--session-dir")
                .arg(&scratch_dir_str)
                .arg("--append-system-prompt")
                .arg(divo_prompt)
                .env("PI_CODING_AGENT_DIR", &agent_dir_str)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            for skill_dir in &runtime.skill_dirs {
                cmd.arg("--skill").arg(skill_dir);
            }
            cmd.current_dir(&workspace_dir);
            apply_provider_env(&mut cmd, &runtime.agent_dir);
            apply_divo_gateway_env(&mut cmd, &runtime.agent_dir);
            apply_divo_workspace_env(&mut cmd, &workspace_dir, &divo_layout);
            let mut child = cmd.spawn().map_err(|e| {
                format!(
                    "Failed to spawn bundled Pi (bun={} cli={}): {e}",
                    runtime.bun.display(),
                    runtime.cli_js.display()
                )
            })?;

            let stdin = child.stdin.take().ok_or("Failed to capture pi stdin")?;
            let stdout = child.stdout.take().ok_or("Failed to capture pi stdout")?;
            let stderr = child.stderr.take().ok_or("Failed to capture pi stderr")?;

            guard.data_folder = Some(data_folder);
            guard.scratch_dir = Some(scratch_dir);
            guard.workspace_dir = Some(workspace_dir);
            guard.run_thread_id = Some(run_thread_id);
            guard.process = Some(PiProcess { child, stdin });
            (stdout, stderr)
        };

        let inner_reader = self.inner.clone();
        let app_reader = self.app.clone();
        let cmd_tx_reader = self.cmd_tx.clone();

        std::thread::spawn(move || {
            use std::io::Read;
            let mut stdout = stdout;
            let mut buf = [0u8; 8192];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]);
                        let lines: Vec<String> = {
                            let mut guard = inner_reader.lock().unwrap();
                            guard.stdout_buffer.push_str(&chunk);
                            let mut lines = Vec::new();
                            while let Some(newline_idx) = guard.stdout_buffer.find('\n') {
                                let line = guard.stdout_buffer[..newline_idx].to_string();
                                guard.stdout_buffer =
                                    guard.stdout_buffer[newline_idx + 1..].to_string();
                                let line = line.trim_end_matches('\r').trim().to_string();
                                if !line.is_empty() {
                                    lines.push(line);
                                }
                            }
                            lines
                        };
                        for line in lines {
                            Self::handle_line(&inner_reader, &app_reader, &cmd_tx_reader, &line);
                        }
                    }
                    Err(_) => break,
                }
            }
            let mut guard = inner_reader.lock().unwrap();
            guard.process = None;
            drop(guard);
            let thread_id = inner_reader
                .lock()
                .unwrap()
                .active_thread_id
                .clone()
                .unwrap_or_default();
            Self::emit_pi_event(
                &app_reader,
                thread_id,
                serde_json::json!({
                    "type": "pi_process_exit",
                    "message": "Pi process exited"
                }),
            );
        });

        std::thread::spawn(move || {
            use std::io::Read;
            let mut stderr = stderr;
            let mut buf = [0u8; 1024];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        eprintln!("[pi stderr] {}", String::from_utf8_lossy(&buf[..n]).trim());
                    }
                    Err(_) => break,
                }
            }
        });

        self.wait_until_ready().await
    }

    fn active_thread_id(inner: &Arc<StdMutex<SharedState>>) -> String {
        inner
            .lock()
            .unwrap()
            .active_thread_id
            .clone()
            .unwrap_or_default()
    }

    fn handle_line(
        inner: &Arc<StdMutex<SharedState>>,
        app: &Arc<Mutex<Option<AppHandle>>>,
        cmd_tx: &mpsc::Sender<String>,
        line: &str,
    ) {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[pi] JSON parse error: {} line={}", e, line);
                return;
            }
        };

        let event_type = value.get("type").and_then(|v| v.as_str());

        if event_type == Some("response") {
            if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                let mut guard = inner.lock().unwrap();
                if let Some(tx) = guard.pending.remove(id) {
                    let success = value
                        .get("success")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let result = if success {
                        Ok(value
                            .get("data")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null))
                    } else {
                        Err(value
                            .get("error")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Pi command failed")
                            .to_string())
                    };
                    let _ = tx.send(result);
                }
            }

            if value.get("command").and_then(|v| v.as_str()) == Some("prompt") {
                let thread_id = Self::active_thread_id(inner);
                let success = value
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if success {
                    let request_id = value
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    Self::emit_pi_event(
                        app,
                        thread_id,
                        serde_json::json!({
                            "type": "prompt_accepted",
                            "requestId": request_id
                        }),
                    );
                } else if let Some(msg) = value.get("error").and_then(|v| v.as_str()) {
                    Self::emit_pi_event(
                        app,
                        thread_id,
                        serde_json::json!({
                            "type": "prompt_rejected",
                            "message": msg
                        }),
                    );
                }
            }
            return;
        }

        if event_type == Some("extension_ui_request") {
            let thread_id = Self::active_thread_id(inner);
            Self::emit_pi_event(app, thread_id, value.clone());

            // Block on dialog methods until Jan implements extension UI bridge.
            if let Some(method) = value.get("method").and_then(|v| v.as_str()) {
                match method {
                    "select" | "confirm" | "input" | "editor" => {
                        if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                            let cancel = serde_json::json!({
                                "type": "extension_ui_response",
                                "id": id,
                                "cancelled": true
                            });
                            if let Ok(json) = serde_json::to_string(&cancel) {
                                let _ = cmd_tx.send(json);
                            }
                        }
                    }
                    _ => {}
                }
            }
            return;
        }

        if event_type.is_some() {
            let thread_id = Self::active_thread_id(inner);
            Self::emit_pi_event(app, thread_id, value);
        }
    }

    fn emit_pi_event(
        app: &Arc<Mutex<Option<AppHandle>>>,
        thread_id: String,
        mut event: serde_json::Value,
    ) {
        if let Some(obj) = event.as_object_mut() {
            obj.insert(
                "thread_id".to_string(),
                serde_json::Value::String(thread_id),
            );
        } else {
            event = serde_json::json!({
                "thread_id": thread_id,
                "type": "unknown",
                "payload": event
            });
        }

        if let Ok(guard) = app.try_lock() {
            if let Some(app) = guard.as_ref() {
                let _ = app.emit("pi-event", event);
            }
        }
    }

    pub async fn ensure_thread(&self, thread_id: String) -> Result<(), String> {
        let needs_switch = {
            let guard = self.inner.lock().unwrap();
            guard.active_thread_id.as_deref() != Some(thread_id.as_str())
        };

        if !needs_switch {
            return Ok(());
        }

        if let Ok(state) = self.get_state().await {
            if state
                .get("isStreaming")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                self.abort().await?;
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }

        let (data_folder, session_path, workspace_dir) = {
            let guard = self.inner.lock().unwrap();
            let data_folder = guard
                .data_folder
                .clone()
                .ok_or("Pi process is not running")?;
            let workspace_dir = guard
                .workspace_dir
                .clone()
                .ok_or("Pi workspace is not configured")?;
            let session_path = resolve_session_path(&data_folder, &thread_id);
            (data_folder, session_path, workspace_dir)
        };

        ensure_thread_dir_exists(&data_folder, &thread_id)?;
        ensure_session_workspace_cwd(&session_path, &workspace_dir)?;

        let resp = self
            .send_rpc(serde_json::json!({
                "type": "switch_session",
                "sessionPath": session_path.to_string_lossy()
            }))
            .await?;
        if resp
            .get("cancelled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return Err("Session switch cancelled".into());
        }

        let mut guard = self.inner.lock().unwrap();
        guard.active_thread_id = Some(thread_id);
        Ok(())
    }

    pub async fn get_state(&self) -> Result<serde_json::Value, String> {
        self.send_rpc(serde_json::json!({ "type": "get_state" }))
            .await
    }

    async fn restart_if_browser_cdp_changed(&self, app: &AppHandle) -> Result<(), String> {
        let fingerprint = current_browser_cdp_fingerprint();
        let (needs_restart, data_folder, scratch_dir, workspace_dir, run_thread_id) = {
            let guard = self.inner.lock().unwrap();
            let needs = guard.process.is_some()
                && fingerprint.is_some()
                && fingerprint != guard.browser_cdp_fingerprint;
            (
                needs,
                guard.data_folder.clone(),
                guard.scratch_dir.clone(),
                guard.workspace_dir.clone(),
                guard.run_thread_id.clone(),
            )
        };

        if !needs_restart {
            return Ok(());
        }

        self.stop().await;
        kill_orphan_chrome_devtools_mcp();

        let (data_folder, scratch_dir, workspace_dir) =
            match (data_folder, scratch_dir, workspace_dir) {
                (Some(d), Some(s), Some(w)) => (d, s, w),
                _ => return Ok(()),
            };

        self.start(
            app.clone(),
            data_folder,
            scratch_dir,
            workspace_dir,
            run_thread_id,
        )
        .await
    }

    pub async fn prompt(&self, thread_id: String, message: String) -> Result<(), String> {
        if let Some(app) = self.app.lock().await.clone() {
            self.restart_if_browser_cdp_changed(&app).await?;
        }
        self.ensure_thread(thread_id).await?;
        self.send_rpc(serde_json::json!({
            "type": "prompt",
            "message": message
        }))
        .await?;
        Ok(())
    }

    pub async fn abort(&self) -> Result<(), String> {
        self.send_rpc(serde_json::json!({ "type": "abort" }))
            .await?;
        Ok(())
    }

    pub async fn stop(&self) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(mut pi) = guard.process.take() {
            let _ = pi.child.kill();
        }
        guard.active_thread_id = None;
        guard.browser_cdp_fingerprint = None;
        guard.pending.clear();
    }

    pub async fn is_running(&self) -> bool {
        let guard = self.inner.lock().unwrap();
        guard.process.is_some()
    }
}
