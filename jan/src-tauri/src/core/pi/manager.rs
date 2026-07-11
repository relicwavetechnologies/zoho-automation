use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use super::browser::{current_browser_cdp_fingerprint, kill_orphan_chrome_devtools_mcp};
use super::env::{
    apply_divo_gateway_env, apply_divo_skill_env, apply_divo_workspace_env, apply_local_lark_env,
    apply_provider_env,
};
use super::runtime::PiRuntimePaths;
use super::session::{ensure_session_workspace_cwd, resolve_session_path};
use crate::core::divo::workspace::{prepare_workspace_run_layout, DivoWorkspaceRunLayout};
use crate::core::threads::utils::ensure_thread_dir_exists;

const DIVO_APPROVAL_PROTOCOL_TITLE: &str = "divo_approval_v1";
const DIVO_MEMORY_REVIEW_PROTOCOL_TITLE: &str = "divo_memory_review_v1";
const MAX_MEMORY_REVIEW_MESSAGE_BYTES: usize = 16_000;

struct PiProcess {
    child: Child,
    stdin: std::process::ChildStdin,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingExtensionUiRequest {
    thread_id: String,
    method: String,
    source: Option<ApprovalSource>,
    protocol: ExtensionUiProtocol,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExtensionUiProtocol {
    Approval,
    MemoryReview,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApprovalSource {
    Divo,
    Bash,
    Edit,
    Write,
}

fn take_pending_confirm(
    requests: &mut HashMap<String, PendingExtensionUiRequest>,
    active_thread_id: Option<&str>,
    request_id: &str,
    thread_id: &str,
) -> Result<PendingExtensionUiRequest, String> {
    if active_thread_id != Some(thread_id) {
        return Err("Approval response does not belong to the active thread".into());
    }
    let pending = requests
        .get(request_id)
        .ok_or("Unknown or already resolved extension UI request")?;
    if pending.thread_id != thread_id {
        return Err("Approval response thread does not match its request".into());
    }
    if pending.method != "confirm" {
        return Err("This extension UI request is not a confirmation".into());
    }
    if pending.protocol != ExtensionUiProtocol::Approval {
        return Err("This extension UI request is not a Divo approval".into());
    }
    Ok(requests
        .remove(request_id)
        .expect("request existed while the state lock was held"))
}

fn take_pending_memory_review(
    requests: &mut HashMap<String, PendingExtensionUiRequest>,
    active_thread_id: Option<&str>,
    request_id: &str,
    thread_id: &str,
) -> Result<PendingExtensionUiRequest, String> {
    if active_thread_id != Some(thread_id) {
        return Err("Memory review response does not belong to the active thread".into());
    }
    let pending = requests
        .get(request_id)
        .ok_or("Unknown or already resolved memory review request")?;
    if pending.thread_id != thread_id {
        return Err("Memory review response thread does not match its request".into());
    }
    if pending.method != "editor" || pending.protocol != ExtensionUiProtocol::MemoryReview {
        return Err("This extension UI request is not a Divo memory review".into());
    }
    Ok(requests
        .remove(request_id)
        .expect("request existed while the state lock was held"))
}

fn drain_pending_extension_ui(
    requests: &mut HashMap<String, PendingExtensionUiRequest>,
    thread_id: Option<&str>,
) -> Vec<String> {
    let request_ids = requests
        .iter()
        .filter(|(_, request)| {
            thread_id
                .map(|expected| request.thread_id == expected)
                .unwrap_or(true)
        })
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in &request_ids {
        requests.remove(id);
    }
    request_ids
}

fn is_divo_approval_request(value: &serde_json::Value, thread_id: &str) -> bool {
    !thread_id.is_empty()
        && value.get("method").and_then(|v| v.as_str()) == Some("confirm")
        && value.get("title").and_then(|v| v.as_str()) == Some(DIVO_APPROVAL_PROTOCOL_TITLE)
}

fn is_non_empty_bounded_string(value: Option<&serde_json::Value>, max: usize) -> bool {
    value
        .and_then(|value| value.as_str())
        .is_some_and(|value| !value.trim().is_empty() && value.trim().chars().count() <= max)
}

fn valid_memory_review_request(value: &serde_json::Value) -> bool {
    let Some(prefill) = value.get("prefill").and_then(|value| value.as_str()) else {
        return false;
    };
    if prefill.len() > MAX_MEMORY_REVIEW_MESSAGE_BYTES {
        return false;
    }
    let Ok(descriptor) = serde_json::from_str::<serde_json::Value>(prefill) else {
        return false;
    };
    if descriptor.get("version").and_then(|value| value.as_u64()) != Some(1)
        || !is_non_empty_bounded_string(descriptor.get("proposalId"), 200)
    {
        return false;
    }
    let Some(bullets) = descriptor.get("bullets").and_then(|value| value.as_array()) else {
        return false;
    };
    if bullets.len() > 10
        || bullets.iter().any(|bullet| {
            !is_non_empty_bounded_string(bullet.get("id"), 200)
                || !is_non_empty_bounded_string(bullet.get("text"), 500)
        })
    {
        return false;
    }
    let Some(targets) = descriptor
        .get("allowedTargets")
        .and_then(|value| value.as_array())
    else {
        return false;
    };
    !targets.is_empty()
        && targets.len() <= 3
        && targets.iter().all(|target| {
            let scope = target.get("scope").and_then(|value| value.as_str());
            let department_id = target.get("departmentId");
            matches!(scope, Some("personal" | "department" | "company"))
                && is_non_empty_bounded_string(target.get("label"), 200)
                && match scope {
                    Some("department") => is_non_empty_bounded_string(department_id, 200),
                    _ => department_id.is_none(),
                }
        })
}

fn is_divo_memory_review_request(value: &serde_json::Value, thread_id: &str) -> bool {
    !thread_id.is_empty()
        && value.get("method").and_then(|value| value.as_str()) == Some("editor")
        && value.get("title").and_then(|value| value.as_str())
            == Some(DIVO_MEMORY_REVIEW_PROTOCOL_TITLE)
        && valid_memory_review_request(value)
}

fn valid_memory_review_response(value: &str) -> bool {
    if value.len() > MAX_MEMORY_REVIEW_MESSAGE_BYTES {
        return false;
    }
    let Ok(response) = serde_json::from_str::<serde_json::Value>(value) else {
        return false;
    };
    if response.get("version").and_then(|value| value.as_u64()) != Some(1)
        || !is_non_empty_bounded_string(response.get("proposalId"), 200)
    {
        return false;
    }
    let decision = response.get("decision").and_then(|value| value.as_str());
    if !matches!(decision, Some("approve" | "revise" | "cancel")) {
        return false;
    }
    let Some(selected_ids) = response
        .get("selectedBulletIds")
        .and_then(|value| value.as_array())
    else {
        return false;
    };
    if selected_ids.len() > 10
        || selected_ids
            .iter()
            .any(|value| !is_non_empty_bounded_string(Some(value), 200))
    {
        return false;
    }
    let target_valid = match response.get("selectedTarget") {
        Some(serde_json::Value::Null) | None => false,
        Some(target) => match target.get("scope").and_then(|value| value.as_str()) {
            Some("department") => is_non_empty_bounded_string(target.get("departmentId"), 200),
            Some("personal" | "company") => target.get("departmentId").is_none(),
            _ => false,
        },
    };
    match decision {
        Some("approve") => target_valid && !selected_ids.is_empty(),
        Some("revise") => is_non_empty_bounded_string(response.get("revision"), 1_000),
        Some("cancel") => true,
        _ => false,
    }
}

fn approval_source(value: &serde_json::Value) -> Option<ApprovalSource> {
    let message = value.get("message")?.as_str()?;
    let descriptor: serde_json::Value = serde_json::from_str(message).ok()?;
    if descriptor.get("version").and_then(|value| value.as_u64()) != Some(1) {
        return None;
    }
    match descriptor.get("source").and_then(|value| value.as_str()) {
        Some("divo") => Some(ApprovalSource::Divo),
        Some("bash") => Some(ApprovalSource::Bash),
        Some("edit") => Some(ApprovalSource::Edit),
        Some("write") => Some(ApprovalSource::Write),
        _ => None,
    }
}

fn should_auto_allow_bash(
    source: Option<ApprovalSource>,
    allowed_threads: &HashSet<String>,
    thread_id: &str,
) -> bool {
    source == Some(ApprovalSource::Bash) && allowed_threads.contains(thread_id)
}

fn can_enable_always_allow_bash(pending: &PendingExtensionUiRequest, confirmed: bool) -> bool {
    confirmed && pending.source == Some(ApprovalSource::Bash)
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
    pending_extension_ui: HashMap<String, PendingExtensionUiRequest>,
    bash_always_allowed_threads: HashSet<String>,
    stdout_buffer: String,
}

pub struct PiManager {
    inner: Arc<StdMutex<SharedState>>,
    cmd_tx: mpsc::Sender<String>,
    // Pi stdout is consumed on a blocking thread. Keep the app handle behind
    // the same blocking mutex so forwarding an extension UI request cannot
    // silently lose the event when a Tokio mutex is temporarily contended.
    app: Arc<StdMutex<Option<AppHandle>>>,
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
            pending_extension_ui: HashMap::new(),
            bash_always_allowed_threads: HashSet::new(),
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
            app: Arc::new(StdMutex::new(None)),
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
            let mut app_guard = self.app.lock().unwrap();
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
                guard.pending_extension_ui.clear();
                if let Some(thread_id) = initial_thread_id.as_deref() {
                    guard
                        .bash_always_allowed_threads
                        .retain(|candidate| candidate == thread_id);
                } else {
                    guard.bash_always_allowed_threads.clear();
                }
                guard.active_thread_id = None;
                kill_orphan_chrome_devtools_mcp();
            }
            guard.browser_cdp_fingerprint = new_fingerprint;
        }

        kill_orphan_chrome_devtools_mcp();

        let (stdout, stderr, child_pid) = {
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
            apply_divo_skill_env(&mut cmd, &runtime.skill_dirs);
            apply_divo_workspace_env(&mut cmd, &workspace_dir, &divo_layout);
            apply_local_lark_env(&mut cmd, runtime.lark_cli_wrapper.as_deref());
            let mut child = cmd.spawn().map_err(|e| {
                format!(
                    "Failed to spawn bundled Pi (bun={} cli={}): {e}",
                    runtime.bun.display(),
                    runtime.cli_js.display()
                )
            })?;
            let child_pid = child.id();

            let stdin = child.stdin.take().ok_or("Failed to capture pi stdin")?;
            let stdout = child.stdout.take().ok_or("Failed to capture pi stdout")?;
            let stderr = child.stderr.take().ok_or("Failed to capture pi stderr")?;

            guard.data_folder = Some(data_folder);
            guard.scratch_dir = Some(scratch_dir);
            guard.workspace_dir = Some(workspace_dir);
            guard.run_thread_id = Some(run_thread_id);
            guard.process = Some(PiProcess { child, stdin });
            (stdout, stderr, child_pid)
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
            let should_emit_exit = {
                let mut guard = inner_reader.lock().unwrap();
                let is_current_process = guard
                    .process
                    .as_ref()
                    .map(|pi| pi.child.id() == child_pid)
                    .unwrap_or(false);
                if is_current_process {
                    guard.process = None;
                    guard.pending_extension_ui.clear();
                    guard.bash_always_allowed_threads.clear();
                }
                is_current_process
            };
            if !should_emit_exit {
                return;
            }
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
        app: &Arc<StdMutex<Option<AppHandle>>>,
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
            let request_id = value
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_owned);
            if let (Some(id), Some(method)) = (
                value.get("id").and_then(|v| v.as_str()),
                value.get("method").and_then(|v| v.as_str()),
            ) {
                if is_divo_approval_request(&value, &thread_id) {
                    let source = approval_source(&value);
                    let auto_allow_bash = {
                        let guard = inner.lock().unwrap();
                        should_auto_allow_bash(
                            source,
                            &guard.bash_always_allowed_threads,
                            &thread_id,
                        )
                    };

                    if auto_allow_bash {
                        let response = serde_json::json!({
                            "type": "extension_ui_response",
                            "id": id,
                            "confirmed": true
                        });
                        if serde_json::to_string(&response)
                            .ok()
                            .is_some_and(|json| cmd_tx.send(json).is_ok())
                        {
                            return;
                        }
                    }

                    inner.lock().unwrap().pending_extension_ui.insert(
                        id.to_string(),
                        PendingExtensionUiRequest {
                            thread_id: thread_id.clone(),
                            method: method.to_string(),
                            source,
                            protocol: ExtensionUiProtocol::Approval,
                        },
                    );
                } else if is_divo_memory_review_request(&value, &thread_id) {
                    inner.lock().unwrap().pending_extension_ui.insert(
                        id.to_string(),
                        PendingExtensionUiRequest {
                            thread_id: thread_id.clone(),
                            method: method.to_string(),
                            source: None,
                            protocol: ExtensionUiProtocol::MemoryReview,
                        },
                    );
                } else if matches!(method, "select" | "confirm" | "input" | "editor") {
                    // The desktop implements only the named Divo approval and
                    // memory-review contracts. Keep every other dialog fail-closed
                    // instead of leaving Pi blocked on UI the frontend cannot render.
                    if let Ok(json) = serde_json::to_string(&serde_json::json!({
                        "type": "extension_ui_response",
                        "id": id,
                        "cancelled": true
                    })) {
                        let _ = cmd_tx.send(json);
                    }
                }
            }
            if !Self::emit_pi_event(app, thread_id, value.clone()) {
                // The editor/confirm promise is already pending in Pi. If the
                // desktop cannot deliver its card request, cancel it instead
                // of leaving the agent blocked with no actionable UI.
                if let Some(request_id) = request_id {
                    let should_cancel = inner
                        .lock()
                        .unwrap()
                        .pending_extension_ui
                        .remove(&request_id)
                        .is_some();
                    if should_cancel {
                        if let Ok(json) = serde_json::to_string(&serde_json::json!({
                            "type": "extension_ui_response",
                            "id": request_id,
                            "cancelled": true
                        })) {
                            let _ = cmd_tx.send(json);
                        }
                    }
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
        app: &Arc<StdMutex<Option<AppHandle>>>,
        thread_id: String,
        mut event: serde_json::Value,
    ) -> bool {
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

        let app = app.lock().unwrap().clone();
        let Some(app) = app else {
            eprintln!("[pi] Cannot emit Pi event: app handle is unavailable");
            return false;
        };
        if let Err(error) = app.emit("pi-event", event) {
            eprintln!("[pi] Failed to emit Pi event: {error}");
            return false;
        }
        true
    }

    pub async fn ensure_thread(&self, thread_id: String) -> Result<(), String> {
        let needs_switch = {
            let guard = self.inner.lock().unwrap();
            guard.active_thread_id.as_deref() != Some(thread_id.as_str())
        };

        if !needs_switch {
            return Ok(());
        }

        self.cancel_pending_extension_ui(None);
        let preserve_bash_rule = {
            let mut guard = self.inner.lock().unwrap();
            let preserve = guard.bash_always_allowed_threads.contains(&thread_id);
            guard
                .bash_always_allowed_threads
                .retain(|candidate| candidate == &thread_id);
            preserve
        };

        if let Ok(state) = self.get_state().await {
            if state
                .get("isStreaming")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                self.abort().await?;
                if preserve_bash_rule {
                    self.set_bash_approval_rule(&thread_id, true);
                }
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
        let app = self.app.lock().unwrap().clone();
        if let Some(app) = app {
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
        self.cancel_pending_extension_ui(None);
        self.inner
            .lock()
            .unwrap()
            .bash_always_allowed_threads
            .clear();
        self.send_rpc(serde_json::json!({ "type": "abort" }))
            .await?;
        Ok(())
    }

    pub async fn stop(&self) {
        self.cancel_pending_extension_ui(None);
        let mut guard = self.inner.lock().unwrap();
        if let Some(mut pi) = guard.process.take() {
            let _ = pi.child.kill();
        }
        guard.active_thread_id = None;
        guard.run_thread_id = None;
        guard.browser_cdp_fingerprint = None;
        guard.pending.clear();
        guard.pending_extension_ui.clear();
        guard.bash_always_allowed_threads.clear();
    }

    fn cancel_pending_extension_ui(&self, thread_id: Option<&str>) {
        let request_ids = {
            let mut guard = self.inner.lock().unwrap();
            drain_pending_extension_ui(&mut guard.pending_extension_ui, thread_id)
        };

        for id in request_ids {
            if let Ok(json) = serde_json::to_string(&serde_json::json!({
                "type": "extension_ui_response",
                "id": id,
                "cancelled": true
            })) {
                let _ = self.cmd_tx.send(json);
            }
        }
    }

    pub fn extension_ui_response(
        &self,
        request_id: String,
        thread_id: String,
        confirmed: Option<bool>,
        value: Option<String>,
        cancelled: bool,
        always_allow_bash: bool,
    ) -> Result<(), String> {
        let (pending, response) = {
            let mut guard = self.inner.lock().unwrap();
            if guard.process.is_none() {
                return Err("Pi process is not running".into());
            }
            let active_thread_id = guard.active_thread_id.clone();
            let protocol = guard
                .pending_extension_ui
                .get(&request_id)
                .map(|pending| pending.protocol)
                .ok_or("Unknown or already resolved extension UI request")?;
            let pending = match protocol {
                ExtensionUiProtocol::Approval => take_pending_confirm(
                    &mut guard.pending_extension_ui,
                    active_thread_id.as_deref(),
                    &request_id,
                    &thread_id,
                )?,
                ExtensionUiProtocol::MemoryReview => take_pending_memory_review(
                    &mut guard.pending_extension_ui,
                    active_thread_id.as_deref(),
                    &request_id,
                    &thread_id,
                )?,
            };
            let is_confirmed = confirmed.unwrap_or(false);
            if always_allow_bash && !can_enable_always_allow_bash(&pending, is_confirmed) {
                guard
                    .pending_extension_ui
                    .insert(request_id.clone(), pending);
                return Err("Always allow is available only for a confirmed Bash request".into());
            }
            if always_allow_bash {
                guard.bash_always_allowed_threads.insert(thread_id.clone());
            }
            let response = match protocol {
                ExtensionUiProtocol::Approval => {
                    let Some(confirmed) = confirmed else {
                        guard
                            .pending_extension_ui
                            .insert(request_id.clone(), pending);
                        return Err("Divo approval response requires confirmed".into());
                    };
                    serde_json::json!({
                        "type": "extension_ui_response",
                        "id": request_id.clone(),
                        "confirmed": confirmed
                    })
                }
                ExtensionUiProtocol::MemoryReview => {
                    if cancelled {
                        serde_json::json!({
                            "type": "extension_ui_response",
                            "id": request_id.clone(),
                            "cancelled": true
                        })
                    } else if value.as_deref().is_some_and(valid_memory_review_response) {
                        serde_json::json!({
                            "type": "extension_ui_response",
                            "id": request_id.clone(),
                            "value": value.expect("validated value is present")
                        })
                    } else {
                        // Invalid structured form data is consumed as a cancellation.
                        // Never leave Pi waiting or let malformed data reach publishing.
                        serde_json::json!({
                            "type": "extension_ui_response",
                            "id": request_id.clone(),
                            "cancelled": true
                        })
                    }
                }
            };
            (pending, response)
        };

        let response = serde_json::to_string(&response).map_err(|error| error.to_string())?;

        if let Err(error) = self.write_stdin(&response) {
            let mut guard = self.inner.lock().unwrap();
            if always_allow_bash {
                guard.bash_always_allowed_threads.remove(&thread_id);
            }
            guard.pending_extension_ui.insert(request_id, pending);
            return Err(error);
        }
        Ok(())
    }

    pub fn revoke_bash_approval(&self, thread_id: &str) {
        self.set_bash_approval_rule(thread_id, false);
    }

    pub fn set_bash_approval_rule(&self, thread_id: &str, allowed: bool) {
        let mut guard = self.inner.lock().unwrap();
        if allowed {
            guard
                .bash_always_allowed_threads
                .insert(thread_id.to_string());
        } else {
            guard.bash_always_allowed_threads.remove(thread_id);
        }
    }

    pub fn bash_approval_allowed(&self, thread_id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .bash_always_allowed_threads
            .contains(thread_id)
    }

    pub async fn is_running(&self) -> bool {
        let guard = self.inner.lock().unwrap();
        guard.process.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        approval_source, can_enable_always_allow_bash, drain_pending_extension_ui,
        is_divo_approval_request, is_divo_memory_review_request, should_auto_allow_bash,
        take_pending_confirm, take_pending_memory_review, valid_memory_review_response,
        ApprovalSource, ExtensionUiProtocol, PendingExtensionUiRequest, PiManager,
    };
    use std::collections::{HashMap, HashSet};

    fn pending(method: &str, thread_id: &str) -> PendingExtensionUiRequest {
        PendingExtensionUiRequest {
            thread_id: thread_id.to_string(),
            method: method.to_string(),
            source: None,
            protocol: ExtensionUiProtocol::Approval,
        }
    }

    #[test]
    fn confirmation_response_requires_matching_active_thread_and_request() {
        let mut requests =
            HashMap::from([("request-1".to_string(), pending("confirm", "thread-1"))]);

        assert!(
            take_pending_confirm(&mut requests, Some("thread-2"), "request-1", "thread-1").is_err()
        );
        assert!(requests.contains_key("request-1"));

        assert!(
            take_pending_confirm(&mut requests, Some("thread-1"), "unknown", "thread-1").is_err()
        );
        assert!(requests.contains_key("request-1"));

        assert!(
            take_pending_confirm(&mut requests, Some("thread-1"), "request-1", "thread-1").is_ok()
        );
        assert!(requests.is_empty());
    }

    #[test]
    fn confirmation_response_rejects_other_dialog_methods_without_consuming_them() {
        let mut requests = HashMap::from([("request-1".to_string(), pending("input", "thread-1"))]);

        assert!(
            take_pending_confirm(&mut requests, Some("thread-1"), "request-1", "thread-1").is_err()
        );
        assert!(requests.contains_key("request-1"));
    }

    #[test]
    fn fail_closed_cleanup_drains_only_the_selected_thread() {
        let mut requests = HashMap::from([
            ("request-1".to_string(), pending("confirm", "thread-1")),
            ("request-2".to_string(), pending("confirm", "thread-2")),
        ]);

        assert_eq!(
            drain_pending_extension_ui(&mut requests, Some("thread-1")),
            vec!["request-1".to_string()]
        );
        assert!(!requests.contains_key("request-1"));
        assert!(requests.contains_key("request-2"));
    }

    #[test]
    fn only_the_versioned_divo_confirm_is_forwarded_to_the_frontend() {
        assert!(is_divo_approval_request(
            &serde_json::json!({
                "method": "confirm",
                "title": "divo_approval_v1"
            }),
            "thread-1"
        ));
        assert!(!is_divo_approval_request(
            &serde_json::json!({
                "method": "confirm",
                "title": "Other extension"
            }),
            "thread-1"
        ));
        assert!(!is_divo_approval_request(
            &serde_json::json!({
                "method": "select",
                "title": "divo_approval_v1"
            }),
            "thread-1"
        ));
        assert!(!is_divo_approval_request(
            &serde_json::json!({
                "method": "confirm",
                "title": "divo_approval_v1"
            }),
            ""
        ));
    }

    fn memory_review_event(prefill: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "method": "editor",
            "title": "divo_memory_review_v1",
            "prefill": prefill.to_string()
        })
    }

    #[test]
    fn only_valid_named_memory_reviews_are_forwarded() {
        let valid = memory_review_event(serde_json::json!({
            "version": 1,
            "proposalId": "proposal-1",
            "bullets": [{"id": "fact-1", "text": "Acme uses net-60 terms."}],
            "allowedTargets": [
                {"scope": "personal", "label": "Personal"},
                {"scope": "department", "label": "Finance", "departmentId": "dept-1"}
            ]
        }));
        assert!(is_divo_memory_review_request(&valid, "thread-1"));
        assert!(!is_divo_memory_review_request(&valid, ""));

        let malformed = memory_review_event(serde_json::json!({
            "version": 1,
            "proposalId": "proposal-1",
            "bullets": [{"id": "fact-1", "text": "Fact"}],
            "allowedTargets": [{"scope": "department", "label": "Finance"}]
        }));
        assert!(!is_divo_memory_review_request(&malformed, "thread-1"));
    }

    #[test]
    fn memory_review_responses_are_request_and_thread_bound() {
        let mut request = pending("editor", "thread-1");
        request.protocol = ExtensionUiProtocol::MemoryReview;
        let mut requests = HashMap::from([("review-1".to_string(), request)]);

        assert!(take_pending_memory_review(
            &mut requests,
            Some("thread-2"),
            "review-1",
            "thread-1"
        )
        .is_err());
        assert!(requests.contains_key("review-1"));
        assert!(take_pending_memory_review(
            &mut requests,
            Some("thread-1"),
            "review-1",
            "thread-1"
        )
        .is_ok());
        assert!(requests.is_empty());
    }

    #[test]
    fn malformed_memory_review_values_fail_closed() {
        assert!(valid_memory_review_response(
            &serde_json::json!({
                "version": 1,
                "proposalId": "proposal-1",
                "decision": "approve",
                "selectedTarget": {"scope": "department", "departmentId": "dept-1"},
                "selectedBulletIds": ["fact-1"]
            })
            .to_string()
        ));
        assert!(!valid_memory_review_response("not json"));
        assert!(!valid_memory_review_response(
            &serde_json::json!({
                "version": 1,
                "proposalId": "proposal-1",
                "decision": "approve",
                "selectedTarget": {"scope": "company"},
                "selectedBulletIds": []
            })
            .to_string()
        ));
    }

    #[test]
    fn memory_review_field_limits_count_unicode_characters_not_utf8_bytes() {
        let at_fact_limit = "界".repeat(500);
        let over_fact_limit = "界".repeat(501);
        let valid_request = memory_review_event(serde_json::json!({
            "version": 1,
            "proposalId": "proposal-1",
            "bullets": [{"id": "fact-1", "text": at_fact_limit}],
            "allowedTargets": [{"scope": "personal", "label": "Personal"}]
        }));
        let invalid_request = memory_review_event(serde_json::json!({
            "version": 1,
            "proposalId": "proposal-1",
            "bullets": [{"id": "fact-1", "text": over_fact_limit}],
            "allowedTargets": [{"scope": "personal", "label": "Personal"}]
        }));
        assert!(is_divo_memory_review_request(&valid_request, "thread-1"));
        assert!(!is_divo_memory_review_request(&invalid_request, "thread-1"));

        let response = |revision: String| {
            serde_json::json!({
                "version": 1,
                "proposalId": "proposal-1",
                "decision": "revise",
                "selectedTarget": null,
                "selectedBulletIds": [],
                "revision": revision
            })
            .to_string()
        };
        assert!(valid_memory_review_response(&response("界".repeat(1_000))));
        assert!(!valid_memory_review_response(&response("界".repeat(1_001))));
    }

    #[test]
    fn always_allow_classification_accepts_only_versioned_bash_requests() {
        let bash = serde_json::json!({
            "message": serde_json::json!({
                "version": 1,
                "source": "bash",
                "kind": "bash.execute"
            }).to_string()
        });
        let edit = serde_json::json!({
            "message": serde_json::json!({
                "version": 1,
                "source": "edit",
                "kind": "file.edit"
            }).to_string()
        });
        let unknown_version = serde_json::json!({
            "message": serde_json::json!({
                "version": 2,
                "source": "bash"
            }).to_string()
        });

        assert_eq!(approval_source(&bash), Some(ApprovalSource::Bash));
        assert_eq!(approval_source(&edit), Some(ApprovalSource::Edit));
        assert_eq!(approval_source(&unknown_version), None);
    }

    #[test]
    fn bash_grants_are_source_and_thread_scoped() {
        let allowed = HashSet::from(["thread-1".to_string()]);
        assert!(should_auto_allow_bash(
            Some(ApprovalSource::Bash),
            &allowed,
            "thread-1"
        ));
        assert!(!should_auto_allow_bash(
            Some(ApprovalSource::Bash),
            &allowed,
            "thread-2"
        ));
        assert!(!should_auto_allow_bash(
            Some(ApprovalSource::Write),
            &allowed,
            "thread-1"
        ));

        let bash = PendingExtensionUiRequest {
            thread_id: "thread-1".into(),
            method: "confirm".into(),
            source: Some(ApprovalSource::Bash),
            protocol: ExtensionUiProtocol::Approval,
        };
        let divo = PendingExtensionUiRequest {
            source: Some(ApprovalSource::Divo),
            ..bash.clone()
        };
        assert!(can_enable_always_allow_bash(&bash, true));
        assert!(!can_enable_always_allow_bash(&bash, false));
        assert!(!can_enable_always_allow_bash(&divo, true));
    }

    #[test]
    fn permission_rules_can_explicitly_enable_and_revoke_bash_for_one_task() {
        let manager = PiManager::new();

        manager.set_bash_approval_rule("thread-1", true);
        assert!(manager.bash_approval_allowed("thread-1"));
        assert!(!manager.bash_approval_allowed("thread-2"));

        manager.revoke_bash_approval("thread-1");
        assert!(!manager.bash_approval_allowed("thread-1"));
    }
}
