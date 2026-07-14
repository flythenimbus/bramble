import type { PasskeyCredential } from "../hooks/useVault";
import type { EntriesPayload, RosterEntry, RosterPayload } from "../sync";
import type { SubdomainMatchMode } from "./autofill";

/** Minimal login shape for current-tab matching: id + the fields the hostname policy reads. */
export interface CurrentTabLogin {
	id: string;
	urls: string[];
	subdomainMatch?: SubdomainMatchMode;
}

/** State carried from the originating popup into a freshly-opened detached window so the pop-out lands on the same route. */
export interface PopOutHandoff {
	/** Router href to restore, e.g. "/vault/new/card". */
	path: string;
	/** Serializable form snapshot of the active route, or undefined when there's nothing to restore. Transported via chrome.storage.session not the URL, since a draft can contain a plaintext password. */
	draft?: unknown;
}

/** Full-tab screens the options page can boot into, via `?screen=`. Default (omitted) is the vault setup flow. */
export type OptionsScreen = "import" | "restore";

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
	/**
	 * Save bytes to a file the user keeps, for the vault export / backup flow. Extension: a
	 * download. Absent where there is no save mechanism, which hides the export affordance.
	 * The bytes are the encrypted vault, so the file is safe at rest (still needs the master
	 * password to open).
	 */
	exportBytes?(suggestedName: string, bytes: Uint8Array, mimeType: string): Promise<void>;
	/**
	 * Origin (protocol + hostname[:port]) of the active tab, to pre-populate "Website URL".
	 * Null for chrome://, about:, non-http(s) pages, or when the tab can't be read.
	 */
	getCurrentTabOrigin(): Promise<string | null>;
	/**
	 * Ids of `logins` matching the active tab under each login's subdomain policy,
	 * to surface current-site matches at the top of the list. The platform owns the
	 * eTLD+1 matching. Empty when there's no current site (mobile, chrome://).
	 */
	matchCurrentTab(logins: CurrentTabLogin[]): Promise<string[]>;
	/**
	 * Call immediately before opening a native file picker. On single-window hosts (mobile)
	 * the OS picker backgrounds the app, which would trip the "Immediately" auto-lock and drop
	 * the in-progress import/keyfile selection; this keeps the vault unlocked across that one
	 * background→foreground cycle. Absent on the extension, where pickers run in a full tab
	 * whose session isn't foreground-gated (no-op).
	 */
	notifyFilePickerOpening?(): void;
	/** Open the current UI in a detached window so it doesn't dismiss on focus loss, closing the originating popup. `handoff` resumes the route + draft. */
	popOut(handoff?: PopOutHandoff): Promise<void>;
	/** Read (and clear) the handoff stashed by a preceding popOut(). Null when there's nothing to restore. Called once during boot. */
	consumeHandoff(): Promise<PopOutHandoff | null>;
	/**
	 * Persist the current route so a normal (non-detached) popup resumes where it was after
	 * being closed and reopened while the session is still unlocked. Fire-and-forget; only
	 * the path is stored (never a form draft, which can hold a plaintext password). Absent
	 * where the UI context is long-lived (mobile), which never loses its route.
	 */
	persistRoute?(path: string): void;
	/** Read the route stashed by persistRoute (null when none). Called once at boot; the caller restores it only when the vault is unlocked. */
	restoreRoute?(): Promise<string | null>;
	/** True when already running inside a popped-out window; used to hide the pop-out affordance there. */
	isDetached(): boolean;
	// Static per-target capability flags live in flags.ts `CAPABILITIES` (resolved via `useCan`).
	/**
	 * Connect a one-click backup provider end to end: run the interactive OAuth flow, exchange the
	 * code, and persist the resulting target (a new one, or `targetId` to reconnect an existing one).
	 * The whole flow runs in the extension's background service worker so it survives the popup
	 * closing when the provider window steals focus, so a caller in a popup that gets torn down mid-flow
	 * still ends up with a saved target (visible on reopen). Extension only; absent on mobile, which
	 * keeps the OAuth tiles "coming soon". See docs/cloud-storage-backups.md.
	 */
	connectBackupOAuth?(providerId: string, opts?: { targetId?: string }): Promise<void>;
	/** Attach/detach the passkey provider at runtime (extension only; paired with the passkeyProvider capability). Persisting the pref is the caller's job; this just applies it now. */
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
	/** This device's Ed25519 roster-signing verify key (base64), for authenticated roster entries
	 * (Item A). Generated + persisted on first call. Optional: absent on hosts not yet signing-capable,
	 * where entries stay unsigned (verify-if-present tolerates that during rollout). Paired with signRoster. */
	syncSigningPublicKey?(): Promise<string>;
	/** Ed25519-sign a canonical roster-entry string (see canonicalRosterEntry). Paired with syncSigningPublicKey. */
	signRoster?(canonical: string): Promise<string>;
	/** This device's admission verify key (base64), derived from the master password + this device's
	 * password-slot salt (Item A rogue-injection close). Published in the device's roster entry so
	 * peers can verify which NEW devices this one admits. Requires a fresh password entry; the signing
	 * key is derived transiently in the crypto host and never stored. Optional: absent on hosts without
	 * password-authority admission. See docs/p2p-sync-revocation-hardening.md. */
	syncAdmissionPublicKey?(password: string, saltB64: string): Promise<string>;
	/** Admission-sign an admitted device's canonical roster entry with THIS device's password-derived
	 * admission key (see syncAdmissionPublicKey). Requires a fresh password entry. Paired with it. */
	syncAdmissionSign?(password: string, saltB64: string, canonical: string): Promise<string>;
	/** Clear all of this device's local sync state (group, device keys, relay) so a freshly created
	 * vault starts as an un-enrolled device — sync identity belongs to the vault, not the browser.
	 * Optional: platforms with no local sync state may omit it. */
	resetSyncState?(): Promise<void>;
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
	/** For kind "synced": epoch ms of the reconcile, carrying the "last synced" tick to the UI (mobile). */
	at?: number;
}
