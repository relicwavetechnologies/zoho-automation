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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DivoCapabilityTool {
    pub tool_id: String,
    pub actions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DivoCapabilityFamily {
    pub family_id: String,
    pub display_name: String,
    pub connection_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_provider: Option<String>,
    pub skill_mode: String,
    #[serde(default)]
    pub tools: Vec<DivoCapabilityTool>,
    #[serde(default)]
    pub skills: Vec<DivoCapabilityFamilySkill>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DivoCapabilityFamilySkill {
    pub skill_id: String,
    pub name: String,
    pub mode: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_revision: Option<u64>,
    pub department_function: String,
    pub company_role: String,
    pub department_role: String,
    #[serde(default)]
    pub available_skills: Vec<DivoCapabilitySkill>,
    #[serde(default)]
    pub available_tools: Vec<DivoCapabilityTool>,
    #[serde(default)]
    pub families: Vec<DivoCapabilityFamily>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub personal_memory: Vec<String>,
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

pub fn read_runtime_context(path: &Path) -> Result<Option<DivoRuntimeContext>, String> {
    match fs::read(path) {
        Ok(serialized) => serde_json::from_slice(&serialized)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
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
            personal_memory: vec!["User prefers concise summaries.".to_string()],
            capability_bootstrap: Some(DivoCapabilityBootstrap {
                version: 3,
                registry_revision: Some(7),
                department_function: "finance".to_string(),
                company_role: "MEMBER".to_string(),
                department_role: "FINANCE_MANAGER".to_string(),
                available_skills: vec![],
                available_tools: vec![],
                families: vec![DivoCapabilityFamily {
                    family_id: "zoho".to_string(),
                    display_name: "Zoho".to_string(),
                    connection_mode: "member_selectable".to_string(),
                    connection_provider: Some("zoho".to_string()),
                    skill_mode: "optional".to_string(),
                    tools: vec![DivoCapabilityTool {
                        tool_id: "zohoBooks".to_string(),
                        actions: vec!["read".to_string()],
                        display_name: Some("Zoho Books".to_string()),
                        description: Some(
                            "Use Zoho Books for governed access to invoices.".to_string(),
                        ),
                    }],
                    skills: vec![],
                }],
                preferred_skills: vec![DivoCapabilitySkill {
                    id: "skill-finance".to_string(),
                    slug: "finance-ops-core".to_string(),
                    name: "Finance Ops Core".to_string(),
                    description: "Route broad finance questions.".to_string(),
                    revision: None,
                }],
                preferred_tools: vec![DivoCapabilityTool {
                    tool_id: "zohoBooks".to_string(),
                    actions: vec!["read".to_string()],
                    display_name: None,
                    description: None,
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
            personal_memory: vec![],
            capability_bootstrap: None,
        };

        write_runtime_context(&path, &context).unwrap();
        let restored: DivoRuntimeContext =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(restored, context);
        let serialized = String::from_utf8(fs::read(&path).unwrap()).unwrap();
        assert!(serialized.contains("\"departments\""));
        assert!(!serialized.contains("personalMemory"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn preserves_legacy_capability_bootstrap_payloads() {
        for version in [1, 2] {
            let payload = serde_json::json!({
                "version": version,
                "departmentFunction": "finance",
                "companyRole": "MEMBER",
                "departmentRole": "FINANCE_MANAGER",
                "preferredSkills": [],
                "preferredTools": [],
                "routingHints": []
            });
            let parsed: DivoCapabilityBootstrap = serde_json::from_value(payload).unwrap();
            assert_eq!(parsed.version, version);
            assert!(parsed.available_skills.is_empty());
            assert!(parsed.available_tools.is_empty());
            assert!(parsed.families.is_empty());

            let restored: DivoCapabilityBootstrap =
                serde_json::from_value(serde_json::to_value(&parsed).unwrap()).unwrap();
            assert_eq!(restored, parsed);
        }
    }
}
