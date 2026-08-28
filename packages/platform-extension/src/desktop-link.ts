/// <reference types="chrome" />

// The popup/options side of the desktop link. Every call is a message to the background,
// which owns the native port and the stored keys; no key material or code is handled here.
// See background/desktop-link.ts.

import type { DesktopLinkAdapter, DesktopLinkStatus } from "@core/adapters/desktop-link";
import { api } from "./platform-api";

async function dispatch<T = unknown>(type: string, extra?: Record<string, unknown>): Promise<T> {
	const res = await api.runtime.sendMessage({ type, ...extra });
	if (!res?.ok) throw new Error(res?.error ?? `${type} failed`);
	return res.data as T;
}

/**
 * Whether this browser can talk to the desktop app at all.
 *
 * The link is native messaging, and only the Chromium manifest asks for the permission: the
 * desktop app writes Chromium-shaped host manifests (`allowed_origins`) into Chromium support
 * directories, and Firefox wants `allowed_extensions` in a Mozilla one. So on Firefox there is
 * nothing at either end, and offering to connect would be a settings section whose only outcome
 * is an error.
 *
 * Read from the manifest rather than sniffing the browser, so this turns itself on the day
 * Firefox support is added rather than needing to be remembered.
 *
 * BOTH permission arrays count. Chromium asks for `nativeMessaging` at connect time rather than
 * at install (see docs/desktop-link-optional-permission.md), so it is declared optional there;
 * declaring it required again must keep working. This answers "could this browser ever do it",
 * not "may it right now" — that is `permission.granted()`, and it is the only honest test, since
 * `typeof api.runtime.connectNative` goes stale in both directions across a grant or a revoke.
 */
const canNativeMessage = (): boolean => {
	try {
		const manifest = api.runtime.getManifest();
		const declared = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
		return declared.includes("nativeMessaging");
	} catch {
		return false;
	}
};

const adapter: DesktopLinkAdapter = {
	status: () => dispatch<DesktopLinkStatus>("DESKTOP_LINK_STATUS"),
	// The code goes straight through to the background and is never stored here.
	pair: async (code) => {
		await dispatch("DESKTOP_LINK_PAIR", { code });
	},
	connect: () => dispatch<boolean>("DESKTOP_LINK_CONNECT"),
	query: async (hostname) => {
		const answer = await dispatch<{ ok: boolean; error?: string; matches?: unknown[] }>(
			"DESKTOP_LINK_QUERY",
			{ hostname },
		);
		if (!answer.ok) throw new Error(answer.error ?? "query failed");
		return (answer.matches ?? []) as { id: string; name: string; secondary: string }[];
	},
	// The invite the app armed when the user clicked Connect. Null rather than an error when
	// there is none: the app arms one only while its dialog is open, and a version that predates
	// this arms none at all, so "no invite" is an ordinary answer and not a fault.
	claimSyncInvite: () => dispatch<string | null>("DESKTOP_LINK_CLAIM_INVITE"),
	desktopSyncKey: () => dispatch<string | null>("DESKTOP_LINK_SYNC_KEY"),
	unlink: async () => {
		await dispatch("DESKTOP_LINK_UNLINK");
	},
};

/** Undefined where the browser cannot do it, which is what hides the Settings section. */
export const extensionDesktopLink: DesktopLinkAdapter | undefined = canNativeMessage()
	? adapter
	: undefined;
