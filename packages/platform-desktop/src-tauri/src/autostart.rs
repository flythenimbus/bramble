//! Starting with the session, so the backup schedule is kept by a process that is running.
//!
//! "Backs up on schedule" is only true of an app that is up. The tick lives in this process
//! (see `backup`), so on a machine that gets rebooted and never manually launched, a daily backup
//! is not one. This is the piece that makes that claim honest.
//!
//! Mechanism per platform, all of it `tauri-plugin-autostart` over the `auto-launch` crate: a
//! login item on macOS, a `Run` registry value on Windows, an XDG `~/.config/autostart` entry on
//! Linux. XDG rather than a systemd user unit on purpose, because this is a tray app: an XDG entry
//! starts once the graphical session exists, where a user unit wanting `default.target` can come
//! up with no display to render into.
//!
//! **The TPM credential tier will want a systemd user unit anyway**, since
//! `LoadCredentialEncrypted=` only delivers to a systemd-started service, and at that point Linux
//! autostart should move to the unit rather than keep both. See docs/cloud-storage-backups.md.

use tauri_plugin_autostart::MacosLauncher;

/// Passed by the registered entry, so a login-launched app goes to the tray rather than putting a
/// window in front of someone who did not ask for one.
pub const HIDDEN_FLAG: &str = "--hidden";

/// `LaunchAgent` rather than `AppleScript`: a plist in `~/Library/LaunchAgents` is inspectable and
/// removable by the user, where the AppleScript variant edits the opaque Login Items list and
/// needs an automation permission prompt to do it.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_FLAG]))
}

/// Whether this launch came from the autostart entry rather than from a person.
pub fn launched_hidden() -> bool {
    std::env::args().any(|arg| arg == HIDDEN_FLAG)
}
