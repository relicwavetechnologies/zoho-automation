use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const DIVO_RUNTIME_CONTEXT_FILE: &str = "divo-runtime-context.json";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DivoCapabilitySkill {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DivoCapabilityTool {
    pub tool_id: String,
    pub actions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DivoZohoConnectionHint {
    pub accessible_count: usize,
    pub connection_id: Option<String>,
    pub label: Option<String>,
    pub access: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DivoCapabilityBootstrap {
    pub version: u8,
    pub department_function: String,
    pub company_role: String,
    pub department_role: String,
    pub preferred_skills: Vec<DivoCapabilitySkill>,
    pub preferred_tools: Vec<DivoCapabilityTool>,
    pub routing_hints: Vec<String>,
    pub zoho_connection: Option<DivoZohoConnectionHint>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DivoRuntimeContext {
    pub department_id: Option<String>,
    pub department_name: Option<String>,
    pub persona_prompt: String,
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub departments: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_bootstrap: Option<DivoCapabilityBootstrap>,
}

pub fn runtime_context_path(agent_dir: &Path) -> PathBuf {
    agent_dir.join(DIVO_RUNTIME_CONTEXT_FILE)
}

pub fn write_runtime_context(path: &Path, context: &DivoRuntimeContext) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Divo runtime context path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let serialized = serde_json::to_vec_pretty(context).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".divo-runtime-context-{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, serialized).map_err(|e| e.to_string())?;

    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

pub fn clear_runtime_context(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_clears_runtime_context() {
        let dir = std::env::temp_dir().join(format!("jan-divo-runtime-context-{}", Uuid::new_v4()));
        let path = runtime_context_path(&dir);
        let context = DivoRuntimeContext {
            department_id: Some("dept-1".to_string()),
            department_name: Some("Finance".to_string()),
            persona_prompt: "Use verified records.".to_string(),
            version: Some("2026-07-11T00:00:00.000Z".to_string()),
            departments: vec!["Finance".to_string(), "Operations".to_string()],
            capability_bootstrap: Some(DivoCapabilityBootstrap {
                version: 1,
                department_function: "finance".to_string(),
                company_role: "MEMBER".to_string(),
                department_role: "FINANCE_MANAGER".to_string(),
                preferred_skills: vec![DivoCapabilitySkill {
                    id: "skill-finance".to_string(),
                    slug: "finance-ops-core".to_string(),
                    name: "Finance Ops Core".to_string(),
                    description: "Route broad finance questions.".to_string(),
                }],
                preferred_tools: vec![DivoCapabilityTool {
                    tool_id: "zohoBooks".to_string(),
                    actions: vec!["read".to_string()],
                }],
                routing_hints: vec!["Unpaid invoices use Zoho Books.".to_string()],
                zoho_connection: Some(DivoZohoConnectionHint {
                    accessible_count: 1,
                    connection_id: Some("connection-1".to_string()),
                    label: Some("Finance Books".to_string()),
                    access: Some("read_write".to_string()),
                }),
            }),
        };

        write_runtime_context(&path, &context).unwrap();
        let restored: DivoRuntimeContext =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(restored, context);

        clear_runtime_context(&path).unwrap();
        assert!(!path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn writes_member_department_names_without_a_selected_department() {
        let dir = std::env::temp_dir().join(format!("jan-divo-runtime-context-{}", Uuid::new_v4()));
        let path = runtime_context_path(&dir);
        let context = DivoRuntimeContext {
            department_id: None,
            department_name: None,
            persona_prompt: String::new(),
            version: None,
            departments: vec!["Finance".to_string(), "Operations".to_string()],
            capability_bootstrap: None,
        };

        write_runtime_context(&path, &context).unwrap();
        let restored: DivoRuntimeContext =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(restored, context);
        let serialized = String::from_utf8(fs::read(&path).unwrap()).unwrap();
        assert!(serialized.contains("\"departments\""));
        assert!(!serialized.contains("memory"));

        let _ = fs::remove_dir_all(dir);
    }
}
