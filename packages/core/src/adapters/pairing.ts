/**
 * Linking this device with a browser extension over a local channel.
 *
 * Desktop only, and absent everywhere else: the extension has no second app to link with, and
 * mobile has no local socket. Where it is undefined the Settings section simply does not
 * render, which is why nothing here is capability-gated in flags.ts.
 *
 * The user opens a Connect dialog here and presses Link in the extension; both screens show
 * symbols from the handshake, and both must confirm they match. A label the browser gives is
 * only what it *claims* to be, so the symbols are the authentication, not the name. See
 * docs/desktop-link-onboarding.md.
 */

/** A browser that completed a link and may open authenticated sessions. */
export interface PairedBrowser {
	/** The peer's static public key. This is the identity; everything else is display. */
	publicKey: string;
	/**
	 * What the browser called itself when it linked, such as "Chrome on Mac". Assertable by
	 * whatever connected, so it is context for the user and never proof of anything. Show it,
	 * do not decide anything on it.
	 */
	label: string;
	/** Epoch ms. */
	pairedAt: number;
}

export interface PairingAdapter {
	/** The browsers linked to the vault open now. */
	list(): Promise<PairedBrowser[]>;
	/**
	 * This device's own pairing identity. Exists to be *shown when it fails*: if the key has
	 * gone from the OS credential store while browsers are still listed, nothing else in this
	 * interface notices, and the user sees a browser that simply never connects. The rejection
	 * message carries the recovery.
	 */
	identity(): Promise<string>;
	/** Revoke a browser from the vault open now. Its next connection fails, because its key is no
	 * longer accepted there. */
	forget(publicKey: string): Promise<boolean>;
	/**
	 * Arm the sync invite a browser may claim over the link once it has linked, so connecting a
	 * browser also brings it this vault.
	 *
	 * Armed for a window, not held indefinitely, and that is the security property rather than
	 * tidiness: an established link authenticates a browser, and authentication is not consent to
	 * hand over the vault today. The app answers a claim only while this is armed, which means the
	 * user clicked the button and re-entered their master password moments ago.
	 */
	armSyncInvite?(payload: string, ttlMs: number): Promise<void>;
	/** Disarm, for a dialog the user dismissed. Dismissing is a refusal. */
	clearSyncInvite?(): Promise<void>;
	/** Publish what the open vault holds, for the browser linking now; null clears it. */
	setVaultSummary?(
		summary: { name: string; empty: boolean; entries: number; backupTargets?: boolean } | null,
	): Promise<void>;
	/** Accept an emoji link while the Connect dialog is open. */
	beginLinkWindow?(): Promise<void>;
	/** The dialog closed: refuse any link in progress and drop the invite. */
	cancelLinkWindow?(): Promise<void>;
	/** This screen's answer to the emoji comparison. */
	answerLink?(approved: boolean): Promise<void>;
	/** A browser finished the link handshake and waits on both answers. Returns an unsubscribe. */
	onLinkPending?(cb: (pending: { sasHashB64: string; label: string }) => void): () => void;
	/** A link settled, either way. Returns an unsubscribe. */
	onLinkDone?(cb: (paired: boolean) => void): () => void;
}
