import type { PasskeyCredential } from "../hooks/useVault";
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

/** A passkey the provider just stored, for a confirmation toast. */
export interface PasskeySavedInfo {
	rpId: string;
	/** The login the passkey attached to / the new login created for it. */
	loginName: string;
	/** True when a new login was created; false when attached to an existing one. */
	created: boolean;
}

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
	/** Whether this platform can detach the UI into a standalone window. False on single-window hosts (mobile), which hides the pop-out affordance. */
	supportsPopOut: boolean;
	/** True where `scanQrFromActiveTab` is a live camera scan (mobile) rather than an active-tab capture; gates camera-scan affordances (e.g. scanning a pairing QR). */
	supportsCameraScan: boolean;
	/** Whether WebAuthn security-key unlock works here. False on mobile (iOS doesn't pass `prf` to authenticators, Android is NFC-blocked), where biometric unlock replaces it. Gates the security-key UI. */
	supportsSecurityKeys: boolean;
	/** Whether this platform can capture a submitted login and offer to save it (the corner-prompt flow). True on the extension; false on mobile (no save hook wired). Gates the "Offer to save logins" setting. See docs/mobile-port.md. */
	supportsSaveCapture: boolean;
	/** Whether this platform can act as a WebAuthn passkey provider for other sites. True on the Chromium extension (chrome.webAuthenticationProxy); false elsewhere. Gates the passkey-provider setting. See docs/passkey-provider.md. */
	supportsPasskeyProvider: boolean;
	/** Attach/detach the passkey provider at runtime (extension only; paired with supportsPasskeyProvider). Persisting the pref is the caller's job; this just applies it now. */
	setPasskeyProviderEnabled?(enabled: boolean): Promise<void>;
	/** Subscribe to passkey-provider saves so the UI can confirm them (extension only). Returns an unsubscribe. */
	onPasskeySaved?(callback: (info: PasskeySavedInfo) => void): () => void;
	/**
	 * Mobile only: drain passkeys the native credential provider minted during a sign-in
	 * registration and return them decrypted, so the app can persist them into the vault (the
	 * sandboxed extension can't write it). Cleared on read; resolves [] when none. Absent where
	 * there's no native provider. See docs/passkey-provider.md.
	 */
	consumePendingPasskeys?(): Promise<PasskeyCredential[]>;
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
		iceUrl?: string;
		groupKeyB64: string;
		psk: string;
		roster: RosterPayload;
		entries: EntriesPayload;
		/** This device's password-slot fields (base64) so a joining device can prove its
		 * typed password matches; omitted when this device has no password slot. */
		passwordCheck?: { saltB64: string; slotIdB64: string; verifierB64: string };
	}): Promise<void>;
	/** Enrollment (joiner): connect to the inviter from a decoded pairing code; the offscreen rebuilds the vault, unlocked by a password or a security-key slot (exactly one). `ownEntry` is handed to the inviter so both rosters end up symmetric. */
	startEnrollJoin(opts: {
		relayUrl: string;
		iceUrl?: string;
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
	/** Joiner: a human-readable reason a join failed recoverably (e.g. password mismatch). */
	message?: string;
}
