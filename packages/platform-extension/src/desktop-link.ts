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
	unlink: async () => {
		await dispatch("DESKTOP_LINK_UNLINK");
	},
};
