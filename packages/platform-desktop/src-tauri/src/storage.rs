//! Vault blobs and metadata on the native filesystem.
//!
//! Simpler than the extension's chrome.storage backend, and stronger: writes are a real
//! temp-plus-rename, so a crash mid-write leaves the previous bytes intact rather than a
//! torn value. The `.bak` snapshot is still taken before every overwrite, because the
//! failure `readVaultBackup` exists for (issue #27) is not a torn write.
//!
//! Layout under the app data dir:
//!   vaults/<vaultId>.vlt   the encrypted vault
//!   vaults/<vaultId>.bak   the previous good bytes
//!   meta.json              unencrypted metadata (settings, sync ids, ...)
//!
//! Everything below is split in two: an `ops` layer parameterised on the data dir, and
//! `#[tauri::command]` wrappers that do nothing but resolve that dir. The split exists so
//! the part that can lose a vault is testable without a running Tauri app.

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

type CmdResult<T> = Result<T, String>;

/// Filesystem layer. Takes the data dir rather than an `AppHandle` so it can be driven
/// against a temp dir from tests; see the `tests` module at the foot of this file.
mod ops {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::Mutex,
    };

    use serde_json::{Map, Value};

    use super::CmdResult;

    /// Resolves an omitted vault id. Multi-vault gets a real registry later; today every
    /// caller that omits the id means "the one vault". See docs/multiple-vaults.md.
    const DEFAULT_VAULT_ID: &str = "default";

    /// Serializes meta.json read-modify-write so two concurrent setMeta calls can't lose one.
    static META_LOCK: Mutex<()> = Mutex::new(());

    fn io<T>(r: std::io::Result<T>, what: &str) -> CmdResult<T> {
        r.map_err(|e| format!("{what}: {e}"))
    }

    fn vaults_dir(root: &Path) -> CmdResult<PathBuf> {
        let dir = root.join("vaults");
        io(fs::create_dir_all(&dir), "create vaults dir")?;
        Ok(dir)
    }

    /// Reject anything that could escape the vaults dir; ids reach here from the webview.
    pub fn vault_paths(root: &Path, vault_id: Option<&str>) -> CmdResult<(PathBuf, PathBuf)> {
        let id = vault_id.unwrap_or(DEFAULT_VAULT_ID);
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(format!("invalid vault id: {id}"));
        }
        let dir = vaults_dir(root)?;
        Ok((dir.join(format!("{id}.vlt")), dir.join(format!("{id}.bak"))))
    }

    /// Write via a sibling temp file and rename, so the destination is never partially written.
    fn write_atomic(path: &Path, bytes: &[u8]) -> CmdResult<()> {
        let tmp = path.with_extension("tmp");
        io(fs::write(&tmp, bytes), "write temp")?;
        io(fs::rename(&tmp, path), "rename temp")
    }

    pub fn has_vault(root: &Path, vault_id: Option<&str>) -> CmdResult<bool> {
        // Omitted id asks whether ANY vault exists, which is what the unlock screen branches on.
        if vault_id.is_none() {
            let dir = vaults_dir(root)?;
            let any = io(fs::read_dir(&dir), "read vaults dir")?
                .filter_map(Result::ok)
                .any(|e| e.path().extension().is_some_and(|x| x == "vlt"));
            return Ok(any);
        }
        Ok(vault_paths(root, vault_id)?.0.exists())
    }

    pub fn read_vault(root: &Path, vault_id: Option<&str>) -> CmdResult<Vec<u8>> {
        let (blob, _) = vault_paths(root, vault_id)?;
        io(fs::read(&blob), "read vault")
    }

    pub fn write_vault(root: &Path, blob: &[u8], vault_id: Option<&str>) -> CmdResult<()> {
        let (path, backup) = vault_paths(root, vault_id)?;
        // Snapshot the previous good bytes first; the contract is that a crash mid-write
        // still leaves something recoverable.
        if path.exists() {
            let previous = io(fs::read(&path), "read vault for snapshot")?;
            write_atomic(&backup, &previous)?;
        }
        write_atomic(&path, blob)
    }

    pub fn read_vault_backup(root: &Path, vault_id: Option<&str>) -> CmdResult<Option<Vec<u8>>> {
        let (_, backup) = vault_paths(root, vault_id)?;
        if !backup.exists() {
            return Ok(None);
        }
        io(fs::read(&backup), "read vault backup").map(Some)
    }

    pub fn restore_vault_backup(root: &Path, vault_id: Option<&str>) -> CmdResult<bool> {
        let (path, backup) = vault_paths(root, vault_id)?;
        if !backup.exists() {
            return Ok(false);
        }
        let bytes = io(fs::read(&backup), "read vault backup")?;
        // Deliberately no fresh snapshot: the caller is recovering, and overwriting the
        // backup with the bad live bytes would destroy the only good copy.
        write_atomic(&path, &bytes)?;
        Ok(true)
    }

    pub fn delete_vault(root: &Path, vault_id: &str) -> CmdResult<()> {
        let (path, backup) = vault_paths(root, Some(vault_id))?;
        for p in [path, backup] {
            if p.exists() {
                io(fs::remove_file(&p), "delete vault file")?;
            }
        }
        Ok(())
    }

    // ---- metadata ----

    fn meta_path(root: &Path) -> PathBuf {
        root.join("meta.json")
    }

    fn read_meta(root: &Path) -> CmdResult<Map<String, Value>> {
        let path = meta_path(root);
        if !path.exists() {
            return Ok(Map::new());
        }
        let raw = io(fs::read(&path), "read meta")?;
        match serde_json::from_slice::<Value>(&raw) {
            Ok(Value::Object(m)) => Ok(m),
            // A corrupt meta.json must not brick the app; it holds settings, never vault data.
            _ => Ok(Map::new()),
        }
    }

    fn write_meta(root: &Path, meta: Map<String, Value>) -> CmdResult<()> {
        let bytes =
            serde_json::to_vec(&Value::Object(meta)).map_err(|e| format!("encode meta: {e}"))?;
        write_atomic(&meta_path(root), &bytes)
    }

    pub fn get_meta(root: &Path, key: &str) -> CmdResult<Option<Value>> {
        Ok(read_meta(root)?.get(key).cloned())
    }

    pub fn set_meta(root: &Path, key: String, value: Value) -> CmdResult<()> {
        let _guard = META_LOCK
            .lock()
            .map_err(|_| "meta lock poisoned".to_string())?;
        let mut meta = read_meta(root)?;
        meta.insert(key, value);
        write_meta(root, meta)
    }

    pub fn remove_meta(root: &Path, key: &str) -> CmdResult<()> {
        let _guard = META_LOCK
            .lock()
            .map_err(|_| "meta lock poisoned".to_string())?;
        let mut meta = read_meta(root)?;
        meta.remove(key);
        write_meta(root, meta)
    }

    pub fn export_bytes(path: &Path, bytes: &[u8]) -> CmdResult<()> {
        io(fs::write(path, bytes), "export bytes")
    }
}

// ---- Tauri commands: resolve the data dir, then defer to `ops` ----

pub(crate) fn data_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    Ok(dir)
}

#[tauri::command]
pub fn storage_has_vault(app: AppHandle, vault_id: Option<String>) -> CmdResult<bool> {
    ops::has_vault(&data_dir(&app)?, vault_id.as_deref())
}

#[tauri::command]
pub fn storage_read_vault(app: AppHandle, vault_id: Option<String>) -> CmdResult<Vec<u8>> {
    ops::read_vault(&data_dir(&app)?, vault_id.as_deref())
}

#[tauri::command]
pub fn storage_write_vault(
    app: AppHandle,
    blob: Vec<u8>,
    vault_id: Option<String>,
) -> CmdResult<()> {
    ops::write_vault(&data_dir(&app)?, &blob, vault_id.as_deref())
}

#[tauri::command]
pub fn storage_read_vault_backup(
    app: AppHandle,
    vault_id: Option<String>,
) -> CmdResult<Option<Vec<u8>>> {
    ops::read_vault_backup(&data_dir(&app)?, vault_id.as_deref())
}

#[tauri::command]
pub fn storage_restore_vault_backup(app: AppHandle, vault_id: Option<String>) -> CmdResult<bool> {
    ops::restore_vault_backup(&data_dir(&app)?, vault_id.as_deref())
}

#[tauri::command]
pub fn storage_delete_vault(app: AppHandle, vault_id: String) -> CmdResult<()> {
    ops::delete_vault(&data_dir(&app)?, &vault_id)
}

#[tauri::command]
pub fn storage_get_meta(app: AppHandle, key: String) -> CmdResult<Option<Value>> {
    ops::get_meta(&data_dir(&app)?, &key)
}

#[tauri::command]
pub fn storage_set_meta(app: AppHandle, key: String, value: Value) -> CmdResult<()> {
    ops::set_meta(&data_dir(&app)?, key, value)
}

#[tauri::command]
pub fn storage_remove_meta(app: AppHandle, key: String) -> CmdResult<()> {
    ops::remove_meta(&data_dir(&app)?, &key)
}

/// Write bytes the user chose a path for (vault export / backup). The path comes from the
/// dialog plugin, so it is user-selected rather than webview-chosen; writing here instead
/// of through the fs plugin keeps this crate free of a filesystem scope to widen later.
#[tauri::command]
pub fn shell_export_bytes(path: String, bytes: Vec<u8>) -> CmdResult<()> {
    ops::export_bytes(&PathBuf::from(path), &bytes)
}

#[cfg(test)]
mod tests {
    use super::ops;
    use serde_json::json;
    use std::{fs, path::Path};
    use tempfile::TempDir;

    fn root() -> TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    fn vlt(dir: &Path, id: &str) -> std::path::PathBuf {
        dir.join("vaults").join(format!("{id}.vlt"))
    }

    fn bak(dir: &Path, id: &str) -> std::path::PathBuf {
        dir.join("vaults").join(format!("{id}.bak"))
    }

    #[test]
    fn write_then_read_round_trips() {
        let d = root();
        ops::write_vault(d.path(), b"v1", None).unwrap();
        assert_eq!(ops::read_vault(d.path(), None).unwrap(), b"v1");
    }

    #[test]
    fn writing_into_a_fresh_dir_bootstraps_it() {
        let d = root();
        // Nothing exists yet: no vaults/ dir, no blob. The first write has to create both.
        assert!(!d.path().join("vaults").exists());
        ops::write_vault(d.path(), b"first", None).unwrap();
        assert!(vlt(d.path(), "default").exists());
    }

    #[test]
    fn overwriting_snapshots_the_previous_bytes() {
        let d = root();
        ops::write_vault(d.path(), b"v1", None).unwrap();
        ops::write_vault(d.path(), b"v2", None).unwrap();
        assert_eq!(ops::read_vault(d.path(), None).unwrap(), b"v2");
        assert_eq!(fs::read(bak(d.path(), "default")).unwrap(), b"v1");
    }

    #[test]
    fn the_first_write_leaves_no_backup() {
        let d = root();
        ops::write_vault(d.path(), b"v1", None).unwrap();
        // Nothing was overwritten, so there is nothing to recover to.
        assert!(!bak(d.path(), "default").exists());
        assert_eq!(ops::read_vault_backup(d.path(), None).unwrap(), None);
    }

    #[test]
    fn reading_the_backup_does_not_restore_it() {
        // Issue #27: the caller needs to inspect the snapshot and decide whether it is
        // actually better than what is live. Reading must not touch the live blob.
        let d = root();
        ops::write_vault(d.path(), b"v1", None).unwrap();
        ops::write_vault(d.path(), b"v2", None).unwrap();

        let snapshot = ops::read_vault_backup(d.path(), None).unwrap();

        assert_eq!(snapshot.as_deref(), Some(&b"v1"[..]));
        assert_eq!(ops::read_vault(d.path(), None).unwrap(), b"v2");
    }

    #[test]
    fn restoring_does_not_snapshot_over_the_good_copy() {
        // The whole point of issue #27. The live blob decodes fine but is sealed under a key
        // its slots do not wrap, so the user restores. If restore took a snapshot first the
        // way an ordinary write does, it would overwrite the only good copy with the bad
        // bytes, and a second restore would hand back the corruption.
        let d = root();
        ops::write_vault(d.path(), b"good", None).unwrap();
        ops::write_vault(d.path(), b"bad", None).unwrap();
        assert_eq!(fs::read(bak(d.path(), "default")).unwrap(), b"good");

        assert!(ops::restore_vault_backup(d.path(), None).unwrap());

        assert_eq!(ops::read_vault(d.path(), None).unwrap(), b"good");
        // Still the good bytes, so restoring twice is safe.
        assert_eq!(fs::read(bak(d.path(), "default")).unwrap(), b"good");
        assert!(ops::restore_vault_backup(d.path(), None).unwrap());
        assert_eq!(ops::read_vault(d.path(), None).unwrap(), b"good");
    }

    #[test]
    fn restoring_reports_false_when_there_is_nothing_to_restore() {
        let d = root();
        ops::write_vault(d.path(), b"only", None).unwrap();
        assert!(!ops::restore_vault_backup(d.path(), None).unwrap());
        // And leaves the live blob alone.
        assert_eq!(ops::read_vault(d.path(), None).unwrap(), b"only");
    }

    #[test]
    fn vaults_do_not_collide() {
        let d = root();
        ops::write_vault(d.path(), b"alpha", Some("a")).unwrap();
        ops::write_vault(d.path(), b"beta", Some("b")).unwrap();
        assert_eq!(ops::read_vault(d.path(), Some("a")).unwrap(), b"alpha");
        assert_eq!(ops::read_vault(d.path(), Some("b")).unwrap(), b"beta");
    }

    #[test]
    fn a_vaults_backup_is_its_own() {
        let d = root();
        ops::write_vault(d.path(), b"a1", Some("a")).unwrap();
        ops::write_vault(d.path(), b"a2", Some("a")).unwrap();
        ops::write_vault(d.path(), b"b1", Some("b")).unwrap();
        // b has never been overwritten, so it has no snapshot even though a does.
        assert_eq!(
            ops::read_vault_backup(d.path(), Some("a"))
                .unwrap()
                .as_deref(),
            Some(&b"a1"[..])
        );
        assert_eq!(ops::read_vault_backup(d.path(), Some("b")).unwrap(), None);
    }

    #[test]
    fn rejects_ids_that_would_escape_the_vaults_dir() {
        // Ids arrive from the webview, so this is the boundary check rather than a nicety.
        let d = root();
        for bad in [
            "..",
            "../evil",
            "a/b",
            "a\\b",
            "/etc/passwd",
            "",
            "a.b",
            "with space",
            "unicode\u{202e}",
        ] {
            let err = ops::vault_paths(d.path(), Some(bad));
            assert!(err.is_err(), "id {bad:?} should have been rejected");
        }
    }

    #[test]
    fn accepts_the_id_shapes_the_app_actually_mints() {
        let d = root();
        for ok in ["default", "vault-1", "vault_2", "AbC123"] {
            assert!(
                ops::vault_paths(d.path(), Some(ok)).is_ok(),
                "id {ok:?} should have been accepted"
            );
        }
    }

    #[test]
    fn has_vault_without_an_id_asks_whether_any_exists() {
        let d = root();
        assert!(!ops::has_vault(d.path(), None).unwrap());
        ops::write_vault(d.path(), b"x", Some("somethingelse")).unwrap();
        // Not the default id, but the unlock screen still needs to know a vault is present.
        assert!(ops::has_vault(d.path(), None).unwrap());
        assert!(!ops::has_vault(d.path(), Some("default")).unwrap());
    }

    #[test]
    fn a_lone_backup_does_not_count_as_a_vault() {
        let d = root();
        ops::write_vault(d.path(), b"v1", None).unwrap();
        ops::write_vault(d.path(), b"v2", None).unwrap();
        fs::remove_file(vlt(d.path(), "default")).unwrap();
        // The .bak is still there, but there is no vault to open.
        assert!(!ops::has_vault(d.path(), None).unwrap());
    }

    #[test]
    fn deleting_removes_the_blob_and_its_backup() {
        let d = root();
        ops::write_vault(d.path(), b"v1", Some("gone")).unwrap();
        ops::write_vault(d.path(), b"v2", Some("gone")).unwrap();
        assert!(bak(d.path(), "gone").exists());

        ops::delete_vault(d.path(), "gone").unwrap();

        assert!(!vlt(d.path(), "gone").exists());
        assert!(!bak(d.path(), "gone").exists());
    }

    #[test]
    fn deleting_a_vault_that_is_not_there_is_not_an_error() {
        let d = root();
        assert!(ops::delete_vault(d.path(), "never-existed").is_ok());
    }

    #[test]
    fn writing_leaves_no_temp_file_behind() {
        // A stray .tmp would be a partially written vault sitting next to the real one.
        let d = root();
        ops::write_vault(d.path(), b"v1", None).unwrap();
        ops::write_vault(d.path(), b"v2", None).unwrap();
        let leftovers: Vec<_> = fs::read_dir(d.path().join("vaults"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left {} temp files", leftovers.len());
    }

    #[test]
    fn a_stale_temp_file_is_ignored_and_overwritten() {
        // What a crash between write and rename actually leaves behind. The live blob is
        // still the previous good bytes, and the next write must not trip over the debris.
        let d = root();
        ops::write_vault(d.path(), b"v1", None).unwrap();
        fs::write(d.path().join("vaults").join("default.tmp"), b"torn").unwrap();

        assert_eq!(ops::read_vault(d.path(), None).unwrap(), b"v1");
        ops::write_vault(d.path(), b"v2", None).unwrap();
        assert_eq!(ops::read_vault(d.path(), None).unwrap(), b"v2");
    }

    #[test]
    fn meta_round_trips_and_removes() {
        let d = root();
        assert_eq!(ops::get_meta(d.path(), "missing").unwrap(), None);

        ops::set_meta(d.path(), "k".into(), json!({ "a": 1 })).unwrap();
        assert_eq!(ops::get_meta(d.path(), "k").unwrap(), Some(json!({"a": 1})));

        ops::set_meta(d.path(), "other".into(), json!("keep")).unwrap();
        ops::remove_meta(d.path(), "k").unwrap();

        assert_eq!(ops::get_meta(d.path(), "k").unwrap(), None);
        // Removing one key must not take the rest of the file with it.
        assert_eq!(
            ops::get_meta(d.path(), "other").unwrap(),
            Some(json!("keep"))
        );
    }

    #[test]
    fn corrupt_meta_reads_as_empty_rather_than_failing() {
        // meta.json holds settings, never vault data, so a damaged one must not brick the
        // app the way a hard error on boot would.
        let d = root();
        fs::create_dir_all(d.path()).unwrap();
        fs::write(d.path().join("meta.json"), b"{not json").unwrap();

        assert_eq!(ops::get_meta(d.path(), "anything").unwrap(), None);
        // And it recovers: the next write replaces the damaged file.
        ops::set_meta(d.path(), "k".into(), json!(1)).unwrap();
        assert_eq!(ops::get_meta(d.path(), "k").unwrap(), Some(json!(1)));
    }

    #[test]
    fn meta_holding_a_json_array_reads_as_empty() {
        // Valid JSON, wrong shape. Same contract as corrupt: degrade, do not fail.
        let d = root();
        fs::write(d.path().join("meta.json"), b"[1,2,3]").unwrap();
        assert_eq!(ops::get_meta(d.path(), "k").unwrap(), None);
    }

    #[test]
    fn export_writes_the_bytes_verbatim() {
        let d = root();
        let out = d.path().join("export.bramble");
        ops::export_bytes(&out, b"encrypted").unwrap();
        assert_eq!(fs::read(&out).unwrap(), b"encrypted");
    }
}
