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
//! Two mechanisms. macOS and Linux drop a JSON file into each browser's own profile
//! directory. Windows keeps the same JSON in ONE place and has each browser's registry key
//! point at it, because that is what Chromium reads there: `HKCU\Software\<vendor>\<browser>
//! \NativeMessagingHosts\<host>`, whose default value is the path to the file. So the Windows
//! table is a path AND a key, and `install_all` writes a value rather than a file.
//!
//! Firefox is absent on all three: it reads a different manifest schema from a different
//! location, and the Firefox build of the extension declares `nativeMessaging` in neither
//! permission array, so a host manifest for it would be something no browser would ever act
//! on. See docs/desktop-port.md.
//!
//! Nothing here depends on HOW the Chromium extension holds that permission. It is optional there
//! now, asked for when the user connects rather than at install, but this file keys on the
//! extension id and a browser refuses an unpermitted `connectNative` before any manifest is
//! consulted. So a manifest written for a browser that has not been granted it yet is harmless
//! and correct: it is what makes the connection work the moment the user says yes.
//! See docs/desktop-link-optional-permission.md.

use std::{
    fs,
    path::{Path, PathBuf},
};

// Only `browser_root_from` takes one, and only the two platforms that resolve a root from the
// environment have it.
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::ffi::OsStr;

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

/// The same again for Windows, with the registry key each browser reads appended.
///
/// The middle field is still a profile directory, relative to `%LOCALAPPDATA%`, and still
/// exists for exactly one reason: to answer "is this browser actually installed" before
/// writing anything. Creating `HKCU\Software\Google\Chrome` on a machine with no Chrome is
/// the registry's version of conjuring up a profile directory, and it is just as rude.
///
/// Which is why the third field is the key the browser READS rather than the key that
/// belongs to it, and why those are not always the same: a fork can be installed and still
/// look somewhere else entirely. Detection and destination are therefore separate columns,
/// and two browsers pointing at one key is expected rather than a mistake.
///
/// Opera is absent, unlike on the other two platforms. Its Windows profile lives under roaming
/// `%APPDATA%` rather than `%LOCALAPPDATA%`, so it does not fit this table, and which key it
/// reads for native messaging is not something to guess at when getting it wrong means writing
/// into another vendor's tree. See docs/desktop-port.md.
#[cfg(windows)]
const BROWSERS: &[(&str, &str, &str)] = &[
    (
        "Chrome",
        r"Google\Chrome\User Data",
        r"Software\Google\Chrome",
    ),
    (
        "Chrome Beta",
        r"Google\Chrome Beta\User Data",
        r"Software\Google\Chrome Beta",
    ),
    (
        "Chrome Dev",
        r"Google\Chrome Dev\User Data",
        r"Software\Google\Chrome Dev",
    ),
    // Canary's directory and key are both "SxS", which is Chrome's own name for a side-by-side
    // install, not a typo.
    (
        "Chrome Canary",
        r"Google\Chrome SxS\User Data",
        r"Software\Google\Chrome SxS",
    ),
    ("Chromium", r"Chromium\User Data", r"Software\Chromium"),
    (
        "Brave",
        r"BraveSoftware\Brave-Browser\User Data",
        r"Software\BraveSoftware\Brave-Browser",
    ),
    (
        "Brave Beta",
        r"BraveSoftware\Brave-Browser-Beta\User Data",
        r"Software\BraveSoftware\Brave-Browser-Beta",
    ),
    (
        "Edge",
        r"Microsoft\Edge\User Data",
        r"Software\Microsoft\Edge",
    ),
    // Vivaldi reads CHROME's key rather than its own. Not a guess and not laziness: a
    // manifest under `Software\Vivaldi\NativeMessagingHosts` is never read, so the browser
    // answers "Specified native messaging host not found" with a correct-looking key sitting
    // right there, which is as misleading as it sounds. KeePassXC hit the same thing
    // (keepassxreboot/keepassxc-browser#48). So Vivaldi's own directory still decides whether
    // it is installed, and what gets written is Chrome's key. This is the one case where the
    // rule above about not creating another vendor's key has to give: the alternative is a
    // browser the app can never talk to.
    ("Vivaldi", r"Vivaldi\User Data", r"Software\Google\Chrome"),
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
#[cfg(any(target_os = "macos", target_os = "linux"))]
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

/// Chromium keeps its profiles under the LOCAL AppData on Windows, not the roaming one the
/// vault sits in: profile directories are large and machine-specific, and roaming them would
/// be a mistake the browsers do not make.
#[cfg(windows)]
fn browser_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
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
    // Tauri strips the target triple off a sidecar when it bundles it but keeps the extension,
    // so what lands beside the app on Windows is `bramble-proxy.exe`.
    let name = if cfg!(windows) {
        "bramble-proxy.exe"
    } else {
        "bramble-proxy"
    };
    let beside = exe.parent()?.join(name);
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

/// Serialise the manifest and put it at `path`, through a temporary file so a browser reading
/// it concurrently never sees half a document.
fn write_manifest(path: &Path, proxy: &Path) -> std::io::Result<()> {
    let body = serde_json::to_vec_pretty(&manifest_for(proxy))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &body)?;
    fs::rename(&tmp, path)
}

/// Write the manifest for one browser. `browser_dir` is the browser's support directory, not
/// the NativeMessagingHosts directory inside it.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn install_into(browser_dir: &Path, proxy: &Path) -> std::io::Result<()> {
    let hosts = browser_dir.join("NativeMessagingHosts");
    fs::create_dir_all(&hosts)?;
    write_manifest(&hosts.join(format!("{HOST_NAME}.json")), proxy)
}

/// Install into every browser present under `root`, returning the ones written.
///
/// `root` is what `browser_root` resolved: the home directory on macOS, XDG_CONFIG_HOME on
/// Linux. Failures are collected rather than propagated: one browser with awkward permissions
/// must not stop the others from working.
#[cfg(any(target_os = "macos", target_os = "linux"))]
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

/// Where the one manifest file lives on Windows.
///
/// One file for every browser, rather than a copy per profile directory, because nothing on
/// Windows reads a file it found by looking: each browser is handed this path by its own
/// registry value. Kept in the app's data directory, beside the vault and the pipe, so an
/// uninstall that removes that directory takes it too.
#[cfg(windows)]
fn manifest_file(data_dir: &Path) -> PathBuf {
    data_dir.join(format!("{HOST_NAME}.json"))
}

/// Point one browser's registry at the manifest.
///
/// The value is the key's DEFAULT (the empty name), which is what Chromium reads; a named
/// value here would be ignored and the host would look installed while doing nothing.
#[cfg(windows)]
fn install_into(browser_key: &str, manifest: &Path) -> std::io::Result<()> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    // HKCU, never HKLM: this is a per-user install and writing the machine hive would need
    // elevation the app does not have and should not ask for.
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(format!(r"{browser_key}\NativeMessagingHosts\{HOST_NAME}"))?;
    key.set_value("", &manifest.display().to_string())
}

/// Write the manifest once, then point every installed browser at it.
///
/// `root` is `%LOCALAPPDATA%` and `data_dir` is the app's own directory. Split rather than
/// derived because the two live under different roots on Windows (local versus roaming), which
/// is exactly the sort of thing that is wrong for a year before anyone notices.
#[cfg(windows)]
pub fn install_all(root: &Path, data_dir: &Path, proxy: &Path) -> Vec<&'static str> {
    let manifest = manifest_file(data_dir);
    if let Err(e) = write_manifest(&manifest, proxy) {
        // Nothing below this is worth doing: every key would name a file that is not there.
        log::error!("native messaging manifest {}: {e}", manifest.display());
        return Vec::new();
    }

    let mut installed = Vec::new();
    for (name, relative, key) in BROWSERS {
        // Absence means the browser is not installed, which is not a failure.
        if !root.join(relative).is_dir() {
            continue;
        }
        match install_into(key, &manifest) {
            Ok(()) => installed.push(*name),
            Err(e) => log::warn!("native messaging registry key for {name}: {e}"),
        }
    }
    installed
}

/// Refresh every manifest against the running binary's location. Called at startup, which is
/// what keeps them correct across an app update or the app being moved.
pub fn refresh() {
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        log::info!("native messaging manifests: not implemented on this platform");
    }
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    {
        let Some(proxy) = proxy_path() else {
            log::error!("native messaging manifests: cannot locate the proxy");
            return;
        };
        let Some(root) = browser_root() else {
            log::error!("native messaging manifests: no profile root");
            return;
        };
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let installed = install_all(&root, &proxy);
        #[cfg(windows)]
        let installed = {
            let Some(data_dir) = crate::socket_addr::app_data_dir() else {
                log::error!("native messaging manifests: no APPDATA");
                return;
            };
            if let Err(e) = fs::create_dir_all(&data_dir) {
                log::error!("native messaging manifests: {}: {e}", data_dir.display());
                return;
            }
            install_all(&root, &data_dir, &proxy)
        };
        if installed.is_empty() {
            log::info!("native messaging manifests: no supported browser found");
        } else {
            log::info!("native messaging manifests: installed for {installed:?} -> {proxy:?}");
        }
    }
}

/// Tests that hold on every platform: the host name, the extension id, and the shape of the
/// document itself. None of them touch the browser table, which is a different shape per
/// platform, or the install step, which is a file on unix and a registry value on Windows.
#[cfg(test)]
mod tests_common {
    use super::*;

    #[test]
    fn the_manifest_has_the_shape_chrome_requires() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("host.json");
        write_manifest(&at, Path::new("/opt/bramble/bramble-proxy")).unwrap();

        let m: serde_json::Value = serde_json::from_slice(&fs::read(&at).unwrap()).unwrap();
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
    fn a_rewrite_leaves_no_temp_file_behind() {
        // Rewritten on every launch, so the temp-and-rename must not accumulate.
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("host.json");
        write_manifest(&at, Path::new("/old/bramble-proxy")).unwrap();
        write_manifest(&at, Path::new("/new/bramble-proxy")).unwrap();

        let m: serde_json::Value = serde_json::from_slice(&fs::read(&at).unwrap()).unwrap();
        assert_eq!(m["path"], "/new/bramble-proxy");
        assert!(!dir.path().join("host.tmp").exists());
    }

    #[test]
    fn every_browser_entry_is_distinct() {
        // A duplicated path would silently mean one browser overwrites another's manifest.
        // Only the DIRECTORY has to be unique: on Windows two browsers may legitimately read
        // one registry key, which `vivaldi_is_pointed_at_chromes_key` covers.
        #[cfg(windows)]
        let mut paths: Vec<_> = BROWSERS.iter().map(|(_, p, _)| *p).collect();
        #[cfg(not(windows))]
        let mut paths: Vec<_> = BROWSERS.iter().map(|(_, p)| *p).collect();
        paths.sort_unstable();
        let before = paths.len();
        paths.dedup();
        assert_eq!(paths.len(), before, "duplicate browser directory");
    }

    /// Vivaldi reads Chrome's key, and this locks that in because it looks exactly like a bug.
    ///
    /// Anyone tidying this table will see a Vivaldi row pointing at `Software\Google\Chrome`,
    /// assume it is a copy-paste error, and "fix" it. The symptom that follows is a browser
    /// that reports the host as not found while a perfectly well-formed key sits under
    /// `Software\Vivaldi`, which is a slow afternoon to diagnose a second time.
    #[test]
    #[cfg(windows)]
    fn vivaldi_is_pointed_at_chromes_key() {
        let (_, _, key) = BROWSERS
            .iter()
            .find(|(name, _, _)| *name == "Vivaldi")
            .expect("Vivaldi is in the table");
        assert_eq!(
            *key, r"Software\Google\Chrome",
            "Vivaldi does not read its own NativeMessagingHosts key; see the comment on the table"
        );
    }

    /// hooks.nsh mirrors this table by hand.
    #[test]
    #[cfg(windows)]
    fn the_uninstaller_knows_every_key_we_write() {
        let hooks = include_str!("../windows/hooks.nsh");
        for (name, _, key) in BROWSERS {
            let expected = format!(r#"{key}\NativeMessagingHosts\{HOST_NAME}"#);
            assert!(
                hooks.contains(&expected),
                "hooks.nsh has no cleanup for {name}'s registry key ({expected})"
            );
        }
    }

    /// The purge line names an NSIS path that fails silently on a missing file, so pin it
    /// against the crate name.
    #[test]
    fn the_purge_command_names_the_binary_the_installer_installs() {
        let hooks = include_str!("../windows/hooks.nsh");
        let expected =
            format!(r#"nsExec::Exec '"$INSTDIR\{}.exe" --purge-secrets'"#, env!("CARGO_PKG_NAME"));
        assert!(
            hooks.contains(&expected),
            "hooks.nsh purges through `{expected}`, which is not what the installer installs"
        );
    }

    #[test]
    fn every_browser_directory_is_a_relative_path() {
        // A leading slash would make `root.join(..)` discard the root, which in a test writes
        // to a temp dir and in the app writes to somebody's real profile.
        #[cfg(windows)]
        let entries: Vec<(&str, &str)> = BROWSERS.iter().map(|(n, p, _)| (*n, *p)).collect();
        #[cfg(not(windows))]
        let entries: Vec<(&str, &str)> = BROWSERS.iter().map(|(n, p)| (*n, *p)).collect();
        for (name, relative) in entries {
            assert!(
                Path::new(relative).is_relative(),
                "{name} is not relative: {relative}"
            );
        }
    }
}

/// The registry half, which only Windows has.
#[cfg(all(test, windows))]
mod tests_windows {
    use super::*;
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    /// A scratch key of our own, so the test exercises the real registry without touching a
    /// browser's tree. Removed on the way out whether or not the assertions held.
    struct ScratchKey(String);

    impl ScratchKey {
        fn new(tag: &str) -> Self {
            Self(format!(
                r"Software\Bramble-test-{}-{tag}",
                std::process::id()
            ))
        }
    }

    impl Drop for ScratchKey {
        fn drop(&mut self) {
            let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.0);
        }
    }

    #[test]
    fn the_manifest_path_lands_in_the_default_value() {
        // Chromium reads the key's DEFAULT value. A named value would leave the host looking
        // installed while the browser finds nothing, which is the failure this pins down.
        let scratch = ScratchKey::new("default");
        let manifest = Path::new(r"C:\Users\someone\AppData\Roaming\app.bramble.desktop\host.json");
        install_into(&scratch.0, manifest).expect("write the key");

        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(format!(r"{}\NativeMessagingHosts\{HOST_NAME}", scratch.0))
            .expect("key exists");
        let value: String = key.get_value("").expect("default value");
        assert_eq!(value, manifest.display().to_string());
    }

    #[test]
    fn a_rerun_replaces_a_stale_path() {
        // What an app update or a move leaves behind. Rewritten every launch for this reason.
        let scratch = ScratchKey::new("stale");
        install_into(&scratch.0, Path::new(r"C:\Old\host.json")).unwrap();
        install_into(&scratch.0, Path::new(r"C:\New\host.json")).unwrap();

        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(format!(r"{}\NativeMessagingHosts\{HOST_NAME}", scratch.0))
            .unwrap();
        let value: String = key.get_value("").unwrap();
        assert_eq!(value, r"C:\New\host.json");
    }

    #[test]
    fn a_browser_that_is_not_installed_gets_no_key() {
        // The registry equivalent of not conjuring up a profile directory: an empty root means
        // no browser is present, so nothing should be written for any of them.
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let installed = install_all(
            root.path(),
            data.path(),
            Path::new(r"C:\x\bramble-proxy.exe"),
        );
        assert!(installed.is_empty());
        // The manifest is still written: it is keyed to the app, not to any browser, and the
        // next browser to appear should find it already there.
        assert!(manifest_file(data.path()).is_file());
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
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
        assert_eq!(
            fs::metadata(&first).unwrap().permissions().mode() & 0o777,
            0o755
        );

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
}
