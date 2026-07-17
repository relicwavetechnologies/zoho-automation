use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::core::divo::runtime_context::DIVO_RUNTIME_CONTEXT_FILE;
use crate::core::divo::workspace::DivoWorkspaceRunLayout;

/// Divo gateway config forwarded to bundled Pi (desktop-managed; never from prompts).
pub const DIVO_GATEWAY_ENV_VARS: &[&str] = &[
    "DIVO_BACKEND_URL",
    "DIVO_MEMBER_TOKEN",
    "DIVO_DEPARTMENT_ID",
    "DIVO_RUNTIME_CONTEXT_PATH",
];

const DIVO_PROCESS_ONLY_ENV_VARS: &[&str] = &[
    "DIVO_RUN_CONTEXT_PATH",
    "DIVO_SKILL_DIRS",
    "DIVO_WORKSPACE_DIR",
    "DIVO_INTERNAL_DIR",
    "DIVO_RUN_ID",
    "DIVO_RUN_DIR",
    "DIVO_SCRATCH_DIR",
    "DIVO_SCRIPTS_DIR",
    "DIVO_ARTIFACTS_DIR",
    "DIVO_LOGS_DIR",
];

const DIVO_RUNTIME_CONTEXT_PATH_ENV: &str = "DIVO_RUNTIME_CONTEXT_PATH";

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

    // The desktop owns this file path. Do not allow inherited shell or .env
    // values to redirect Pi to an untrusted prompt source.
    cmd.env(
        DIVO_RUNTIME_CONTEXT_PATH_ENV,
        agent_dir.join(DIVO_RUNTIME_CONTEXT_FILE),
    );
}

/// A coding-mode Pi process must not inherit the company session or Divo-only
/// process context from the desktop environment.
pub fn remove_divo_process_env(cmd: &mut Command) {
    for key in DIVO_GATEWAY_ENV_VARS
        .iter()
        .chain(DIVO_PROCESS_ONLY_ENV_VARS.iter())
    {
        cmd.env_remove(key);
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

pub fn apply_divo_skill_env(cmd: &mut Command, skill_dirs: &[PathBuf]) {
    if let Ok(joined) = std::env::join_paths(skill_dirs) {
        cmd.env("DIVO_SKILL_DIRS", joined);
    }
}

/// Write `pi-agent/divo.env` from desktop session fields (called after login).
pub fn write_divo_env_file(
    agent_dir: &Path,
    backend_url: &str,
    member_token: &str,
    department_id: Option<&str>,
    runtime_context_path: &Path,
) -> Result<(), String> {
    fs::create_dir_all(agent_dir).map_err(|e| e.to_string())?;
    let backend_url = clean_env_value("DIVO_BACKEND_URL", backend_url)?
        .trim_end_matches('/')
        .to_string();
    let member_token = clean_env_value("DIVO_MEMBER_TOKEN", member_token)?;
    let runtime_context_path = clean_env_value(
        "DIVO_RUNTIME_CONTEXT_PATH",
        &runtime_context_path.to_string_lossy(),
    )?;
    let mut lines = vec![
        format!("DIVO_BACKEND_URL={backend_url}"),
        format!("DIVO_MEMBER_TOKEN={member_token}"),
        format!("DIVO_RUNTIME_CONTEXT_PATH={runtime_context_path}"),
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

/// Apply direct-provider credentials to a Coding-mode child process.
/// Precedence: process env > `jan/.env` > coding provider.env > legacy provider.env.
/// The legacy file is read-only compatibility input; Divo credentials are never read here.
pub fn apply_coding_provider_env(
    cmd: &mut Command,
    coding_agent_dir: &Path,
    legacy_agent_dir: &Path,
) {
    let jan_env = resolve_jan_dotenv();
    apply_coding_provider_env_from_sources(
        cmd,
        coding_agent_dir,
        legacy_agent_dir,
        jan_env.as_deref(),
        |key| std::env::var(key).ok(),
    );
}

fn apply_coding_provider_env_from_sources<F>(
    cmd: &mut Command,
    coding_agent_dir: &Path,
    legacy_agent_dir: &Path,
    jan_env: Option<&Path>,
    mut process_env: F,
) where
    F: FnMut(&str) -> Option<String>,
{
    let mut from_files = HashMap::new();
    merge_env_file_keys(
        &mut from_files,
        &legacy_agent_dir.join("provider.env"),
        PI_PROVIDER_ENV_VARS,
    );
    merge_env_file_keys(
        &mut from_files,
        &coding_agent_dir.join("provider.env"),
        PI_PROVIDER_ENV_VARS,
    );
    if let Some(jan_env) = jan_env {
        merge_env_file_keys(&mut from_files, jan_env, PI_PROVIDER_ENV_VARS);
    }

    for key in PI_PROVIDER_ENV_VARS {
        if let Some(val) = process_env(key) {
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

/// Company mode authenticates its vetted provider through DIVO_MEMBER_TOKEN;
/// unrelated direct-provider secrets are not part of that process profile.
pub fn remove_provider_env(cmd: &mut Command) {
    for key in PI_PROVIDER_ENV_VARS {
        cmd.env_remove(key);
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
            &agent_dir.join("divo-runtime-context.json"),
        )
        .unwrap();

        let raw = fs::read_to_string(agent_dir.join("divo.env")).unwrap();
        assert!(raw.contains("DIVO_BACKEND_URL=http://localhost:3000"));
        assert!(raw.contains("DIVO_MEMBER_TOKEN=jwt-abc"));
        assert!(raw.contains("DIVO_DEPARTMENT_ID=dept-1"));
        assert!(raw.contains("DIVO_RUNTIME_CONTEXT_PATH="));

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
            &agent_dir.join("divo-runtime-context.json"),
        )
        .unwrap_err();

        assert!(err.contains("DIVO_MEMBER_TOKEN"));
        assert!(!agent_dir.join("divo.env").exists());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn apply_divo_gateway_env_pins_runtime_context_to_agent_dir() {
        let agent_dir = PathBuf::from("/tmp/divo-agent");
        let mut cmd = Command::new("env");
        apply_divo_gateway_env(&mut cmd, &agent_dir);

        let value = cmd
            .get_envs()
            .find_map(|(key, value)| {
                (key == DIVO_RUNTIME_CONTEXT_PATH_ENV).then_some(value.unwrap())
            })
            .unwrap();
        let expected = agent_dir.join(DIVO_RUNTIME_CONTEXT_FILE);
        assert_eq!(value, expected.as_os_str());
    }

    #[test]
    fn coding_mode_removes_every_divo_token_and_process_context_variable() {
        let mut cmd = Command::new("env");
        remove_divo_process_env(&mut cmd);

        let removed = cmd
            .get_envs()
            .filter_map(|(key, value)| value.is_none().then(|| key.to_string_lossy().into_owned()))
            .collect::<std::collections::HashSet<_>>();
        assert!(removed.contains("DIVO_MEMBER_TOKEN"));
        assert!(removed.contains("DIVO_BACKEND_URL"));
        assert!(removed.contains("DIVO_RUNTIME_CONTEXT_PATH"));
        assert!(removed.contains("DIVO_RUN_CONTEXT_PATH"));
        assert!(removed.contains("DIVO_SKILL_DIRS"));
    }

    #[test]
    fn company_mode_removes_unrelated_direct_provider_secrets() {
        let mut cmd = Command::new("env");
        remove_provider_env(&mut cmd);

        let removed = cmd
            .get_envs()
            .filter_map(|(key, value)| value.is_none().then(|| key.to_string_lossy().into_owned()))
            .collect::<std::collections::HashSet<_>>();
        assert!(removed.contains("DEEPSEEK_API_KEY"));
        assert!(removed.contains("OPENAI_API_KEY"));
        assert!(removed.contains("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn coding_provider_env_uses_legacy_as_read_only_lowest_precedence_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let coding_agent_dir = tmp.path().join("pi-agent-coding");
        let legacy_agent_dir = tmp.path().join("pi-agent");
        let jan_env = tmp.path().join("jan.env");
        fs::create_dir_all(&coding_agent_dir).unwrap();
        fs::create_dir_all(&legacy_agent_dir).unwrap();

        let legacy_provider = "MISTRAL_API_KEY=legacy-only\nOPENAI_API_KEY=legacy-openai\nANTHROPIC_API_KEY=legacy-anthropic\nDEEPSEEK_API_KEY=legacy-deepseek\n";
        let coding_provider =
            "OPENAI_API_KEY=coding-openai\nANTHROPIC_API_KEY=coding-anthropic\nDEEPSEEK_API_KEY=coding-deepseek\n";
        fs::write(legacy_agent_dir.join("provider.env"), legacy_provider).unwrap();
        fs::write(coding_agent_dir.join("provider.env"), coding_provider).unwrap();
        fs::write(
            &jan_env,
            "ANTHROPIC_API_KEY=jan-anthropic\nDEEPSEEK_API_KEY=jan-deepseek\n",
        )
        .unwrap();
        fs::write(
            legacy_agent_dir.join("divo.env"),
            "DIVO_MEMBER_TOKEN=legacy-divo-token\n",
        )
        .unwrap();
        fs::write(
            coding_agent_dir.join("divo.env"),
            "DIVO_MEMBER_TOKEN=coding-divo-token\n",
        )
        .unwrap();

        let mut cmd = Command::new("env");
        remove_divo_process_env(&mut cmd);
        apply_coding_provider_env_from_sources(
            &mut cmd,
            &coding_agent_dir,
            &legacy_agent_dir,
            Some(&jan_env),
            |key| (key == "DEEPSEEK_API_KEY").then(|| "process-deepseek".to_string()),
        );

        let configured = cmd
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<HashMap<_, _>>();
        assert_eq!(
            configured.get("MISTRAL_API_KEY"),
            Some(&Some("legacy-only".to_string()))
        );
        assert_eq!(
            configured.get("OPENAI_API_KEY"),
            Some(&Some("coding-openai".to_string()))
        );
        assert_eq!(
            configured.get("ANTHROPIC_API_KEY"),
            Some(&Some("jan-anthropic".to_string()))
        );
        assert_eq!(
            configured.get("DEEPSEEK_API_KEY"),
            Some(&Some("process-deepseek".to_string()))
        );
        assert_eq!(configured.get("DIVO_MEMBER_TOKEN"), Some(&None));
        assert_eq!(
            fs::read_to_string(legacy_agent_dir.join("provider.env")).unwrap(),
            legacy_provider
        );
        assert_eq!(
            fs::read_to_string(coding_agent_dir.join("provider.env")).unwrap(),
            coding_provider
        );
    }
}
