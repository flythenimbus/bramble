/// <reference types="chrome" />

import { getVek } from "./session";

const OFFSCREEN_URL = "offscreen.html";

// Whether the offscreen crypto document currently holds the VEK. Reset when a
// fresh document is created (it starts locked) and on lock.
let offscreenHasKey = false;

/** Mark whether the offscreen document holds the VEK (set by the unlock/lock flows). */
export function markOffscreenKey(present: boolean): void {
	offscreenHasKey = present;
}

/** Create the offscreen crypto document if absent; a fresh one starts locked. */
export async function ensureOffscreen(): Promise<void> {
	const existing = await chrome.offscreen.hasDocument?.();
	if (existing) return;
	await chrome.offscreen.createDocument({
		url: OFFSCREEN_URL,
		reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.CLIPBOARD],
		justification: "Hosts the Vault WASM crypto module and clears the clipboard after a copy.",
	});
	offscreenHasKey = false;
}

/**
 * Forward a message to the offscreen crypto document, re-injecting the cached
 * VEK first if the offscreen was killed and recreated. Skips injection for the
 * unlock/VEK messages themselves (would infinite-loop) and clipboard ops.
 */
export async function sendToOffscreen(
	message: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
	await ensureOffscreen();
	const type = message.type as string | undefined;
	const skipKeyInjection =
		type === "CRYPTO_UNWRAP_PASSWORD_SLOT" ||
		type === "CRYPTO_UNLOCK_WITH_VEK" ||
		type === "CRYPTO_GENERATE_VEK" ||
		type === "CLIPBOARD_CLEAR";
	const cachedVek = getVek();
	if (cachedVek && !offscreenHasKey && !skipKeyInjection) {
		offscreenHasKey = true;
		await chrome.runtime
			.sendMessage({
				target: "offscreen",
				type: "CRYPTO_UNLOCK_WITH_VEK",
				payload: { vekB64: cachedVek },
			})
			.catch(() => {
				offscreenHasKey = false;
			});
	}
	const response = (await chrome.runtime.sendMessage({ ...message, target: "offscreen" })) as
		| { ok: boolean; data?: unknown; error?: string }
		| undefined;
	return response ?? { ok: false, error: "no response from offscreen" };
}
