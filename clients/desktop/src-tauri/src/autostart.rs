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

#[cfg(any(target_os = "linux", all(test, unix)))]
use std::{ffi::OsStr, fs, io, path::Path};

use tauri_plugin_autostart::MacosLauncher;

/// Passed by the registered entry, so a login-launched app goes to the tray rather than putting a
/// window in front of someone who did not ask for one.
pub const HIDDEN_FLAG: &str = "--hidden";

/// Set by the Nix wrapper to itself: the plugin records `current_exe()`, there the wrapped binary,
/// and an entry starting that skips the GTK environment the wrapper sets (#108).
#[cfg(target_os = "linux")]
const LAUNCHER_ENV: &str = "BRAMBLE_LAUNCHER";

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

/// Called by the frontend right after enabling, since the plugin has just written the entry.
#[cfg(target_os = "linux")]
#[tauri::command]
pub fn autostart_repoint(app: tauri::AppHandle) -> Result<(), String> {
    repoint_installed(&app)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn autostart_repoint() -> Result<(), String> {
    Ok(())
}

/// Repairs an entry an earlier build or version wrote, which nothing else rewrites short of
/// toggling.
#[cfg(target_os = "linux")]
pub fn refresh<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    match repoint_installed(app) {
        Ok(true) => log::info!("autostart entry repointed at the launcher"),
        Ok(false) => {}
        Err(e) => log::warn!("autostart entry not repointed: {e}"),
    }
}

#[cfg(target_os = "linux")]
fn repoint_installed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> io::Result<bool> {
    // Where auto-launch 0.5.0 writes it: dirs::home_dir()/.config/autostart, not XDG_CONFIG_HOME.
    let Some(home) = std::env::var_os("HOME").filter(|home| !home.is_empty()) else {
        return Ok(false);
    };
    repoint_entry(
        &Path::new(&home).join(".config").join("autostart"),
        &app.package_info().name,
        std::env::var_os(LAUNCHER_ENV).as_deref(),
    )
}

/// Points `<dir>/<app_name>.desktop` at the launcher `value` names. `Ok(false)` without a
/// launcher or an entry, touching nothing.
#[cfg(any(target_os = "linux", all(test, unix)))]
fn repoint_entry(dir: &Path, app_name: &str, value: Option<&OsStr>) -> io::Result<bool> {
    let Some(launcher) = named_launcher(value) else {
        return Ok(false);
    };
    let file = dir.join(format!("{app_name}.desktop"));
    let entry = match fs::read_to_string(&file) {
        Ok(entry) => entry,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    match repointed(&entry, launcher) {
        Some(entry) => fs::write(&file, entry).map(|()| true),
        None => Ok(false),
    }
}

/// `BRAMBLE_LAUNCHER`, if absolute: the session starts the entry from no particular directory.
#[cfg(any(target_os = "linux", all(test, unix)))]
fn named_launcher(value: Option<&OsStr>) -> Option<&str> {
    value
        .and_then(OsStr::to_str)
        .filter(|path| Path::new(path).is_absolute())
}

/// `entry` with its `Exec=` program swapped for `program`, or `None` if it already starts that.
/// Other lines are kept, including any key a desktop added to switch the entry off.
#[cfg(any(target_os = "linux", all(test, unix)))]
fn repointed(entry: &str, program: &str) -> Option<String> {
    let out = entry
        .split('\n')
        .map(|line| match line.strip_prefix("Exec=") {
            Some(command) => {
                let args = command.find(' ').map_or("", |at| &command[at..]);
                format!("Exec={program}{args}")
            }
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n");
    (out != entry).then_some(out)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    const WRAPPER: &str = "/nix/store/0000-bramble-0.4.0/bin/bramble-desktop";
    const WRAPPED: &str = "/nix/store/0000-bramble-0.4.0/bin/.bramble-desktop-wrapped";

    /// What auto-launch 0.5.0's `enable()` writes for this app.
    fn entry(program: &str) -> String {
        format!(
            "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Bramble\n\
             Comment=Bramblestartup script\nExec={program} --hidden\nStartupNotify=false\n\
             Terminal=false"
        )
    }

    #[test]
    fn only_an_absolute_launcher_is_named() {
        assert_eq!(named_launcher(Some(OsStr::new(WRAPPER))), Some(WRAPPER));
        for value in [
            None,
            Some(""),
            Some("bramble-desktop"),
            Some("bin/bramble-desktop"),
        ] {
            assert_eq!(named_launcher(value.map(OsStr::new)), None);
        }
    }

    #[test]
    fn an_entry_naming_the_wrapped_binary_is_pointed_at_the_launcher() {
        assert_eq!(repointed(&entry(WRAPPED), WRAPPER), Some(entry(WRAPPER)));
    }

    #[test]
    fn an_entry_already_naming_the_launcher_is_left_alone() {
        assert_eq!(repointed(&entry(WRAPPER), WRAPPER), None);
    }

    #[test]
    fn repointing_keeps_what_a_desktop_added() {
        let disabled = format!("{}\nX-GNOME-Autostart-enabled=false\n", entry(WRAPPED));
        assert_eq!(
            repointed(&disabled, WRAPPER),
            Some(format!(
                "{}\nX-GNOME-Autostart-enabled=false\n",
                entry(WRAPPER)
            ))
        );
    }

    #[test]
    fn enabling_then_repointing_leaves_an_entry_that_starts_the_launcher() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Bramble.desktop");
        fs::write(&file, entry(WRAPPED)).unwrap();

        assert!(repoint_entry(dir.path(), "Bramble", Some(OsStr::new(WRAPPER))).unwrap());
        assert_eq!(fs::read_to_string(&file).unwrap(), entry(WRAPPER));
    }

    #[test]
    fn without_a_launcher_the_entry_is_left_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Bramble.desktop");
        fs::write(&file, entry(WRAPPED)).unwrap();

        for value in [None, Some(""), Some("bin/bramble-desktop")] {
            assert!(!repoint_entry(dir.path(), "Bramble", value.map(OsStr::new)).unwrap());
        }
        assert_eq!(fs::read(&file).unwrap(), entry(WRAPPED).into_bytes());
    }

    #[test]
    fn a_missing_entry_is_not_created() {
        let dir = tempfile::tempdir().unwrap();

        assert!(!repoint_entry(dir.path(), "Bramble", Some(OsStr::new(WRAPPER))).unwrap());
        assert!(!dir.path().join("Bramble.desktop").exists());
    }
}
