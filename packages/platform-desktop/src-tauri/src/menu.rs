//! The application menu. **macOS only.**
//!
//! Built by hand rather than taking `Menu::default`, for two items: an About panel that says who
//! wrote this and under what licence, and a "Check for Updates…" that does not require knowing
//! Settings has an Updates section. Everything else here is the platform's standard menu, rebuilt
//! because customising one submenu means owning the whole bar.
//!
//! Edit is not optional. Without it, Cmd-C and Cmd-V stop working in the webview — in a password
//! manager, of all things. That is a macOS responder-chain requirement and does not transfer:
//! WebKitGTK and WebView2 handle the clipboard keys themselves.
//!
//! Off macOS there is no menu at all. A menu bar there is drawn *inside* the window, so it spends
//! a strip of a 600x580 window on File > Quit (the tray has it), Window > Minimize (the title bar
//! has it) and About plus Check for Updates, both of which are in Settings. macOS is the one
//! platform where the bar belongs to the screen rather than the window, and so costs nothing.
//!
//! macOS renders only some of `AboutMetadata`: name, version, short_version, copyright, icon and
//! credits. `authors`, `license` and `website` are accepted and silently dropped, so everything
//! worth showing goes through `credits` instead. It renders as plain text, so the source URL is
//! selectable rather than clickable.

#[cfg(target_os = "macos")]
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, Runtime,
};

#[cfg(target_os = "macos")]
/// Menu item id and the event the webview listens for. One string, so they cannot drift.
pub const CHECK_FOR_UPDATES: &str = "check-for-updates";

#[cfg(target_os = "macos")]
const SOURCE_URL: &str = "https://github.com/flythenimbus/bramble";
#[cfg(target_os = "macos")]
const AUTHOR: &str = "flythenimbus";

#[cfg(target_os = "macos")]
fn about<R: Runtime>(app: &AppHandle<R>) -> AboutMetadata<'static> {
    let version = app.package_info().version.to_string();
    AboutMetadata {
        name: Some("Bramble".into()),
        version: Some(version),
        copyright: Some(format!("© 2026 {AUTHOR}")),
        // The panel shows this verbatim under the version. Kept to four short lines: it is a
        // credits box, not a README.
        credits: Some(format!(
            "By {AUTHOR}\n\nFree software under the GNU General Public License v3.0.\n{SOURCE_URL}"
        )),
        // Set for the platforms that use them; macOS ignores all three.
        authors: Some(vec![AUTHOR.into()]),
        license: Some("GPL-3.0-only".into()),
        website: Some(SOURCE_URL.into()),
        website_label: Some("Source code".into()),
        ..Default::default()
    }
}

#[cfg(target_os = "macos")]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Absent, not greyed out, where the package manager owns updates: a disabled item invites the
    // question "why can I not check for updates", which is the wrong question to make someone ask.
    // See crate::can_self_update.
    let updatable = crate::can_self_update();
    let check = MenuItem::with_id(app, CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    {
        // The first submenu IS the app menu on macOS, and its items are the ones under the app
        // name. Order follows the platform convention: About, then app-specific items, then the
        // Services/Hide/Quit block macOS users expect to find in fixed positions.
        // Bound to locals first: the submenu takes references, so each item has to outlive the
        // slice, and the conditional update check means it cannot be one expression any more.
        let about_item = PredefinedMenuItem::about(app, Some("About Bramble"), Some(about(app)))?;
        let sep1 = PredefinedMenuItem::separator(app)?;
        let services = PredefinedMenuItem::services(app, None)?;
        let sep2 = PredefinedMenuItem::separator(app)?;
        let hide = PredefinedMenuItem::hide(app, None)?;
        let hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let show_all = PredefinedMenuItem::show_all(app, None)?;
        let sep3 = PredefinedMenuItem::separator(app)?;
        let quit = PredefinedMenuItem::quit(app, None)?;

        let mut items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![&about_item];
        if updatable {
            items.push(&check);
        }
        for item in [
            &sep1 as &dyn tauri::menu::IsMenuItem<R>,
            &services,
            &sep2,
            &hide,
            &hide_others,
            &show_all,
            &sep3,
            &quit,
        ] {
            items.push(item);
        }
        let app_menu = Submenu::with_items(app, "Bramble", true, &items)?;
        Menu::with_items(app, &[&app_menu, &edit, &window])
    }

}

#[cfg(target_os = "macos")]
/// Route the one item that does something of ours. The check itself runs in the webview, which
/// already owns the updater adapter, the dialog copy and the progress UI; duplicating that here
/// would mean two implementations of "is there an update" that could disagree.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id != CHECK_FOR_UPDATES {
        return;
    }
    // Bring the window back first: the menu is reachable with every window closed or hidden, and
    // a modal dialog belonging to nothing visible is a dialog that looks like it came from
    // nowhere.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit(CHECK_FOR_UPDATES, ());
}

// The update manifest served from the website is the live update channel, and a malformed one is
// not a quiet failure: the updater calls `res.json()` on any 2xx that is not 204, so anything it
// cannot parse surfaces as an error rather than "no update". Worse, the site answers unknown paths
// with 200 and an HTML page, so a missing file fails the same way. Parsing the committed manifest
// here catches that before it is deployed rather than after.
#[cfg(all(test, any(target_os = "macos", windows, target_os = "linux")))]
mod manifest_tests {
    use tauri_plugin_updater::RemoteRelease;

    const MANIFEST: &str = include_str!("../../../../website/public/desktop/latest.json");

    #[test]
    fn update_manifest_parses_and_names_every_target_we_ship() {
        let release: RemoteRelease =
            serde_json::from_str(MANIFEST).expect("latest.json must deserialize as a RemoteRelease");

        // Resolved BEFORE the version comparison in the plugin, so a manifest missing the running
        // target errors out even when it advertises an older version than the one installed.
        for target in ["darwin-aarch64", "darwin-x86_64"] {
            release
                .download_url(target)
                .unwrap_or_else(|_| panic!("latest.json has no entry for {target}"));
            release
                .signature(target)
                .unwrap_or_else(|_| panic!("latest.json has no signature for {target}"));
        }
    }
}
