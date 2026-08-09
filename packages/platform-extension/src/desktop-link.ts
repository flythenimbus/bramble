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

export const extensionDesktopLink: DesktopLinkAdapter = {
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
