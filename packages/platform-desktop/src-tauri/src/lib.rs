//! Bramble desktop shell.
//!
//! The webview renders `@vault/core`; this process owns everything the webview must not:
//! the VEK (see `crypto`), the vault files (see `storage`), and later the sync hub, the
//! spotlight window, auto-type, and the browser IPC. See docs/desktop-port.md.

mod crypto;
mod storage;

/// Version of the shared Rust crypto core this binary linked. Exists to prove the
/// core-rust-as-a-cargo-dependency path end to end, which is the bet Tauri was picked on;
/// the Settings "About" row reads it.
#[tauri::command]
fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_version,
            crypto::crypto_is_locked,
            crypto::crypto_lock,
            crypto::crypto_generate_vek,
            crypto::crypto_unlock_with_vek,
            crypto::crypto_export_vek,
            crypto::crypto_rotate_vek,
            crypto::crypto_generate_salt,
            crypto::crypto_generate_slot_id,
            crypto::crypto_wrap_vek_password,
            crypto::crypto_unwrap_vek_password,
            crypto::crypto_verify_password_slot,
            crypto::crypto_wrap_vek_webauthn,
            crypto::crypto_unwrap_vek_webauthn,
            crypto::crypto_verify_webauthn_slot,
            crypto::crypto_encrypt_entry,
            crypto::crypto_decrypt_entry,
            crypto::crypto_decrypt_entries,
            crypto::crypto_encrypt_with_vek,
            crypto::crypto_decrypt_with_vek,
            storage::storage_has_vault,
            storage::storage_read_vault,
            storage::storage_write_vault,
            storage::storage_read_vault_backup,
            storage::storage_restore_vault_backup,
            storage::storage_delete_vault,
            storage::storage_get_meta,
            storage::storage_set_meta,
            storage::storage_remove_meta,
            storage::shell_export_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
