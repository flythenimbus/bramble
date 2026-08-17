// Two things the window needs that the platform does not give us off macOS.
//
// Both exist because `muda`, the menu library under Tauri, documents its `close_window` and `quit`
// predefined items as **unsupported on Linux**. So the menu carries no Ctrl-W and no Ctrl-Q there
// however it is built, and removing the menu bar cost nothing that was working. The keystrokes
// have to be handled where they land instead, which is here.
//
// macOS is excluded from all of it: its menu supplies Cmd-W and Cmd-Q properly, and its tray
// inverts a template icon by itself.

import { invoke } from "@tauri-apps/api/core";

const isMac = navigator.userAgent.includes("Macintosh");

/**
 * Ctrl-W closes to the tray and Ctrl-Q quits, matching what the menu would have done.
 *
 * Not registered as global shortcuts: those are grabbed system-wide, and a password manager
 * swallowing Ctrl-W for every other application would be hostile.
 */
export function installWindowShortcuts() {
	if (isMac) return;
	window.addEventListener("keydown", (event) => {
		if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
		const key = event.key.toLowerCase();
		if (key !== "w" && key !== "q") return;
		event.preventDefault();
		// Quit is deliberate and unrecoverable-ish (the schedule stops with the process), where
		// closing just hides. Both are what the platform's own accelerators mean.
		void invoke(key === "w" ? "hide_to_tray" : "quit_app").catch(() => {});
	});
}

/**
 * Keep the tray icon legible against the panel.
 *
 * The icon ships as a macOS template: pure black pixels carrying their shape in the alpha channel,
 * which macOS inverts to suit the menu bar. Nobody does that for us on Linux, so ayatana draws
 * black-on-black in a dark panel. The app already resolves light versus dark and writes it to the
 * root element's class list, so watching that is both free and correct: it follows the OS while
 * the theme is "system" and follows the user once they pick one.
 */
export function syncTrayTheme() {
	if (isMac) return;
	const root = document.documentElement;
	let last: boolean | undefined;
	let queued: ReturnType<typeof setTimeout> | undefined;
	const push = () => {
		const dark = root.classList.contains("dark");
		if (dark === last) return;
		last = dark;
		void invoke("tray_theme", { dark }).catch(() => {});
	};
	// Coalesced, and kept off the first paint. Repainting the tray is expensive on Linux: the icon
	// cannot be passed as bytes, so it goes to disk and the panel reloads it. The theme provider
	// settles the class in the same tick it mounts, so an immediate call competes with showing the
	// window for the first time. A tray icon that is correct a moment later costs nothing; a
	// stuttering launch is the thing people notice.
	const schedule = () => {
		clearTimeout(queued);
		queued = setTimeout(push, 250);
	};
	schedule();
	new MutationObserver(schedule).observe(root, { attributes: true, attributeFilter: ["class"] });
}
