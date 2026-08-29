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
//! macOS and Linux. Windows keeps this in the registry rather than the filesystem, so it is a
//! different mechanism and not a path table. Firefox is absent on both: it reads a different
//! manifest schema from a different directory, and the Firefox build of the extension declares
//! `nativeMessaging` in neither permission array, so a host manifest for it would be a file no
//! browser would ever act on. See docs/desktop-port.md.
//!
//! Nothing here depends on HOW the Chromium extension holds that permission. It is optional there
//! now, asked for when the user connects rather than at install, but this file keys on the
//! extension id and a browser refuses an unpermitted `connectNative` before any manifest is
//! consulted. So a manifest written for a browser that has not been granted it yet is harmless
//! and correct: it is what makes the connection work the moment the user says yes.
//! See docs/desktop-link-optional-permission.md.

use std::{
    ffi::OsStr,
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

/// Chromium-family browsers and where they keep their host manifests, relative to the root
/// `browser_root` resolves. Each entry's PARENT must already exist for us to install into it.
#[cfg(target_os = "macos")]
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

/// The same, under XDG_CONFIG_HOME rather than Application Support. Chrome's own directory
/// names here are its release channels rather than its display names, which is why "Dev" is
/// `-unstable`: that is what the package installs.
#[cfg(target_os = "linux")]
const BROWSERS: &[(&str, &str)] = &[
    ("Chrome", "google-chrome"),
    ("Chrome Beta", "google-chrome-beta"),
    ("Chrome Dev", "google-chrome-unstable"),
    ("Chromium", "chromium"),
    ("Brave", "BraveSoftware/Brave-Browser"),
    ("Brave Beta", "BraveSoftware/Brave-Browser-Beta"),
    ("Edge", "microsoft-edge"),
    ("Vivaldi", "vivaldi"),
    ("Opera", "opera"),
];

/// Where those relative paths start.
///
/// Two different roots because the platforms disagree about what a profile directory is
/// relative to: everything on macOS hangs off the home directory, where on Linux the browsers
/// read XDG_CONFIG_HOME. Honouring it matters more than it looks: a user who sets it takes
/// their profiles with them, and manifests written to ~/.config would land beside nothing.
///
/// Taken as arguments so the resolution is testable without touching the process environment,
/// which tests cannot do safely in parallel.
fn browser_root_from(xdg_config_home: Option<&OsStr>, home: Option<&OsStr>) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let _ = xdg_config_home;
        Some(PathBuf::from(home?))
    }
    #[cfg(target_os = "linux")]
    {
        xdg_config_home
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| Some(PathBuf::from(home?).join(".config")))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (xdg_config_home, home);
        None
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn browser_root() -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_CONFIG_HOME");
    let home = std::env::var_os("HOME");
    browser_root_from(xdg.as_deref(), home.as_deref())
}

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
///
/// The AppImage is the exception, and it is why this is not simply a join: it runs from a mount
/// point whose name changes on every launch, so the path beside the binary is one that stops
/// existing the moment the app does. A manifest naming it works until the next start and then
/// points at nothing, which the browser reports as the host being unavailable rather than as a
/// stale path. There the proxy is copied somewhere durable and that copy is named instead.
pub fn proxy_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let beside = exe.parent()?.join("bramble-proxy");
    #[cfg(target_os = "linux")]
    {
        // Set by the AppImage runtime to the image's own path, and by nothing else.
        if std::env::var_os("APPIMAGE").is_some() {
            return durable_copy(&beside);
        }
    }
    Some(beside)
}

/// Put the proxy where it will still be next launch, next to the socket it dials.
///
/// Copied on every start rather than when it looks stale: an update changes the binary and the
/// obvious cheap checks (length, mtime) both admit a version that did not change either. Through
/// a rename, not a write in place, because a browser may be running the previous copy and
/// replacing the file it is executing is a way to break a session that is working.
#[cfg(target_os = "linux")]
fn durable_copy(mounted: &Path) -> Option<PathBuf> {
    copy_into(&crate::socket_addr::app_data_dir()?, mounted)
}

#[cfg(target_os = "linux")]
fn copy_into(dir: &Path, mounted: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    fs::create_dir_all(dir).ok()?;
    let dest = dir.join("bramble-proxy");
    let tmp = dest.with_extension("tmp");
    fs::copy(mounted, &tmp).ok()?;
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).ok()?;
    fs::rename(&tmp, &dest).ok()?;
    Some(dest)
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

/// Install into every browser present under `root`, returning the ones written.
///
/// `root` is what `browser_root` resolved: the home directory on macOS, XDG_CONFIG_HOME on
/// Linux. Failures are collected rather than propagated: one browser with awkward permissions
/// must not stop the others from working.
pub fn install_all(root: &Path, proxy: &Path) -> Vec<&'static str> {
    let mut installed = Vec::new();
    for (name, relative) in BROWSERS {
        let dir = root.join(relative);
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
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        log::info!("native messaging manifests: not implemented on this platform");
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let Some(proxy) = proxy_path() else {
            log::error!("native messaging manifests: cannot locate the proxy");
            return;
        };
        let Some(root) = browser_root() else {
            log::error!("native messaging manifests: no HOME");
            return;
        };
        let installed = install_all(&root, &proxy);
        if installed.is_empty() {
            log::info!("native messaging manifests: no supported browser found");
        } else {
            log::info!("native messaging manifests: installed for {installed:?} -> {proxy:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// The first browser in this platform's table, and the last, so the fixtures follow the
    /// table rather than restating it: the macOS paths hang off Application Support and the
    /// Linux ones off XDG_CONFIG_HOME, and a test naming either directly would only ever run
    /// on one of them.
    const FIRST: (&str, &str) = BROWSERS[0];
    const LAST: (&str, &str) = BROWSERS[BROWSERS.len() - 1];

    fn root_with(browsers: &[&str]) -> TempDir {
        let root = tempfile::tempdir().expect("temp dir");
        for relative in browsers {
            fs::create_dir_all(root.path().join(relative)).unwrap();
        }
        root
    }

    fn read_manifest(root: &Path, relative: &str) -> serde_json::Value {
        let path = root
            .join(relative)
            .join("NativeMessagingHosts")
            .join(format!("{HOST_NAME}.json"));
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn installs_only_for_browsers_that_exist() {
        let root = root_with(&[FIRST.1]);
        let installed = install_all(root.path(), Path::new("/tmp/bramble-proxy"));

        assert_eq!(installed, vec![FIRST.0]);
        // Never conjure up a profile directory for a browser that is not installed.
        assert!(!root.path().join(LAST.1).exists());
    }

    #[test]
    fn the_manifest_has_the_shape_chrome_requires() {
        let root = root_with(&[FIRST.1]);
        install_all(root.path(), Path::new("/opt/bramble/bramble-proxy"));

        let m = read_manifest(root.path(), FIRST.1);
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
    fn every_browser_directory_is_a_relative_path() {
        // A leading slash would make `root.join(..)` discard the root, which in a test writes
        // to a temp dir and in the app writes to somebody's real profile.
        for (name, relative) in BROWSERS {
            assert!(
                Path::new(relative).is_relative(),
                "{name} is not relative: {relative}"
            );
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn linux_follows_xdg_config_home() {
        let home = std::ffi::OsString::from("/home/someone");
        let xdg = std::ffi::OsString::from("/config/xdg");
        assert_eq!(
            browser_root_from(Some(&xdg), Some(&home)).unwrap(),
            PathBuf::from("/config/xdg")
        );
        assert_eq!(
            browser_root_from(None, Some(&home)).unwrap(),
            PathBuf::from("/home/someone/.config")
        );
        // Relative values are ignored rather than resolved, as the specification says and as
        // the browsers themselves do.
        let relative = std::ffi::OsString::from("config");
        assert_eq!(
            browser_root_from(Some(&relative), Some(&home)).unwrap(),
            PathBuf::from("/home/someone/.config")
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_roots_at_the_home_directory() {
        let home = std::ffi::OsString::from("/Users/someone");
        let xdg = std::ffi::OsString::from("/config/xdg");
        // XDG means nothing here: the browsers do not read it, so honouring it would write
        // manifests somewhere no browser looks.
        assert_eq!(
            browser_root_from(Some(&xdg), Some(&home)).unwrap(),
            PathBuf::from("/Users/someone")
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn the_appimage_copy_is_executable_and_replaces_the_old_one() {
        use std::os::unix::fs::PermissionsExt;

        let mount = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let mounted = mount.path().join("bramble-proxy");
        fs::write(&mounted, b"#!/bin/true\nfirst").unwrap();

        let first = copy_into(data.path(), &mounted).expect("copied");
        assert_eq!(fs::read(&first).unwrap(), b"#!/bin/true\nfirst");
        // The browser executes this file; a copy that is not executable is a host that cannot
        // start, which Chrome reports only as the port disconnecting.
        assert_eq!(fs::metadata(&first).unwrap().permissions().mode() & 0o777, 0o755);

        // An update: same destination, new bytes, and no leftover .tmp beside it.
        fs::write(&mounted, b"#!/bin/true\nsecond").unwrap();
        let second = copy_into(data.path(), &mounted).expect("copied again");
        assert_eq!(second, first);
        assert_eq!(fs::read(&second).unwrap(), b"#!/bin/true\nsecond");
        assert!(!data.path().join("bramble-proxy.tmp").exists());
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
        // What an app update, a drag to another folder, or a new AppImage mount leaves behind.
        let root = root_with(&[FIRST.1]);
        install_all(root.path(), Path::new("/old/location/bramble-proxy"));
        install_all(root.path(), Path::new("/new/location/bramble-proxy"));

        let m = read_manifest(root.path(), FIRST.1);
        assert_eq!(m["path"], "/new/location/bramble-proxy");
    }

    #[test]
    fn a_missing_hosts_directory_is_created() {
        let root = root_with(&[FIRST.1]);
        // A fresh browser profile has the support directory but no NativeMessagingHosts.
        install_all(root.path(), Path::new("/tmp/bramble-proxy"));
        assert!(root
            .path()
            .join(FIRST.1)
            .join("NativeMessagingHosts")
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
