//! Attachment files on the native filesystem. See docs/file-attachments.md.
//!
//! Layout, one folder per vault under the app data dir, so nothing here can list, read or
//! delete another vault's files:
//!   blobs/<vaultId>/<hash>            a sealed attachment, named by the SHA-256 of its bytes
//!   blobs/<vaultId>/.staging-<key>    one being sealed or received; never listed as a blob
//! and under the app cache dir:
//!   open/<token>/<name>               a decrypted copy handed to another app; swept on lock
//!   open/kdbx-<id>/attachment-<n>     a KeePass import's attachments, until sealed; swept too
//!   open/kdbx-<id>/<name>.kdbx        a KeePass export, until saved where the user chose; swept
//!
//! An attachment's bytes never cross into the webview to be sealed or opened. A picked file is
//! sealed from its path here, with the VEK this process holds, and a copy to open is decrypted
//! here straight to disk. Only backup and restore move blob bytes across, and those go as raw
//! IPC bytes rather than the JSON number arrays the rest of this IPC uses, which would turn a
//! 90 MB attachment into several hundred megabytes of JSON.
//!
//! As in storage.rs, `ops` takes its directories as parameters, so the part that can lose or
//! leak a file is testable without a running app.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Manager,
};

type CmdResult<T> = Result<T, String>;

/// A file the user picked in the native dialog. The size is read here so the core can refuse an
/// oversized attachment before anything is sealed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    path: String,
    name: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobEntry {
    hash: String,
    size: u64,
}

/// One attachment of a KeePass export, by its address in this vault's store, and the entry and
/// name it goes under.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdbxFile {
    pub entry: u32,
    pub hash: String,
    pub size: u64,
    pub wrapped_fek: String,
    pub fek_iv: String,
    pub nonce_prefix: String,
    pub name: String,
}

/// A KeePass export written here, for the shell to copy where the user chooses, and the folder
/// it is in, for `files_discard_kdbx` once it is.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedKdbx {
    path: String,
    size: u64,
    dir: String,
}

pub(crate) mod ops {
    use std::{
        fs,
        io::{Read, Seek, SeekFrom, Write},
        path::{Path, PathBuf},
    };

    use vault_crypto::SealedFileBlob;

    use super::{BlobEntry, CmdResult, KdbxFile};
    use crate::storage::ops::{restrict_dir, restrict_file, validate_vault_id};

    const STAGING: &str = ".staging-";
    const OPEN_DIR: &str = "open";

    fn io<T>(r: std::io::Result<T>, what: &str) -> CmdResult<T> {
        r.map_err(|e| format!("{what}: {e}"))
    }

    fn not_found_ok(r: std::io::Result<()>, what: &str) -> CmdResult<()> {
        match r {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => io(other, what),
        }
    }

    /// Lowercase hex SHA-256: a blob's address, and its filename.
    pub fn validate_hash(hash: &str) -> CmdResult<()> {
        if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            Ok(())
        } else {
            Err("not a blob hash".into())
        }
    }

    /// A staging key or an open token: a hash or a UUID. One path segment, nothing that climbs.
    pub fn validate_key(key: &str) -> CmdResult<()> {
        if !key.is_empty() && key.len() <= 64 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            Ok(())
        } else {
            Err("invalid key".into())
        }
    }

    fn utf8(path: &Path) -> CmdResult<String> {
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| "path is not valid UTF-8".to_string())
    }

    /// One vault's attachment folder, created owner-only.
    pub fn blob_dir(root: &Path, vault_id: &str) -> CmdResult<PathBuf> {
        validate_vault_id(vault_id)?;
        let blobs = root.join("blobs");
        io(fs::create_dir_all(&blobs), "create blobs dir")?;
        restrict_dir(&blobs)?;
        let dir = blobs.join(vault_id);
        io(fs::create_dir_all(&dir), "create vault blobs dir")?;
        restrict_dir(&dir)?;
        Ok(dir)
    }

    fn blob_path(root: &Path, vault_id: &str, hash: &str) -> CmdResult<PathBuf> {
        validate_hash(hash)?;
        Ok(blob_dir(root, vault_id)?.join(hash))
    }

    fn staging_path(root: &Path, vault_id: &str, key: &str) -> CmdResult<PathBuf> {
        validate_key(key)?;
        Ok(blob_dir(root, vault_id)?.join(format!("{STAGING}{key}")))
    }

    /// Seal a picked file into the vault's store. Sealed into staging and renamed onto its hash,
    /// because the address is the hash of the ciphertext and is only known once sealing ends; a
    /// failed seal leaves nothing published.
    pub fn seal(
        root: &Path,
        vault_id: &str,
        token: &str,
        src: &Path,
        meta_json: &str,
    ) -> CmdResult<SealedFileBlob> {
        let staging = staging_path(root, vault_id, token)?;
        let sealed = match vault_crypto::seal_file(utf8(src)?, utf8(&staging)?, meta_json.to_owned())
        {
            Ok(sealed) => sealed,
            Err(e) => {
                let _ = fs::remove_file(&staging);
                return Err(e.to_string());
            }
        };
        restrict_file(&staging)?;
        let dst = blob_path(root, vault_id, &sealed.hash)?;
        io(fs::rename(&staging, &dst), "publish sealed file")?;
        Ok(sealed)
    }

    pub fn has(root: &Path, vault_id: &str, hash: &str) -> CmdResult<bool> {
        Ok(blob_path(root, vault_id, hash)?.is_file())
    }

    pub fn size(root: &Path, vault_id: &str, hash: &str) -> CmdResult<Option<u64>> {
        Ok(fs::metadata(blob_path(root, vault_id, hash)?)
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len()))
    }

    fn read_range(path: &Path, offset: u64, length: u64) -> CmdResult<Vec<u8>> {
        let mut file = io(fs::File::open(path), "open")?;
        io(file.seek(SeekFrom::Start(offset)), "seek")?;
        let mut out = Vec::with_capacity(length as usize);
        io(file.take(length).read_to_end(&mut out), "read")?;
        Ok(out)
    }

    pub fn read(root: &Path, vault_id: &str, hash: &str, offset: u64, length: u64) -> CmdResult<Vec<u8>> {
        read_range(&blob_path(root, vault_id, hash)?, offset, length)
    }

    pub fn remove(root: &Path, vault_id: &str, hash: &str) -> CmdResult<()> {
        not_found_ok(fs::remove_file(blob_path(root, vault_id, hash)?), "remove blob")
    }

    /// Every blob this vault holds. Filtered by the hash shape rather than by "not staging", so
    /// a sweep can never be handed a file this store does not understand.
    pub fn list(root: &Path, vault_id: &str) -> CmdResult<Vec<BlobEntry>> {
        let mut out = Vec::new();
        for entry in io(fs::read_dir(blob_dir(root, vault_id)?), "list blobs")? {
            let entry = io(entry, "list blobs")?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
            if validate_hash(&name).is_err() {
                continue;
            }
            let meta = io(entry.metadata(), "stat blob")?;
            if meta.is_file() {
                out.push(BlobEntry { hash: name, size: meta.len() });
            }
        }
        Ok(out)
    }

    pub fn append_staged(root: &Path, vault_id: &str, key: &str, bytes: &[u8]) -> CmdResult<()> {
        let path = staging_path(root, vault_id, key)?;
        let fresh = !path.exists();
        let mut file = io(
            fs::OpenOptions::new().create(true).append(true).open(&path),
            "open staging",
        )?;
        if fresh {
            restrict_file(&path)?;
        }
        io(file.write_all(bytes), "write staging")
    }

    pub fn staged_size(root: &Path, vault_id: &str, key: &str) -> CmdResult<u64> {
        Ok(fs::metadata(staging_path(root, vault_id, key)?)
            .map(|m| m.len())
            .unwrap_or(0))
    }

    pub fn read_staged(root: &Path, vault_id: &str, key: &str, offset: u64, length: u64) -> CmdResult<Vec<u8>> {
        read_range(&staging_path(root, vault_id, key)?, offset, length)
    }

    /// Promote a received blob. Only ever after the core has verified its hash.
    pub fn publish_staged(root: &Path, vault_id: &str, hash: &str) -> CmdResult<()> {
        let staging = staging_path(root, vault_id, hash)?;
        let dst = blob_path(root, vault_id, hash)?;
        io(fs::rename(staging, dst), "publish blob")
    }

    pub fn discard_staged(root: &Path, vault_id: &str, key: &str) -> CmdResult<()> {
        not_found_ok(fs::remove_file(staging_path(root, vault_id, key)?), "discard staging")
    }

    /// Erase a vault's whole attachment folder, for when the vault itself is deleted.
    pub fn delete_vault(root: &Path, vault_id: &str) -> CmdResult<()> {
        validate_vault_id(vault_id)?;
        match fs::remove_dir_all(root.join("blobs").join(vault_id)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => io(other, "delete vault attachments"),
        }
    }

    /// A name safe as one path segment. The sealed name is shown to the user, so it can hold
    /// anything; a separator would become a folder and `..` would climb out of it.
    pub fn file_name_for(name: &str) -> String {
        let cleaned: String = name
            .chars()
            .map(|c| match c {
                '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*' => '_',
                c if c.is_control() => '_',
                c => c,
            })
            .collect();
        let cleaned = cleaned.trim().trim_start_matches('.').to_string();
        if cleaned.is_empty() {
            "attachment".into()
        } else {
            cleaned
        }
    }

    /// Decrypt one attachment to `<cache>/open/<token>/<name>` and return that path.
    #[allow(clippy::too_many_arguments)]
    pub fn open_copy(
        root: &Path,
        cache: &Path,
        vault_id: &str,
        hash: &str,
        token: &str,
        name: &str,
        wrapped_fek: &str,
        fek_iv: &str,
        nonce_prefix: &str,
    ) -> CmdResult<PathBuf> {
        let src = blob_path(root, vault_id, hash)?;
        validate_key(token)?;
        let open = cache.join(OPEN_DIR);
        io(fs::create_dir_all(&open), "create open dir")?;
        restrict_dir(&open)?;
        let dir = open.join(token);
        io(fs::create_dir_all(&dir), "create open folder")?;
        restrict_dir(&dir)?;
        let dst = dir.join(file_name_for(name));
        vault_crypto::open_file_to_path(
            wrapped_fek.to_owned(),
            fek_iv.to_owned(),
            nonce_prefix.to_owned(),
            utf8(&src)?,
            utf8(&dst)?,
        )
        .map_err(|e| e.to_string())?;
        restrict_file(&dst)?;
        Ok(dst)
    }

    /// A fresh folder for one KeePass import's attachments or one export, among the decrypted
    /// copies, so the lock's sweep takes whatever an interrupted one leaves behind.
    pub fn new_kdbx_dir(cache: &Path) -> CmdResult<PathBuf> {
        let mut id = [0u8; 16];
        getrandom::fill(&mut id).map_err(|e| format!("KeePass folder id: {e}"))?;
        let name: String = id.iter().map(|b| format!("{b:02x}")).collect();
        Ok(cache.join(OPEN_DIR).join(format!("kdbx-{name}")))
    }

    /// Whether `dir` is a folder `new_kdbx_dir` could have made. The webview names these
    /// paths back, so nothing else may be read or deleted through them.
    fn is_kdbx_dir(cache: &Path, dir: &Path) -> bool {
        dir.parent() == Some(cache.join(OPEN_DIR).as_path())
            && dir
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_prefix("kdbx-"))
                .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
    }

    /// A file directly in a KeePass folder, and nowhere else.
    fn kdbx_file(cache: &Path, path: &Path) -> CmdResult<PathBuf> {
        match path.parent() {
            Some(dir) if is_kdbx_dir(cache, dir) && path.file_name().is_some() => {
                Ok(path.to_path_buf())
            }
            _ => Err("not a KeePass export".into()),
        }
    }

    /// Delete one KeePass folder, and only one.
    pub fn discard_kdbx_dir(cache: &Path, dir: &Path) -> CmdResult<()> {
        if !is_kdbx_dir(cache, dir) {
            return Err("not a KeePass folder".into());
        }
        not_found_ok(fs::remove_dir_all(dir), "discard KeePass folder")
    }

    /// Write a KeePass database holding `entries` and each of `files`, opened from this vault's
    /// store, to `<cache>/open/kdbx-<id>/<name>`. Returns the file, its size and its folder.
    /// Whole or nothing: on failure the folder goes with whatever was written.
    pub fn save_kdbx(
        root: &Path,
        cache: &Path,
        vault_id: &str,
        name: &str,
        entries: &[vault_crypto::SaveEntry],
        password: &str,
        files: &[KdbxFile],
    ) -> CmdResult<(PathBuf, u64, PathBuf)> {
        let files = files
            .iter()
            .map(|f| {
                Ok(vault_crypto::KdbxExportFile {
                    blob_path: utf8(&blob_path(root, vault_id, &f.hash)?)?,
                    wrapped_fek: f.wrapped_fek.clone(),
                    fek_iv: f.fek_iv.clone(),
                    nonce_prefix: f.nonce_prefix.clone(),
                    size: f.size,
                    entry: f.entry,
                    name: f.name.clone(),
                })
            })
            .collect::<CmdResult<Vec<_>>>()?;
        let open = cache.join(OPEN_DIR);
        io(fs::create_dir_all(&open), "create open dir")?;
        restrict_dir(&open)?;
        let dir = new_kdbx_dir(cache)?;
        io(fs::create_dir(&dir), "create KeePass folder")?;
        restrict_dir(&dir)?;
        let out = dir.join(file_name_for(name));
        let written = vault_crypto::save_to_path(entries, password, &files, &out)
            .and_then(|size| restrict_file(&out).map(|()| size));
        match written {
            Ok(size) => Ok((out, size, dir)),
            Err(e) => {
                let _ = fs::remove_dir_all(&dir);
                Err(e)
            }
        }
    }

    /// Part of a KeePass export written here, for a shell that reads rather than copies it.
    pub fn read_kdbx(cache: &Path, path: &Path, offset: u64, length: u64) -> CmdResult<Vec<u8>> {
        read_range(&kdbx_file(cache, path)?, offset, length)
    }

    /// Copy a KeePass export written here to `dest`, beside it first and renamed into place, so
    /// the chosen path never holds half a database.
    pub fn export_kdbx(cache: &Path, src: &Path, dest: &Path) -> CmdResult<()> {
        let src = kdbx_file(cache, src)?;
        let name = dest
            .file_name()
            .ok_or("export path has no file name")?
            .to_string_lossy();
        let temp = dest.with_file_name(format!(".{name}.partial"));
        let copied =
            io(fs::copy(&src, &temp), "export").and_then(|_| io(fs::rename(&temp, dest), "export"));
        if copied.is_err() {
            let _ = fs::remove_file(&temp);
        }
        copied
    }

    /// Delete every decrypted copy. There may be none.
    pub fn sweep_opened(cache: &Path) -> CmdResult<()> {
        match fs::remove_dir_all(cache.join(OPEN_DIR)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => io(other, "sweep opened copies"),
        }
    }
}

// ---- Tauri commands: check the window, resolve the dirs, then defer to `ops` ----

/// Main window only, as with backup_send: a crate command is not gated by capabilities/*.json,
/// and the spotlight panel is deliberately the narrowest surface in the app.
fn main_only(window: &tauri::Window) -> CmdResult<()> {
    if window.label() == crate::lifetime::MAIN {
        Ok(())
    } else {
        Err("attachments are handled from the main window only".into())
    }
}

fn root(window: &tauri::Window) -> CmdResult<PathBuf> {
    main_only(window)?;
    crate::storage::data_dir(window.app_handle())
}

fn cache_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no app cache dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create cache dir: {e}"))?;
    crate::storage::ops::restrict_dir(&dir)?;
    Ok(dir)
}

/// Pick a file in the native dialog. Returns its path, so the seal can read it here directly.
#[tauri::command]
pub async fn files_pick(window: tauri::Window) -> CmdResult<Option<PickedFile>> {
    use tauri_plugin_dialog::DialogExt;
    main_only(&window)?;
    let app = window.app_handle().clone();
    // The blocking picker must not run on the main thread.
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_file())
        .await
        .map_err(|e| format!("file dialog: {e}"))?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| format!("picked path: {e}"))?;
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("stat picked file: {e}"))?
        .len();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_owned();
    let path = path
        .to_str()
        .ok_or("picked path is not valid UTF-8")?
        .to_owned();
    Ok(Some(PickedFile { path, name, size }))
}

#[tauri::command(async)]
pub fn files_seal(
    window: tauri::Window,
    vault_id: String,
    token: String,
    src_path: String,
    meta_json: String,
) -> CmdResult<vault_crypto::SealedFileBlob> {
    ops::seal(&root(&window)?, &vault_id, &token, Path::new(&src_path), &meta_json)
}

#[tauri::command(async)]
pub fn files_open_meta(
    window: tauri::Window,
    wrapped_fek: String,
    fek_iv: String,
    meta_blob: String,
    meta_iv: String,
) -> CmdResult<String> {
    main_only(&window)?;
    vault_crypto::open_file_meta(wrapped_fek, fek_iv, meta_blob, meta_iv).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn files_reseal_meta(
    window: tauri::Window,
    wrapped_fek: String,
    fek_iv: String,
    meta_json: String,
) -> CmdResult<vault_crypto::MasterEncrypted> {
    main_only(&window)?;
    vault_crypto::reseal_file_meta(wrapped_fek, fek_iv, meta_json).map_err(|e| e.to_string())
}

/// Decrypt an attachment to a temporary copy and open it with the OS default app. The copy is
/// deleted by `files_sweep_opened`, on lock and at startup: the other app reads the file after
/// this returns, so it cannot be deleted here.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn files_open(
    window: tauri::Window,
    vault_id: String,
    hash: String,
    token: String,
    name: String,
    wrapped_fek: String,
    fek_iv: String,
    nonce_prefix: String,
) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let root = root(&window)?;
    let cache = cache_dir(window.app_handle())?;
    let copy = ops::open_copy(
        &root, &cache, &vault_id, &hash, &token, &name, &wrapped_fek, &fek_iv, &nonce_prefix,
    )?;
    let copy = copy.to_str().ok_or("copy path is not valid UTF-8")?.to_owned();
    window
        .app_handle()
        .opener()
        .open_path(copy, None::<&str>)
        .map_err(|e| format!("open attachment: {e}"))
}

/// Where a KeePass import unpacks its attachments. See `ops::new_kdbx_dir`.
pub(crate) fn new_kdbx_dir(window: &tauri::Window) -> CmdResult<PathBuf> {
    main_only(window)?;
    ops::new_kdbx_dir(&cache_dir(window.app_handle())?)
}

/// Delete a KeePass import's unpacked attachments once they are sealed or the import is dropped,
/// or an export once it is saved.
#[tauri::command(async)]
pub fn files_discard_kdbx(window: tauri::Window, dir: String) -> CmdResult<()> {
    main_only(&window)?;
    ops::discard_kdbx_dir(&cache_dir(window.app_handle())?, Path::new(&dir))
}

/// Export the vault as a KeePass database, attachments included, opened here from the store
/// rather than carried through the webview. See `ops::save_kdbx`.
#[tauri::command(async)]
pub fn files_save_kdbx(
    window: tauri::Window,
    vault_id: String,
    name: String,
    entries: Vec<vault_crypto::SaveEntry>,
    password: String,
    files: Vec<KdbxFile>,
) -> CmdResult<SavedKdbx> {
    let root = root(&window)?;
    let cache = cache_dir(window.app_handle())?;
    let (path, size, dir) =
        ops::save_kdbx(&root, &cache, &vault_id, &name, &entries, &password, &files)?;
    Ok(SavedKdbx {
        path: path
            .to_str()
            .ok_or("export path is not valid UTF-8")?
            .to_owned(),
        size,
        dir: dir
            .to_str()
            .ok_or("export folder is not valid UTF-8")?
            .to_owned(),
    })
}

/// Raw bytes back, not a JSON number array.
#[tauri::command(async)]
pub fn files_read_kdbx(
    window: tauri::Window,
    path: String,
    offset: u64,
    length: u64,
) -> CmdResult<Response> {
    main_only(&window)?;
    let bytes = ops::read_kdbx(
        &cache_dir(window.app_handle())?,
        Path::new(&path),
        offset,
        length,
    )?;
    Ok(Response::new(bytes))
}

/// Copy a KeePass export to the path the user chose in the save dialog.
#[tauri::command(async)]
pub fn files_export_kdbx(window: tauri::Window, src: String, path: String) -> CmdResult<()> {
    main_only(&window)?;
    ops::export_kdbx(
        &cache_dir(window.app_handle())?,
        Path::new(&src),
        Path::new(&path),
    )
}

#[tauri::command(async)]
pub fn files_sweep_opened(window: tauri::Window) -> CmdResult<()> {
    main_only(&window)?;
    ops::sweep_opened(&cache_dir(window.app_handle())?)
}

#[tauri::command(async)]
pub fn files_has(window: tauri::Window, vault_id: String, hash: String) -> CmdResult<bool> {
    ops::has(&root(&window)?, &vault_id, &hash)
}

#[tauri::command(async)]
pub fn files_size(window: tauri::Window, vault_id: String, hash: String) -> CmdResult<Option<u64>> {
    ops::size(&root(&window)?, &vault_id, &hash)
}

/// Raw bytes back, not a JSON number array.
#[tauri::command(async)]
pub fn files_read(
    window: tauri::Window,
    vault_id: String,
    hash: String,
    offset: u64,
    length: u64,
) -> CmdResult<Response> {
    Ok(Response::new(ops::read(&root(&window)?, &vault_id, &hash, offset, length)?))
}

#[tauri::command(async)]
pub fn files_remove(window: tauri::Window, vault_id: String, hash: String) -> CmdResult<()> {
    ops::remove(&root(&window)?, &vault_id, &hash)
}

#[tauri::command(async)]
pub fn files_list(window: tauri::Window, vault_id: String) -> CmdResult<Vec<BlobEntry>> {
    ops::list(&root(&window)?, &vault_id)
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> CmdResult<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("missing {name}"))
}

/// Raw bytes in, with the vault and key in headers, since a raw body leaves no JSON arguments.
#[tauri::command]
pub async fn files_append_staged(window: tauri::Window, request: Request<'_>) -> CmdResult<()> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let vault_id = header(&request, "x-vault-id")?;
    let key = header(&request, "x-key")?;
    ops::append_staged(&root(&window)?, vault_id, key, bytes)
}

#[tauri::command(async)]
pub fn files_staged_size(window: tauri::Window, vault_id: String, key: String) -> CmdResult<u64> {
    ops::staged_size(&root(&window)?, &vault_id, &key)
}

#[tauri::command(async)]
pub fn files_read_staged(
    window: tauri::Window,
    vault_id: String,
    key: String,
    offset: u64,
    length: u64,
) -> CmdResult<Response> {
    Ok(Response::new(ops::read_staged(&root(&window)?, &vault_id, &key, offset, length)?))
}

#[tauri::command(async)]
pub fn files_publish_staged(window: tauri::Window, vault_id: String, hash: String) -> CmdResult<()> {
    ops::publish_staged(&root(&window)?, &vault_id, &hash)
}

#[tauri::command(async)]
pub fn files_discard_staged(window: tauri::Window, vault_id: String, key: String) -> CmdResult<()> {
    ops::discard_staged(&root(&window)?, &vault_id, &key)
}

#[tauri::command(async)]
pub fn files_delete_vault(window: tauri::Window, vault_id: String) -> CmdResult<()> {
    ops::delete_vault(&root(&window)?, &vault_id)
}

#[cfg(test)]
mod tests {
    use super::ops;
    use std::fs;

    const VAULT: &str = "11111111-2222-4333-8444-555555555555";
    const OTHER: &str = "22222222-2222-4333-8444-555555555555";
    const HASH: &str = "abababababababababababababababababababababababababababababababab";

    // The core holds one VEK for the process: the tests here that load it take turns.
    static VEK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn unlocked() -> std::sync::MutexGuard<'static, ()> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        let held = VEK.lock().unwrap_or_else(|e| e.into_inner());
        vault_crypto::unlock_with_vek(B64.encode([0x5au8; 32])).unwrap();
        held
    }

    fn hold(root: &std::path::Path, vault: &str, hash: &str, bytes: &[u8]) {
        ops::append_staged(root, vault, hash, bytes).unwrap();
        ops::publish_staged(root, vault, hash).unwrap();
    }

    #[test]
    fn each_vault_has_its_own_folder_and_cannot_reach_another() {
        let dir = tempfile::tempdir().unwrap();
        hold(dir.path(), VAULT, HASH, b"one");
        assert!(ops::has(dir.path(), VAULT, HASH).unwrap());
        // Same hash asked of another vault: not there, and a remove from it cannot touch ours.
        assert!(!ops::has(dir.path(), OTHER, HASH).unwrap());
        ops::remove(dir.path(), OTHER, HASH).unwrap();
        assert!(ops::has(dir.path(), VAULT, HASH).unwrap());
    }

    #[test]
    fn ids_hashes_and_keys_that_could_climb_out_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["", "..", "../x", "a/b", "a b"] {
            assert!(ops::blob_dir(dir.path(), bad).is_err(), "vault id {bad:?}");
        }
        for bad in ["../etc", "ABABAB", &HASH[1..], "zz"] {
            assert!(ops::has(dir.path(), VAULT, bad).is_err(), "hash {bad:?}");
        }
        for bad in ["", "../x", "a/b", "a.b"] {
            assert!(ops::staged_size(dir.path(), VAULT, bad).is_err(), "key {bad:?}");
        }
    }

    #[test]
    fn staging_is_kept_out_of_the_listing_until_published() {
        let dir = tempfile::tempdir().unwrap();
        ops::append_staged(dir.path(), VAULT, HASH, b"part").unwrap();
        ops::append_staged(dir.path(), VAULT, HASH, b"ial").unwrap();
        assert_eq!(ops::staged_size(dir.path(), VAULT, HASH).unwrap(), 7);
        assert!(ops::list(dir.path(), VAULT).unwrap().is_empty());
        ops::publish_staged(dir.path(), VAULT, HASH).unwrap();
        let listed = ops::list(dir.path(), VAULT).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(ops::read(dir.path(), VAULT, HASH, 0, 100).unwrap(), b"partial");
        assert_eq!(ops::read(dir.path(), VAULT, HASH, 2, 3).unwrap(), b"rti");
    }

    #[test]
    fn deleting_a_vault_takes_only_its_attachments() {
        let dir = tempfile::tempdir().unwrap();
        hold(dir.path(), VAULT, HASH, b"one");
        hold(dir.path(), OTHER, HASH, b"two");
        ops::delete_vault(dir.path(), VAULT).unwrap();
        assert!(!ops::has(dir.path(), VAULT, HASH).unwrap());
        assert!(ops::has(dir.path(), OTHER, HASH).unwrap());
        ops::delete_vault(dir.path(), VAULT).unwrap(); // again: nothing there, still fine
    }

    // The sealed name is attacker-influenced on an import path and becomes a filename here.
    #[test]
    fn a_name_cannot_become_a_path() {
        assert_eq!(ops::file_name_for("tax/2026.pdf"), "tax_2026.pdf");
        assert_eq!(ops::file_name_for("..\\..\\evil"), "_.._evil");
        assert_eq!(ops::file_name_for(".."), "attachment");
        assert_eq!(ops::file_name_for("   "), "attachment");
        assert_eq!(ops::file_name_for("ok name.pdf"), "ok name.pdf");
        assert_eq!(ops::file_name_for("bad\u{0}name"), "bad_name");
    }

    // The webview names the folder to discard, so only one an import or export made may go.
    #[test]
    fn a_keepass_folder_is_discarded_and_nothing_else_is() {
        let cache = tempfile::tempdir().unwrap();
        let ours = ops::new_kdbx_dir(cache.path()).unwrap();
        fs::create_dir_all(&ours).unwrap();
        fs::write(ours.join("attachment-0"), b"x").unwrap();
        let elsewhere = cache.path().join("open").join("some-copy");
        fs::create_dir_all(&elsewhere).unwrap();

        for bad in [
            cache.path().to_path_buf(),
            cache.path().join("open"),
            elsewhere.clone(),
            ours.join(".."),
            cache.path().join("kdbx-00000000000000000000000000000000"),
        ] {
            assert!(
                ops::discard_kdbx_dir(cache.path(), &bad).is_err(),
                "{}",
                bad.display()
            );
        }
        assert!(elsewhere.exists());

        ops::discard_kdbx_dir(cache.path(), &ours).unwrap();
        assert!(!ours.exists());
        // Gone already: still fine.
        ops::discard_kdbx_dir(cache.path(), &ours).unwrap();
        // And the lock's sweep would have taken it anyway: it lives among the decrypted copies.
        assert_eq!(ours.parent(), Some(cache.path().join("open").as_path()));
    }

    // Seal and open against the real core, with a VEK loaded, end to end on disk.
    #[test]
    fn seals_a_picked_file_and_opens_it_back() {
        let _vek = unlocked();
        let dir = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();

        let src = dir.path().join("my scan.pdf");
        let content: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&src, &content).unwrap();

        let sealed = ops::seal(dir.path(), VAULT, "tok-1", &src, r#"{"name":"my scan.pdf","mime":"application/pdf"}"#)
            .unwrap();
        assert!(ops::has(dir.path(), VAULT, &sealed.hash).unwrap());
        // Nothing left in staging once published.
        assert_eq!(ops::staged_size(dir.path(), VAULT, "tok-1").unwrap(), 0);

        let copy = ops::open_copy(
            dir.path(),
            cache.path(),
            VAULT,
            &sealed.hash,
            "open-1",
            "my scan.pdf",
            &sealed.wrapped_fek,
            &sealed.fek_iv,
            &sealed.nonce_prefix,
        )
        .unwrap();
        assert!(copy.ends_with("open/open-1/my scan.pdf"));
        assert_eq!(fs::read(&copy).unwrap(), content);

        ops::sweep_opened(cache.path()).unwrap();
        assert!(!copy.exists());
        vault_crypto::lock();
    }

    // Sealed in the store, exported as KeePass, copied to the chosen path, opened back.
    #[test]
    fn exports_a_keepass_database_with_its_attachments() {
        let _vek = unlocked();
        let dir = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let src = dir.path().join("scan.pdf");
        let content: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&src, &content).unwrap();
        let sealed = ops::seal(
            dir.path(),
            VAULT,
            "tok-1",
            &src,
            r#"{"name":"scan.pdf","mime":"application/pdf"}"#,
        )
        .unwrap();
        let file = |size| super::KdbxFile {
            entry: 0,
            hash: sealed.hash.clone(),
            size,
            wrapped_fek: sealed.wrapped_fek.clone(),
            fek_iv: sealed.fek_iv.clone(),
            nonce_prefix: sealed.nonce_prefix.clone(),
            name: "scan.pdf".into(),
        };
        let entries: Vec<vault_crypto::SaveEntry> = serde_json::from_value(serde_json::json!([
            { "strings": [{ "key": "Title", "value": "Passport", "protected": false }] }
        ]))
        .unwrap();

        // Not the size on record: refused, and no folder left behind.
        assert!(ops::save_kdbx(
            dir.path(),
            cache.path(),
            VAULT,
            "out.kdbx",
            &entries,
            "pw",
            &[file(sealed.size + 1)]
        )
        .is_err());
        assert_eq!(fs::read_dir(cache.path().join("open")).unwrap().count(), 0);

        let (path, size, folder) = ops::save_kdbx(
            dir.path(),
            cache.path(),
            VAULT,
            "out.kdbx",
            &entries,
            "pw",
            &[file(sealed.size)],
        )
        .unwrap();
        assert_eq!(path, folder.join("out.kdbx"));
        assert_eq!(fs::metadata(&path).unwrap().len(), size);
        let head = ops::read_kdbx(cache.path(), &path, 0, 4).unwrap();
        assert_eq!(head, [0x03, 0xd9, 0xa2, 0x9a]);

        let dest = dir.path().join("chosen.kdbx");
        ops::export_kdbx(cache.path(), &path, &dest).unwrap();
        assert!(!dir.path().join(".chosen.kdbx.partial").exists());
        let unpacked = dir.path().join("unpacked");
        let opened = vault_crypto::open_kdbx4(
            fs::read(&dest).unwrap(),
            "pw".into(),
            None,
            unpacked.to_str().unwrap().into(),
        )
        .unwrap();
        assert_eq!(opened.entries[0].binaries[0].name, "scan.pdf");
        assert_eq!(fs::read(&opened.attachments[0].path).unwrap(), content);

        // Only a file in a KeePass folder may be read or copied out.
        assert!(ops::read_kdbx(cache.path(), &src, 0, 4).is_err());
        assert!(ops::export_kdbx(cache.path(), &src, &dest).is_err());
        assert!(ops::read_kdbx(cache.path(), &folder, 0, 4).is_err());

        ops::discard_kdbx_dir(cache.path(), &folder).unwrap();
        assert!(!path.exists());
        vault_crypto::lock();
    }
}
