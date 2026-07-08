use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::core::threads::utils::get_pi_session_path;

/// Resolve the on-disk Pi session file for a Jan thread.
///
/// Pi agent memory is co-located with thread data at
/// `threads/{thread_id}/pi-session.jsonl`, alongside `messages.jsonl`.
pub fn resolve_session_path(data_folder: &Path, thread_id: &str) -> PathBuf {
    get_pi_session_path(data_folder, thread_id)
}

pub fn read_session_workspace_cwd(session_path: &Path) -> Result<Option<PathBuf>, String> {
    if !session_path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(session_path).map_err(|e| e.to_string())?;
    let Some(first_line) = raw.lines().next() else {
        return Ok(None);
    };

    let header: serde_json::Value = match serde_json::from_str(first_line) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if header.get("type").and_then(|v| v.as_str()) != Some("session") {
        return Ok(None);
    }

    let Some(cwd) = header.get("cwd").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    Ok(Some(PathBuf::from(trimmed)))
}

/// Keep existing Pi sessions pinned to the Jan-selected workspace.
///
/// Pi stores cwd in the first JSONL session header. Without this repair, an old
/// thread can pull Pi back to whatever cwd the desktop process used previously.
pub fn ensure_session_workspace_cwd(
    session_path: &Path,
    workspace_dir: &Path,
) -> Result<(), String> {
    if !session_path.exists() {
        return Ok(());
    }

    let raw = fs::read_to_string(session_path).map_err(|e| e.to_string())?;
    let Some(first_line) = raw.lines().next() else {
        return Ok(());
    };

    let mut header: serde_json::Value = match serde_json::from_str(first_line) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    if header.get("type").and_then(|v| v.as_str()) != Some("session") {
        return Ok(());
    }

    let workspace = workspace_dir.to_string_lossy().to_string();
    if header.get("cwd").and_then(|v| v.as_str()) == Some(workspace.as_str()) {
        return Ok(());
    }

    let Some(obj) = header.as_object_mut() else {
        return Ok(());
    };
    obj.insert("cwd".to_string(), serde_json::Value::String(workspace));

    let remainder = raw.find('\n').map(|idx| &raw[idx + 1..]).unwrap_or("");
    let mut next = serde_json::to_string(&header).map_err(|e| e.to_string())?;
    next.push('\n');
    next.push_str(remainder);
    fs::write(session_path, next).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn resolve_session_path_matches_thread_layout() {
        let base = PathBuf::from("/tmp/jandata");
        let path = resolve_session_path(&base, "thread-1");
        assert!(path.ends_with("threads/thread-1/pi-session.jsonl"));
    }

    #[test]
    fn ensure_session_workspace_cwd_updates_session_header_only() {
        let dir = std::env::temp_dir().join(format!("jan-pi-session-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let session_path = dir.join("pi-session.jsonl");
        fs::write(
            &session_path,
            "{\"type\":\"session\",\"id\":\"s1\",\"cwd\":\"/old\"}\n{\"type\":\"message\"}\n",
        )
        .unwrap();

        ensure_session_workspace_cwd(&session_path, Path::new("/new/workspace")).unwrap();

        let updated = fs::read_to_string(&session_path).unwrap();
        let mut lines = updated.lines();
        let header: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(
            header.get("cwd").and_then(|v| v.as_str()),
            Some("/new/workspace")
        );
        assert_eq!(lines.next(), Some("{\"type\":\"message\"}"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_session_workspace_cwd_reads_session_header() {
        let dir =
            std::env::temp_dir().join(format!("jan-pi-session-cwd-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let session_path = dir.join("pi-session.jsonl");
        fs::write(
            &session_path,
            "{\"type\":\"session\",\"id\":\"s1\",\"cwd\":\"/workspace\"}\n{\"type\":\"message\"}\n",
        )
        .unwrap();

        let cwd = read_session_workspace_cwd(&session_path).unwrap();
        assert_eq!(cwd.as_deref(), Some(Path::new("/workspace")));

        let _ = fs::remove_dir_all(&dir);
    }
}
