//! Bramble desktop shell.
//!
//! The webview renders `@vault/core`; this process owns everything the webview must not:
//! the VEK (see `crypto`), the vault files (see `storage`), and later the sync hub, the
//! spotlight window, auto-type, and the browser IPC. See docs/desktop-port.md.

mod crypto;
mod index_store;
mod lifetime;
mod manifest;
mod pairing;
mod socket;
// Shared with the proxy binary through `#[path]` rather than linked, so the app only uses
// SOCKET_NAME from it and the rest is live over there.
mod secure_store;
#[allow(dead_code)]
mod socket_addr;
mod spotlight;
mod storage;
mod sync_crypto;

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_log::{Target, TargetKind};

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
            // Logging is registered in release too, not just debug. A release build used to
            // be entirely silent, so when pairing refused a connection there was nowhere at
            // all to find out why: no stdout, no file, and a UI that showed nothing. Stdout
            // for `pnpm dev:desktop`, a file for a build someone is actually running.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(if cfg!(debug_assertions) {
                        log::LevelFilter::Debug
                    } else {
                        log::LevelFilter::Info
                    })
                    .targets([
                        Target::new(TargetKind::Stdout),
                        Target::new(TargetKind::LogDir {
                            file_name: Some("bramble".into()),
                        }),
                    ])
                    .build(),
            )?;

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

            // Rewritten every launch, not installed once: the manifest carries an absolute
            // path to the proxy, so an app update or a move silently breaks every browser.
            manifest::refresh();

            // The browser proxy's end of the pipe. Bound at startup rather than on first
            // pairing: an extension that is already paired reconnects whenever its browser
            // starts, without the user doing anything.
            match storage::data_dir(app.handle()) {
                // Not fatal. A vault manager with no browser link is still a vault manager,
                // and refusing to launch over it would be a worse failure than losing fill.
                Ok(root) => {
                    socket::attach(app.handle().clone());
                    if let Err(e) = socket::listen(&root) {
                        log::error!("browser socket unavailable: {e}");
                    }
                }
                Err(e) => log::error!("browser socket: no data dir: {e}"),
            }
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
            pairing::pairing_begin,
            pairing::pairing_cancel,
            pairing::pairing_is_open,
            pairing::pairing_list,
            pairing::pairing_forget,
            pairing::pairing_public_key,
            index_store::link_set_index,
            index_store::link_clear_index,
            socket::link_sync_send,
            socket::link_sync_peers,
            secure_store::secure_get,
            secure_store::secure_set,
            secure_store::secure_delete,
            sync_crypto::sync_handshake_generate_keypair,
            sync_crypto::sync_handshake_start_initiator,
            sync_crypto::sync_handshake_start_responder,
            sync_crypto::sync_handshake_enroll_initiator,
            sync_crypto::sync_handshake_enroll_responder,
            sync_crypto::sync_handshake_read,
            sync_crypto::sync_handshake_encrypt,
            sync_crypto::sync_handshake_decrypt,
            sync_crypto::sync_handshake_remote_static,
            sync_crypto::sync_handshake_close,
            sync_crypto::sync_nostr_generate_key,
            sync_crypto::sync_nostr_public_key,
            sync_crypto::sync_nostr_sign,
            sync_crypto::sync_nostr_verify,
            sync_crypto::sync_roster_sig_generate_key,
            sync_crypto::sync_roster_sig_public_key,
            sync_crypto::sync_roster_sign,
            sync_crypto::sync_roster_verify,
            sync_crypto::sync_roster_admission_public_key,
            sync_crypto::sync_roster_admission_sign,
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
