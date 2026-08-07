//! Where the browser socket lives.
//!
//! Included by both the app (`mod socket_addr`) and the proxy (via `#[path]`) rather than
//! shared through the library, because the proxy must not link Tauri: the browser spawns it
//! on every launch, so it has to stay a small, fast binary. Two processes agreeing on a path
//! by copying a string is exactly the kind of thing that drifts, so it lives in one file.

use std::path::PathBuf;

/// Must match `identifier` in tauri.conf.json: on macOS that is what names the app's data
/// directory, and the proxy has no Tauri to ask.
pub const APP_IDENTIFIER: &str = "app.bramble.desktop";

pub const SOCKET_NAME: &str = "bramble.sock";

/// The socket path, derived the same way Tauri derives the app data dir.
///
/// Only macOS for now, matching where the desktop build is actually tested. Windows has no
/// unix sockets at all and will want a named pipe rather than a different path, so there is
/// nothing to guess at here. See docs/desktop-port.md.
pub fn default_socket_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library/Application Support")
                .join(APP_IDENTIFIER)
                .join(SOCKET_NAME),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}
