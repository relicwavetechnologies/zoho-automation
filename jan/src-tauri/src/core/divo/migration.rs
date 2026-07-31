use std::{fs, io, path::Path};

use tauri::{AppHandle, Manager, Runtime};

use crate::core::app::constants::LEGACY_TAURI_BUNDLE_IDENTIFIER;

const DIVO_STORE_FILES: &[&str] = &["divo-session.json", "divo-settings.json"];

/// Copies Divo-owned stores from Jan's former bundle-data directory into the
/// new Divo bundle-data directory. Existing destination files always win and
/// legacy files are retained, making the migration safe to retry or roll back.
pub fn migrate_legacy_divo_stores<R: Runtime>(app: &AppHandle<R>) -> io::Result<()> {
    let Some(data_dir) = dirs::data_dir() else {
        return Ok(());
    };
    let source = data_dir.join(LEGACY_TAURI_BUNDLE_IDENTIFIER);
    let destination = app
        .path()
        .app_data_dir()
        .map_err(|error| io::Error::other(error.to_string()))?;
    copy_missing_store_files(&source, &destination)
}

fn copy_missing_store_files(source: &Path, destination: &Path) -> io::Result<()> {
    for file_name in DIVO_STORE_FILES {
        let source_file = source.join(file_name);
        let destination_file = destination.join(file_name);
        if !source_file.is_file() || destination_file.exists() {
            continue;
        }
        fs::create_dir_all(destination)?;
        fs::copy(&source_file, &destination_file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_only_missing_divo_stores_without_removing_legacy_data() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy");
        let destination = temp.path().join("divo");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("divo-session.json"), "legacy-session").unwrap();
        fs::write(source.join("divo-settings.json"), "legacy-settings").unwrap();
        fs::write(destination.join("divo-session.json"), "current-session").unwrap();

        copy_missing_store_files(&source, &destination).unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("divo-session.json")).unwrap(),
            "current-session"
        );
        assert_eq!(
            fs::read_to_string(destination.join("divo-settings.json")).unwrap(),
            "legacy-settings"
        );
        assert!(source.join("divo-session.json").exists());
        assert!(source.join("divo-settings.json").exists());
    }
}
