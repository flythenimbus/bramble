import type { EntriesPayload, RosterEntry, RosterPayload } from "../sync";

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
	/** Tear down the offscreen sync host (enrollment / ongoing sync). */
	stopSyncSpike(): Promise<void>;
	/** Subscribe to the sync host's status lines (shown in the dev panel). Returns an unsubscribe function. */
	onSyncStatus(callback: (status: string) => void): () => void;
	/** This device's Noise static public key (base64), for the roster and pairing code. Generated + persisted on first call. */
	syncDevicePublicKey(): Promise<string>;
	/** Enrollment (inviter): listen on the group's relay room and hand the joiner the bundle (roster + entries; the VEK is added in the offscreen). */
	startEnrollInvite(opts: {
		relayUrl: string;
		groupKeyB64: string;
		psk: string;
		roster: RosterPayload;
		entries: EntriesPayload;
	}): Promise<void>;
	/** Enrollment (joiner): connect to the inviter from a decoded pairing code; the offscreen rebuilds the vault, unlocked by a password or a security-key slot (exactly one). `ownEntry` is handed to the inviter so both rosters end up symmetric. */
	startEnrollJoin(opts: {
		relayUrl: string;
		groupKeyB64: string;
		psk: string;
		inviterPub: string;
		ownEntry: RosterEntry;
		password?: string;
		webauthn?: { hmacSecretB64: string; credentialIdB64: string; saltB64: string };
	}): Promise<void>;
	/** Subscribe to structured enrollment events from the sync host (e.g. the joiner's rebuilt vault). Returns an unsubscribe function. */
	onSyncEvent(callback: (event: SyncEvent) => void): () => void;
}

/** A structured event from the sync host (vs. the human-readable status strings). */
export interface SyncEvent {
	kind: string;
	/** Joiner: the rebuilt, VEK-wrapped vault blob (base64) for the host to write. */
	vaultBlobB64?: string;
	roster?: RosterPayload;
	/** Inviter: a joining device's roster entry (JSON), to add to our roster. */
	entryJson?: string;
}
