//! Keeping the app alive independently of its main window.
//!
//! A launcher cannot die with the window it launches from. Tauri's default is to quit once
//! every window is destroyed, which would mean closing the vault window silently kills the
//! global hotkey and leaves no route back to the app. So the main window hides instead of
//! closing, a tray icon provides the way back, and macOS dock clicks reopen it.
//!
//! This is also the scaffolding the sync hub needs later: an always-on peer is only useful
//! if the process outlives the UI. See docs/desktop-port.md.

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

use crate::spotlight;

pub const MAIN: &str = "main";

/// Show or hide the Dock icon, following the main window.
///
/// macOS hangs this off the app's activation policy rather than off any window: `Regular`
/// means a Dock icon and a menu bar, `Accessory` means neither while still allowing windows
/// and keyboard focus. So a closed vault window leaves no Dock presence at all, and the app
/// stops appearing in Cmd+Tab, which is the shape a menu-bar-resident app is supposed to
/// have. The trade is that with no Dock icon there is nothing to click, so the tray is the
/// only route back; that is why the tray goes in first.
pub fn set_dock_visible(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let policy = if visible {
            ActivationPolicy::Regular
        } else {
            ActivationPolicy::Accessory
        };
        if let Err(e) = app.set_activation_policy(policy) {
            log::warn!("could not change activation policy: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows and Linux have no equivalent: taskbar presence is per-window, and the main
        // window's entry goes with it when it hides.
        let _ = (app, visible);
    }
}

/// Hide the vault window and give up the Dock icon with it.
pub fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.hide();
    }
    // After hiding, not before: dropping to Accessory while the window is still on screen
    // makes macOS reshuffle focus underneath it.
    set_dock_visible(app, false);
}

/// Bring the vault window back, from the tray or a dock click. Un-minimises too: hidden and
/// minimised are different states and the user means the same thing by both.
pub fn show_main(app: &AppHandle) {
    // Before showing, so the window arrives with a Dock icon already in place rather than
    // one that pops in a frame later.
    set_dock_visible(app, true);
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// The menu bar icon and its menu, which is the only visible affordance that the app is
/// still running once the main window is closed.
pub fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Bramble", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "Quick Access", true, Some(spotlight::HOTKEY))?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Bramble", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quick, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Bramble")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quick" => spotlight::toggle(app),
            // The only route that actually exits, now that closing the window does not.
            "quit" => app.exit(0),
            _ => {}
        });

    // A template image: macOS ignores the colour and renders the alpha, so the icon inverts
    // itself against a light or dark menu bar. Shipping the app icon here would put a black
    // rounded square up there that disappears in dark mode. See scripts/make-macos-icon.mjs.
    match Image::from_bytes(include_bytes!("../icons/tray.png")) {
        Ok(icon) => {
            builder = builder.icon(icon);
            #[cfg(target_os = "macos")]
            {
                builder = builder.icon_as_template(true);
            }
        }
        // Better a tray with the default icon than no tray at all: without one there is no
        // way back to a closed window.
        Err(e) => log::warn!("tray icon unavailable, falling back: {e}"),
    }

    builder.build(app)?;
    Ok(())
}
