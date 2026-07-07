use std::path::{Path, PathBuf};

use crate::core::threads::utils::get_pi_session_path;

/// Resolve the on-disk Pi session file for a Jan thread.
///
/// Pi agent memory is co-located with thread data at
/// `threads/{thread_id}/pi-session.jsonl`, alongside `messages.jsonl`.
pub fn resolve_session_path(data_folder: &Path, thread_id: &str) -> PathBuf {
    get_pi_session_path(data_folder, thread_id)
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
}
