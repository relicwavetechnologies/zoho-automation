use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use super::home::DivoHomeLayout;

pub const LARK_CLI_RESOURCE_REL: &str =
    "resources/lark-cli/node_modules/@larksuite/cli/bin/lark-cli";

const LARK_CLI_HOME_DIR: &str = "lark-cli-home";
const LARK_CLI_WRAPPER_DIR: &str = "local-tools/bin";
const SETUP_URL_TIMEOUT: Duration = Duration::from_secs(15);

static SETUP_PROCESS: Lazy<Mutex<Option<LarkSetupProcess>>> = Lazy::new(|| Mutex::new(None));

struct LarkSetupProcess {
    child: Child,
    output_rx: mpsc::Receiver<String>,
    output: String,
}

#[derive(Debug, Clone)]
struct LarkAppCredentials {
    app_id: String,
    app_secret: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLarkStatus {
    installed: bool,
    configured: bool,
    connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cli_path: Option<String>,
    home_path: String,
    uses_configured_app: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLarkSetupStart {
    started: bool,
    completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    authorize_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLarkSetupStatus {
    running: bool,
    completed: bool,
    success: bool,
    output: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLarkAuthStart {
    authorize_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_code: Option<String>,
    raw: Value,
}

#[derive(Debug)]
pub struct LocalLarkRuntime {
    pub cli_path: PathBuf,
    pub home_path: PathBuf,
}

pub fn resolve_bundled_lark_cli(resource_dir: &Path) -> Option<PathBuf> {
    let bundled = resource_dir.join(LARK_CLI_RESOURCE_REL);
    if bundled.is_file() {
        return Some(bundled);
    }

    std::env::var("CARGO_MANIFEST_DIR")
        .ok()
        .and_then(|manifest| {
            let candidate = PathBuf::from(manifest).join(LARK_CLI_RESOURCE_REL);
            candidate.is_file().then_some(candidate)
        })
}

pub fn resolve_lark_cli_home() -> Result<PathBuf, String> {
    let layout = DivoHomeLayout::resolve()?;
    layout.ensure()?;
    let home_path = layout.state_dir.join(LARK_CLI_HOME_DIR);
    fs::create_dir_all(&home_path).map_err(|e| {
        format!(
            "Failed to create isolated Lark CLI home {}: {e}",
            home_path.display()
        )
    })?;
    Ok(home_path)
}

pub fn ensure_lark_cli_wrapper(
    resource_dir: &Path,
    agent_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    let Some(cli_path) = resolve_bundled_lark_cli(resource_dir) else {
        return Ok(None);
    };
    let home_path = resolve_lark_cli_home()?;
    let wrapper_dir = agent_dir.join(LARK_CLI_WRAPPER_DIR);
    fs::create_dir_all(&wrapper_dir).map_err(|e| e.to_string())?;
    let wrapper_path = wrapper_dir.join("lark-cli");

    let script = format!(
        "#!/bin/sh\n\
export HOME={home}\n\
export XDG_CONFIG_HOME={home}/.config\n\
export XDG_CACHE_HOME={home}/.cache\n\
export XDG_DATA_HOME={home}/.local/share\n\
exec {cli} \"$@\"\n",
        home = shell_quote(&home_path),
        cli = shell_quote(&cli_path),
    );
    fs::write(&wrapper_path, script).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&wrapper_path)
            .map_err(|e| e.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&wrapper_path, permissions).map_err(|e| e.to_string())?;
    }

    Ok(Some(wrapper_path))
}

fn shell_quote(path: &Path) -> String {
    let raw = path.to_string_lossy();
    format!("'{}'", raw.replace('\'', "'\\''"))
}

fn resolve_runtime<R: Runtime>(app: &AppHandle<R>) -> Result<LocalLarkRuntime, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;
    let cli_path = resolve_bundled_lark_cli(&resource_dir)
        .ok_or_else(|| "Bundled Lark CLI not found. Run: yarn vendor:pi".to_string())?;
    let home_path = resolve_lark_cli_home()?;
    Ok(LocalLarkRuntime {
        cli_path,
        home_path,
    })
}

fn lark_command(runtime: &LocalLarkRuntime) -> Command {
    let mut cmd = Command::new(&runtime.cli_path);
    cmd.env("HOME", &runtime.home_path)
        .env("XDG_CONFIG_HOME", runtime.home_path.join(".config"))
        .env("XDG_CACHE_HOME", runtime.home_path.join(".cache"))
        .env("XDG_DATA_HOME", runtime.home_path.join(".local/share"));
    cmd
}

fn load_lark_app_credentials() -> Option<LarkAppCredentials> {
    let app_id = read_config_value("DIVO_LARK_APP_ID")?;
    let app_secret = read_config_value("DIVO_LARK_APP_SECRET")?;
    Some(LarkAppCredentials { app_id, app_secret })
}

fn read_config_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            resolve_jan_dotenv()
                .and_then(|path| read_env_file(&path).ok())
                .and_then(|values| values.get(key).cloned())
        })
}

fn resolve_jan_dotenv() -> Option<PathBuf> {
    std::env::var("CARGO_MANIFEST_DIR")
        .ok()
        .and_then(|manifest| PathBuf::from(manifest).parent().map(|p| p.join(".env")))
        .filter(|path| path.is_file())
}

fn read_env_file(path: &Path) -> Result<HashMap<String, String>, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut values = HashMap::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();
        if !key.is_empty() && !value.is_empty() {
            values.insert(key.to_string(), value);
        }
    }
    Ok(values)
}

fn configure_lark_app(
    runtime: &LocalLarkRuntime,
    creds: &LarkAppCredentials,
) -> Result<(), String> {
    let mut child = lark_command(runtime)
        .args([
            "config",
            "init",
            "--app-id",
            &creds.app_id,
            "--app-secret-stdin",
            "--brand",
            "lark",
            "--force-init",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to configure bundled Lark CLI app: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(creds.app_secret.as_bytes())
            .map_err(|e| format!("Failed to pass Lark app secret to CLI: {e}"))?;
        stdin
            .write_all(b"\n")
            .map_err(|e| format!("Failed to finish Lark app secret input: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Lark app configuration: {e}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "Lark app configuration failed: {}{}",
        stdout.trim(),
        stderr.trim()
    ))
}

fn ensure_lark_app_configured(runtime: &LocalLarkRuntime) -> Result<bool, String> {
    let Some(creds) = load_lark_app_credentials() else {
        return Ok(false);
    };
    configure_lark_app(runtime, &creds)?;
    Ok(true)
}

fn run_lark_json(
    runtime: &LocalLarkRuntime,
    args: &[&str],
) -> Result<(i32, String, Value), String> {
    let output = lark_command(runtime)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run bundled lark-cli: {e}"))?;
    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let body = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    let parsed = serde_json::from_str(body).unwrap_or_else(|_| {
        serde_json::json!({
            "ok": false,
            "raw": body,
            "stderr": stderr.trim(),
        })
    });
    Ok((code, body.to_string(), parsed))
}

fn read_process_output<R: BufRead + Send + 'static>(reader: R, tx: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        for line in reader.lines().map_while(Result::ok) {
            let _ = tx.send(line + "\n");
        }
    });
}

fn drain_setup_output(process: &mut LarkSetupProcess) {
    while let Ok(chunk) = process.output_rx.try_recv() {
        process.output.push_str(&chunk);
    }
}

fn first_url(raw: &str) -> Option<String> {
    raw.split_whitespace()
        .find_map(|part| {
            let cleaned = part.trim_matches(|c: char| {
                matches!(c, '"' | '\'' | ')' | '(' | ']' | '[' | ',' | ';')
            });
            (cleaned.starts_with("https://") || cleaned.starts_with("http://"))
                .then(|| cleaned.to_string())
        })
        .filter(|url| !url.is_empty())
}

fn find_string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(found) = map.get(*key).and_then(Value::as_str) {
                    return Some(found);
                }
            }
            map.values()
                .find_map(|child| find_string_field(child, keys))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| find_string_field(child, keys)),
        _ => None,
    }
}

fn find_url_field(value: &Value) -> Option<String> {
    find_string_field(
        value,
        &[
            "authorize_url",
            "authorizeUrl",
            "verification_uri_complete",
            "verificationUriComplete",
            "verification_uri",
            "verificationUri",
            "url",
        ],
    )
    .map(str::to_string)
    .or_else(|| first_url(&value.to_string()))
}

fn account_label(value: &Value) -> Option<String> {
    find_string_field(
        value,
        &[
            "email",
            "userEmail",
            "name",
            "userName",
            "tenant",
            "tenantName",
            "account",
        ],
    )
    .map(str::to_string)
}

#[tauri::command]
pub async fn divo_lark_local_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LocalLarkStatus, String> {
    let home_path = resolve_lark_cli_home()?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;
    let Some(cli_path) = resolve_bundled_lark_cli(&resource_dir) else {
        return Ok(LocalLarkStatus {
            installed: false,
            configured: false,
            connected: false,
            account_label: None,
            status_text: Some("Bundled lark-cli has not been vendored yet.".to_string()),
            cli_path: None,
            home_path: home_path.display().to_string(),
            uses_configured_app: load_lark_app_credentials().is_some(),
            version: None,
            raw: None,
            error: None,
        });
    };

    let runtime = LocalLarkRuntime {
        cli_path: cli_path.clone(),
        home_path: home_path.clone(),
    };
    let version = lark_command(&runtime)
        .arg("--version")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty());

    let (code, raw_text, raw) = run_lark_json(&runtime, &["auth", "status", "--json"])?;
    let error_type = raw
        .get("error")
        .and_then(|e| e.get("type"))
        .and_then(Value::as_str);
    let error_subtype = raw
        .get("error")
        .and_then(|e| e.get("subtype"))
        .and_then(Value::as_str);
    let configured = error_subtype != Some("not_configured") && error_type != Some("config");
    let ok = raw.get("ok").and_then(Value::as_bool).unwrap_or(code == 0);

    Ok(LocalLarkStatus {
        installed: true,
        configured,
        connected: configured && ok,
        account_label: account_label(&raw),
        status_text: raw
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .or_else(|| find_string_field(&raw, &["status", "message"]))
            .map(str::to_string),
        cli_path: Some(cli_path.display().to_string()),
        home_path: home_path.display().to_string(),
        uses_configured_app: load_lark_app_credentials().is_some(),
        version,
        raw: Some(raw),
        error: (code != 0 && configured).then_some(raw_text),
    })
}

#[tauri::command]
pub async fn divo_lark_local_setup_start<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LocalLarkSetupStart, String> {
    let runtime = resolve_runtime(&app)?;
    if ensure_lark_app_configured(&runtime)? {
        return Ok(LocalLarkSetupStart {
            started: false,
            completed: true,
            authorize_url: None,
        });
    }

    let mut guard = SETUP_PROCESS.lock().map_err(|e| e.to_string())?;
    if let Some(process) = guard.as_mut() {
        drain_setup_output(process);
        if let Some(url) = first_url(&process.output) {
            return Ok(LocalLarkSetupStart {
                started: false,
                completed: false,
                authorize_url: Some(url),
            });
        }
    }

    let mut child = lark_command(&runtime)
        .args([
            "config",
            "init",
            "--new",
            "--force-init",
            "--brand",
            "lark",
            "--lang",
            "en",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start Lark CLI setup: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture Lark setup stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture Lark setup stderr".to_string())?;
    let (tx, rx) = mpsc::channel();
    read_process_output(BufReader::new(stdout), tx.clone());
    read_process_output(BufReader::new(stderr), tx);

    let mut output = String::new();
    let started_at = std::time::Instant::now();
    while started_at.elapsed() < SETUP_URL_TIMEOUT {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(250)) {
            output.push_str(&chunk);
            if let Some(url) = first_url(&output) {
                *guard = Some(LarkSetupProcess {
                    child,
                    output_rx: rx,
                    output,
                });
                return Ok(LocalLarkSetupStart {
                    started: true,
                    completed: false,
                    authorize_url: Some(url),
                });
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "Lark CLI setup exited before producing a URL (status: {status}, output: {output})"
            ));
        }
    }

    let _ = child.kill();
    Err(format!(
        "Lark CLI setup did not produce a URL within {}s. Output: {}",
        SETUP_URL_TIMEOUT.as_secs(),
        output
    ))
}

#[tauri::command]
pub async fn divo_lark_local_setup_status() -> Result<LocalLarkSetupStatus, String> {
    let mut guard = SETUP_PROCESS.lock().map_err(|e| e.to_string())?;
    let Some(process) = guard.as_mut() else {
        return Ok(LocalLarkSetupStatus {
            running: false,
            completed: false,
            success: false,
            output: String::new(),
        });
    };

    drain_setup_output(process);
    let output = process.output.clone();
    match process.child.try_wait().map_err(|e| e.to_string())? {
        Some(status) => {
            *guard = None;
            Ok(LocalLarkSetupStatus {
                running: false,
                completed: true,
                success: status.success(),
                output,
            })
        }
        None => Ok(LocalLarkSetupStatus {
            running: true,
            completed: false,
            success: false,
            output,
        }),
    }
}

#[tauri::command]
pub async fn divo_lark_local_auth_start<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LocalLarkAuthStart, String> {
    let runtime = resolve_runtime(&app)?;
    let _ = ensure_lark_app_configured(&runtime)?;
    let (code, body, raw) = run_lark_json(
        &runtime,
        &["auth", "login", "--recommend", "--no-wait", "--json"],
    )?;
    if code != 0 {
        return Err(format!("Lark auth start failed: {body}"));
    }
    let authorize_url = find_url_field(&raw)
        .ok_or_else(|| format!("Lark auth response missing authorize URL: {raw}"))?;
    let device_code = find_string_field(&raw, &["device_code", "deviceCode"]).map(str::to_string);
    Ok(LocalLarkAuthStart {
        authorize_url,
        device_code,
        raw,
    })
}

#[tauri::command]
pub async fn divo_lark_local_auth_complete<R: Runtime>(
    app: AppHandle<R>,
    device_code: String,
) -> Result<Value, String> {
    let device_code = device_code.trim();
    if device_code.is_empty() {
        return Err("deviceCode is required".to_string());
    }
    let runtime = resolve_runtime(&app)?;
    let (code, body, raw) = run_lark_json(
        &runtime,
        &["auth", "login", "--device-code", device_code, "--json"],
    )?;
    if code != 0 {
        return Err(format!("Lark auth completion failed: {body}"));
    }
    Ok(raw)
}

#[tauri::command]
pub async fn divo_lark_local_disconnect<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    let runtime = resolve_runtime(&app)?;
    let (code, body, raw) = run_lark_json(&runtime, &["auth", "logout", "--json"])?;
    if code != 0 {
        return Err(format!("Lark logout failed: {body}"));
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_url_extracts_http_url_from_cli_output() {
        let output = "Open this URL: https://example.com/path?x=1, then continue";
        assert_eq!(
            first_url(output).as_deref(),
            Some("https://example.com/path?x=1")
        );
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        let path = PathBuf::from("/tmp/a'b");
        assert_eq!(shell_quote(&path), "'/tmp/a'\\''b'");
    }
}
