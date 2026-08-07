//! Bramble desktop shell.
//!
//! The webview renders `@vault/core`; this process owns everything the webview must not:
//! the VEK (see `crypto`), the vault files (see `storage`), and later the sync hub, the
//! spotlight window, auto-type, and the browser IPC. See docs/desktop-port.md.

mod crypto;
mod lifetime;
mod spotlight;
mod storage;

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

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

            // Registered here rather than in the builder chain because with_shortcuts is
            // fallible and setup is where a `?` has somewhere to go.
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts([spotlight::HOTKEY])?
                    .with_handler(|app, _shortcut, event| {
                        // Fires on press AND release; acting on both would toggle twice and
                        // leave the panel exactly as it was.
                        if event.state() == ShortcutState::Pressed {
                            spotlight::toggle(app);
                        }
                    })
                    .build(),
            )?;

            if let Some(window) = app.get_webview_window(spotlight::LABEL) {
                spotlight::apply_backdrop(&window);
            }
            lifetime::install_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Hide rather than destroy. Tauri quits once every window is gone, so closing
            // this one would take the global hotkey and the tray with it, and there would be
            // no way back into the app.
            WindowEvent::CloseRequested { api, .. } if window.label() == lifetime::MAIN => {
                api.prevent_close();
                lifetime::hide_main(&window.app_handle().clone());
            }
            // A quick-access panel that outlives the user's attention is clutter, and on
            // macOS an always-on-top window with no dock entry is awkward to dismiss any
            // other way.
            WindowEvent::Focused(false) if window.label() == spotlight::LABEL => {
                spotlight::hide(&window.app_handle().clone());
            }
            _ => {}
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
            spotlight::spotlight_hide,
            spotlight::spotlight_set_height,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Built rather than run directly so RunEvent is reachable: the dock icon survives a
        // hidden window on macOS, and clicking it has to bring the vault back.
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => lifetime::show_main(app),
            // The window is only ever hidden now, so the process would otherwise linger with
            // no UI and no way to reach it. Quit is the tray's job.
            RunEvent::ExitRequested { .. } => {}
            _ => {
                let _ = app;
            }
        });
}
