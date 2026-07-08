use std::fs;
use std::path::{Path, PathBuf};

/// Override with an absolute path to a Chromium profile directory (Brave/Chrome/Edge).
pub const PI_BROWSER_USER_DATA_DIR_ENV: &str = "PI_BROWSER_USER_DATA_DIR";
pub const DIVO_ENABLE_CHROME_DEVTOOLS_ENV: &str = "DIVO_ENABLE_CHROME_DEVTOOLS";

struct BrowserProfile {
    _name: &'static str,
    path: PathBuf,
}

/// Chromium profiles checked in order. Brave first (Jan default).
fn browser_profile_candidates(home: &Path) -> Vec<BrowserProfile> {
    #[cfg(target_os = "macos")]
    {
        return vec![
            BrowserProfile {
                _name: "Brave",
                path: home.join("Library/Application Support/BraveSoftware/Brave-Browser"),
            },
            BrowserProfile {
                _name: "Chrome",
                path: home.join("Library/Application Support/Google/Chrome"),
            },
            BrowserProfile {
                _name: "Edge",
                path: home.join("Library/Application Support/Microsoft Edge"),
            },
        ];
    }

    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData/Local"));
        return vec![
            BrowserProfile {
                _name: "Brave",
                path: local.join("BraveSoftware/Brave-Browser/User Data"),
            },
            BrowserProfile {
                _name: "Chrome",
                path: local.join("Google/Chrome/User Data"),
            },
            BrowserProfile {
                _name: "Edge",
                path: local.join("Microsoft/Edge/User Data"),
            },
        ];
    }

    #[cfg(target_os = "linux")]
    {
        return vec![
            BrowserProfile {
                _name: "Brave",
                path: home.join(".config/BraveSoftware/Brave-Browser"),
            },
            BrowserProfile {
                _name: "Chrome",
                path: home.join(".config/google-chrome"),
            },
            BrowserProfile {
                _name: "Edge",
                path: home.join(".config/microsoft-edge"),
            },
        ];
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = home;
        Vec::new()
    }
}

fn home_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    } else {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

pub fn chrome_devtools_enabled() -> bool {
    std::env::var(DIVO_ENABLE_CHROME_DEVTOOLS_ENV)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// Profile dir with active remote debugging (DevToolsActivePort present).
pub fn resolve_browser_user_data_dir() -> Option<PathBuf> {
    if let Ok(override_dir) = std::env::var(PI_BROWSER_USER_DATA_DIR_ENV) {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_dir() {
                return Some(path);
            }
        }
    }

    let home = home_dir()?;
    let candidates = browser_profile_candidates(&home);

    for profile in &candidates {
        if profile.path.join("DevToolsActivePort").is_file() {
            return Some(profile.path.clone());
        }
    }

    candidates
        .into_iter()
        .find(|p| p.path.is_dir())
        .map(|p| p.path)
}

/// `ws://127.0.0.1:PORT/devtools/browser/<uuid>` from DevToolsActivePort.
pub fn read_devtools_ws_endpoint(profile_dir: &Path) -> Option<String> {
    let port_file = profile_dir.join("DevToolsActivePort");
    let raw = fs::read_to_string(port_file).ok()?;
    let mut lines = raw.lines().map(str::trim).filter(|l| !l.is_empty());
    let port = lines.next()?;
    let ws_path = lines.next()?;
    if port.parse::<u16>().is_err() || !ws_path.starts_with("/devtools/") {
        return None;
    }
    Some(format!("ws://127.0.0.1:{port}{ws_path}"))
}

/// Changes when the browser restarts remote debugging (UUID rotates).
pub fn current_browser_cdp_fingerprint() -> Option<String> {
    if !chrome_devtools_enabled() {
        return None;
    }

    resolve_browser_user_data_dir().and_then(|dir| read_devtools_ws_endpoint(&dir))
}

pub fn chrome_devtools_bridge_args(bridge: &Path, chrome_mcp: &Path) -> Vec<String> {
    vec![
        "run".to_string(),
        bridge.to_string_lossy().into_owned(),
        chrome_mcp.to_string_lossy().into_owned(),
    ]
}

pub fn build_chrome_devtools_mcp_server(
    bun: &Path,
    bridge: &Path,
    chrome_mcp: &Path,
) -> serde_json::Value {
    serde_json::json!({
        "command": bun.to_string_lossy(),
        "args": chrome_devtools_bridge_args(bridge, chrome_mcp),
        "directTools": true,
        "lifecycle": "lazy",
        "idleTimeout": 2
    })
}

/// True when mcp.json uses a legacy browser connection mode (not the Jan bridge).
pub fn mcp_config_needs_browser_upgrade(value: &serde_json::Value) -> bool {
    let Some(servers) = value.get("mcpServers").and_then(|v| v.as_object()) else {
        return true;
    };
    let Some(server) = servers.get("chrome-devtools") else {
        return true;
    };
    let Some(args) = server.get("args").and_then(|v| v.as_array()) else {
        return true;
    };

    let uses_bridge = args.iter().any(|a| {
        a.as_str()
            .is_some_and(|s| s.contains("pi-chrome-devtools-bridge"))
    });
    if uses_bridge {
        return false;
    }

    args.iter().any(|a| {
        a.as_str().is_some_and(|s| {
            s.contains("browserUrl")
                || s.contains("browser-url")
                || s.contains("user-data-dir")
                || s.contains("wsEndpoint")
        })
    })
}

/// Best-effort cleanup of stale chrome-devtools-mcp subprocesses after browser kill.
pub fn kill_orphan_chrome_devtools_mcp() {
    #[cfg(unix)]
    {
        use std::process::Command;
        let _ = Command::new("pkill")
            .args(["-f", "chrome-devtools-mcp"])
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_config_needs_upgrade_for_legacy_modes() {
        for args in [
            vec!["run", "/mcp.js", "--browserUrl=http://127.0.0.1:9222"],
            vec!["run", "/mcp.js", "--user-data-dir=/tmp/brave"],
            vec![
                "run",
                "/mcp.js",
                "--wsEndpoint=ws://127.0.0.1:9222/devtools/browser/x",
            ],
        ] {
            let cfg = serde_json::json!({
                "mcpServers": { "chrome-devtools": { "args": args } }
            });
            assert!(mcp_config_needs_browser_upgrade(&cfg));
        }
    }

    #[test]
    fn mcp_config_ok_with_bridge() {
        let cfg = serde_json::json!({
            "mcpServers": {
                "chrome-devtools": {
                    "args": ["run", "/pi-chrome-devtools-bridge.mjs", "/mcp.js"]
                }
            }
        });
        assert!(!mcp_config_needs_browser_upgrade(&cfg));
    }

    #[test]
    fn read_devtools_ws_endpoint_parses_file() {
        let tmp = std::env::temp_dir().join(format!("jan-pi-ws-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("DevToolsActivePort"),
            "9222\n/devtools/browser/abc-123\n",
        )
        .unwrap();
        assert_eq!(
            read_devtools_ws_endpoint(&tmp).as_deref(),
            Some("ws://127.0.0.1:9222/devtools/browser/abc-123")
        );
        let _ = fs::remove_dir_all(&tmp);
    }
}
