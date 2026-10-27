/// <reference types="chrome" />

// Chrome offscreen-document entry. The crypto + sync host logic lives in the
// transport-free ./offscreen-core; this file only owns the Chrome transport: the
// runtime.onMessage listener, the storage bridge (round-tripping to the background
// SW, which owns chrome.storage), and the prefers-color-scheme reporter (the SW
// can't read it; this document can). On Firefox the same host runs in the background
// event page instead — see offscreen-client.ts.

import { handleHostMessage, type SyncBridge, setSyncBridge } from "./offscreen-core";
import { api } from "./platform-api";
import { isExtensionSender } from "./sender";
import type { ApplyRemoteMsg } from "./sync/messages";

// Local read + merge + write happen in the background (it has chrome.storage); the
// offscreen document round-trips to it.
const chromeBridge: SyncBridge = {
	fetchLocalPayload: async (vaultId) => {
		const r = await api.runtime.sendMessage({ type: "SYNC_LOCAL_PAYLOAD", payload: { vaultId } });
		if (!r?.ok || typeof r.data !== "string") {
			throw new Error(r?.error ?? "local payload unavailable");
		}
		return r.data;
	},
	pushRemotePayload: async (vaultId, payloadJson) => {
		const payload: ApplyRemoteMsg = { vaultId, payloadJson };
		const r = await api.runtime.sendMessage({ type: "SYNC_APPLY_REMOTE", payload });
		// A failed merge has to reach the session, which asks for the vault again: peers no longer
		// resend it every tick (docs/sync-rebroadcast.md).
		if (!r?.ok) throw new Error(r?.error ?? "merge failed");
	},
	fetchLocalRoster: async (vaultId) => {
		const r = await api.runtime.sendMessage({ type: "SYNC_LOCAL_ROSTER", payload: { vaultId } });
		return r?.ok && typeof r.data === "string" ? r.data : "";
	},
	pushRemoteRoster: async (vaultId, rosterJson) => {
		const r = await api.runtime.sendMessage({
			type: "SYNC_APPLY_ROSTER",
			payload: { vaultId, rosterJson },
		});
		if (!r?.ok) throw new Error(r?.error ?? "roster merge failed");
	},
	blobArrived: () => {
		void api.runtime.sendMessage({ type: "BLOB_ARRIVED" }).catch(() => {});
	},
	linkSend: (frame) => askBackground("LINK_SYNC_SEND", { frame }),
	linkBlobSend: (stream, frame) => askBackground("LINK_BLOB_SEND", { stream, frame }),
	linkBlobUp: () => askBackground("LINK_BLOB_UP"),
};

/** A yes/no from the background, which owns the native port. No answer (a worker that is gone)
 * is a link that is down, not a fault. */
async function askBackground(type: string, payload?: Record<string, unknown>): Promise<boolean> {
	try {
		const res = (await api.runtime.sendMessage({ type, payload })) as
			| { ok?: boolean; data?: boolean }
			| undefined;
		return res?.ok === true && res.data === true;
	} catch {
		return false;
	}
}
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

api.runtime.onMessage.addListener((message: OffscreenMessage, sender, sendResponse) => {
	if (message?.target !== "offscreen") return false;
	// Only extension-context callers reach the crypto/sync host; reject content scripts.
	// Respond explicitly (not a silent drop) so a misclassified legit caller is diagnosable
	// rather than a generic "no response from offscreen" timeout. See docs/sec-audit-7726.md (A3).
	if (!isExtensionSender(sender)) {
		console.warn("[offscreen] rejected non-extension sender", {
			origin: sender.origin,
			url: sender.url,
			tab: sender.tab?.id,
		});
		sendResponse({ ok: false, error: "forbidden" });
		return false;
	}
	void handleHostMessage(message.type ?? "", message.payload).then(sendResponse);
	return true;
});
