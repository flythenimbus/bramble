/**
 * The extension's side of the link to the Bramble desktop app.
 *
 * The mirror of `PairingAdapter`: the desktop app *shows* a code, this *types* one. Two
 * adapters rather than one because the roles are not symmetric, and an interface covering both
 * would be half-undefined on each side.
 *
 * Extension only. Absent on desktop (which is the other end) and on mobile (no local socket),
 * where the Settings section then does not render.
 */

export interface DesktopLinkStatus {
	paired: boolean;
	/** Epoch ms, when paired. */
	pairedAt?: number;
}

export interface DesktopLinkAdapter {
	status(): Promise<DesktopLinkStatus>;
	/**
	 * Pair using the code shown in the desktop app. Rejects if the app refuses it, which it
	 * does identically for a wrong code, an expired one and one already used: the app
	 * deliberately does not say which, so this cannot report it either.
	 */
	pair(code: string): Promise<void>;
	/** Reconnect over the established keys. True when the desktop app accepted. */
	connect(): Promise<boolean>;
	/** Forget the desktop app on this side. Revoking on the app's side is separate; doing
	 * both is what fully severs the link. */
	unlink(): Promise<void>;
}
