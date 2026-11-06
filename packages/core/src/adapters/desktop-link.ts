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

import type { PairingSas } from "../sync/pairing-sas";

export interface DesktopLinkStatus {
	paired: boolean;
	/** Epoch ms, when paired. */
	pairedAt?: number;
	/**
	 * Whether the host still holds the permission the link needs.
	 *
	 * `paired && !permitted` is the one state worth saying out loud: the user revoked it in the
	 * browser's own settings, so a link that looks connected can do nothing until it is granted
	 * again. Optional, and undefined means "not reported"; only an explicit `false` should be
	 * treated as revoked, so a host that never answers this is never accused of it.
	 */
	permitted?: boolean;
}

export interface DesktopLinkAdapter {
	status(): Promise<DesktopLinkStatus>;
	/**
	 * Pair using the code shown in the desktop app. Rejects if the app refuses it, which it
	 * does identically for a wrong code, an expired one and one already used: the app
	 * deliberately does not say which, so this cannot report it either.
	 */
	pair(code: string): Promise<void>;
	/**
	 * Start linking by emoji: resolves with the emoji to show once the handshake is done, or
	 * `{ legacy: true }` for an app that only knows the code. Absent where only the code exists.
	 */
	start?(): Promise<{ id: string; sas: PairingSas } | { legacy: true }>;
	/** The user's answer to the emoji. Resolves once the app has approved too; nothing is stored
	 * otherwise. */
	confirm?(id: string, matches: boolean): Promise<void>;
	/** Let go of a link the user walked away from. */
	cancel?(id: string): Promise<void>;
	/** What the desktop app's vault holds, asked right after linking and before claiming its
	 * invite: the app answers only the browser that just linked. Null when it will not say. */
	vaultSummary?(): Promise<{
		name: string;
		empty: boolean;
		entries: number;
		backupTargets?: boolean;
	} | null>;
	/** Reconnect over the established keys. True when the desktop app accepted. */
	connect(): Promise<boolean>;
	/**
	 * Ask the desktop app what it holds for a hostname. Answers with metadata only: id, name
	 * and a secondary line, never a credential. Rejects with "locked" when the desktop vault
	 * is locked, which covers the metadata too.
	 */
	query(hostname: string): Promise<{ id: string; name: string; secondary: string }[]>;
	/**
	 * Claim the sync invite the app armed when the user clicked Connect, so pairing is one code
	 * and one click rather than two of each. Null when there is none, which is ordinary: the app
	 * arms one only while its dialog is open, and an older version arms none at all.
	 *
	 * The returned string is the same pairing code a user would otherwise carry by hand, so it
	 * goes straight to `startJoin`.
	 */
	claimSyncInvite?(): Promise<string | null>;
	/**
	 * The desktop app's sync device key, so the UI can tell whether the vault on screen is one
	 * the app shares. The link is per-BROWSER but a sync group is per-VAULT, so "connected" is
	 * true of the browser while saying nothing about the vault you happen to be standing in.
	 *
	 * A public key, published in the roster to every group member already, and it describes the
	 * device rather than any vault: the comparison happens here, against rosters this browser
	 * already holds, so nothing about the app's vaults is disclosed. Null when the app is not
	 * running or predates this.
	 */
	desktopSyncKey?(): Promise<string | null>;
	/**
	 * Attach the link just made to the vault that now holds the desktop's, once the app has listed
	 * it. False when the app will not (its window closed, or the link expired): the link is let go.
	 */
	attach?(vaultId: string): Promise<boolean>;
	/** Let go of a link made in a flow that ended without a vault. Nothing is kept on either side. */
	abandon?(): Promise<void>;
	/** Forget a deleted vault's link: a key the desktop app would still accept. */
	forgetVault?(vaultId: string): Promise<void>;
	/** Forget the open vault's link on this side, and say how many vaults still have one. Revoking
	 * on the app's side is separate; doing both is what fully severs the link. */
	unlink(): Promise<{ remaining: number }>;
	/**
	 * The browser permission the link needs, where the host asks for it at runtime instead of
	 * being granted it at install.
	 *
	 * Absent where there is nothing to ask for, which callers must read as "already allowed"
	 * rather than "not allowed": a host that holds the permission from install has no runtime
	 * question to answer, and gating the UI on this being present would hide the feature on
	 * exactly those hosts. See docs/desktop-link-optional-permission.md.
	 */
	permission?: {
		/**
		 * Whether the browser holds it right now.
		 *
		 * The only honest test. Do not substitute "is the native API callable", which goes stale
		 * in both directions: a context created before a grant never gains the binding, and one
		 * created before a revoke keeps it.
		 */
		granted(): Promise<boolean>;
		/**
		 * Ask the user for it, resolving false if they decline.
		 *
		 * Must be called from a user gesture, and only from a surface that survives a modal
		 * browser dialog. On Chromium the toolbar popup does not: it is torn down when the prompt
		 * takes focus, and this promise dies with it while the grant still lands. The caller is
		 * responsible for being somewhere durable first.
		 */
		request(): Promise<boolean>;
		/** Hand it back. Paired with unlink, so severing the link also returns what it needed. */
		drop(): Promise<void>;
	};
}
