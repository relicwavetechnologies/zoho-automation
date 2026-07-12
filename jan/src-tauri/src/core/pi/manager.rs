use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

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
struct RunOwner {
    thread_id: String,
    run_id: String,
}

impl RunOwner {
    fn new(thread_id: String, run_id: String) -> Result<Self, String> {
        let thread_id = thread_id.trim().to_string();
        if thread_id.is_empty() {
            return Err("A thread id is required".into());
        }
        let run_id = run_id.trim().to_string();
        if run_id.is_empty() {
            return Err("A run id is required".into());
        }
        Ok(Self { thread_id, run_id })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingExtensionUiRequest {
    owner: RunOwner,
    method: String,
    source: Option<ApprovalSource>,
    protocol: ExtensionUiProtocol,
}

#[derive(Debug)]
struct PendingRpc {
    command: String,
    owner: Option<RunOwner>,
    tx: oneshot::Sender<Result<serde_json::Value, String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ExtensionUiReconciliation {
    request_id: String,
    owner: RunOwner,
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
    request_id: &str,
    owner: &RunOwner,
) -> Result<PendingExtensionUiRequest, String> {
    let pending = requests
        .get(request_id)
        .ok_or("Unknown or already resolved extension UI request")?;
    if pending.owner != *owner {
        return Err("Approval response does not match its active run".into());
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
    request_id: &str,
    owner: &RunOwner,
) -> Result<PendingExtensionUiRequest, String> {
    let pending = requests
        .get(request_id)
        .ok_or("Unknown or already resolved memory review request")?;
    if pending.owner != *owner {
        return Err("Memory review response does not match its active run".into());
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
    owner: Option<&RunOwner>,
) -> Vec<ExtensionUiReconciliation> {
    let reconciliations = requests
        .iter()
        .filter(|(_, request)| {
            owner
                .map(|expected| request.owner == *expected)
                .unwrap_or(true)
        })
        .map(|(id, request)| ExtensionUiReconciliation {
            request_id: id.clone(),
            owner: request.owner.clone(),
        })
        .collect::<Vec<_>>();
    for reconciliation in &reconciliations {
        let id = &reconciliation.request_id;
        requests.remove(id);
    }
    reconciliations
}

fn fail_pending_rpc(pending: &mut HashMap<String, PendingRpc>, error: &str) {
    for (_, pending) in pending.drain() {
        let _ = pending.tx.send(Err(error.to_string()));
    }
}

fn require_active_run(
    active_run: Option<&RunOwner>,
    owner: &RunOwner,
    action: &str,
) -> Result<(), String> {
    match active_run {
        Some(active) if active == owner => Ok(()),
        Some(_) => Err(format!("{action} does not belong to the active run")),
        None => Err(format!("No active Pi run matches this {action} request")),
    }
}

fn clear_active_run_if_matches(active_run: &mut Option<RunOwner>, owner: &RunOwner) -> bool {
    if active_run.as_ref() == Some(owner) {
        *active_run = None;
        return true;
    }
    false
}

/// A prompt acknowledgement only ends ownership when Pi rejects the prompt.
/// A successful acknowledgement means the agent has accepted work and remains
/// the active owner until a later terminal lifecycle event.
fn response_clears_active_run(pending: &PendingRpc, success: bool) -> bool {
    pending.command == "prompt" && !success
}

fn event_owner_payload(event: &mut serde_json::Value, owner: Option<&RunOwner>) {
    if let Some(obj) = event.as_object_mut() {
        obj.insert(
            "thread_id".to_string(),
            serde_json::Value::String(
                owner
                    .map(|owner| owner.thread_id.clone())
                    .unwrap_or_default(),
            ),
        );
        if let Some(owner) = owner {
            obj.insert(
                "run_id".to_string(),
                serde_json::Value::String(owner.run_id.clone()),
            );
        }
        return;
    }

    *event = serde_json::json!({
        "thread_id": owner
            .map(|owner| owner.thread_id.clone())
            .unwrap_or_default(),
        "run_id": owner.map(|owner| owner.run_id.clone()),
        "type": "unknown",
        "payload": event.clone()
    });
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
    runtime_thread_id: Option<String>,
    active_thread_id: Option<String>,
    active_run: Option<RunOwner>,
    browser_cdp_fingerprint: Option<String>,
    pending: HashMap<String, PendingRpc>,
    pending_extension_ui: HashMap<String, PendingExtensionUiRequest>,
    bash_always_allowed_threads: HashSet<String>,
    stdout_buffer: String,
}

pub struct PiManager {
    inner: Arc<StdMutex<SharedState>>,
    lifecycle: Arc<Mutex<()>>,
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
            lifecycle: self.lifecycle.clone(),
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
            runtime_thread_id: None,
            active_thread_id: None,
            active_run: None,
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
            lifecycle: Arc::new(Mutex::new(())),
            cmd_tx,
            app: Arc::new(StdMutex::new(None)),
        }
    }

    fn write_stdin(&self, json: &str) -> Result<(), String> {
        self.cmd_tx
            .send(json.to_string())
            .map_err(|e| format!("Failed to queue Pi command: {}", e))
    }

    async fn send_rpc(
        &self,
        mut cmd: serde_json::Value,
        owner: Option<RunOwner>,
    ) -> Result<serde_json::Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let command = cmd
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown")
            .to_string();
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
            guard
                .pending
                .insert(id.clone(), PendingRpc { command, owner, tx });
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
                .send_rpc(serde_json::json!({ "type": "get_state" }), None)
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

    fn emit_extension_ui_reconciliations(
        app: &Arc<StdMutex<Option<AppHandle>>>,
        reconciliations: Vec<ExtensionUiReconciliation>,
        reason: &str,
    ) {
        for reconciliation in reconciliations {
            Self::emit_pi_event(
                app,
                Some(&reconciliation.owner),
                serde_json::json!({
                    "type": "extension_ui_response",
                    "id": reconciliation.request_id,
                    "cancelled": true,
                    "reason": reason,
                }),
            );
        }
    }

    fn clear_active_run_for_owner(&self, owner: &RunOwner) {
        let mut guard = self.inner.lock().unwrap();
        clear_active_run_if_matches(&mut guard.active_run, owner);
    }

    fn active_run(&self) -> Option<RunOwner> {
        self.inner.lock().unwrap().active_run.clone()
    }

    async fn wait_for_run_clear(&self, owner: &RunOwner) -> Result<(), String> {
        for _ in 0..100 {
            if self.active_run().as_ref() != Some(owner) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err("Timed out waiting for the active Pi run to stop".into())
    }

    async fn start_locked(
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

        let reconciliations = {
            let mut guard = self.inner.lock().unwrap();
            if guard.process.is_some() {
                let workspace_changed = guard
                    .workspace_dir
                    .as_ref()
                    .map(|current| current != &workspace_dir)
                    .unwrap_or(true);
                let stale =
                    new_fingerprint.is_some() && new_fingerprint != guard.browser_cdp_fingerprint;
                if !stale && !workspace_changed {
                    return Ok(());
                }
                if let Some(mut pi) = guard.process.take() {
                    let _ = pi.child.kill();
                }
                fail_pending_rpc(
                    &mut guard.pending,
                    "Pi process restarted before the RPC completed",
                );
                let reconciliations =
                    drain_pending_extension_ui(&mut guard.pending_extension_ui, None);
                if let Some(thread_id) = initial_thread_id.as_deref() {
                    guard
                        .bash_always_allowed_threads
                        .retain(|candidate| candidate == thread_id);
                } else {
                    guard.bash_always_allowed_threads.clear();
                }
                guard.active_run = None;
                guard.runtime_thread_id = None;
                guard.active_thread_id = None;
                guard.browser_cdp_fingerprint = new_fingerprint.clone();
                reconciliations
            } else {
                guard.browser_cdp_fingerprint = new_fingerprint.clone();
                Vec::new()
            }
        };

        if !reconciliations.is_empty() {
            Self::emit_extension_ui_reconciliations(
                &self.app,
                reconciliations,
                "process_restarted",
            );
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
            guard.runtime_thread_id = Some(run_thread_id);
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
            let (should_emit_exit, owner, reconciliations) = {
                let mut guard = inner_reader.lock().unwrap();
                let is_current_process = guard
                    .process
                    .as_ref()
                    .map(|pi| pi.child.id() == child_pid)
                    .unwrap_or(false);
                if !is_current_process {
                    (false, None, Vec::new())
                } else {
                    let owner = guard.active_run.take();
                    fail_pending_rpc(&mut guard.pending, "Pi process exited unexpectedly");
                    let reconciliations =
                        drain_pending_extension_ui(&mut guard.pending_extension_ui, None);
                    guard.process = None;
                    guard.runtime_thread_id = None;
                    guard.active_thread_id = None;
                    guard.bash_always_allowed_threads.clear();
                    (true, owner, reconciliations)
                }
            };
            if !should_emit_exit {
                return;
            }
            Self::emit_extension_ui_reconciliations(&app_reader, reconciliations, "process_exited");
            Self::emit_pi_event(
                &app_reader,
                owner.as_ref(),
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
                let success = value
                    .get("success")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                let (pending, clear_owner) = {
                    let mut guard = inner.lock().unwrap();
                    let pending = guard.pending.remove(id);
                    let clear_owner = pending
                        .as_ref()
                        .filter(|pending| response_clears_active_run(pending, success))
                        .and_then(|pending| pending.owner.clone());
                    if let Some(owner) = clear_owner.as_ref() {
                        clear_active_run_if_matches(&mut guard.active_run, owner);
                    }
                    (pending, clear_owner)
                };
                if let Some(pending) = pending {
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
                    let owner = pending.owner.clone();
                    let _ = pending.tx.send(result);

                    if pending.command == "prompt" {
                        if success {
                            let request_id = value
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            Self::emit_pi_event(
                                app,
                                owner.as_ref(),
                                serde_json::json!({
                                    "type": "prompt_accepted",
                                    "requestId": request_id
                                }),
                            );
                        } else if let Some(msg) = value.get("error").and_then(|v| v.as_str()) {
                            let owner = clear_owner.or(owner);
                            Self::emit_pi_event(
                                app,
                                owner.as_ref(),
                                serde_json::json!({
                                    "type": "prompt_rejected",
                                    "message": msg
                                }),
                            );
                        }
                    }
                }
            }
            return;
        }

        if event_type == Some("extension_ui_request") {
            let owner = inner.lock().unwrap().active_run.clone();
            let request_owner = match owner {
                Some(owner) => owner,
                None => {
                    if let (Some(id), Some(method)) = (
                        value.get("id").and_then(|value| value.as_str()),
                        value.get("method").and_then(|value| value.as_str()),
                    ) {
                        if matches!(method, "select" | "confirm" | "input" | "editor") {
                            if let Ok(json) = serde_json::to_string(&serde_json::json!({
                                "type": "extension_ui_response",
                                "id": id,
                                "cancelled": true
                            })) {
                                let _ = cmd_tx.send(json);
                            }
                        }
                    }
                    return;
                }
            };
            let request_id = value
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_owned);
            let (registered, auto_response) = if let (Some(id), Some(method)) = (
                value.get("id").and_then(|v| v.as_str()),
                value.get("method").and_then(|v| v.as_str()),
            ) {
                let mut guard = inner.lock().unwrap();
                if guard.active_run.as_ref() != Some(&request_owner) {
                    (false, None)
                } else if is_divo_approval_request(&value, &request_owner.thread_id) {
                    let source = approval_source(&value);
                    if should_auto_allow_bash(
                        source,
                        &guard.bash_always_allowed_threads,
                        &request_owner.thread_id,
                    ) {
                        (
                            true,
                            serde_json::to_string(&serde_json::json!({
                                "type": "extension_ui_response",
                                "id": id,
                                "confirmed": true
                            }))
                            .ok(),
                        )
                    } else {
                        guard.pending_extension_ui.insert(
                            id.to_string(),
                            PendingExtensionUiRequest {
                                owner: request_owner.clone(),
                                method: method.to_string(),
                                source,
                                protocol: ExtensionUiProtocol::Approval,
                            },
                        );
                        (true, None)
                    }
                } else if is_divo_memory_review_request(&value, &request_owner.thread_id) {
                    guard.pending_extension_ui.insert(
                        id.to_string(),
                        PendingExtensionUiRequest {
                            owner: request_owner.clone(),
                            method: method.to_string(),
                            source: None,
                            protocol: ExtensionUiProtocol::MemoryReview,
                        },
                    );
                    (true, None)
                } else {
                    if matches!(method, "select" | "confirm" | "input" | "editor") {
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
                    (true, None)
                }
            } else {
                let guard = inner.lock().unwrap();
                (guard.active_run.as_ref() == Some(&request_owner), None)
            };

            if !registered {
                if let Some(id) = request_id {
                    if let Ok(json) = serde_json::to_string(&serde_json::json!({
                        "type": "extension_ui_response",
                        "id": id,
                        "cancelled": true
                    })) {
                        let _ = cmd_tx.send(json);
                    }
                }
                return;
            }

            if let Some(response) = auto_response {
                let _ = cmd_tx.send(response);
                return;
            }

            // Hold the state lock through event emission. A concurrent abort or
            // stop can therefore only emit its terminal reconciliation after the
            // request card, never before it.
            let delivered = {
                let guard = inner.lock().unwrap();
                guard.active_run.as_ref() == Some(&request_owner)
                    && Self::emit_pi_event(app, Some(&request_owner), value.clone())
            };
            if !delivered {
                // The editor/confirm promise is already pending in Pi. If the
                // desktop cannot deliver its card request, cancel it instead
                // of leaving the agent blocked with no actionable UI.
                if let Some(request_id) = request_id {
                    let cancelled = inner
                        .lock()
                        .unwrap()
                        .pending_extension_ui
                        .remove(&request_id);
                    if let Some(cancelled) = cancelled {
                        if let Ok(json) = serde_json::to_string(&serde_json::json!({
                            "type": "extension_ui_response",
                            "id": request_id,
                            "cancelled": true
                        })) {
                            let _ = cmd_tx.send(json);
                        }
                        Self::emit_pi_event(
                            app,
                            Some(&cancelled.owner),
                            serde_json::json!({
                                "type": "extension_ui_response",
                                "id": request_id,
                                "cancelled": true,
                                "reason": "frontend_delivery_failed"
                            }),
                        );
                    }
                }
            }
            return;
        }

        if event_type.is_some() {
            let (owner, reconciliations) = {
                let mut guard = inner.lock().unwrap();
                let owner = guard.active_run.clone();
                let reconciliations = if event_type == Some("agent_end")
                    && !value
                        .get("willRetry")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
                {
                    guard.active_run = None;
                    owner.as_ref().map_or_else(Vec::new, |owner| {
                        drain_pending_extension_ui(&mut guard.pending_extension_ui, Some(owner))
                    })
                } else {
                    Vec::new()
                };
                (owner, reconciliations)
            };
            Self::emit_extension_ui_reconciliations(&app, reconciliations, "agent_ended");
            Self::emit_pi_event(app, owner.as_ref(), value);
        }
    }

    fn emit_pi_event(
        app: &Arc<StdMutex<Option<AppHandle>>>,
        owner: Option<&RunOwner>,
        mut event: serde_json::Value,
    ) -> bool {
        event_owner_payload(&mut event, owner);

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

    pub async fn start(
        &self,
        app: AppHandle,
        data_folder: PathBuf,
        scratch_dir: PathBuf,
        workspace_dir: PathBuf,
        initial_thread_id: Option<String>,
    ) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        self.start_locked(
            app,
            data_folder,
            scratch_dir,
            workspace_dir,
            initial_thread_id,
        )
        .await
    }

    async fn ensure_thread_locked(&self, thread_id: String) -> Result<(), String> {
        let needs_switch = {
            let guard = self.inner.lock().unwrap();
            guard.active_thread_id.as_deref() != Some(thread_id.as_str())
        };

        if !needs_switch {
            return Ok(());
        }

        let previous_run = self.active_run();
        let preserve_bash_rule = {
            let mut guard = self.inner.lock().unwrap();
            let preserve = guard.bash_always_allowed_threads.contains(&thread_id);
            guard
                .bash_always_allowed_threads
                .retain(|candidate| candidate == &thread_id);
            preserve
        };

        if let Some(owner) = previous_run {
            self.abort_locked(owner.clone(), "thread_switched").await?;
            self.wait_for_run_clear(&owner).await?;
        }

        let restart_for_thread = {
            let guard = self.inner.lock().unwrap();
            guard.runtime_thread_id.as_deref() != Some(thread_id.as_str())
        };
        if restart_for_thread {
            self.restart_for_thread_locked(&thread_id, preserve_bash_rule)
                .await?;
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
            .send_rpc(
                serde_json::json!({
                    "type": "switch_session",
                    "sessionPath": session_path.to_string_lossy()
                }),
                None,
            )
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

    async fn restart_for_thread_locked(
        &self,
        thread_id: &str,
        preserve_bash_rule: bool,
    ) -> Result<(), String> {
        let (data_folder, scratch_dir, workspace_dir) = {
            let guard = self.inner.lock().unwrap();
            (
                guard
                    .data_folder
                    .clone()
                    .ok_or("Pi process is not running")?,
                guard
                    .scratch_dir
                    .clone()
                    .ok_or("Pi scratch directory is not configured")?,
                guard
                    .workspace_dir
                    .clone()
                    .ok_or("Pi workspace is not configured")?,
            )
        };
        let app = self
            .app
            .lock()
            .unwrap()
            .clone()
            .ok_or("Pi app handle is not configured")?;

        self.stop_locked().await;
        if preserve_bash_rule {
            self.set_bash_approval_rule(thread_id, true);
        }
        self.start_locked(
            app,
            data_folder,
            scratch_dir,
            workspace_dir,
            Some(thread_id.to_string()),
        )
        .await
    }

    pub async fn ensure_thread(&self, thread_id: String) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        self.ensure_thread_locked(thread_id).await
    }

    pub async fn get_state(&self) -> Result<serde_json::Value, String> {
        self.send_rpc(serde_json::json!({ "type": "get_state" }), None)
            .await
    }

    async fn restart_if_browser_cdp_changed_locked(&self, app: &AppHandle) -> Result<(), String> {
        let fingerprint = current_browser_cdp_fingerprint();
        let (needs_restart, data_folder, scratch_dir, workspace_dir, initial_thread_id) = {
            let guard = self.inner.lock().unwrap();
            let needs = guard.process.is_some()
                && fingerprint.is_some()
                && fingerprint != guard.browser_cdp_fingerprint;
            (
                needs,
                guard.data_folder.clone(),
                guard.scratch_dir.clone(),
                guard.workspace_dir.clone(),
                guard
                    .active_run
                    .as_ref()
                    .map(|owner| owner.thread_id.clone())
                    .or_else(|| guard.active_thread_id.clone()),
            )
        };

        if !needs_restart {
            return Ok(());
        }

        self.stop_locked().await;
        kill_orphan_chrome_devtools_mcp();

        let (data_folder, scratch_dir, workspace_dir) =
            match (data_folder, scratch_dir, workspace_dir) {
                (Some(d), Some(s), Some(w)) => (d, s, w),
                _ => return Ok(()),
            };

        self.start_locked(
            app.clone(),
            data_folder,
            scratch_dir,
            workspace_dir,
            initial_thread_id,
        )
        .await
    }

    pub async fn prompt(
        &self,
        thread_id: String,
        run_id: String,
        message: String,
    ) -> Result<(), String> {
        let owner = RunOwner::new(thread_id, run_id)?;
        let _lifecycle = self.lifecycle.lock().await;
        let app = self.app.lock().unwrap().clone();
        if let Some(app) = app {
            self.restart_if_browser_cdp_changed_locked(&app).await?;
        }
        self.ensure_thread_locked(owner.thread_id.clone()).await?;
        {
            let mut guard = self.inner.lock().unwrap();
            if let Some(active_run) = guard.active_run.as_ref() {
                if active_run == &owner {
                    return Err("This Pi run is already active".into());
                }
                return Err("Another Pi run is already active".into());
            }
            guard.active_run = Some(owner.clone());
        }
        let result = self
            .send_rpc(
                serde_json::json!({
                    "type": "prompt",
                    "message": message
                }),
                Some(owner.clone()),
            )
            .await;
        if result.is_err() {
            self.clear_active_run_for_owner(&owner);
        }
        result.map(|_| ())
    }

    async fn abort_locked(&self, owner: RunOwner, reason: &str) -> Result<(), String> {
        {
            let guard = self.inner.lock().unwrap();
            require_active_run(guard.active_run.as_ref(), &owner, "abort")?;
        }
        self.cancel_pending_extension_ui(Some(&owner), reason);
        self.inner
            .lock()
            .unwrap()
            .bash_always_allowed_threads
            .remove(&owner.thread_id);
        self.send_rpc(serde_json::json!({ "type": "abort" }), None)
            .await?;
        Ok(())
    }

    pub async fn abort(&self, thread_id: String, run_id: String) -> Result<(), String> {
        let owner = RunOwner::new(thread_id, run_id)?;
        let _lifecycle = self.lifecycle.lock().await;
        self.abort_locked(owner, "run_aborted").await
    }

    async fn stop_locked(&self) {
        self.cancel_pending_extension_ui(None, "process_stopped");
        let mut guard = self.inner.lock().unwrap();
        if let Some(mut pi) = guard.process.take() {
            let _ = pi.child.kill();
        }
        guard.runtime_thread_id = None;
        guard.active_thread_id = None;
        guard.active_run = None;
        guard.browser_cdp_fingerprint = None;
        fail_pending_rpc(
            &mut guard.pending,
            "Pi process stopped before the RPC completed",
        );
        guard.bash_always_allowed_threads.clear();
    }

    pub async fn stop(&self) {
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_locked().await;
    }

    fn cancel_pending_extension_ui(&self, owner: Option<&RunOwner>, reason: &str) {
        let reconciliations = {
            let mut guard = self.inner.lock().unwrap();
            drain_pending_extension_ui(&mut guard.pending_extension_ui, owner)
        };

        for reconciliation in &reconciliations {
            if let Ok(json) = serde_json::to_string(&serde_json::json!({
                "type": "extension_ui_response",
                "id": reconciliation.request_id,
                "cancelled": true
            })) {
                let _ = self.cmd_tx.send(json);
            }
        }
        Self::emit_extension_ui_reconciliations(&self.app, reconciliations, reason);
    }

    pub fn extension_ui_response(
        &self,
        request_id: String,
        thread_id: String,
        run_id: String,
        confirmed: Option<bool>,
        value: Option<String>,
        cancelled: bool,
        always_allow_bash: bool,
    ) -> Result<(), String> {
        let owner = RunOwner::new(thread_id.clone(), run_id)?;
        let (pending, response) = {
            let mut guard = self.inner.lock().unwrap();
            if guard.process.is_none() {
                return Err("Pi process is not running".into());
            }
            let protocol = guard
                .pending_extension_ui
                .get(&request_id)
                .map(|pending| pending.protocol)
                .ok_or("Unknown or already resolved extension UI request")?;
            let pending = match protocol {
                ExtensionUiProtocol::Approval => {
                    take_pending_confirm(&mut guard.pending_extension_ui, &request_id, &owner)?
                }
                ExtensionUiProtocol::MemoryReview => take_pending_memory_review(
                    &mut guard.pending_extension_ui,
                    &request_id,
                    &owner,
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
                guard
                    .bash_always_allowed_threads
                    .insert(owner.thread_id.clone());
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
                guard.bash_always_allowed_threads.remove(&owner.thread_id);
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
        approval_source, can_enable_always_allow_bash, clear_active_run_if_matches,
        drain_pending_extension_ui, event_owner_payload, fail_pending_rpc,
        is_divo_approval_request, is_divo_memory_review_request, require_active_run,
        response_clears_active_run, should_auto_allow_bash, take_pending_confirm,
        take_pending_memory_review, valid_memory_review_response, ApprovalSource,
        ExtensionUiProtocol, PendingExtensionUiRequest, PendingRpc, PiManager, RunOwner,
    };
    use std::collections::{HashMap, HashSet};
    use tokio::runtime::Runtime;

    fn owner(thread_id: &str, run_id: &str) -> RunOwner {
        RunOwner::new(thread_id.to_string(), run_id.to_string()).unwrap()
    }

    fn pending(method: &str, thread_id: &str, run_id: &str) -> PendingExtensionUiRequest {
        PendingExtensionUiRequest {
            owner: owner(thread_id, run_id),
            method: method.to_string(),
            source: None,
            protocol: ExtensionUiProtocol::Approval,
        }
    }

    fn pending_rpc(command: &str, owner: Option<RunOwner>) -> PendingRpc {
        let (tx, _rx) = tokio::sync::oneshot::channel();
        PendingRpc {
            command: command.to_string(),
            owner,
            tx,
        }
    }

    #[test]
    fn confirmation_response_requires_matching_run_and_request() {
        let request_owner = owner("thread-1", "run-1");
        let mut requests = HashMap::from([(
            "request-1".to_string(),
            pending("confirm", "thread-1", "run-1"),
        )]);

        assert!(
            take_pending_confirm(&mut requests, "request-1", &owner("thread-1", "run-2")).is_err()
        );
        assert!(requests.contains_key("request-1"));

        assert!(take_pending_confirm(&mut requests, "unknown", &request_owner).is_err());
        assert!(requests.contains_key("request-1"));

        assert!(take_pending_confirm(&mut requests, "request-1", &request_owner).is_ok());
        assert!(requests.is_empty());
    }

    #[test]
    fn confirmation_response_rejects_other_dialog_methods_without_consuming_them() {
        let mut requests = HashMap::from([(
            "request-1".to_string(),
            pending("input", "thread-1", "run-1"),
        )]);

        assert!(
            take_pending_confirm(&mut requests, "request-1", &owner("thread-1", "run-1")).is_err()
        );
        assert!(requests.contains_key("request-1"));
    }

    #[test]
    fn fail_closed_cleanup_drains_only_the_selected_run() {
        let mut requests = HashMap::from([
            (
                "request-1".to_string(),
                pending("confirm", "thread-1", "run-1"),
            ),
            (
                "request-2".to_string(),
                pending("confirm", "thread-1", "run-2"),
            ),
        ]);

        assert_eq!(
            drain_pending_extension_ui(&mut requests, Some(&owner("thread-1", "run-1"))),
            vec![super::ExtensionUiReconciliation {
                request_id: "request-1".to_string(),
                owner: owner("thread-1", "run-1"),
            }]
        );
        assert!(!requests.contains_key("request-1"));
        assert!(requests.contains_key("request-2"));
    }

    #[test]
    fn stale_abort_scope_is_rejected() {
        let active = owner("thread-1", "run-1");
        assert!(require_active_run(Some(&active), &active, "abort").is_ok());
        assert!(require_active_run(Some(&active), &owner("thread-1", "run-2"), "abort").is_err());
    }

    #[test]
    fn run_owner_requires_nonempty_thread_and_run_ids() {
        assert!(RunOwner::new(" thread-1 ".into(), " run-1 ".into()).is_ok());
        assert!(RunOwner::new(" ".into(), "run-1".into()).is_err());
        assert!(RunOwner::new("thread-1".into(), " ".into()).is_err());
    }

    #[test]
    fn successful_prompt_ack_retains_active_run_owner() {
        let owner = owner("thread-1", "run-1");
        let pending = pending_rpc("prompt", Some(owner.clone()));
        let mut active_run = Some(owner.clone());

        assert!(!response_clears_active_run(&pending, true));
        if response_clears_active_run(&pending, true) {
            clear_active_run_if_matches(&mut active_run, &owner);
        }

        assert_eq!(active_run, Some(owner));
    }

    #[test]
    fn failed_prompt_ack_clears_active_run_owner() {
        let owner = owner("thread-1", "run-1");
        let pending = pending_rpc("prompt", Some(owner.clone()));
        let mut active_run = Some(owner.clone());

        assert!(response_clears_active_run(&pending, false));
        assert!(clear_active_run_if_matches(&mut active_run, &owner));

        assert_eq!(active_run, None);
    }

    #[test]
    fn process_exit_fails_pending_rpc_immediately() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut pending = HashMap::from([(
            "rpc-1".to_string(),
            PendingRpc {
                command: "prompt".into(),
                owner: Some(owner("thread-1", "run-1")),
                tx,
            },
        )]);

        fail_pending_rpc(&mut pending, "Pi process exited unexpectedly");
        assert!(pending.is_empty());

        let result = Runtime::new()
            .unwrap()
            .block_on(async { rx.await.unwrap() });
        assert_eq!(result.unwrap_err(), "Pi process exited unexpectedly");
    }

    #[test]
    fn emitted_events_include_run_id() {
        let mut event = serde_json::json!({ "type": "prompt_accepted" });
        event_owner_payload(&mut event, Some(&owner("thread-1", "run-1")));

        assert_eq!(
            event.get("thread_id").and_then(|value| value.as_str()),
            Some("thread-1")
        );
        assert_eq!(
            event.get("run_id").and_then(|value| value.as_str()),
            Some("run-1")
        );
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
    fn memory_review_responses_are_request_and_run_bound() {
        let mut request = pending("editor", "thread-1", "run-1");
        request.protocol = ExtensionUiProtocol::MemoryReview;
        let mut requests = HashMap::from([("review-1".to_string(), request)]);

        assert!(
            take_pending_memory_review(&mut requests, "review-1", &owner("thread-1", "run-2"))
                .is_err()
        );
        assert!(requests.contains_key("review-1"));
        assert!(
            take_pending_memory_review(&mut requests, "review-1", &owner("thread-1", "run-1"))
                .is_ok()
        );
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
            owner: owner("thread-1", "run-1"),
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
