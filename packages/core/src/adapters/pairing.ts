/**
 * Pairing this device with a browser extension over a local channel.
 *
 * Desktop only, and absent everywhere else: the extension has no second app to pair with, and
 * mobile has no local socket. Where it is undefined the Settings section simply does not
 * render, which is why nothing here is capability-gated in flags.ts.
 *
 * The user carries a short code from this app to the extension. That code is the whole
 * authentication: the approval it replaces could only ever display what a caller *claimed* to
 * be, so a malicious local process could assert any extension id and race the real one to be
 * the request the user approved. See docs/desktop-port.md.
 */

/** A browser that completed pairing and may open authenticated sessions. */
export interface PairedBrowser {
	/** The peer's static public key. This is the identity; everything else is display. */
	publicKey: string;
	/**
	 * What the browser called itself when it paired, usually its extension id. Assertable by
	 * whatever connected, so it is context for the user and never proof of anything. Show it,
	 * do not decide anything on it.
	 */
	label: string;
	/** Epoch ms. */
	pairedAt: number;
}

export interface PairingAdapter {
	/**
	 * Open a pairing window and return the code to show. The code is a bearer secret for its
	 * lifetime: display it, never log it, and stop showing it the moment the user looks away.
	 * Single-use, expires, and burns after a handful of wrong attempts.
	 */
	begin(): Promise<string>;
	/**
	 * Close the pairing window. Call this when the dialog is dismissed, not merely for tidiness:
	 * a code left live is a usable secret nobody is watching.
	 */
	cancel(): Promise<void>;
	/** Whether a code is still outstanding, so the UI can stop showing an expired one. */
	isOpen(): Promise<boolean>;
	list(): Promise<PairedBrowser[]>;
	/** Revoke a browser. Its next connection fails, because its key is no longer accepted. */
	forget(publicKey: string): Promise<boolean>;
}
