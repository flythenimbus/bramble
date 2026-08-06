//! The quick-access panel: a frameless, always-on-top window opened by a global hotkey.
//!
//! Lives in this process rather than a second binary, which is the whole reason the design
//! works: one process means one VEK, shared with the main window, with no cross-process key
//! handoff. See docs/desktop-port.md and issue #27 for what that hazard costs.
//!
//! The window is declared in tauri.conf.json (hidden, transparent, undecorated) so it exists
//! from launch; this module gives it the parts config cannot express: the native blur behind
//! the webview, the hotkey that toggles it, and dismissal on focus loss.

use std::sync::Mutex;

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

/// Where the panel's top-left was placed when it opened. The panel grows downward as results
/// appear, so the anchor has to survive a resize: macOS measures a window from its bottom-left
/// corner, and letting height changes push the top around would make the search field move
/// under the user mid-keystroke.
static ANCHOR: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// Height of the search row on its own, matching the `h-16` header in spotlight.tsx. What the
/// panel collapses to when there is nothing to show. Kept in step with that class by hand: if
/// it drifts low the panel opens short and jumps once the webview measures itself.
const COLLAPSED_HEIGHT: f64 = 64.0;

/// Never let the panel outgrow this, however many results match.
const MAX_HEIGHT: f64 = 460.0;

/// Must match the window label in tauri.conf.json.
pub const LABEL: &str = "spotlight";

/// Toggled with Cmd+Shift+Space on macOS, Ctrl+Shift+Space elsewhere. Deliberately not
/// Cmd+Space, which is Spotlight's; this is the binding 1Password's quick access uses.
pub const HOTKEY: &str = "CmdOrCtrl+Shift+Space";

/// Put the native blur behind the webview. Failure is logged rather than propagated: an
/// opaque panel is a cosmetic loss, and it is the expected outcome on Linux, which has no
/// standard compositor blur to ask for.
pub fn apply_backdrop(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        // HudWindow is the material the system's own floating panels use, and it stays dark
        // in both appearances rather than following the desktop tint.
        match apply_vibrancy(
            window,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            // The window itself stays square; this is what gives the panel its shape, so the
            // radius is a visual decision rather than a detail. Matches the system's own
            // floating panels rather than the 12 used for ordinary cards.
            Some(16.0),
        ) {
            Ok(()) => log::info!("spotlight backdrop: vibrancy applied"),
            Err(e) => log::warn!("spotlight backdrop unavailable: {e}"),
        }
    }
    #[cfg(target_os = "windows")]
    {
        // Acrylic rather than Mica: Mica is a desktop-wallpaper tint for long-lived windows,
        // where this is a transient panel over whatever happens to be underneath.
        if let Err(e) = window_vibrancy::apply_acrylic(window, Some((18, 18, 18, 125))) {
            log::warn!("spotlight backdrop unavailable: {e}");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = window;
        log::info!("spotlight backdrop: no blur on this platform, panel stays opaque");
    }
}

/// Show the panel if hidden, hide it if shown. Everything is best-effort: a hotkey that
/// silently does nothing is better than one that can bring the process down.
pub fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        log::error!("spotlight window missing");
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    // Open collapsed. The webview clears its query on focus and will ask to grow if anything
    // matches; starting at the last size would flash an empty results area first.
    if let Ok(scale) = window.scale_factor() {
        if let Ok(size) = window.outer_size() {
            let width = size.to_logical::<f64>(scale).width;
            let _ = window.set_size(LogicalSize::new(width, COLLAPSED_HEIGHT));
        }
    }
    position(app, &window);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Place the panel on the display the user is actually looking at, a little above centre.
///
/// `center()` alone is wrong twice over: it centres on whichever monitor the window happens
/// to already be on rather than the active one, and dead centre reads as low for something
/// you type into. Falls back to `center()` whenever the cursor or its monitor cannot be
/// resolved, so a headless or unusual display setup still gets a usable position.
fn position(app: &AppHandle, window: &WebviewWindow) {
    let fallback = || {
        let _ = window.center();
    };
    let (Ok(cursor), Ok(size)) = (app.cursor_position(), window.outer_size()) else {
        return fallback();
    };
    let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) else {
        return fallback();
    };

    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin = area.position.to_logical::<f64>(scale);
    let work = area.size.to_logical::<f64>(scale);
    let panel = size.to_logical::<f64>(scale);

    let x = origin.x + (work.width - panel.width) / 2.0;
    // Golden-ish rather than centred: sits where the eye already is.
    let y = origin.y + (work.height - panel.height) * 0.28;
    log::info!(
        "spotlight position: cursor=({:.0},{:.0}) work={:.0}x{:.0}@({:.0},{:.0}) panel={:.0}x{:.0} -> ({:.0},{:.0})",
        cursor.x, cursor.y, work.width, work.height, origin.x, origin.y, panel.width, panel.height, x, y
    );
    *ANCHOR.lock().unwrap() = Some((x, y));
    let _ = window.set_position(LogicalPosition::new(x, y));
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

/// Dismiss from the webview (Escape). Hiding rather than closing keeps the window and its
/// React tree alive, so the next open is instant.
#[tauri::command]
pub fn spotlight_hide(app: AppHandle) {
    hide(&app);
}

/// Track the content height, so the panel is a bare search field until there is something to
/// show and grows only as far as it needs.
///
/// This is the content-fitting the main window deliberately does not do, and the difference
/// is not inconsistency. A vault window that moves under you is wrong; a launcher that does
/// not is broken, because an empty results area is dead space the user has to look past.
/// The content here is also bounded and deterministic, which is what made it unworkable on
/// the main window's internally-scrolling screens.
#[tauri::command]
pub fn spotlight_set_height(app: AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let target = height.clamp(COLLAPSED_HEIGHT, MAX_HEIGHT);
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let current = match window.outer_size() {
        Ok(size) => size.to_logical::<f64>(scale),
        Err(_) => return,
    };
    if (current.height - target).abs() < 1.0 {
        return;
    }
    let _ = window.set_size(LogicalSize::new(current.width, target));
    // Re-pin the top-left. Without this the panel appears to crawl up the screen as it
    // grows, because the origin macOS keeps fixed is the opposite corner.
    if let Some((x, y)) = *ANCHOR.lock().unwrap() {
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
}
