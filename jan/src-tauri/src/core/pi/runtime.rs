use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::browser::{
    build_chrome_devtools_mcp_server, chrome_devtools_enabled, current_browser_cdp_fingerprint,
    mcp_config_needs_browser_upgrade, resolve_browser_user_data_dir,
};
use crate::core::divo::home::DivoHomeLayout;
use crate::core::divo::local_lark::ensure_lark_cli_wrapper;

const PI_AGENT_DIR_NAME: &str = "pi-agent";
const BUNDLED_CLI_REL: &str =
    "resources/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const AGENT_TEMPLATE_REL: &str = "resources/pi/agent-template";
const BUNDLED_EXTENSIONS_REL: &str = "resources/pi-extensions";
const BUNDLED_SKILLS_REL: &str = "resources/pi-skills";
const BUNDLED_AGENT_NPM_REL: &str = "resources/pi/agent-npm";
const BUNDLED_BRIDGE_REL: &str = "resources/pi/pi-chrome-devtools-bridge.mjs";

const CHROME_DEVTOOLS_MCP_REL: &str =
    "resources/pi/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js";

pub struct PiRuntimePaths {
    pub bun: PathBuf,
    pub cli_js: PathBuf,
    pub agent_dir: PathBuf,
    pub skill_dirs: Vec<PathBuf>,
    pub lark_cli_wrapper: Option<PathBuf>,
    /// CDP WebSocket fingerprint — changes when the browser restarts debugging.
    pub browser_cdp_fingerprint: Option<String>,
}

impl PiRuntimePaths {
    pub fn resolve(app: &AppHandle, data_folder: &Path) -> Result<Self, String> {
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

        let agent_dir = data_folder.join(PI_AGENT_DIR_NAME);
        bootstrap_agent_dir(&resource_dir, &agent_dir, &bun)?;
        let skill_dirs = bootstrap_divo_skill_dirs(&resource_dir)?;
        let lark_cli_wrapper = ensure_lark_cli_wrapper(&resource_dir, &agent_dir)?;

        Ok(PiRuntimePaths {
            bun,
            cli_js,
            agent_dir,
            skill_dirs,
            lark_cli_wrapper,
            browser_cdp_fingerprint: current_browser_cdp_fingerprint(),
        })
    }
}

/// `externalBin` bun lands next to the app binary in dev (`target/debug/bun`).
/// Release macOS: `Contents/MacOS/bun`. Packaged resources: `resources/bin/bun`.
fn resolve_bundled_bun(resource_dir: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![
        resource_dir.join("resources/bin/bun"),
        resource_dir.join("bun"),
    ];

    if let Some(parent) = resource_dir.parent() {
        candidates.push(parent.join("bun"));
        #[cfg(target_os = "macos")]
        candidates.push(parent.join("MacOS/bun"));
    }

    // Dev: resource_dir is often `target/debug/resources`
    if resource_dir.file_name().is_some_and(|n| n == "resources") {
        if let Some(parent) = resource_dir.parent() {
            candidates.push(parent.join("bun"));
        }
    }

    // Fallback: source tree (`src-tauri/resources/bin/bun`) when running `tauri dev`
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        candidates.push(PathBuf::from(manifest).join("resources/bin/bun"));
    }

    candidates.into_iter().find(|p| p.exists())
}

fn default_pi_settings_json() -> &'static str {
    r#"{
  "packages": ["npm:pi-mcp-adapter"],
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-pro",
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
            serde_json::Value::String("deepseek".to_string()),
        );
        changed = true;
    }
    if obj.get("defaultModel").is_none() {
        obj.insert(
            "defaultModel".to_string(),
            serde_json::Value::String("deepseek-v4-pro".to_string()),
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

fn bootstrap_agent_dir(resource_dir: &Path, agent_dir: &Path, bun: &Path) -> Result<(), String> {
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
    if extensions_src.exists() {
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

fn bootstrap_divo_skill_dirs(resource_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let layout = DivoHomeLayout::resolve()?;
    layout.ensure()?;

    if let Some(skills_src) = resolve_bundled_skills_dir(resource_dir) {
        sync_dir_contents(&skills_src, &layout.company_skills_dir)?;
    }

    Ok(vec![layout.company_skills_dir, layout.user_skills_dir])
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
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|e| {
            format!(
                "Failed to clear bundled Pi extensions at {}: {e}",
                dest.display()
            )
        })?;
    }
    sync_dir_contents(src, dest)
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

    #[test]
    fn bundled_paths_use_expected_suffixes() {
        assert!(BUNDLED_CLI_REL.contains("pi-coding-agent"));
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
}
