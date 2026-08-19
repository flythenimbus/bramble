//! Where the browser socket lives.
//!
//! Included by both the app (`mod socket_addr`) and the proxy (via `#[path]`) rather than
//! shared through the library, because the proxy must not link Tauri: the browser spawns it
//! on every launch, so it has to stay a small, fast binary. Two processes agreeing on a path
//! by copying a string is exactly the kind of thing that drifts, so it lives in one file.

use std::{
    ffi::{OsStr, OsString},
    path::PathBuf,
};

/// Must match `identifier` in tauri.conf.json: on macOS that is what names the app's data
/// directory, and the proxy has no Tauri to ask.
pub const APP_IDENTIFIER: &str = "app.bramble.desktop";

pub const SOCKET_NAME: &str = "bramble.sock";

/// The app's data directory, derived the way Tauri derives it, from the values Tauri reads.
///
/// Taken as arguments rather than read here so the rule itself can be tested: this has to agree
/// with `app_data_dir()` on the Tauri side or the proxy connects to a path nothing is listening
/// on, and that failure looks exactly like the app not running.
///
/// Windows is absent because it has no unix sockets at all and will want a named pipe rather
/// than a different path, so there is nothing to guess at here. See docs/desktop-port.md.
fn data_dir_from(xdg_data_home: Option<&OsStr>, home: Option<&OsStr>) -> Option<PathBuf> {
    // One cfg block per platform, each the whole body: a `return` in some arms and a tail in
    // others is how the credential store lost its type and stopped compiling off Linux.
    #[cfg(target_os = "macos")]
    {
        let _ = xdg_data_home;
        Some(
            PathBuf::from(home?)
                .join("Library/Application Support")
                .join(APP_IDENTIFIER),
        )
    }
    #[cfg(target_os = "linux")]
    {
        // XDG_DATA_HOME when it is set and absolute, else ~/.local/share. The absolute test is
        // the specification's, and the `dirs` crate Tauri uses applies it too: a relative value
        // is to be ignored rather than resolved against the working directory.
        let base = xdg_data_home
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| Some(PathBuf::from(home?).join(".local/share")))?;
        Some(base.join(APP_IDENTIFIER))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (xdg_data_home, home);
        None
    }
}

/// The app's data directory on this machine, or None on a platform this does not cover.
pub fn app_data_dir() -> Option<PathBuf> {
    let xdg: Option<OsString> = std::env::var_os("XDG_DATA_HOME");
    let home: Option<OsString> = std::env::var_os("HOME");
    data_dir_from(xdg.as_deref(), home.as_deref())
}

/// The socket path, which is that directory plus one name.
pub fn default_socket_path() -> Option<PathBuf> {
    Some(app_data_dir()?.join(SOCKET_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "linux")]
    fn linux_follows_xdg_data_home_when_it_is_absolute() {
        let home = OsString::from("/home/someone");
        let xdg = OsString::from("/data/xdg");
        assert_eq!(
            data_dir_from(Some(&xdg), Some(&home)).unwrap(),
            PathBuf::from("/data/xdg/app.bramble.desktop")
        );
        assert_eq!(
            data_dir_from(None, Some(&home)).unwrap(),
            PathBuf::from("/home/someone/.local/share/app.bramble.desktop")
        );
        // A relative XDG_DATA_HOME is to be ignored, not resolved: honouring it would put the
        // socket somewhere that depends on the working directory of whoever launched the app.
        let relative = OsString::from("relative/data");
        assert_eq!(
            data_dir_from(Some(&relative), Some(&home)).unwrap(),
            PathBuf::from("/home/someone/.local/share/app.bramble.desktop")
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_is_the_application_support_directory() {
        let home = OsString::from("/Users/someone");
        assert_eq!(
            data_dir_from(None, Some(&home)).unwrap(),
            PathBuf::from("/Users/someone/Library/Application Support/app.bramble.desktop")
        );
    }

    #[test]
    fn no_home_is_no_path() {
        assert!(data_dir_from(None, None).is_none());
    }

    #[test]
    fn the_socket_is_one_name_under_the_data_directory() {
        // The app binds `socket_path(app_data_dir())`, which is the same join. If these two
        // ever disagree the proxy dials a path nothing is listening on.
        if let Some(dir) = app_data_dir() {
            assert_eq!(default_socket_path().unwrap(), dir.join(SOCKET_NAME));
        }
    }
}
