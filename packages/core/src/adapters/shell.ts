/** State carried from the originating popup into a freshly-opened detached window so the pop-out lands on the same route. */
export interface PopOutHandoff {
	/** Router href to restore, e.g. "/vault/new/card". */
	path: string;
	/** Serializable form snapshot of the active route, or undefined when there's nothing to restore. Transported via chrome.storage.session not the URL, since a draft can contain a plaintext password. */
	draft?: unknown;
}

/** Full-tab screens the options page can boot into, via `?screen=`. Default (omitted) is the vault setup flow. */
export type OptionsScreen = "import";

export interface ShellAdapter {
	/** Host extension's display name, read from its manifest. Single source of truth for the user-facing brand. */
	appName: string;
	/** Host extension's version string, read from its manifest. Shown on the Settings "About" row. */
	version: string;
	/**
	 * Open the platform's full-tab UI (e.g. the options page, where file pickers work reliably).
	 * No argument is the vault setup flow; pass a `screen` to land on another flow such as "import".
	 */
	openSetup(screen?: OptionsScreen): Promise<void>;
	/** Whether this context can show a native file picker (FSA API). False where blocked (e.g. Brave Shields); storage falls back to chrome.storage.local. */
	hasFilePicker(): boolean;
	/**
	 * Origin (protocol + hostname[:port]) of the active tab, to pre-populate "Website URL".
	 * Null for chrome://, about:, non-http(s) pages, or when the tab can't be read.
	 */
	getCurrentTabOrigin(): Promise<string | null>;
	/** Open the current UI in a detached window so it doesn't dismiss on focus loss, closing the originating popup. `handoff` resumes the route + draft. */
	popOut(handoff?: PopOutHandoff): Promise<void>;
	/** Read (and clear) the handoff stashed by a preceding popOut(). Null when there's nothing to restore. Called once during boot. */
	consumeHandoff(): Promise<PopOutHandoff | null>;
	/** True when already running inside a popped-out window; used to hide the pop-out affordance there. */
	isDetached(): boolean;
	/**
	 * Capture the active page and decode a single QR code, returning the decoded text (typically `otpauth://`) or null.
	 * Used to import a TOTP key off a site's 2FA setup page.
	 */
	scanQrFromActiveTab(): Promise<string | null>;
	/**
	 * Commit a parked corner-prompt capture if one is waiting. Called by `useVault.unlock` after a successful
	 * password-verify so a locked-vault "Unlock & save" flow finishes transparently. Returns true iff a handoff was consumed.
	 */
	flushPendingCornerCapture(): Promise<boolean>;
}
