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
///
/// On Wayland this minimises instead, and the reason is worth keeping. KWin draws the titlebar
/// server-side and sends the app a close request when the X is clicked; a window that has been
/// hidden and shown again stops acting on that request, so the button goes dead while dragging
/// the same titlebar still works, because KWin does the dragging itself. Hiding unmaps the
/// surface, and it is the unmapping that breaks it. Minimising keeps the surface mapped, and
/// `skip_taskbar` is what makes a minimised window feel closed rather than parked.
pub fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        if wayland() {
            let _ = window.set_skip_taskbar(true);
            let _ = window.minimize();
        } else {
            let _ = window.hide();
        }
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
    if wayland() {
        let _ = window.set_skip_taskbar(false);
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Whether this is a Wayland session, which is the only place the minimise dance is needed.
/// X11 unmaps and remaps without losing anything, and there the window really should disappear
/// rather than sit minimised.
fn wayland() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some()
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
    //
    // Nobody does that inverting for us anywhere else. Ayatana draws the pixels it is given, and
    // the pixels are pure black, so on a dark Plasma panel the icon is a black smudge. Off macOS
    // the shape is therefore drawn in whichever of the two variants the theme calls for, and
    // `set_tray_theme` swaps it when the theme changes.
    match Image::from_bytes(tray_icon_bytes(false)) {
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

/// The same artwork in two colours: black for a light panel, white for a dark one. `tray-light`
/// is generated from `tray.png` by whitening the RGB and keeping the alpha, since the shape lives
/// entirely in the alpha channel.
fn tray_icon_bytes(dark_theme: bool) -> &'static [u8] {
    if dark_theme {
        include_bytes!("../icons/tray-light.png")
    } else {
        include_bytes!("../icons/tray.png")
    }
}

/// Repaint the tray for a light or dark surround.
///
/// Driven from the webview rather than read from the desktop, because the app already resolves
/// this: it follows the OS through `prefers-color-scheme` when the user's theme is "system", and
/// follows the user when they have picked one. Reading the desktop directly would need a portal
/// round trip and would then disagree with the app whenever those two differ.
///
/// A no-op on macOS, which does its own inverting from the template and would only be made worse
/// by being told what to do.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn set_tray_theme(app: &AppHandle, dark_theme: bool) {
    #[cfg(not(target_os = "macos"))]
    {
        // Repainting is not free on Linux. Under libayatana the icon cannot be handed over as
        // bytes, so the tray crate writes a temporary PNG and points GTK at a new icon theme
        // search path, and GTK rescans. Doing that on every call, when the frontend re-reports a
        // theme that has not changed, is how a tray icon starts costing frames.
        static APPLIED: std::sync::Mutex<Option<bool>> = std::sync::Mutex::new(None);
        let mut applied = match APPLIED.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if *applied == Some(dark_theme) {
            return;
        }

        let Some(tray) = app.tray_by_id("main") else {
            return;
        };
        let started = std::time::Instant::now();
        match Image::from_bytes(tray_icon_bytes(dark_theme)) {
            Ok(icon) => {
                if let Err(e) = tray.set_icon(Some(icon)) {
                    log::warn!("could not repaint the tray icon: {e}");
                    return;
                }
                *applied = Some(dark_theme);
                // Timed because a stutter here is invisible in a profile taken anywhere else:
                // the work happens in the panel, not in this process.
                log::info!(
                    "tray icon -> {} in {}ms",
                    if dark_theme { "light" } else { "dark" },
                    started.elapsed().as_millis()
                );
            }
            Err(e) => log::warn!("tray icon variant unavailable: {e}"),
        }
    }
}
