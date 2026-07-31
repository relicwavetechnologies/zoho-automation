use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const DIVO_RUN_CONTEXT_PATH_ENV: &str = "DIVO_RUN_CONTEXT_PATH";

/// Desktop-owned provenance for a single prompt accepted by a reusable Pi
/// runtime. Extensions capture this before asking the desktop to render a
/// Divo UI request. It is deliberately separate from the member/persona
/// runtime context shared by all Pi processes.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DivoRunContext {
    pub version: u8,
    pub thread_id: String,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teach_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub department_id: Option<String>,
}

pub fn slot_run_context_path(scratch_dir: &Path, slot_id: &str) -> PathBuf {
    scratch_dir
        .join("divo-run-context")
        .join(format!("{slot_id}.json"))
}

/// Writes to a fresh file before renaming it into place. Callers clear the
/// previous context at a terminal boundary, so the rename never exposes a
/// partially written owner to the persistent child process.
pub fn write_run_context(path: &Path, context: &DivoRunContext) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Divo run context path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".divo-run-context-{}.tmp", Uuid::new_v4()));
    let encoded = serde_json::to_vec(context).map_err(|error| error.to_string())?;
    fs::write(&temporary, encoded).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

pub fn clear_run_context(path: &Path) -> Result<(), String> {
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
    fn run_context_lifecycle_is_isolated_by_slot_and_rotates_by_run() {
        let root = std::env::temp_dir().join(format!("jan-divo-run-context-{}", Uuid::new_v4()));
        let first = slot_run_context_path(&root, "slot-a");
        let second = slot_run_context_path(&root, "slot-b");
        let run_a1 = DivoRunContext {
            version: 1,
            thread_id: "thread-a".into(),
            run_id: "run-a1".into(),
            profile: None,
            teach_session_id: None,
            department_id: None,
        };
        let run_a2 = DivoRunContext {
            version: 1,
            thread_id: "thread-a".into(),
            run_id: "run-a2".into(),
            profile: None,
            teach_session_id: None,
            department_id: None,
        };
        let run_b = DivoRunContext {
            version: 1,
            thread_id: "thread-b".into(),
            run_id: "run-b".into(),
            profile: None,
            teach_session_id: None,
            department_id: None,
        };

        write_run_context(&first, &run_a1).unwrap();
        write_run_context(&second, &run_b).unwrap();
        clear_run_context(&first).unwrap();
        assert!(!first.exists());
        assert_eq!(
            serde_json::from_slice::<DivoRunContext>(&fs::read(&second).unwrap()).unwrap(),
            run_b
        );

        write_run_context(&first, &run_a2).unwrap();
        assert_eq!(
            serde_json::from_slice::<DivoRunContext>(&fs::read(&first).unwrap()).unwrap(),
            run_a2
        );
        clear_run_context(&first).unwrap();
        clear_run_context(&second).unwrap();
        let _ = fs::remove_dir_all(root);
    }
}
