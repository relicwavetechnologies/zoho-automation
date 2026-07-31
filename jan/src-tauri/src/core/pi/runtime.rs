use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;

use tauri::{AppHandle, Manager};

use super::browser::{
    build_chrome_devtools_mcp_server, chrome_devtools_enabled, current_browser_cdp_fingerprint,
    mcp_config_needs_browser_upgrade, resolve_browser_user_data_dir,
};

pub(super) const PI_AGENT_DIR_NAME: &str = "pi-agent";
const PI_CODING_AGENT_DIR_NAME: &str = "pi-agent-coding";
const BUNDLED_CLI_REL: &str =
    "resources/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const AGENT_TEMPLATE_REL: &str = "resources/pi/agent-template";
const BUNDLED_EXTENSIONS_REL: &str = "resources/pi-extensions";
const BUNDLED_SKILLS_REL: &str = "resources/pi-skills";
const BUNDLED_AGENT_NPM_REL: &str = "resources/pi/agent-npm";
const BUNDLED_BRIDGE_REL: &str = "resources/pi/pi-chrome-devtools-bridge.mjs";
const EXTENSIONS_BUNDLE_ID_FILE: &str = ".divo-bundle-id";

const CHROME_DEVTOOLS_MCP_REL: &str =
    "resources/pi/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js";
const DEFAULT_PI_PROVIDER: &str = "deepseek";
const DEFAULT_PI_MODEL: &str = "deepseek-v4-flash";
const LEGACY_DEFAULT_PI_MODEL: &str = "deepseek-v4-pro";
const COMPANY_EXTENSION_NAMES: [&str; 6] = [
    "divo-llm",
    "divo-gateway",
    "divo-memory",
    "divo-subagents",
    "divo-artifact",
    "divo-chat-history",
];
const COMPANY_TOOL_ALLOWLIST: &str =
    "read,write,edit,bash,divo_gateway,divo_skill_view,divo_skill_resolve,divo_memory_review,divo_teach_clarify,memory,divo_subagents,divo_artifact,divo_search_chats,divo_read_chat";

/// Every company Pi process has its own lifecycle lock, but its agent-dir
/// bootstrap is shared by the whole desktop process. Keep all mutation of that
/// shared directory behind one lock so parallel chats cannot delete or rewrite
/// the same runtime files concurrently.
static PI_AGENT_BOOTSTRAP_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PiRuntimeMode {
    Company,
    Coding,
}

impl PiRuntimeMode {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            Some("company") => Ok(Self::Company),
            Some("coding") | None => Ok(Self::Coding),
            Some(other) => Err(format!(
                "Unknown Pi runtime mode \"{other}\". Expected company or coding."
            )),
        }
    }

    fn agent_dir_name(self) -> &'static str {
        match self {
            Self::Company => PI_AGENT_DIR_NAME,
            Self::Coding => PI_CODING_AGENT_DIR_NAME,
        }
    }
}

pub struct PiRuntimePaths {
    pub bun: PathBuf,
    pub cli_js: PathBuf,
    pub agent_dir: PathBuf,
    /// Bundled helper assets available to server-resolved Divo skills. This is
    /// not passed to Pi as a skill directory and cannot trigger local skill discovery.
    pub bundled_skills_dir: Option<PathBuf>,
    pub trusted_skill_dirs: Vec<PathBuf>,
    pub trusted_extension_paths: Vec<PathBuf>,
    /// CDP WebSocket fingerprint — changes when the browser restarts debugging.
    pub browser_cdp_fingerprint: Option<String>,
}

impl PiRuntimePaths {
    pub fn resolve(
        app: &AppHandle,
        data_folder: &Path,
        mode: PiRuntimeMode,
    ) -> Result<Self, String> {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;

        let bun = resolve_bundled_bun(&resource_dir).ok_or_else(|| {
            format!(
                "Bundled bun not found (resource dir: {}). Run: yarn download:bin",
                resource_dir.display()
            )
        })?;

        let cli_js = resource_dir.join(BUNDLED_CLI_REL);
        if !cli_js.exists() {
            return Err(format!(
                "Bundled Pi not found at {}. Run: yarn vendor:pi",
                cli_js.display()
            ));
        }

        let agent_dir = data_folder.join(mode.agent_dir_name());
        bootstrap_agent_dir(
            &resource_dir,
            &agent_dir,
            &bun,
            mode == PiRuntimeMode::Company,
        )?;
        let (trusted_skill_dirs, trusted_extension_paths) = match mode {
            PiRuntimeMode::Company => (
                resolve_trusted_skill_dirs(&resource_dir)?,
                resolve_trusted_extension_paths(&resource_dir)?,
            ),
            PiRuntimeMode::Coding => (Vec::new(), Vec::new()),
        };
        let bundled_skills_dir = match mode {
            PiRuntimeMode::Company => resolve_bundled_skills_dir(&resource_dir),
            PiRuntimeMode::Coding => None,
        };

        Ok(PiRuntimePaths {
            bun,
            cli_js,
            agent_dir,
            bundled_skills_dir,
            trusted_skill_dirs,
            trusted_extension_paths,
            browser_cdp_fingerprint: (mode == PiRuntimeMode::Coding)
                .then(current_browser_cdp_fingerprint)
                .flatten(),
        })
    }
}

/// Apply Pi's immutable company-mode resource and tool boundary. Explicit CLI
/// resources remain enabled even when automatic discovery is disabled.
pub fn apply_company_cli_boundary(command: &mut Command, runtime: &PiRuntimePaths) {
    command
        .arg("--no-skills")
        .arg("--no-extensions")
        .arg("--no-prompt-templates")
        .arg("--no-context-files")
        .arg("--tools")
        .arg(COMPANY_TOOL_ALLOWLIST);
    for extension_path in &runtime.trusted_extension_paths {
        command.arg("--extension").arg(extension_path);
    }
    for skill_dir in &runtime.trusted_skill_dirs {
        command.arg("--skill").arg(skill_dir);
    }
}

/// `externalBin` Bun lands next to the app binary in dev. Packaged Windows
/// installers put it in `resources/bin/bun.exe`; macOS places it beside the
/// app executable. Keep these candidates explicit because Tauri's resource
/// directory layout differs across bundle targets.
fn resolve_bundled_bun(resource_dir: &Path) -> Option<PathBuf> {
    bundled_bun_candidates(resource_dir, cfg!(windows))
        .into_iter()
        .find(|p| p.exists())
}

fn bundled_bun_candidates(resource_dir: &Path, windows: bool) -> Vec<PathBuf> {
    let bun_name = if windows { "bun.exe" } else { "bun" };
    let sidecar_name = if windows {
        "bun-x86_64-pc-windows-msvc.exe"
    } else {
        "bun"
    };

    let mut candidates: Vec<PathBuf> = vec![
        // Tauri resource glob layout.
        resource_dir.join("resources/bin").join(bun_name),
        // Windows NSIS layout and source-tree/dev resource layout.
        resource_dir.join("bin").join(bun_name),
        // Tauri externalBin layout.
        resource_dir.join(bun_name),
        resource_dir.join(sidecar_name),
    ];

    if let Some(parent) = resource_dir.parent() {
        candidates.push(parent.join(bun_name));
        candidates.push(parent.join(sidecar_name));
        if !windows {
            candidates.push(parent.join("MacOS/bun"));
        }
    }

    // Dev: resource_dir is often `target/debug/resources`
    if resource_dir.file_name().is_some_and(|n| n == "resources") {
        if let Some(parent) = resource_dir.parent() {
            candidates.push(parent.join(bun_name));
            candidates.push(parent.join(sidecar_name));
        }
    }

    // Fallback: source tree (`src-tauri/resources/bin/bun`) when running `tauri dev`
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        candidates.push(PathBuf::from(manifest).join("resources/bin").join(bun_name));
    }

    candidates
}

fn default_pi_settings_json() -> &'static str {
    r#"{
  "packages": ["npm:pi-mcp-adapter"],
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-flash",
  "defaultThinkingLevel": "medium"
}"#
}

/// Patch older pi-agent settings (provider defaults + pi-mcp-adapter package).
fn ensure_pi_settings(settings_path: &Path) -> Result<(), String> {
    let raw = fs::read_to_string(settings_path).map_err(|e| e.to_string())?;
    let mut value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let Some(obj) = value.as_object_mut() else {
        return Ok(());
    };

    let mut changed = false;
    if obj.get("defaultProvider").is_none() {
        obj.insert(
            "defaultProvider".to_string(),
            serde_json::Value::String(DEFAULT_PI_PROVIDER.to_string()),
        );
        changed = true;
    }
    if obj.get("defaultModel").is_none()
        || obj.get("defaultModel").and_then(|v| v.as_str()) == Some(LEGACY_DEFAULT_PI_MODEL)
    {
        obj.insert(
            "defaultModel".to_string(),
            serde_json::Value::String(DEFAULT_PI_MODEL.to_string()),
        );
        changed = true;
    }

    let packages = obj
        .entry("packages")
        .or_insert_with(|| serde_json::json!([]));
    if let Some(arr) = packages.as_array_mut() {
        let has_adapter = arr.iter().any(|v| v.as_str() == Some("npm:pi-mcp-adapter"));
        if !has_adapter {
            arr.push(serde_json::Value::String("npm:pi-mcp-adapter".to_string()));
            changed = true;
        }
    }

    if changed {
        fs::write(
            settings_path,
            serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn bootstrap_agent_dir(
    resource_dir: &Path,
    agent_dir: &Path,
    bun: &Path,
    sync_divo_extensions: bool,
) -> Result<(), String> {
    with_pi_agent_bootstrap_lock(|| {
        bootstrap_agent_dir_locked(resource_dir, agent_dir, bun, sync_divo_extensions)
    })
}

fn with_pi_agent_bootstrap_lock<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _bootstrap = PI_AGENT_BOOTSTRAP_LOCK.lock().unwrap_or_else(|poisoned| {
        log::warn!("divo.pi.bootstrap.lock_poisoned recovering=true");
        poisoned.into_inner()
    });
    operation()
}

fn bootstrap_agent_dir_locked(
    resource_dir: &Path,
    agent_dir: &Path,
    bun: &Path,
    sync_divo_extensions: bool,
) -> Result<(), String> {
    fs::create_dir_all(agent_dir).map_err(|e| e.to_string())?;

    let template_dir = resource_dir.join(AGENT_TEMPLATE_REL);
    let extensions_src = resource_dir.join(BUNDLED_EXTENSIONS_REL);
    let agent_npm_src = resource_dir.join(BUNDLED_AGENT_NPM_REL);

    let settings_path = agent_dir.join("settings.json");
    let mcp_path = agent_dir.join("mcp.json");
    if !settings_path.exists() {
        if template_dir.join("settings.json").exists() {
            copy_file(&template_dir.join("settings.json"), &settings_path)?;
        } else {
            fs::write(&settings_path, default_pi_settings_json()).map_err(|e| e.to_string())?;
        }
    } else {
        ensure_pi_settings(&settings_path)?;
    }

    ensure_mcp_json(&mcp_path, bun, resource_dir)?;

    let extensions_dest = agent_dir.join("extensions");
    if sync_divo_extensions && extensions_src.exists() {
        sync_bundled_extensions(&extensions_src, &extensions_dest)?;
    }

    let npm_dest = agent_dir.join("npm");
    if agent_npm_src.exists() {
        fs::create_dir_all(&npm_dest).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(&agent_npm_src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            let dest = npm_dest.join(name);
            if entry.path().is_dir() {
                sync_dir_contents(&entry.path(), &dest)?;
            }
        }
    }

    Ok(())
}

fn resolve_trusted_extension_paths(resource_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let extensions_root = resource_dir.join(BUNDLED_EXTENSIONS_REL);
    let mut paths = Vec::with_capacity(COMPANY_EXTENSION_NAMES.len());
    for name in COMPANY_EXTENSION_NAMES {
        let path = extensions_root.join(name).join("index.ts");
        if !path.is_file() {
            return Err(format!(
                "Bundled Divo extension is missing at {}",
                path.display()
            ));
        }
        paths.push(path);
    }
    Ok(paths)
}

/// Bundled local skills loaded into Pi. Company SaaS skills are resolved
/// through the authenticated backend registry; no writable user skill
/// directory is passed to Pi. Other bundled directories may be exposed as
/// fixed helper assets via DIVO_BUNDLED_SKILLS_DIR, never as discoverable skills.
fn resolve_trusted_skill_dirs(resource_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let skills_root = resolve_bundled_skills_dir(resource_dir).ok_or_else(|| {
        format!(
            "Bundled Divo skills directory was not found under {}",
            resource_dir.display(),
        )
    })?;
    let mut dirs = Vec::with_capacity(2);
    for name in ["divo-gateway", "divo-chat-history"] {
        let skill_dir = skills_root.join(name);
        if !skill_dir.join("SKILL.md").is_file() {
            return Err(format!(
                "Bundled Divo skill is missing at {}",
                skill_dir.display(),
            ));
        }
        dirs.push(skill_dir);
    }
    Ok(dirs)
}

fn resolve_bundled_skills_dir(resource_dir: &Path) -> Option<PathBuf> {
    let bundled = resource_dir.join(BUNDLED_SKILLS_REL);
    if bundled.exists() {
        return Some(bundled);
    }

    std::env::var("CARGO_MANIFEST_DIR")
        .ok()
        .and_then(|manifest| {
            PathBuf::from(manifest)
                .parent()
                .map(|p| p.join("pi-skills"))
        })
        .filter(|path| path.exists())
}

fn ensure_mcp_json(mcp_path: &Path, bun: &Path, resource_dir: &Path) -> Result<(), String> {
    if !chrome_devtools_enabled() {
        remove_chrome_devtools_mcp_server(mcp_path)?;
        return Ok(());
    }

    let chrome_mcp = resolve_chrome_devtools_mcp(resource_dir)?;
    let bridge = resolve_chrome_devtools_bridge(resource_dir)?;

    if resolve_browser_user_data_dir().is_none() {
        eprintln!(
            "[pi] Browser MCP skipped: no Chromium profile found. \
             Enable Brave remote debugging or set {}.",
            super::browser::PI_BROWSER_USER_DATA_DIR_ENV
        );
        return Ok(());
    }

    let should_write = if mcp_path.exists() {
        let raw = fs::read_to_string(mcp_path).map_err(|e| e.to_string())?;
        let value: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
        mcp_config_needs_browser_upgrade(&value)
    } else {
        true
    };

    if !should_write {
        return Ok(());
    }

    let server = build_chrome_devtools_mcp_server(bun, &bridge, &chrome_mcp);
    let content = serde_json::json!({
        "mcpServers": {
            "chrome-devtools": server
        }
    });

    fs::write(
        mcp_path,
        serde_json::to_string_pretty(&content).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn remove_chrome_devtools_mcp_server(mcp_path: &Path) -> Result<(), String> {
    if !mcp_path.exists() {
        return Ok(());
    }

    let raw = fs::read_to_string(mcp_path).map_err(|e| e.to_string())?;
    let mut value: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({ "mcpServers": {} }));

    let Some(root) = value.as_object_mut() else {
        value = serde_json::json!({ "mcpServers": {} });
        fs::write(
            mcp_path,
            serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    };

    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let changed = match servers.as_object_mut() {
        Some(servers_obj) => servers_obj.remove("chrome-devtools").is_some(),
        None => {
            *servers = serde_json::json!({});
            true
        }
    };

    if changed {
        fs::write(
            mcp_path,
            serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn resolve_chrome_devtools_bridge(resource_dir: &Path) -> Result<PathBuf, String> {
    let bundled = resource_dir.join(BUNDLED_BRIDGE_REL);
    if bundled.is_file() {
        return Ok(bundled);
    }

    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let from_scripts = PathBuf::from(manifest)
            .parent()
            .map(|p| p.join("scripts/pi-chrome-devtools-bridge.mjs"))
            .unwrap_or_default();
        if from_scripts.is_file() {
            return Ok(from_scripts);
        }
    }

    Err("Bundled pi-chrome-devtools-bridge.mjs not found. Run: yarn vendor:pi".into())
}

fn resolve_chrome_devtools_mcp(resource_dir: &Path) -> Result<PathBuf, String> {
    let resolved = resource_dir.join(CHROME_DEVTOOLS_MCP_REL);
    if resolved.exists() {
        return Ok(resolved);
    }

    Err(format!(
        "Bundled chrome-devtools-mcp not found at {}. Run: yarn vendor:pi",
        resolved.display()
    ))
}

fn sync_bundled_extensions(src: &Path, dest: &Path) -> Result<(), String> {
    let parent = dest.parent().ok_or_else(|| {
        format!(
            "Bundled Pi extensions destination has no parent: {}",
            dest.display()
        )
    })?;
    let name = dest
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Invalid bundled Pi extensions path: {}", dest.display()))?;
    let staging = parent.join(format!(".{name}.staging"));
    let previous = parent.join(format!(".{name}.previous"));

    recover_interrupted_extension_sync(dest, &staging, &previous)?;
    if bundled_extensions_are_current(src, dest) {
        log::debug!("divo.pi.extensions.bundle_current path={}", dest.display());
        return Ok(());
    }
    let started = Instant::now();
    log::info!("divo.pi.extensions.sync_started path={}", dest.display());

    remove_path_if_exists(&staging)?;
    if let Err(error) = sync_dir_contents(src, &staging) {
        let _ = remove_path_if_exists(&staging);
        return Err(format!(
            "Failed to stage bundled Pi extensions from {}: {error}",
            src.display()
        ));
    }

    let had_previous = dest.exists();
    if had_previous {
        fs::rename(dest, &previous).map_err(|error| {
            let _ = remove_path_if_exists(&staging);
            format!(
                "Failed to preserve current Pi extensions at {}: {error}",
                dest.display()
            )
        })?;
    }

    if let Err(error) = fs::rename(&staging, dest) {
        let rollback_error = if had_previous {
            fs::rename(&previous, dest).err()
        } else {
            None
        };
        let _ = remove_path_if_exists(&staging);
        return Err(match rollback_error {
            Some(rollback) => format!(
                "Failed to activate bundled Pi extensions at {}: {error}; rollback also failed: {rollback}",
                dest.display()
            ),
            None => format!(
                "Failed to activate bundled Pi extensions at {}: {error}",
                dest.display()
            ),
        });
    }

    // The new mirror is already complete and active. A failed cleanup is safe
    // to retry on the next bootstrap and must not fail an otherwise valid run.
    if let Err(error) = remove_path_if_exists(&previous) {
        log::warn!(
            "divo.pi.extensions.previous_cleanup_failed path={} error={error}",
            previous.display()
        );
    }
    log::info!(
        "divo.pi.extensions.sync_completed path={} elapsed_ms={}",
        dest.display(),
        started.elapsed().as_millis()
    );
    Ok(())
}

fn recover_interrupted_extension_sync(
    dest: &Path,
    staging: &Path,
    previous: &Path,
) -> Result<(), String> {
    if !dest.exists() && previous.exists() {
        fs::rename(previous, dest).map_err(|error| {
            format!(
                "Failed to recover previous Pi extensions at {}: {error}",
                dest.display()
            )
        })?;
    }
    remove_path_if_exists(staging)?;
    if dest.exists() {
        remove_path_if_exists(previous)?;
    }
    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Failed to inspect {}: {error}", path.display())),
    };
    if metadata.file_type().is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Failed to remove {}: {error}", path.display()))
    } else {
        fs::remove_file(path)
            .map_err(|error| format!("Failed to remove {}: {error}", path.display()))
    }
}

fn bundled_extensions_are_current(src: &Path, dest: &Path) -> bool {
    let source_id = read_extension_bundle_id(src);
    source_id.is_some()
        && source_id == read_extension_bundle_id(dest)
        && COMPANY_EXTENSION_NAMES
            .iter()
            .all(|name| dest.join(name).join("index.ts").is_file())
}

fn read_extension_bundle_id(root: &Path) -> Option<String> {
    fs::read_to_string(root.join(EXTENSIONS_BUNDLE_ID_FILE))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Copy missing / updated files from src into dest (recursive). Never deletes extra files in dest.
fn sync_dir_contents(src: &Path, dest: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;

    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            sync_dir_contents(&src_path, &dest_path)?;
        } else {
            let should_copy = match fs::metadata(&dest_path) {
                Ok(meta) => fs::metadata(&src_path)
                    .map(|s| s.len() != meta.len())
                    .unwrap_or(true),
                Err(_) => true,
            };
            if should_copy {
                copy_file(&src_path, &dest_path)?;
            }
        }
    }
    Ok(())
}

fn copy_file(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(src, dest).map_err(|e| {
        format!(
            "Failed to copy {} -> {}: {e}",
            src.display(),
            dest.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_extension_bundle(root: &Path, bundle_id: &str, content: &str) {
        for name in COMPANY_EXTENSION_NAMES {
            let extension = root.join(name);
            fs::create_dir_all(&extension).unwrap();
            fs::write(extension.join("index.ts"), format!("{content}:{name}")).unwrap();
        }
        fs::write(
            root.join(EXTENSIONS_BUNDLE_ID_FILE),
            format!("{bundle_id}\n"),
        )
        .unwrap();
    }

    #[test]
    fn bundled_paths_use_expected_suffixes() {
        assert!(BUNDLED_CLI_REL.contains("pi-coding-agent"));
    }

    #[test]
    fn runtime_mode_defaults_to_token_free_coding_and_rejects_unknown_values() {
        assert_eq!(PiRuntimeMode::parse(None).unwrap(), PiRuntimeMode::Coding);
        assert_eq!(
            PiRuntimeMode::parse(Some("company")).unwrap(),
            PiRuntimeMode::Company
        );
        assert!(PiRuntimeMode::parse(Some("hybrid")).is_err());
        assert_eq!(PiRuntimeMode::Company.agent_dir_name(), "pi-agent");
        assert_eq!(PiRuntimeMode::Coding.agent_dir_name(), "pi-agent-coding");
    }

    #[test]
    fn company_cli_boundary_is_an_exact_immutable_allowlist() {
        let runtime = PiRuntimePaths {
            bun: PathBuf::from("/bundle/bun"),
            cli_js: PathBuf::from("/bundle/pi/cli.js"),
            agent_dir: PathBuf::from("/data/pi-agent"),
            bundled_skills_dir: Some(PathBuf::from("/bundle/pi-skills")),
            trusted_skill_dirs: vec![
                PathBuf::from("/bundle/pi-skills/divo-gateway"),
                PathBuf::from("/bundle/pi-skills/divo-chat-history"),
            ],
            trusted_extension_paths: vec![
                PathBuf::from("/bundle/pi-extensions/divo-llm/index.ts"),
                PathBuf::from("/bundle/pi-extensions/divo-gateway/index.ts"),
                PathBuf::from("/bundle/pi-extensions/divo-memory/index.ts"),
                PathBuf::from("/bundle/pi-extensions/divo-subagents/index.ts"),
                PathBuf::from("/bundle/pi-extensions/divo-artifact/index.ts"),
                PathBuf::from("/bundle/pi-extensions/divo-chat-history/index.ts"),
            ],
            browser_cdp_fingerprint: None,
        };
        let mut command = Command::new("bun");

        apply_company_cli_boundary(&mut command, &runtime);

        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.contains(&"--no-skills".to_string()));
        assert!(args.contains(&"--no-extensions".to_string()));
        assert!(args.contains(&"--no-prompt-templates".to_string()));
        assert!(args.contains(&"--no-context-files".to_string()));
        assert!(args.windows(2).any(|pair| {
            pair == [
                "--tools",
                "read,write,edit,bash,divo_gateway,divo_skill_view,divo_skill_resolve,divo_memory_review,divo_teach_clarify,memory,divo_subagents,divo_artifact,divo_search_chats,divo_read_chat",
            ]
        }));
        assert_eq!(args.iter().filter(|arg| *arg == "--extension").count(), 6);
        assert_eq!(args.iter().filter(|arg| *arg == "--skill").count(), 2);
    }

    #[test]
    fn resolve_bundled_bun_finds_dev_sidecar_layout() {
        let tmp = std::env::temp_dir().join(format!("jan-pi-bun-test-{}", std::process::id()));
        let debug_dir = tmp.join("target/debug");
        let bun_path = debug_dir.join("bun");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&debug_dir).unwrap();
        fs::write(&bun_path, b"").unwrap();

        let found = resolve_bundled_bun(&debug_dir);
        assert_eq!(found.as_deref(), Some(bun_path.as_path()));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bundled_bun_candidates_include_windows_installer_and_sidecar_layouts() {
        let resource_dir = PathBuf::from(r"C:\Program Files\Divo Dex\resources");
        let candidates = bundled_bun_candidates(&resource_dir, true);

        assert!(candidates.contains(&resource_dir.join("bin/bun.exe")));
        assert!(candidates.contains(&resource_dir.join("bun-x86_64-pc-windows-msvc.exe")));
        assert!(candidates.contains(&resource_dir.parent().unwrap().join("bun.exe")));
    }

    #[test]
    fn resolve_bundled_skills_dir_finds_packaged_resources() {
        let tmp = std::env::temp_dir().join(format!("jan-pi-skills-test-{}", std::process::id()));
        let skills_dir = tmp.join(BUNDLED_SKILLS_REL);
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&skills_dir).unwrap();

        let found = resolve_bundled_skills_dir(&tmp);
        assert_eq!(found.as_deref(), Some(skills_dir.as_path()));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn trusted_skill_dirs_exclude_bundled_asset_directories() {
        let tmp =
            std::env::temp_dir().join(format!("jan-pi-trusted-skills-test-{}", std::process::id()));
        let skills_dir = tmp.join(BUNDLED_SKILLS_REL);
        let gateway_dir = skills_dir.join("divo-gateway");
        let chat_history_dir = skills_dir.join("divo-chat-history");
        let assets_dir = skills_dir.join("files-and-documents");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&gateway_dir).unwrap();
        fs::write(gateway_dir.join("SKILL.md"), b"gateway").unwrap();
        fs::create_dir_all(&chat_history_dir).unwrap();
        fs::write(chat_history_dir.join("SKILL.md"), b"chat-history").unwrap();
        // A bundled directory of helper scripts is reachable through
        // DIVO_BUNDLED_SKILLS_DIR but must never become a discoverable skill:
        // capabilities are DB rows the agent reaches router-first.
        fs::create_dir_all(assets_dir.join("scripts")).unwrap();
        fs::write(assets_dir.join("scripts/extract.py"), b"# helper").unwrap();
        fs::create_dir_all(skills_dir.join("untrusted-local-company-skill")).unwrap();
        fs::write(
            skills_dir.join("untrusted-local-company-skill/SKILL.md"),
            b"local",
        )
        .unwrap();

        let trusted = resolve_trusted_skill_dirs(&tmp).unwrap();
        assert_eq!(trusted, vec![gateway_dir, chat_history_dir]);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn remove_chrome_devtools_mcp_server_preserves_other_servers() {
        let tmp = std::env::temp_dir().join(format!("jan-pi-mcp-test-{}", std::process::id()));
        let mcp_path = tmp.join("mcp.json");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            &mcp_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": {
                    "chrome-devtools": { "command": "bun" },
                    "other": { "command": "node" }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        remove_chrome_devtools_mcp_server(&mcp_path).unwrap();

        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&mcp_path).unwrap()).unwrap();
        let servers = value
            .get("mcpServers")
            .and_then(|servers| servers.as_object())
            .unwrap();
        assert!(!servers.contains_key("chrome-devtools"));
        assert!(servers.contains_key("other"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sync_bundled_extensions_mirrors_source_directory() {
        let tmp = std::env::temp_dir().join(format!(
            "jan-pi-extension-mirror-test-{}",
            std::process::id()
        ));
        let src = tmp.join("src");
        let dest = tmp.join("dest");
        let _ = fs::remove_dir_all(&tmp);

        fs::create_dir_all(src.join("divo-gateway")).unwrap();
        fs::write(src.join("divo-gateway/index.ts"), b"gateway").unwrap();
        fs::create_dir_all(dest.join("stale-extension")).unwrap();
        fs::write(dest.join("stale-extension/index.ts"), b"stale").unwrap();
        fs::create_dir_all(dest.join("old-managed")).unwrap();
        fs::write(dest.join("old-managed/index.ts"), b"old").unwrap();

        sync_bundled_extensions(&src, &dest).unwrap();

        assert!(dest.join("divo-gateway/index.ts").is_file());
        assert!(!dest.join("stale-extension").exists());
        assert!(!dest.join("old-managed").exists());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bundled_extension_identity_detects_current_and_changed_bundles() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("src");
        let dest = temp.path().join("dest");
        write_test_extension_bundle(&src, "bundle-a", "source");
        write_test_extension_bundle(&dest, "bundle-a", "source");

        assert!(bundled_extensions_are_current(&src, &dest));

        fs::write(src.join(EXTENSIONS_BUNDLE_ID_FILE), b"bundle-b\n").unwrap();
        assert!(!bundled_extensions_are_current(&src, &dest));
    }

    #[test]
    fn bundled_extension_sync_recovers_an_interrupted_swap() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("src");
        let dest = temp.path().join("extensions");
        let staging = temp.path().join(".extensions.staging");
        let previous = temp.path().join(".extensions.previous");
        write_test_extension_bundle(&src, "bundle-new", "new");
        write_test_extension_bundle(&previous, "bundle-old", "old");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("partial.ts"), b"partial").unwrap();

        sync_bundled_extensions(&src, &dest).unwrap();

        assert!(bundled_extensions_are_current(&src, &dest));
        assert_eq!(
            fs::read_to_string(dest.join("divo-gateway/index.ts")).unwrap(),
            "new:divo-gateway"
        );
        assert!(!staging.exists());
        assert!(!previous.exists());
    }

    #[test]
    fn shared_agent_bootstrap_is_serialized_across_parallel_threads() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Barrier};
        use std::time::Duration;

        let barrier = Arc::new(Barrier::new(3));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();

        for _ in 0..2 {
            let barrier = barrier.clone();
            let active = active.clone();
            let peak = peak.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                with_pi_agent_bootstrap_lock(|| {
                    let concurrent = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(concurrent, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(25));
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
                .unwrap();
            }));
        }

        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }
}
