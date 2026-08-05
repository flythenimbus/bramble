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

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

/// Resolves an omitted vault id. Multi-vault gets a real registry later; today every
/// caller that omits the id means "the one vault". See docs/multiple-vaults.md.
const DEFAULT_VAULT_ID: &str = "default";

/// Serializes meta.json read-modify-write so two concurrent setMeta calls can't lose one.
static META_LOCK: Mutex<()> = Mutex::new(());

type CmdResult<T> = Result<T, String>;

fn io<T>(r: std::io::Result<T>, what: &str) -> CmdResult<T> {
    r.map_err(|e| format!("{what}: {e}"))
}

fn data_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    io(fs::create_dir_all(&dir), "create data dir")?;
    Ok(dir)
}

fn vaults_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = data_dir(app)?.join("vaults");
    io(fs::create_dir_all(&dir), "create vaults dir")?;
    Ok(dir)
}

/// Reject anything that could escape the vaults dir; ids reach here from the webview.
fn vault_paths(app: &AppHandle, vault_id: Option<String>) -> CmdResult<(PathBuf, PathBuf)> {
    let id = vault_id.unwrap_or_else(|| DEFAULT_VAULT_ID.to_string());
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid vault id: {id}"));
    }
    let dir = vaults_dir(app)?;
    Ok((dir.join(format!("{id}.vlt")), dir.join(format!("{id}.bak"))))
}

/// Write via a sibling temp file and rename, so the destination is never partially written.
fn write_atomic(path: &Path, bytes: &[u8]) -> CmdResult<()> {
    let tmp = path.with_extension("tmp");
    io(fs::write(&tmp, bytes), "write temp")?;
    io(fs::rename(&tmp, path), "rename temp")
}

#[tauri::command]
pub fn storage_has_vault(app: AppHandle, vault_id: Option<String>) -> CmdResult<bool> {
    // Omitted id asks whether ANY vault exists, which is what the unlock screen branches on.
    if vault_id.is_none() {
        let dir = vaults_dir(&app)?;
        let any = io(fs::read_dir(&dir), "read vaults dir")?
            .filter_map(Result::ok)
            .any(|e| e.path().extension().is_some_and(|x| x == "vlt"));
        return Ok(any);
    }
    Ok(vault_paths(&app, vault_id)?.0.exists())
}

#[tauri::command]
pub fn storage_read_vault(app: AppHandle, vault_id: Option<String>) -> CmdResult<Vec<u8>> {
    let (blob, _) = vault_paths(&app, vault_id)?;
    io(fs::read(&blob), "read vault")
}

#[tauri::command]
pub fn storage_write_vault(
    app: AppHandle,
    blob: Vec<u8>,
    vault_id: Option<String>,
) -> CmdResult<()> {
    let (path, backup) = vault_paths(&app, vault_id)?;
    // Snapshot the previous good bytes first; the contract is that a crash mid-write
    // still leaves something recoverable.
    if path.exists() {
        let previous = io(fs::read(&path), "read vault for snapshot")?;
        write_atomic(&backup, &previous)?;
    }
    write_atomic(&path, &blob)
}

#[tauri::command]
pub fn storage_read_vault_backup(
    app: AppHandle,
    vault_id: Option<String>,
) -> CmdResult<Option<Vec<u8>>> {
    let (_, backup) = vault_paths(&app, vault_id)?;
    if !backup.exists() {
        return Ok(None);
    }
    io(fs::read(&backup), "read vault backup").map(Some)
}

#[tauri::command]
pub fn storage_restore_vault_backup(app: AppHandle, vault_id: Option<String>) -> CmdResult<bool> {
    let (path, backup) = vault_paths(&app, vault_id)?;
    if !backup.exists() {
        return Ok(false);
    }
    let bytes = io(fs::read(&backup), "read vault backup")?;
    // Deliberately no fresh snapshot: the caller is recovering, and overwriting the
    // backup with the bad live bytes would destroy the only good copy.
    write_atomic(&path, &bytes)?;
    Ok(true)
}

#[tauri::command]
pub fn storage_delete_vault(app: AppHandle, vault_id: String) -> CmdResult<()> {
    let (path, backup) = vault_paths(&app, Some(vault_id))?;
    for p in [path, backup] {
        if p.exists() {
            io(fs::remove_file(&p), "delete vault file")?;
        }
    }
    Ok(())
}

// ---- metadata ----

fn meta_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(data_dir(app)?.join("meta.json"))
}

fn read_meta(app: &AppHandle) -> CmdResult<Map<String, Value>> {
    let path = meta_path(app)?;
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

#[tauri::command]
pub fn storage_get_meta(app: AppHandle, key: String) -> CmdResult<Option<Value>> {
    Ok(read_meta(&app)?.get(&key).cloned())
}

#[tauri::command]
pub fn storage_set_meta(app: AppHandle, key: String, value: Value) -> CmdResult<()> {
    let _guard = META_LOCK
        .lock()
        .map_err(|_| "meta lock poisoned".to_string())?;
    let mut meta = read_meta(&app)?;
    meta.insert(key, value);
    let bytes =
        serde_json::to_vec(&Value::Object(meta)).map_err(|e| format!("encode meta: {e}"))?;
    write_atomic(&meta_path(&app)?, &bytes)
}

/// Write bytes the user chose a path for (vault export / backup). The path comes from the
/// dialog plugin, so it is user-selected rather than webview-chosen; writing here instead
/// of through the fs plugin keeps this crate free of a filesystem scope to widen later.
#[tauri::command]
pub fn shell_export_bytes(path: String, bytes: Vec<u8>) -> CmdResult<()> {
    io(fs::write(PathBuf::from(path), bytes), "export bytes")
}

#[tauri::command]
pub fn storage_remove_meta(app: AppHandle, key: String) -> CmdResult<()> {
    let _guard = META_LOCK
        .lock()
        .map_err(|_| "meta lock poisoned".to_string())?;
    let mut meta = read_meta(&app)?;
    meta.remove(&key);
    let bytes =
        serde_json::to_vec(&Value::Object(meta)).map_err(|e| format!("encode meta: {e}"))?;
    write_atomic(&meta_path(&app)?, &bytes)
}
