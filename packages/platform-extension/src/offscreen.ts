/// <reference types="chrome" />

// Chrome offscreen-document entry. The crypto + sync host logic lives in the
// transport-free ./offscreen-core; this file only owns the Chrome transport: the
// runtime.onMessage listener, the storage bridge (round-tripping to the background
// SW, which owns chrome.storage), and the prefers-color-scheme reporter (the SW
// can't read it; this document can). On Firefox the same host runs in the background
// event page instead — see offscreen-client.ts.

import { handleHostMessage, type SyncBridge, setSyncBridge } from "./offscreen-core";
import { api } from "./platform-api";
import type { ApplyRemoteMsg } from "./sync/messages";

// Local read + merge + write happen in the background (it has chrome.storage); the
// offscreen document round-trips to it.
const chromeBridge: SyncBridge = {
	fetchLocalPayload: async () => {
		const r = await api.runtime.sendMessage({ type: "SYNC_LOCAL_PAYLOAD" });
		if (!r?.ok || typeof r.data !== "string") {
			throw new Error(r?.error ?? "local payload unavailable");
		}
		return r.data;
	},
	pushRemotePayload: async (payloadJson: string) => {
		const payload: ApplyRemoteMsg = { payloadJson };
		await api.runtime.sendMessage({ type: "SYNC_APPLY_REMOTE", payload });
	},
	fetchLocalRoster: async () => {
		const r = await api.runtime.sendMessage({ type: "SYNC_LOCAL_ROSTER" });
		return r?.ok && typeof r.data === "string" ? r.data : "";
	},
	pushRemoteRoster: async (rosterJson: string) => {
		await api.runtime.sendMessage({ type: "SYNC_APPLY_ROSTER", payload: { rosterJson } });
	},
};
setSyncBridge(chromeBridge);

// Report the OS colour scheme so the background can pick the matching monochrome
// toolbar icon. The service worker can't read prefers-color-scheme; this offscreen
// document can, and it stays alive to catch later changes.
const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
function reportColorScheme(): void {
	void api.runtime
		.sendMessage({ type: "THEME_ICON_SET", payload: { dark: colorScheme.matches } })
		.catch(() => {});
}
reportColorScheme();
colorScheme.addEventListener("change", reportColorScheme);

interface OffscreenMessage {
	target?: string;
	type?: string;
	payload?: unknown;
}

api.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
	if (message?.target !== "offscreen") return false;
	void handleHostMessage(message.type ?? "", message.payload).then(sendResponse);
	return true;
});
