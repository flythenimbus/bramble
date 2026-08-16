//! Installing the native-messaging host manifest.
//!
//! Chrome will only spawn a host it has a manifest for, and only for the extension ids that
//! manifest names. The file is per-browser, per-user, and carries an ABSOLUTE path to the
//! proxy binary, which is what makes this more than a one-time install step: move the app or
//! update it and every manifest is stale, with the extension failing to connect and nothing
//! saying why. So they are rewritten on every launch rather than written once.
//!
//! Only browsers that are already installed get one. The directory is created if missing, but
//! the browser's own support directory is never conjured up: writing a Brave profile
//! directory onto a machine with no Brave would be presumptuous and would leave litter behind
//! that nothing ever cleans up.
//!
//! macOS only for now, matching where the desktop build is tested. Windows keeps this in the
//! registry rather than the filesystem, so it is a different mechanism and not a path table.
//! See docs/desktop-port.md.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::socket_addr::APP_IDENTIFIER;

/// What the extension passes to `chrome.runtime.connectNative`. Chrome restricts this to
/// lowercase alphanumerics, underscores and dots, so the reverse-DNS identifier is legal as-is.
const HOST_NAME: &str = APP_IDENTIFIER;

/// The published extension, whose id is fixed by the `key` in packages/manifests/chromium.
/// Unpacked dev builds keep that key (`build:chromium`), and the release bundle strips it, but
/// the store listing carries the same id, so one entry covers development and production.
/// Do not take this from cws-public.pem: that is the upload-signing key, and it derives a
/// different, wrong id.
const ALLOWED_EXTENSION_IDS: &[&str] = &["kmokhdhoggbdcgoepifeckhgbfakaknm"];

/// Chromium-family browsers and where they keep their host manifests, relative to `~`.
/// Each entry's PARENT must already exist for us to install into it.
const BROWSERS: &[(&str, &str)] = &[
    ("Chrome", "Library/Application Support/Google/Chrome"),
    (
        "Chrome Beta",
        "Library/Application Support/Google/Chrome Beta",
    ),
    (
        "Chrome Canary",
        "Library/Application Support/Google/Chrome Canary",
    ),
    ("Chromium", "Library/Application Support/Chromium"),
    (
        "Brave",
        "Library/Application Support/BraveSoftware/Brave-Browser",
    ),
    ("Edge", "Library/Application Support/Microsoft Edge"),
    ("Vivaldi", "Library/Application Support/Vivaldi"),
    ("Arc", "Library/Application Support/Arc/User Data"),
    (
        "Opera",
        "Library/Application Support/com.operasoftware.Opera",
    ),
];

#[derive(Serialize)]
struct HostManifest {
    name: String,
    description: String,
    path: String,
    #[serde(rename = "type")]
    kind: String,
    allowed_origins: Vec<String>,
}

fn manifest_for(proxy: &Path) -> HostManifest {
    HostManifest {
        name: HOST_NAME.to_string(),
        description: "Bramble password manager".to_string(),
        path: proxy.display().to_string(),
        kind: "stdio".to_string(),
        allowed_origins: ALLOWED_EXTENSION_IDS
            // The trailing slash is not decoration: Chrome matches these as origins and
            // silently ignores an entry without it.
            .iter()
            .map(|id| format!("chrome-extension://{id}/"))
            .collect(),
    }
}

/// The proxy that sits beside the running binary.
///
/// In development that is `target/debug/`; in a bundle it is `Contents/MacOS/` on macOS and
/// `/usr/bin` from the `.deb`. Every packaging path now puts it there, which the .deb, Nix and
/// cask tests each assert, and the shipped 0.2.0 disk image carries it.
pub fn proxy_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("bramble-proxy"))
}

/// Write the manifest for one browser. `browser_dir` is the browser's support directory, not
/// the NativeMessagingHosts directory inside it.
fn install_into(browser_dir: &Path, proxy: &Path) -> std::io::Result<()> {
    let hosts = browser_dir.join("NativeMessagingHosts");
    fs::create_dir_all(&hosts)?;
    let body = serde_json::to_vec_pretty(&manifest_for(proxy))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let path = hosts.join(format!("{HOST_NAME}.json"));
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &body)?;
    fs::rename(&tmp, &path)
}

/// Install into every browser present under `home`, returning the ones written.
///
/// Failures are collected rather than propagated: one browser with awkward permissions must
/// not stop the others from working.
pub fn install_all(home: &Path, proxy: &Path) -> Vec<&'static str> {
    let mut installed = Vec::new();
    for (name, relative) in BROWSERS {
        let dir = home.join(relative);
        // Absence means the browser is not installed, which is not a failure.
        if !dir.is_dir() {
            continue;
        }
        match install_into(&dir, proxy) {
            Ok(()) => installed.push(*name),
            Err(e) => log::warn!("native messaging manifest for {name}: {e}"),
        }
    }
    installed
}

/// Refresh every manifest against the running binary's location. Called at startup, which is
/// what keeps them correct across an app update or the app being moved.
pub fn refresh() {
    #[cfg(not(target_os = "macos"))]
    {
        log::info!("native messaging manifests: not implemented on this platform");
    }
    #[cfg(target_os = "macos")]
    {
        let Some(proxy) = proxy_path() else {
            log::error!("native messaging manifests: cannot locate the proxy");
            return;
        };
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            log::error!("native messaging manifests: no HOME");
            return;
        };
        let installed = install_all(&home, &proxy);
        if installed.is_empty() {
            log::info!("native messaging manifests: no supported browser found");
        } else {
            log::info!("native messaging manifests: installed for {installed:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn home_with(browsers: &[&str]) -> TempDir {
        let home = tempfile::tempdir().expect("temp dir");
        for relative in browsers {
            fs::create_dir_all(home.path().join(relative)).unwrap();
        }
        home
    }

    fn read_manifest(home: &Path, relative: &str) -> serde_json::Value {
        let path = home
            .join(relative)
            .join("NativeMessagingHosts")
            .join(format!("{HOST_NAME}.json"));
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn installs_only_for_browsers_that_exist() {
        let home = home_with(&["Library/Application Support/Google/Chrome"]);
        let installed = install_all(home.path(), Path::new("/tmp/bramble-proxy"));

        assert_eq!(installed, vec!["Chrome"]);
        // Never conjure up a profile directory for a browser that is not installed.
        assert!(!home
            .path()
            .join("Library/Application Support/Vivaldi")
            .exists());
    }

    #[test]
    fn the_manifest_has_the_shape_chrome_requires() {
        let home = home_with(&["Library/Application Support/Chromium"]);
        install_all(home.path(), Path::new("/opt/bramble/bramble-proxy"));

        let m = read_manifest(home.path(), "Library/Application Support/Chromium");
        assert_eq!(m["name"], HOST_NAME);
        assert_eq!(m["type"], "stdio");
        assert_eq!(m["path"], "/opt/bramble/bramble-proxy");
        // Chrome matches allowed_origins as origins; without the trailing slash it silently
        // ignores the entry and the connection is refused with no explanation.
        assert_eq!(
            m["allowed_origins"][0],
            "chrome-extension://kmokhdhoggbdcgoepifeckhgbfakaknm/"
        );
    }

    #[test]
    fn the_host_name_is_legal_for_chrome() {
        // Lowercase alphanumerics, underscores and dots; no leading, trailing or doubled dot.
        assert!(HOST_NAME
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.'));
        assert!(!HOST_NAME.starts_with('.') && !HOST_NAME.ends_with('.'));
        assert!(!HOST_NAME.contains(".."));
    }

    #[test]
    fn the_id_is_the_published_one_not_the_signing_key() {
        // Guards a mistake that costs an afternoon: cws-public.pem derives
        // hmflaieknajdnnmkdaphfglgjnoakkih, which is the upload-signing key rather than the
        // item id, and nothing would connect.
        assert_eq!(
            ALLOWED_EXTENSION_IDS,
            ["kmokhdhoggbdcgoepifeckhgbfakaknm"],
            "must match the store listing and packages/manifests/chromium's key"
        );
    }

    #[test]
    fn a_rerun_rewrites_a_stale_proxy_path() {
        // What an app update or a drag to another folder leaves behind.
        let home = home_with(&["Library/Application Support/Google/Chrome"]);
        install_all(home.path(), Path::new("/old/location/bramble-proxy"));
        install_all(home.path(), Path::new("/new/location/bramble-proxy"));

        let m = read_manifest(home.path(), "Library/Application Support/Google/Chrome");
        assert_eq!(m["path"], "/new/location/bramble-proxy");
    }

    #[test]
    fn a_missing_hosts_directory_is_created() {
        let home = home_with(&["Library/Application Support/Google/Chrome"]);
        // A fresh browser profile has the support directory but no NativeMessagingHosts.
        install_all(home.path(), Path::new("/tmp/bramble-proxy"));
        assert!(home
            .path()
            .join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
            .is_dir());
    }

    #[test]
    fn every_browser_entry_is_distinct() {
        // A duplicated path would silently mean one browser overwrites another's manifest.
        let mut paths: Vec<_> = BROWSERS.iter().map(|(_, p)| *p).collect();
        paths.sort_unstable();
        let before = paths.len();
        paths.dedup();
        assert_eq!(paths.len(), before, "duplicate browser directory");
    }
}
