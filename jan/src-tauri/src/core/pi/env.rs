use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::core::divo::local_lark::resolve_lark_cli_home;
use crate::core::divo::workspace::DivoWorkspaceRunLayout;

/// Divo gateway config forwarded to bundled Pi (desktop-managed; never from prompts).
pub const DIVO_GATEWAY_ENV_VARS: &[&str] = &[
    "DIVO_BACKEND_URL",
    "DIVO_MEMBER_TOKEN",
    "DIVO_DEPARTMENT_ID",
];

/// Pi provider API keys — see pi-coding-agent/docs/providers.md.
/// Jan does not map its own provider keys; only these env vars are forwarded.
pub const PI_PROVIDER_ENV_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANT_LING_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "NVIDIA_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_GATEWAY_ID",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "ZAI_API_KEY",
    "ZAI_CODING_CN_API_KEY",
    "OPENCODE_API_KEY",
    "HF_TOKEN",
    "FIREWORKS_API_KEY",
    "TOGETHER_API_KEY",
    "KIMI_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CN_API_KEY",
    "XIAOMI_API_KEY",
    "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
];

fn merge_gateway_env_from_files(into: &mut HashMap<String, String>, agent_dir: &Path) {
    if let Some(jan_env) = resolve_jan_dotenv() {
        merge_env_file_keys(into, &jan_env, DIVO_GATEWAY_ENV_VARS);
    }
    merge_env_file_keys(into, &agent_dir.join("divo.env"), DIVO_GATEWAY_ENV_VARS);
}

/// Apply Divo gateway credentials to a child Pi process.
/// Precedence: existing process env > `jan/.env` (dev) > `pi-agent/divo.env`.
pub fn apply_divo_gateway_env(cmd: &mut Command, agent_dir: &Path) {
    let mut from_files = HashMap::new();
    merge_gateway_env_from_files(&mut from_files, agent_dir);

    for key in DIVO_GATEWAY_ENV_VARS {
        if let Ok(val) = std::env::var(key) {
            if !val.trim().is_empty() {
                cmd.env(key, val);
                continue;
            }
        }
        if let Some(val) = from_files.get(*key) {
            if !val.trim().is_empty() {
                cmd.env(key, val);
            }
        }
    }
}

pub fn apply_divo_workspace_env(
    cmd: &mut Command,
    workspace_dir: &Path,
    layout: &DivoWorkspaceRunLayout,
) {
    // These paths are guidance for scratch placement, not permission inputs.
    cmd.env("DIVO_WORKSPACE_DIR", workspace_dir)
        .env("DIVO_INTERNAL_DIR", &layout.divo_dir)
        .env("DIVO_RUN_ID", &layout.run_id)
        .env("DIVO_RUN_DIR", &layout.run_dir)
        .env("DIVO_SCRATCH_DIR", &layout.tmp_dir)
        .env("DIVO_SCRIPTS_DIR", &layout.scripts_dir)
        .env("DIVO_ARTIFACTS_DIR", &layout.artifacts_dir)
        .env("DIVO_LOGS_DIR", &layout.logs_dir);
}

pub fn apply_local_lark_env(cmd: &mut Command, wrapper_path: Option<&Path>) {
    let Some(wrapper_path) = wrapper_path else {
        return;
    };
    cmd.env("DIVO_LARK_CLI", wrapper_path);
    if let Ok(home_path) = resolve_lark_cli_home() {
        cmd.env("DIVO_LARK_CLI_HOME", home_path);
    }
    if let Some(bin_dir) = wrapper_path.parent() {
        prepend_path(cmd, bin_dir);
    }
}

fn prepend_path(cmd: &mut Command, bin_dir: &Path) {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![bin_dir.to_path_buf()];
    paths.extend(std::env::split_paths(&current));
    if let Ok(joined) = std::env::join_paths(paths) {
        cmd.env("PATH", joined);
    }
}

/// Write `pi-agent/divo.env` from desktop session fields (called after login).
pub fn write_divo_env_file(
    agent_dir: &Path,
    backend_url: &str,
    member_token: &str,
    department_id: Option<&str>,
) -> Result<(), String> {
    fs::create_dir_all(agent_dir).map_err(|e| e.to_string())?;
    let backend_url = clean_env_value("DIVO_BACKEND_URL", backend_url)?
        .trim_end_matches('/')
        .to_string();
    let member_token = clean_env_value("DIVO_MEMBER_TOKEN", member_token)?;
    let mut lines = vec![
        format!("DIVO_BACKEND_URL={backend_url}"),
        format!("DIVO_MEMBER_TOKEN={member_token}"),
    ];
    if let Some(dept) = department_id {
        let trimmed = clean_env_value("DIVO_DEPARTMENT_ID", dept)?;
        if !trimmed.is_empty() {
            lines.push(format!("DIVO_DEPARTMENT_ID={trimmed}"));
        }
    }
    fs::write(agent_dir.join("divo.env"), lines.join("\n") + "\n").map_err(|e| e.to_string())
}

fn clean_env_value(key: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.contains('\n') || trimmed.contains('\r') {
        return Err(format!("{key} must be a single-line value"));
    }
    Ok(trimmed.to_string())
}

/// Apply Pi provider credentials to a child process.
/// Precedence: existing process env > `jan/.env` (dev) > `pi-agent/provider.env`.
pub fn apply_provider_env(cmd: &mut Command, agent_dir: &Path) {
    let mut from_files = HashMap::new();
    if let Some(jan_env) = resolve_jan_dotenv() {
        merge_env_file_keys(&mut from_files, &jan_env, PI_PROVIDER_ENV_VARS);
    }
    merge_env_file_keys(
        &mut from_files,
        &agent_dir.join("provider.env"),
        PI_PROVIDER_ENV_VARS,
    );

    for key in PI_PROVIDER_ENV_VARS {
        if let Ok(val) = std::env::var(key) {
            if !val.trim().is_empty() {
                cmd.env(key, val);
                continue;
            }
        }
        if let Some(val) = from_files.get(*key) {
            if !val.trim().is_empty() {
                cmd.env(key, val);
            }
        }
    }
}

fn resolve_jan_dotenv() -> Option<PathBuf> {
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let candidate = PathBuf::from(manifest).parent()?.join(".env");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn merge_env_file_keys(into: &mut HashMap<String, String>, path: &Path, allowed_keys: &[&str]) {
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || !allowed_keys.contains(&key) {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if !value.is_empty() {
            into.insert(key.to_string(), value.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_env_file_parses_deepseek_key() {
        let tmp = std::env::temp_dir().join(format!("jan-pi-env-test-{}", std::process::id()));
        let env_path = tmp.join("provider.env");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            &env_path,
            "# comment\nDEEPSEEK_API_KEY=sk-test\nIGNORED=1\n",
        )
        .unwrap();

        let mut map = HashMap::new();
        merge_env_file_keys(&mut map, &env_path, PI_PROVIDER_ENV_VARS);
        assert_eq!(
            map.get("DEEPSEEK_API_KEY").map(String::as_str),
            Some("sk-test")
        );
        assert!(!map.contains_key("IGNORED"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_divo_env_file_writes_gateway_vars() {
        let tmp = std::env::temp_dir().join(format!("jan-divo-env-test-{}", std::process::id()));
        let agent_dir = tmp.join("pi-agent");
        let _ = fs::remove_dir_all(&tmp);

        write_divo_env_file(
            &agent_dir,
            "http://localhost:3000/",
            "jwt-abc",
            Some("dept-1"),
        )
        .unwrap();

        let raw = fs::read_to_string(agent_dir.join("divo.env")).unwrap();
        assert!(raw.contains("DIVO_BACKEND_URL=http://localhost:3000"));
        assert!(raw.contains("DIVO_MEMBER_TOKEN=jwt-abc"));
        assert!(raw.contains("DIVO_DEPARTMENT_ID=dept-1"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_divo_env_file_rejects_multiline_values() {
        let tmp = std::env::temp_dir().join(format!(
            "jan-divo-env-multiline-test-{}",
            std::process::id()
        ));
        let agent_dir = tmp.join("pi-agent");
        let _ = fs::remove_dir_all(&tmp);

        let err = write_divo_env_file(
            &agent_dir,
            "http://localhost:3000",
            "jwt-abc\nDIVO_BACKEND_URL=http://evil",
            None,
        )
        .unwrap_err();

        assert!(err.contains("DIVO_MEMBER_TOKEN"));
        assert!(!agent_dir.join("divo.env").exists());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn prepend_path_adds_local_tools_first() {
        let mut cmd = Command::new("env");
        let bin_dir = PathBuf::from("/tmp/divo-local-tools");
        prepend_path(&mut cmd, &bin_dir);

        let path = cmd
            .get_envs()
            .find_map(|(key, value)| (key == "PATH").then_some(value.unwrap()))
            .unwrap();
        let first = std::env::split_paths(path).next().unwrap();
        assert_eq!(first, bin_dir);
    }
}
