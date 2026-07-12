use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
#[cfg(test)]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex, Notify};

use super::browser::current_browser_cdp_fingerprint;
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
/// Pi is intentionally bounded because every runtime is a complete Bun process.
const RUNTIME_POOL_CAPACITY: usize = 2;

struct PiProcess {
    child: Child,
    stdin: std::process::ChildStdin,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
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

#[cfg(test)]
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

struct RuntimeState {
    process: Option<PiProcess>,
    active_run: Option<RunOwner>,
    pending: HashMap<String, PendingRpc>,
    pending_extension_ui: HashMap<String, PendingExtensionUiRequest>,
    bash_always_allowed: bool,
    browser_cdp_fingerprint: Option<String>,
    stdout_buffer: String,
    admission_leases: usize,
}

struct RuntimeSlot {
    thread_id: String,
    state: Arc<StdMutex<RuntimeState>>,
    lifecycle: Arc<Mutex<()>>,
}

impl RuntimeSlot {
    fn new(thread_id: String) -> Self {
        Self {
            thread_id,
            state: Arc::new(StdMutex::new(RuntimeState {
                process: None,
                active_run: None,
                pending: HashMap::new(),
                pending_extension_ui: HashMap::new(),
                bash_always_allowed: false,
                browser_cdp_fingerprint: None,
                stdout_buffer: String::new(),
                admission_leases: 0,
            })),
            lifecycle: Arc::new(Mutex::new(())),
        }
    }

    fn reclaimable(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.active_run.is_none()
            && state.pending_extension_ui.is_empty()
            && state.pending.is_empty()
            && state.admission_leases == 0
    }
}

fn idle_runtime_thread(slots: &HashMap<String, Arc<RuntimeSlot>>) -> Option<String> {
    // Stable thread-id ordering makes reclamation reproducible. More importantly,
    // `reclaimable` excludes both an active run and every pending approval.
    slots
        .iter()
        .filter(|(_, slot)| slot.reclaimable())
        .min_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(thread, _)| thread.clone())
}

#[derive(Clone)]
struct RuntimeConfig {
    app: AppHandle,
    data_folder: PathBuf,
    scratch_dir: PathBuf,
    workspace_dir: PathBuf,
}

struct QueuedAdmission {
    ticket: u64,
    owner: Option<RunOwner>,
    state: Arc<AtomicU8>,
}

const WAITER_QUEUED: u8 = 0;
const WAITER_CANCELLED: u8 = 1;
const WAITER_ADMITTED: u8 = 2;
const WAITER_STOPPED: u8 = 3;

struct WaiterGuard {
    ticket: u64,
    state: Arc<AtomicU8>,
    capacity_changed: Arc<Notify>,
    armed: bool,
}

impl WaiterGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
    fn terminal(&self) -> u8 {
        self.state.load(Ordering::Acquire)
    }
}

impl Drop for WaiterGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.state.compare_exchange(
                WAITER_QUEUED,
                WAITER_CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            self.capacity_changed.notify_waiters();
        }
    }
}

struct SlotLease {
    slot: Arc<RuntimeSlot>,
    capacity_changed: Arc<Notify>,
    released: bool,
}

impl SlotLease {
    fn slot(&self) -> &Arc<RuntimeSlot> {
        &self.slot
    }
    fn release(&mut self) {
        if !self.released {
            let mut state = self.slot.state.lock().unwrap();
            state.admission_leases = state.admission_leases.saturating_sub(1);
            self.released = true;
            self.capacity_changed.notify_waiters();
        }
    }
}

impl Drop for SlotLease {
    fn drop(&mut self) {
        self.release();
    }
}

struct PoolState {
    config: Option<RuntimeConfig>,
    slots: HashMap<String, Arc<RuntimeSlot>>,
    waiters: VecDeque<QueuedAdmission>,
    next_ticket: u64,
    bash_rules: HashSet<String>,
    cancelled_runs: HashSet<RunOwner>,
}

pub struct PiManager {
    pool: Arc<Mutex<PoolState>>,
    capacity_changed: Arc<Notify>,
    #[cfg(test)]
    test_hooks: Arc<StdMutex<TestHooks>>,
    #[cfg(test)]
    test_admission_configured: Arc<AtomicBool>,
}

#[cfg(test)]
#[derive(Clone, Default)]
struct TestHooks {
    after_initial_cancel_read: Option<TestHook>,
    after_capacity_observed: Option<TestHook>,
    after_existing_lease: Option<TestHook>,
}

#[cfg(test)]
#[derive(Clone)]
struct TestHook {
    reached: Arc<Notify>,
    resume: Arc<Notify>,
}

impl Clone for PiManager {
    fn clone(&self) -> Self {
        PiManager {
            pool: self.pool.clone(),
            capacity_changed: self.capacity_changed.clone(),
            #[cfg(test)]
            test_hooks: self.test_hooks.clone(),
            #[cfg(test)]
            test_admission_configured: self.test_admission_configured.clone(),
        }
    }
}

impl PiManager {
    pub fn new() -> Self {
        Self {
            pool: Arc::new(Mutex::new(PoolState {
                config: None,
                slots: HashMap::new(),
                waiters: VecDeque::new(),
                next_ticket: 0,
                bash_rules: HashSet::new(),
                cancelled_runs: HashSet::new(),
            })),
            capacity_changed: Arc::new(Notify::new()),
            #[cfg(test)]
            test_hooks: Arc::new(StdMutex::new(TestHooks::default())),
            #[cfg(test)]
            test_admission_configured: Arc::new(AtomicBool::new(false)),
        }
    }

    async fn config(&self) -> Result<RuntimeConfig, String> {
        self.pool
            .lock()
            .await
            .config
            .clone()
            .ok_or("Pi runtime is not configured; call pi_start first".into())
    }

    fn wake_capacity(&self) {
        self.capacity_changed.notify_waiters();
    }

    #[cfg(test)]
    async fn pause_test_hook(&self, select: impl FnOnce(&TestHooks) -> Option<TestHook>) {
        let hook = select(&self.test_hooks.lock().unwrap());
        if let Some(hook) = hook {
            hook.reached.notify_one();
            hook.resume.notified().await;
        }
    }

    async fn acquire_slot(
        &self,
        thread_id: &str,
        waiter_owner: Option<RunOwner>,
    ) -> Result<SlotLease, String> {
        let thread_id = thread_id.trim();
        if thread_id.is_empty() {
            return Err("A thread id is required".into());
        }
        let mut waiter: Option<WaiterGuard> = None;
        loop {
            // Arm the subscription before observing capacity. Any transition
            // after this point either changes the predicate while we hold the
            // pool lock or leaves a retained notification for this wait.
            let notified = self.capacity_changed.notified();
            tokio::pin!(notified);
            let _ = futures::poll!(notified.as_mut());
            let (slot, evicted) = {
                let mut pool = self.pool.lock().await;
                if waiter_owner
                    .as_ref()
                    .is_some_and(|owner| pool.cancelled_runs.remove(owner))
                {
                    return Err("Pi prompt was cancelled before runtime admission".into());
                }
                while pool
                    .waiters
                    .front()
                    .is_some_and(|entry| entry.state.load(Ordering::Acquire) != WAITER_QUEUED)
                {
                    pool.waiters.pop_front();
                }
                if let Some(slot) = pool.slots.get(thread_id) {
                    slot.state.lock().unwrap().admission_leases += 1;
                    #[cfg(test)]
                    if let Some(hook) = self.test_hooks.lock().unwrap().after_existing_lease.clone()
                    {
                        hook.reached.notify_one();
                    }
                    (Some(slot.clone()), None)
                } else {
                    let is_front = waiter.as_ref().map_or_else(
                        || pool.waiters.is_empty(),
                        |guard| {
                            pool.waiters.front().is_some_and(|entry| {
                                entry.ticket == guard.ticket
                                    && Arc::ptr_eq(&entry.state, &guard.state)
                            })
                        },
                    );
                    let available = pool.slots.len() < RUNTIME_POOL_CAPACITY;
                    let idle = if is_front && !available {
                        idle_runtime_thread(&pool.slots)
                    } else {
                        None
                    };
                    if is_front && (available || idle.is_some()) {
                        if let Some(guard) = waiter.as_mut() {
                            let popped = pool.waiters.pop_front();
                            debug_assert!(popped.is_some());
                            guard.state.store(WAITER_ADMITTED, Ordering::Release);
                            guard.disarm();
                        }
                        let evicted = idle.and_then(|thread| pool.slots.remove(&thread));
                        let slot = Arc::new(RuntimeSlot::new(thread_id.to_string()));
                        if pool.bash_rules.contains(thread_id) {
                            slot.state.lock().unwrap().bash_always_allowed = true;
                        }
                        slot.state.lock().unwrap().admission_leases = 1;
                        pool.slots.insert(thread_id.to_string(), slot.clone());
                        (Some(slot), evicted)
                    } else {
                        if waiter.is_none() {
                            let ticket = pool.next_ticket;
                            pool.next_ticket += 1;
                            let state = Arc::new(AtomicU8::new(WAITER_QUEUED));
                            pool.waiters.push_back(QueuedAdmission {
                                ticket,
                                owner: waiter_owner.clone(),
                                state: state.clone(),
                            });
                            waiter = Some(WaiterGuard {
                                ticket,
                                state,
                                capacity_changed: self.capacity_changed.clone(),
                                armed: true,
                            });
                        }
                        (None, None)
                    }
                }
            };

            if let Some(slot) = slot {
                if let Some(old) = evicted {
                    // Only a proven-idle slot is removed above. Its stop and
                    // reconciliation are therefore scoped to that old thread.
                    let app = self
                        .pool
                        .lock()
                        .await
                        .config
                        .as_ref()
                        .map(|config| config.app.clone());
                    Self::stop_slot(&old, app.as_ref(), "idle_reclaimed").await;
                }
                return Ok(SlotLease {
                    slot,
                    capacity_changed: self.capacity_changed.clone(),
                    released: false,
                });
            }
            drop(evicted);
            let guard = waiter.as_ref().expect("waiter was registered");
            match guard.terminal() {
                WAITER_CANCELLED => {
                    return Err("Pi prompt was cancelled while waiting for runtime capacity".into())
                }
                WAITER_STOPPED => {
                    return Err("Pi runtime stopped while waiting for capacity".into())
                }
                _ => {
                    #[cfg(test)]
                    self.pause_test_hook(|hooks| hooks.after_capacity_observed.clone())
                        .await;
                    notified.await
                }
            }
        }
    }

    fn divo_workspace_system_prompt(
        workspace_dir: &std::path::Path,
        layout: &DivoWorkspaceRunLayout,
    ) -> String {
        format!(
            "Divo workspace policy:\n- The selected workspace root is: {workspace}\n- The active Jan thread id for this run is: {thread_id}\n- Divo-owned scratch state for this run is: {run_dir}\n- Put temporary helper scripts, scratch notes, downloaded intermediate files, logs, and generated analysis artifacts under DIVO_RUN_DIR or the matching DIVO_* directory.\n- Do not create temporary scripts or scratch files in the workspace root or project folders.\n- Only create or edit files outside .divo when they are real project files required by the user's task.\n- Do not store credentials, backend tokens, or SaaS tokens in workspace files.",
            workspace = workspace_dir.display(),
            thread_id = layout.thread_id,
            run_dir = layout.run_dir.display(),
        )
    }

    fn write_stdin(slot: &RuntimeSlot, json: &str) -> Result<(), String> {
        let mut state = slot.state.lock().unwrap();
        let process = state.process.as_mut().ok_or("Pi process is not running")?;
        writeln!(process.stdin, "{json}")
            .map_err(|error| format!("Failed to write Pi command: {error}"))?;
        process
            .stdin
            .flush()
            .map_err(|error| format!("Failed to flush Pi command: {error}"))
    }

    async fn send_rpc(
        slot: &RuntimeSlot,
        mut command: serde_json::Value,
        owner: Option<RunOwner>,
        capacity_changed: &Notify,
    ) -> Result<serde_json::Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let command_name = command
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown")
            .to_string();
        command
            .as_object_mut()
            .ok_or("Pi command must be an object")?
            .insert("id".into(), serde_json::Value::String(id.clone()));
        let serialized = serde_json::to_string(&command).map_err(|error| error.to_string())?;
        let (tx, rx) = oneshot::channel();
        {
            let mut state = slot.state.lock().unwrap();
            if state.process.is_none() {
                return Err("Pi process is not running".into());
            }
            state.pending.insert(
                id.clone(),
                PendingRpc {
                    command: command_name,
                    owner,
                    tx,
                },
            );
        }
        if let Err(error) = Self::write_stdin(slot, &serialized) {
            slot.state.lock().unwrap().pending.remove(&id);
            capacity_changed.notify_waiters();
            return Err(error);
        }
        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err("Pi RPC channel closed".into()),
            Err(_) => {
                slot.state.lock().unwrap().pending.remove(&id);
                capacity_changed.notify_waiters();
                Err("Pi RPC timed out".into())
            }
        }
    }

    async fn wait_until_ready(slot: &RuntimeSlot, capacity_changed: &Notify) -> Result<(), String> {
        for attempt in 1..=30 {
            match Self::send_rpc(
                slot,
                serde_json::json!({"type":"get_state"}),
                None,
                capacity_changed,
            )
            .await
            {
                Ok(_) => return Ok(()),
                Err(_) if attempt < 30 => tokio::time::sleep(Duration::from_millis(200)).await,
                Err(error) => return Err(error),
            }
        }
        Err("Pi RPC failed to become ready".into())
    }

    fn emit(app: &AppHandle, owner: Option<&RunOwner>, mut event: serde_json::Value) {
        event_owner_payload(&mut event, owner);
        if let Err(error) = app.emit("pi-event", event) {
            eprintln!("[pi] Failed to emit Pi event: {error}");
        }
    }

    fn emit_reconciliations(
        app: &AppHandle,
        reconciliations: Vec<ExtensionUiReconciliation>,
        reason: &str,
    ) {
        for reconciliation in reconciliations {
            Self::emit(
                app,
                Some(&reconciliation.owner),
                serde_json::json!({
                    "type":"extension_ui_response",
                    "id":reconciliation.request_id,
                    "cancelled":true,
                    "reason":reason,
                }),
            );
        }
    }

    async fn spawn_slot(
        slot: &Arc<RuntimeSlot>,
        config: &RuntimeConfig,
        capacity_changed: Arc<Notify>,
    ) -> Result<(), String> {
        let runtime = PiRuntimePaths::resolve(&config.app, &config.data_folder)?;
        std::fs::create_dir_all(&config.scratch_dir)
            .map_err(|error| format!("Failed to create Pi scratch dir: {error}"))?;
        ensure_thread_dir_exists(&config.data_folder, &slot.thread_id)?;
        let session_path = resolve_session_path(&config.data_folder, &slot.thread_id);
        ensure_session_workspace_cwd(&session_path, &config.workspace_dir)?;
        let layout = prepare_workspace_run_layout(&config.workspace_dir, &slot.thread_id)?;
        let mut command = Command::new(&runtime.bun);
        command
            .arg(&runtime.cli_js)
            .arg("--mode")
            .arg("rpc")
            .arg("--session-dir")
            .arg(config.scratch_dir.to_string_lossy().to_string())
            .arg("--append-system-prompt")
            .arg(Self::divo_workspace_system_prompt(
                &config.workspace_dir,
                &layout,
            ))
            .env(
                "PI_CODING_AGENT_DIR",
                runtime.agent_dir.to_string_lossy().to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(&config.workspace_dir);
        for skill_dir in &runtime.skill_dirs {
            command.arg("--skill").arg(skill_dir);
        }
        apply_provider_env(&mut command, &runtime.agent_dir);
        apply_divo_gateway_env(&mut command, &runtime.agent_dir);
        apply_divo_skill_env(&mut command, &runtime.skill_dirs);
        apply_divo_workspace_env(&mut command, &config.workspace_dir, &layout);
        apply_local_lark_env(&mut command, runtime.lark_cli_wrapper.as_deref());
        let mut child = command.spawn().map_err(|error| {
            format!(
                "Failed to spawn bundled Pi (bun={} cli={}): {error}",
                runtime.bun.display(),
                runtime.cli_js.display()
            )
        })?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("Failed to capture Pi stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to capture Pi stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to capture Pi stderr")?;
        {
            let mut state = slot.state.lock().unwrap();
            state.process = Some(PiProcess { child, stdin });
            state.stdout_buffer.clear();
            state.browser_cdp_fingerprint = runtime.browser_cdp_fingerprint.clone();
        }

        let reader_slot = slot.clone();
        let reader_app = config.app.clone();
        let reader_capacity = capacity_changed.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut stdout = stdout;
            let mut buffer = [0; 8192];
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let lines = {
                            let mut state = reader_slot.state.lock().unwrap();
                            state
                                .stdout_buffer
                                .push_str(&String::from_utf8_lossy(&buffer[..count]));
                            let mut lines = Vec::new();
                            while let Some(index) = state.stdout_buffer.find('\n') {
                                let line = state.stdout_buffer[..index].trim().to_string();
                                state.stdout_buffer = state.stdout_buffer[index + 1..].to_string();
                                if !line.is_empty() {
                                    lines.push(line);
                                }
                            }
                            lines
                        };
                        for line in lines {
                            Self::handle_line(&reader_slot, &reader_app, &line, &reader_capacity);
                        }
                    }
                }
            }
            let (owner, reconciliations, exited) = {
                let mut state = reader_slot.state.lock().unwrap();
                let current = state
                    .process
                    .as_ref()
                    .is_some_and(|process| process.child.id() == pid);
                if !current {
                    (None, Vec::new(), false)
                } else {
                    let owner = state.active_run.take();
                    fail_pending_rpc(&mut state.pending, "Pi process exited unexpectedly");
                    let reconciliations =
                        drain_pending_extension_ui(&mut state.pending_extension_ui, None);
                    state.process = None;
                    state.bash_always_allowed = false;
                    state.browser_cdp_fingerprint = None;
                    (owner, reconciliations, true)
                }
            };
            if exited {
                Self::emit_reconciliations(&reader_app, reconciliations, "process_exited");
                Self::emit(
                    &reader_app,
                    owner.as_ref(),
                    serde_json::json!({"type":"pi_process_exit","message":"Pi process exited"}),
                );
                reader_capacity.notify_waiters();
            }
        });
        std::thread::spawn(move || {
            use std::io::Read;
            let mut stderr = stderr;
            let mut buffer = [0; 1024];
            while let Ok(count) = stderr.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                eprintln!(
                    "[pi stderr] {}",
                    String::from_utf8_lossy(&buffer[..count]).trim()
                );
            }
        });
        Self::wait_until_ready(slot, &capacity_changed).await?;
        let response = Self::send_rpc(
            slot,
            serde_json::json!({
                "type": "switch_session",
                "sessionPath": session_path.to_string_lossy(),
            }),
            None,
            &capacity_changed,
        )
        .await?;
        if response
            .get("cancelled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            return Err("Session switch cancelled".into());
        }
        Ok(())
    }

    async fn ensure_slot_started(&self, slot: &Arc<RuntimeSlot>) -> Result<(), String> {
        let _lifecycle = slot.lifecycle.lock().await;
        let needs_restart = {
            let state = slot.state.lock().unwrap();
            state.process.is_some()
                && state.active_run.is_none()
                && current_browser_cdp_fingerprint().is_some()
                && current_browser_cdp_fingerprint() != state.browser_cdp_fingerprint
        };
        if needs_restart {
            let app = self.config().await?.app;
            Self::stop_slot_locked(slot, Some(&app), "process_restarted");
        }
        if slot.state.lock().unwrap().process.is_some() {
            return Ok(());
        }
        Self::spawn_slot(slot, &self.config().await?, self.capacity_changed.clone()).await
    }

    fn stop_slot_locked(slot: &Arc<RuntimeSlot>, app: Option<&AppHandle>, reason: &str) {
        let (process, reconciliations) = {
            let mut state = slot.state.lock().unwrap();
            let process = state.process.take();
            state.active_run = None;
            fail_pending_rpc(
                &mut state.pending,
                "Pi process stopped before the RPC completed",
            );
            let reconciliations = drain_pending_extension_ui(&mut state.pending_extension_ui, None);
            state.bash_always_allowed = false;
            state.browser_cdp_fingerprint = None;
            (process, reconciliations)
        };
        if let Some(mut process) = process {
            let _ = process.child.kill();
        }
        if let Some(app) = app {
            Self::emit_reconciliations(app, reconciliations, reason);
        }
    }

    async fn stop_slot(slot: &Arc<RuntimeSlot>, app: Option<&AppHandle>, reason: &str) {
        let _lifecycle = slot.lifecycle.lock().await;
        Self::stop_slot_locked(slot, app, reason);
    }

    fn handle_line(
        slot: &Arc<RuntimeSlot>,
        app: &AppHandle,
        line: &str,
        capacity_changed: &Notify,
    ) {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("[pi] JSON parse error: {error} line={line}");
                return;
            }
        };
        let event_type = value
            .get("type")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        if event_type.as_deref() == Some("response") {
            let Some(id) = value.get("id").and_then(|value| value.as_str()) else {
                return;
            };
            let success = value
                .get("success")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let (pending, clear_owner) = {
                let mut state = slot.state.lock().unwrap();
                let pending = state.pending.remove(id);
                capacity_changed.notify_waiters();
                let clear_owner = pending
                    .as_ref()
                    .filter(|pending| response_clears_active_run(pending, success))
                    .and_then(|pending| pending.owner.clone());
                if let Some(owner) = clear_owner.as_ref() {
                    clear_active_run_if_matches(&mut state.active_run, owner);
                    capacity_changed.notify_waiters();
                }
                (pending, clear_owner)
            };
            if let Some(pending) = pending {
                let owner = pending.owner.clone();
                let result = if success {
                    Ok(value
                        .get("data")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null))
                } else {
                    Err(value
                        .get("error")
                        .and_then(|value| value.as_str())
                        .unwrap_or("Pi command failed")
                        .to_string())
                };
                let _ = pending.tx.send(result);
                if pending.command == "prompt" {
                    let event = if success {
                        serde_json::json!({"type":"prompt_accepted","requestId":id})
                    } else {
                        serde_json::json!({"type":"prompt_rejected","message":value.get("error").and_then(|v| v.as_str()).unwrap_or("Pi command failed")})
                    };
                    Self::emit(app, clear_owner.as_ref().or(owner.as_ref()), event);
                }
            }
            return;
        }
        if event_type.as_deref() == Some("extension_ui_request") {
            let owner = slot.state.lock().unwrap().active_run.clone();
            let Some(owner) = owner else {
                Self::cancel_unknown_ui(slot, &value);
                return;
            };
            let id = value
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            let registered = if let (Some(id), Some(method)) =
                (id.as_deref(), value.get("method").and_then(|v| v.as_str()))
            {
                let mut state = slot.state.lock().unwrap();
                if state.active_run.as_ref() != Some(&owner) {
                    false
                } else if is_divo_approval_request(&value, &owner.thread_id) {
                    let source = approval_source(&value);
                    if source == Some(ApprovalSource::Bash) && state.bash_always_allowed {
                        drop(state);
                        let _ = Self::write_stdin(slot, &serde_json::json!({"type":"extension_ui_response","id":id,"confirmed":true}).to_string());
                        true
                    } else {
                        state.pending_extension_ui.insert(
                            id.into(),
                            PendingExtensionUiRequest {
                                owner: owner.clone(),
                                method: method.into(),
                                source,
                                protocol: ExtensionUiProtocol::Approval,
                            },
                        );
                        true
                    }
                } else if is_divo_memory_review_request(&value, &owner.thread_id) {
                    state.pending_extension_ui.insert(
                        id.into(),
                        PendingExtensionUiRequest {
                            owner: owner.clone(),
                            method: method.into(),
                            source: None,
                            protocol: ExtensionUiProtocol::MemoryReview,
                        },
                    );
                    true
                } else {
                    false
                }
            } else {
                false
            };
            if registered {
                Self::emit(app, Some(&owner), value);
            } else {
                Self::cancel_unknown_ui(slot, &value);
            }
            return;
        }
        if event_type.is_some() {
            let (owner, reconciliations) = {
                let mut state = slot.state.lock().unwrap();
                let owner = state.active_run.clone();
                let reconciliations = if event_type.as_deref() == Some("agent_end")
                    && !value
                        .get("willRetry")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                {
                    state.active_run = None;
                    owner
                        .as_ref()
                        .map(|owner| {
                            drain_pending_extension_ui(&mut state.pending_extension_ui, Some(owner))
                        })
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };
                (owner, reconciliations)
            };
            Self::emit_reconciliations(app, reconciliations, "agent_ended");
            Self::emit(app, owner.as_ref(), value);
            if event_type.as_deref() == Some("agent_end") && owner.is_some() {
                capacity_changed.notify_waiters();
            }
            return;
        }
    }

    fn cancel_unknown_ui(slot: &RuntimeSlot, value: &serde_json::Value) {
        if let Some(id) = value.get("id").and_then(|value| value.as_str()) {
            let _ = Self::write_stdin(
                slot,
                &serde_json::json!({"type":"extension_ui_response","id":id,"cancelled":true})
                    .to_string(),
            );
        }
    }

    pub async fn start(
        &self,
        app: AppHandle,
        data_folder: PathBuf,
        scratch_dir: PathBuf,
        workspace_dir: PathBuf,
        _initial_thread_id: Option<String>,
    ) -> Result<(), String> {
        let config = RuntimeConfig {
            app,
            data_folder,
            scratch_dir,
            workspace_dir,
        };
        let stale = {
            let mut pool = self.pool.lock().await;
            let changed = pool.config.as_ref().is_some_and(|current| {
                current.workspace_dir != config.workspace_dir
                    || current.data_folder != config.data_folder
            });
            pool.config = Some(config);
            if changed {
                std::mem::take(&mut pool.slots)
                    .into_values()
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            }
        };
        let app = self.config().await?.app;
        for slot in stale {
            Self::stop_slot(&slot, Some(&app), "process_restarted").await;
        }
        self.wake_capacity();
        Ok(())
    }

    pub async fn ensure_thread(&self, thread_id: String) -> Result<(), String> {
        self.config().await?;
        let lease = self.acquire_slot(&thread_id, None).await?;
        self.ensure_slot_started(lease.slot()).await
    }

    pub async fn prompt(
        &self,
        thread_id: String,
        run_id: String,
        message: String,
    ) -> Result<(), String> {
        let owner = RunOwner::new(thread_id, run_id)?;
        if self.pool.lock().await.cancelled_runs.remove(&owner) {
            return Err("Pi prompt was cancelled before runtime admission".into());
        }
        #[cfg(test)]
        self.pause_test_hook(|hooks| hooks.after_initial_cancel_read.clone())
            .await;
        #[cfg(not(test))]
        self.config().await?;
        #[cfg(test)]
        if !self.test_admission_configured.load(Ordering::Acquire) {
            self.config().await?;
        }
        let mut lease = self
            .acquire_slot(&owner.thread_id, Some(owner.clone()))
            .await?;
        let slot = lease.slot().clone();
        let _lifecycle = slot.lifecycle.lock().await;
        if self.pool.lock().await.cancelled_runs.remove(&owner) {
            return Err("Pi prompt was cancelled during runtime admission".into());
        }
        if slot.state.lock().unwrap().process.is_none() {
            Self::spawn_slot(&slot, &self.config().await?, self.capacity_changed.clone()).await?;
        }
        {
            let mut state = slot.state.lock().unwrap();
            if let Some(active) = state.active_run.as_ref() {
                return Err(if active == &owner {
                    "This Pi run is already active".into()
                } else {
                    "Another Pi run is already active for this thread".into()
                });
            }
            state.active_run = Some(owner.clone());
        }
        let result = Self::send_rpc(
            &slot,
            serde_json::json!({"type":"prompt","message":message}),
            Some(owner.clone()),
            &self.capacity_changed,
        )
        .await;
        if result.is_err() {
            clear_active_run_if_matches(&mut slot.state.lock().unwrap().active_run, &owner);
            self.wake_capacity();
        }
        lease.release();
        result.map(|_| ())
    }

    pub async fn abort(&self, thread_id: String, run_id: String) -> Result<(), String> {
        let owner = RunOwner::new(thread_id, run_id)?;
        {
            let pool = self.pool.lock().await;
            if let Some(waiter) = pool.waiters.iter().find(|waiter| {
                waiter.owner.as_ref() == Some(&owner)
                    && waiter.state.load(Ordering::Acquire) == WAITER_QUEUED
            }) {
                waiter.state.store(WAITER_CANCELLED, Ordering::Release);
                self.wake_capacity();
                return Ok(());
            }
        }
        let slot = self.pool.lock().await.slots.get(&owner.thread_id).cloned();
        let Some(slot) = slot else {
            self.pool.lock().await.cancelled_runs.insert(owner);
            self.wake_capacity();
            return Ok(());
        };
        let _lifecycle = slot.lifecycle.lock().await;
        if slot.state.lock().unwrap().active_run.is_none() {
            self.pool.lock().await.cancelled_runs.insert(owner);
            self.wake_capacity();
            return Ok(());
        }
        require_active_run(
            slot.state.lock().unwrap().active_run.as_ref(),
            &owner,
            "abort",
        )?;
        let reconciliations = {
            let mut state = slot.state.lock().unwrap();
            drain_pending_extension_ui(&mut state.pending_extension_ui, Some(&owner))
        };
        let app = self.config().await?.app;
        Self::emit_reconciliations(&app, reconciliations, "run_aborted");
        Self::send_rpc(
            &slot,
            serde_json::json!({"type":"abort"}),
            None,
            &self.capacity_changed,
        )
        .await
        .map(|_| ())
    }

    pub async fn stop(&self) {
        let (slots, app) = {
            let mut pool = self.pool.lock().await;
            let app = pool.config.as_ref().map(|config| config.app.clone());
            for waiter in &pool.waiters {
                waiter.state.store(WAITER_STOPPED, Ordering::Release);
            }
            pool.bash_rules.clear();
            (
                std::mem::take(&mut pool.slots)
                    .into_values()
                    .collect::<Vec<_>>(),
                app,
            )
        };
        for slot in slots {
            Self::stop_slot(&slot, app.as_ref(), "process_stopped").await;
        }
        self.wake_capacity();
    }

    pub async fn extension_ui_response(
        &self,
        request_id: String,
        thread_id: String,
        run_id: String,
        confirmed: Option<bool>,
        value: Option<String>,
        cancelled: bool,
        always_allow_bash: bool,
    ) -> Result<(), String> {
        let owner = RunOwner::new(thread_id, run_id)?;
        if confirmed.is_none() {
            let slot = self
                .pool
                .lock()
                .await
                .slots
                .get(&owner.thread_id)
                .cloned()
                .ok_or("No Pi runtime is assigned to this thread")?;
            if slot
                .state
                .lock()
                .unwrap()
                .pending_extension_ui
                .get(&request_id)
                .is_some_and(|pending| pending.protocol == ExtensionUiProtocol::Approval)
            {
                return Err("Divo approval response requires confirmed".into());
            }
        }
        let slot = self
            .pool
            .lock()
            .await
            .slots
            .get(&owner.thread_id)
            .cloned()
            .ok_or("No Pi runtime is assigned to this thread")?;
        let _lifecycle = slot.lifecycle.lock().await;
        let (pending, response) = {
            let mut state = slot.state.lock().unwrap();
            let protocol = state
                .pending_extension_ui
                .get(&request_id)
                .map(|pending| pending.protocol)
                .ok_or("Unknown or already resolved extension UI request")?;
            let pending = match protocol {
                ExtensionUiProtocol::Approval => {
                    take_pending_confirm(&mut state.pending_extension_ui, &request_id, &owner)?
                }
                ExtensionUiProtocol::MemoryReview => take_pending_memory_review(
                    &mut state.pending_extension_ui,
                    &request_id,
                    &owner,
                )?,
            };
            if always_allow_bash
                && !can_enable_always_allow_bash(&pending, confirmed.unwrap_or(false))
            {
                state
                    .pending_extension_ui
                    .insert(request_id.clone(), pending);
                return Err("Always allow is available only for a confirmed Bash request".into());
            }
            if always_allow_bash {
                state.bash_always_allowed = true;
            }
            let response = match protocol {
                ExtensionUiProtocol::Approval => {
                    serde_json::json!({"type":"extension_ui_response","id":request_id,"confirmed":confirmed.ok_or("Divo approval response requires confirmed")?})
                }
                ExtensionUiProtocol::MemoryReview if cancelled => {
                    serde_json::json!({"type":"extension_ui_response","id":request_id,"cancelled":true})
                }
                ExtensionUiProtocol::MemoryReview
                    if value.as_deref().is_some_and(valid_memory_review_response) =>
                {
                    serde_json::json!({"type":"extension_ui_response","id":request_id,"value":value})
                }
                ExtensionUiProtocol::MemoryReview => {
                    serde_json::json!({"type":"extension_ui_response","id":request_id,"cancelled":true})
                }
            };
            (pending, response)
        };
        if let Err(error) = Self::write_stdin(&slot, &response.to_string()) {
            // The request was consumed under the lifecycle lock. Do not reinsert
            // it after a process exit/stop may have performed terminal cleanup.
            let app = self.config().await?.app;
            Self::emit(
                &app,
                Some(&pending.owner),
                serde_json::json!({
                    "type": "extension_ui_response",
                    "id": request_id,
                    "cancelled": true,
                    "reason": "response_write_failed",
                }),
            );
            return Err(error);
        }
        if always_allow_bash {
            self.pool.lock().await.bash_rules.insert(owner.thread_id);
        }
        Ok(())
    }

    pub async fn revoke_bash_approval(&self, thread_id: &str) {
        self.set_bash_approval_rule(thread_id, false).await;
    }
    pub async fn set_bash_approval_rule(&self, thread_id: &str, allowed: bool) {
        let mut pool = self.pool.lock().await;
        if allowed {
            pool.bash_rules.insert(thread_id.into());
        } else {
            pool.bash_rules.remove(thread_id);
        }
        if let Some(slot) = pool.slots.get(thread_id) {
            slot.state.lock().unwrap().bash_always_allowed = allowed;
        }
    }
    pub async fn bash_approval_allowed(&self, thread_id: &str) -> bool {
        self.pool.lock().await.bash_rules.contains(thread_id)
    }
    pub async fn is_running(&self) -> bool {
        self.pool
            .lock()
            .await
            .slots
            .values()
            .any(|slot| slot.state.lock().unwrap().process.is_some())
    }
    pub async fn get_state(&self) -> Result<serde_json::Value, String> {
        let slot = {
            let pool = self.pool.lock().await;
            pool.slots
                .iter()
                .filter(|(_, slot)| slot.state.lock().unwrap().process.is_some())
                .min_by(|(left, _), (right, _)| left.cmp(right))
                .map(|(_, slot)| slot.clone())
                .ok_or("Pi process is not running")?
        };
        Self::send_rpc(
            &slot,
            serde_json::json!({"type":"get_state"}),
            None,
            &self.capacity_changed,
        )
        .await
    }

    pub async fn get_pool_state(&self) -> serde_json::Value {
        let pool = self.pool.lock().await;
        serde_json::json!({"poolCapacity":RUNTIME_POOL_CAPACITY,"runtimes":pool.slots.values().map(|slot| { let state=slot.state.lock().unwrap(); serde_json::json!({"threadId":slot.thread_id,"running":state.process.is_some(),"activeRunId":state.active_run.as_ref().map(|owner| owner.run_id.clone()),"pendingUi":state.pending_extension_ui.len(),"admissionLeases":state.admission_leases,"pendingRpcs":state.pending.len()}) }).collect::<Vec<_>>(),"waiting":pool.waiters.iter().filter(|waiter| waiter.state.load(Ordering::Acquire) == WAITER_QUEUED).count()})
    }
}

#[cfg(test)]
mod tests {
    use super::{
        approval_source, can_enable_always_allow_bash, clear_active_run_if_matches,
        drain_pending_extension_ui, event_owner_payload, fail_pending_rpc, idle_runtime_thread,
        is_divo_approval_request, is_divo_memory_review_request, require_active_run,
        response_clears_active_run, should_auto_allow_bash, take_pending_confirm,
        take_pending_memory_review, valid_memory_review_response, ApprovalSource,
        ExtensionUiProtocol, PendingExtensionUiRequest, PendingRpc, PiManager, RunOwner,
        RuntimeSlot,
    };
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
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
        let runtime = Runtime::new().unwrap();

        runtime.block_on(manager.set_bash_approval_rule("thread-1", true));
        assert!(runtime.block_on(manager.bash_approval_allowed("thread-1")));
        assert!(!runtime.block_on(manager.bash_approval_allowed("thread-2")));

        runtime.block_on(manager.revoke_bash_approval("thread-1"));
        assert!(!runtime.block_on(manager.bash_approval_allowed("thread-1")));
    }

    #[test]
    fn two_overlapping_runs_remain_owned_by_their_thread_slots() {
        let first = Arc::new(RuntimeSlot::new("thread-a".into()));
        let second = Arc::new(RuntimeSlot::new("thread-b".into()));
        first.state.lock().unwrap().active_run = Some(owner("thread-a", "run-a"));
        second.state.lock().unwrap().active_run = Some(owner("thread-b", "run-b"));

        assert_eq!(
            first.state.lock().unwrap().active_run,
            Some(owner("thread-a", "run-a"))
        );
        assert_eq!(
            second.state.lock().unwrap().active_run,
            Some(owner("thread-b", "run-b"))
        );
        assert!(!first.reclaimable());
        assert!(!second.reclaimable());
    }

    #[test]
    fn third_waiter_can_be_admitted_only_after_an_idle_slot_is_available() {
        let first = Arc::new(RuntimeSlot::new("thread-a".into()));
        let second = Arc::new(RuntimeSlot::new("thread-b".into()));
        first.state.lock().unwrap().active_run = Some(owner("thread-a", "run-a"));
        second.state.lock().unwrap().active_run = Some(owner("thread-b", "run-b"));
        let mut slots = HashMap::from([
            ("thread-a".to_string(), first.clone()),
            ("thread-b".to_string(), second),
        ]);

        assert_eq!(slots.len(), super::RUNTIME_POOL_CAPACITY);
        assert_eq!(idle_runtime_thread(&slots), None);

        first.state.lock().unwrap().active_run = None;
        let reclaimed = idle_runtime_thread(&slots).unwrap();
        assert_eq!(reclaimed, "thread-a");
        slots.remove(&reclaimed);
        slots.insert(
            "thread-c".into(),
            Arc::new(RuntimeSlot::new("thread-c".into())),
        );
        assert_eq!(slots.len(), super::RUNTIME_POOL_CAPACITY);
        assert!(slots.contains_key("thread-c"));
    }

    #[test]
    fn stale_abort_cannot_target_another_slot() {
        let first = owner("thread-a", "run-a");
        let second = owner("thread-b", "run-b");
        assert!(require_active_run(Some(&first), &first, "abort").is_ok());
        assert!(require_active_run(Some(&second), &first, "abort").is_err());
    }

    #[test]
    fn approval_in_one_slot_does_not_make_another_slot_non_reclaimable() {
        let approval_slot = Arc::new(RuntimeSlot::new("thread-a".into()));
        let idle_slot = Arc::new(RuntimeSlot::new("thread-b".into()));
        approval_slot
            .state
            .lock()
            .unwrap()
            .pending_extension_ui
            .insert("approval-a".into(), pending("confirm", "thread-a", "run-a"));
        let slots = HashMap::from([
            ("thread-a".to_string(), approval_slot),
            ("thread-b".to_string(), idle_slot),
        ]);

        assert_eq!(idle_runtime_thread(&slots).as_deref(), Some("thread-b"));
    }

    #[test]
    fn idle_reclamation_is_stable_and_never_evicts_active_or_approval_waiting_slots() {
        let active = Arc::new(RuntimeSlot::new("thread-a".into()));
        active.state.lock().unwrap().active_run = Some(owner("thread-a", "run-a"));
        let approval = Arc::new(RuntimeSlot::new("thread-b".into()));
        approval
            .state
            .lock()
            .unwrap()
            .pending_extension_ui
            .insert("approval-b".into(), pending("confirm", "thread-b", "run-b"));
        let idle = Arc::new(RuntimeSlot::new("thread-c".into()));
        let slots = HashMap::from([
            ("thread-a".to_string(), active),
            ("thread-b".to_string(), approval),
            ("thread-c".to_string(), idle),
        ]);

        assert_eq!(idle_runtime_thread(&slots).as_deref(), Some("thread-c"));
    }

    #[tokio::test]
    async fn cancelled_third_waiter_is_removed_and_never_admitted() {
        let manager = PiManager::new();
        let mut first = manager.acquire_slot("thread-a", None).await.unwrap();
        first.slot().state.lock().unwrap().active_run = Some(owner("thread-a", "run-a"));
        first.release();
        let mut second = manager.acquire_slot("thread-b", None).await.unwrap();
        second.slot().state.lock().unwrap().active_run = Some(owner("thread-b", "run-b"));
        second.release();

        let waiting_owner = owner("thread-c", "run-c");
        let waiter_manager = manager.clone();
        let waiter_owner = waiting_owner.clone();
        let waiter = tokio::spawn(async move {
            waiter_manager
                .acquire_slot("thread-c", Some(waiter_owner))
                .await
        });
        tokio::task::yield_now().await;
        manager
            .abort("thread-c".into(), "run-c".into())
            .await
            .unwrap();
        assert!(waiter.await.unwrap().is_err());
        assert!(!manager.pool.lock().await.slots.contains_key("thread-c"));
    }

    #[tokio::test]
    async fn dropped_waiter_cleans_fifo_and_admission_lease_blocks_eviction() {
        let manager = PiManager::new();
        let mut first = manager.acquire_slot("thread-a", None).await.unwrap();
        let first_slot = first.slot().clone();
        first_slot.state.lock().unwrap().active_run = Some(owner("thread-a", "run-a"));
        first.release();
        let mut second = manager.acquire_slot("thread-b", None).await.unwrap();
        second.slot().state.lock().unwrap().active_run = Some(owner("thread-b", "run-b"));
        second.release();

        let mut dropped =
            Box::pin(manager.acquire_slot("thread-c", Some(owner("thread-c", "run-c"))));
        assert!(matches!(
            futures::poll!(dropped.as_mut()),
            std::task::Poll::Pending
        ));
        drop(dropped);

        // Dropping the caller cancels its explicit waiter identity; it cannot
        // later claim A when that slot becomes idle.
        let pool = manager.pool.lock().await;
        assert!(pool
            .waiters
            .iter()
            .all(|waiter| { waiter.state.load(super::Ordering::Acquire) != super::WAITER_QUEUED }));
        drop(pool);

        // A caller-held lease is not reclaimable even before it starts a
        // prompt or creates any RPC work.
        let held = manager.acquire_slot("thread-a", None).await.unwrap();
        assert!(!held.slot().reclaimable());
    }

    #[tokio::test]
    async fn stop_terminally_releases_waiters() {
        let manager = PiManager::new();
        let mut first = manager.acquire_slot("thread-a", None).await.unwrap();
        first.slot().state.lock().unwrap().active_run = Some(owner("thread-a", "run-a"));
        first.release();
        let mut second = manager.acquire_slot("thread-b", None).await.unwrap();
        second.slot().state.lock().unwrap().active_run = Some(owner("thread-b", "run-b"));
        second.release();
        let waiting_manager = manager.clone();
        let waiter = tokio::spawn(async move {
            waiting_manager
                .acquire_slot("thread-c", Some(owner("thread-c", "run-c")))
                .await
        });
        tokio::task::yield_now().await;
        manager.stop().await;
        assert!(waiter.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn abort_before_prompt_admission_prevents_later_execution() {
        let manager = PiManager::new();
        manager
            .abort("thread-c".into(), "run-c".into())
            .await
            .unwrap();
        assert!(manager
            .prompt("thread-c".into(), "run-c".into(), "late prompt".into())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn failed_ui_response_consumption_never_reinserts_after_terminal_cleanup() {
        let manager = PiManager::new();
        let slot = Arc::new(RuntimeSlot::new("thread-a".into()));
        slot.state
            .lock()
            .unwrap()
            .pending_extension_ui
            .insert("approval-a".into(), pending("confirm", "thread-a", "run-a"));
        manager
            .pool
            .lock()
            .await
            .slots
            .insert("thread-a".into(), slot.clone());

        assert!(manager
            .extension_ui_response(
                "approval-a".into(),
                "thread-a".into(),
                "run-a".into(),
                Some(true),
                None,
                false,
                false,
            )
            .await
            .is_err());
        assert!(slot.state.lock().unwrap().pending_extension_ui.is_empty());
    }

    #[tokio::test]
    async fn barrier_forces_abort_between_initial_read_and_registration() {
        let manager = PiManager::new();
        manager
            .test_admission_configured
            .store(true, super::Ordering::Release);
        let hook = super::TestHook {
            reached: Arc::new(tokio::sync::Notify::new()),
            resume: Arc::new(tokio::sync::Notify::new()),
        };
        {
            let mut hooks = manager.test_hooks.lock().unwrap();
            hooks.after_initial_cancel_read = Some(hook.clone());
        }
        let running = manager.clone();
        let prompt = tokio::spawn(async move {
            running
                .prompt("thread-c".into(), "run-c".into(), "must not run".into())
                .await
        });
        hook.reached.notified().await;
        manager
            .abort("thread-c".into(), "run-c".into())
            .await
            .unwrap();
        hook.resume.notify_one();
        assert_eq!(
            prompt.await.unwrap().unwrap_err(),
            "Pi prompt was cancelled before runtime admission"
        );

        let exact_owner = owner("thread-c", "run-c");
        let pool = manager.pool.lock().await;
        assert!(!pool.slots.contains_key("thread-c"));
        assert!(pool
            .waiters
            .iter()
            .all(|waiter| waiter.owner.as_ref() != Some(&exact_owner)));
        assert!(!pool.cancelled_runs.contains(&exact_owner));
        assert!(pool.slots.values().all(|slot| {
            let state = slot.state.lock().unwrap();
            state.active_run.as_ref() != Some(&exact_owner)
                && state
                    .pending
                    .values()
                    .all(|pending| pending.owner.as_ref() != Some(&exact_owner))
                && state
                    .pending_extension_ui
                    .values()
                    .all(|pending| pending.owner != exact_owner)
        }));
    }

    #[tokio::test]
    async fn armed_wait_barrier_does_not_lose_capacity_notification() {
        let manager = PiManager::new();
        let mut a = manager.acquire_slot("a", None).await.unwrap();
        a.slot().state.lock().unwrap().active_run = Some(owner("a", "a-run"));
        a.release();
        let mut b = manager.acquire_slot("b", None).await.unwrap();
        b.slot().state.lock().unwrap().active_run = Some(owner("b", "b-run"));
        b.release();
        let hook = super::TestHook {
            reached: Arc::new(tokio::sync::Notify::new()),
            resume: Arc::new(tokio::sync::Notify::new()),
        };
        {
            let mut hooks = manager.test_hooks.lock().unwrap();
            hooks.after_capacity_observed = Some(hook.clone());
        }
        let waiting = manager.clone();
        let c =
            tokio::spawn(async move { waiting.acquire_slot("c", Some(owner("c", "c-run"))).await });
        hook.reached.notified().await;
        {
            let pool = manager.pool.lock().await;
            assert_eq!(pool.slots.len(), super::RUNTIME_POOL_CAPACITY);
            assert_eq!(pool.waiters.len(), 1);
            assert_eq!(pool.waiters[0].owner, Some(owner("c", "c-run")));
        }
        a.slot().state.lock().unwrap().active_run = None;
        manager.wake_capacity();
        hook.resume.notify_one();
        let held_c = tokio::time::timeout(std::time::Duration::from_secs(1), c)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let pool = manager.pool.lock().await;
        assert!(pool.waiters.is_empty());
        assert_eq!(pool.slots.len(), super::RUNTIME_POOL_CAPACITY);
        assert!(!pool.slots.contains_key("a"));
        assert!(pool.slots.contains_key("b"));
        assert!(pool.slots.contains_key("c"));
        assert_eq!(held_c.slot().state.lock().unwrap().admission_leases, 1);
    }

    #[tokio::test]
    async fn existing_slot_lease_blocks_competing_reclamation_without_pool_overrun() {
        let manager = PiManager::new();
        let mut a = manager.acquire_slot("thread-a", None).await.unwrap();
        let a_slot = a.slot().clone();
        a.release();
        let mut b = manager.acquire_slot("thread-b", None).await.unwrap();
        b.release();

        let hook = super::TestHook {
            reached: Arc::new(tokio::sync::Notify::new()),
            resume: Arc::new(tokio::sync::Notify::new()),
        };
        {
            let mut hooks = manager.test_hooks.lock().unwrap();
            hooks.after_existing_lease = Some(hook.clone());
        }

        // The observation fires immediately after A's pool-locked reservation.
        // Its returned lease keeps that reservation live while C attempts real
        // admission and reclamation.
        let held_a = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            manager.acquire_slot("thread-a", None),
        )
        .await
        .expect("existing-slot admission should finish")
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), hook.reached.notified())
            .await
            .expect("existing-slot lease observation should fire");
        let held_c = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            manager.acquire_slot("thread-c", None),
        )
        .await
        .expect("competing admission should finish")
        .unwrap();

        let pool = manager.pool.lock().await;
        assert_eq!(pool.slots.len(), super::RUNTIME_POOL_CAPACITY);
        assert!(Arc::ptr_eq(pool.slots.get("thread-a").unwrap(), &a_slot));
        assert!(pool.slots.contains_key("thread-c"));
        assert!(!pool.slots.contains_key("thread-b"));
        assert!(Arc::ptr_eq(held_a.slot(), &a_slot));
        assert_eq!(a_slot.state.lock().unwrap().admission_leases, 1);
        drop(pool);
        drop(held_c);
        drop(held_a);
    }
}
