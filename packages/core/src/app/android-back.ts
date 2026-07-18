// Bridge for the mobile host's Android hardware/gesture back button. The listener lives in
// platform-mobile's Root - outside the router tree - and the router uses memory history, so the
// webview's window.history is irrelevant. InnerApp registers a handler bound to its router, and the
// host calls tryAppBack() when the main app view (not a setup/import/restore overlay) is showing.
let handler: (() => boolean) | null = null;

/** Register (or clear with null) the app's back handler. The fn steps the router back and returns
 * true, or returns false when there's nowhere left to go. */
export function setAppBackHandler(fn: (() => boolean) | null): void {
	handler = fn;
}

/** Ask the app to go back. Returns true if it navigated; false (also when unregistered) means the
 * caller should do its platform default - e.g. minimize the app at the router root. */
export function tryAppBack(): boolean {
	return handler?.() ?? false;
}
