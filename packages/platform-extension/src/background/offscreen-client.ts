/// <reference types="chrome" />

import { api } from "../platform-api";
import { getVek } from "./session";

const OFFSCREEN_URL = "offscreen.html";

// Whether the offscreen crypto document currently holds the VEK. Reset when a
// fresh document is created (it starts locked) and on lock.
let offscreenHasKey = false;

/** Mark whether the offscreen document holds the VEK (set by the unlock/lock flows). */
export function markOffscreenKey(present: boolean): void {
	offscreenHasKey = present;
}

// A single in-flight createDocument, so concurrent callers (e.g. the mount probe
// and the first crypto op) don't both call createDocument and race the
// "Only a single offscreen document may be created" error.
let creating: Promise<void> | null = null;

/** Create the offscreen crypto document if absent; a fresh one starts locked. */
export async function ensureOffscreen(): Promise<void> {
	if (await api.offscreen.hasDocument?.()) return;
	if (!creating) {
		creating = api.offscreen
			.createDocument({
				url: OFFSCREEN_URL,
				reasons: [
					api.offscreen.Reason.WORKERS,
					api.offscreen.Reason.CLIPBOARD,
					api.offscreen.Reason.WEB_RTC,
				],
				justification:
					"Hosts the Vault WASM crypto module, clears the clipboard after a copy, and runs the WebRTC sync transport.",
			})
			.then(() => {
				offscreenHasKey = false; // a fresh document starts locked
			})
			.catch((e: unknown) => {
				// A concurrent caller already created it: treat as success, not a hang.
				if (!String(e).includes("Only a single offscreen document")) throw e;
			})
			.finally(() => {
				creating = null;
			});
	}
	await creating;
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
		type === "CLIPBOARD_CLEAR" ||
		type?.startsWith("SYNC_") === true;
	const cachedVek = getVek();
	if (cachedVek && !offscreenHasKey && !skipKeyInjection) {
		offscreenHasKey = true;
		await api.runtime
			.sendMessage({
				target: "offscreen",
				type: "CRYPTO_UNLOCK_WITH_VEK",
				payload: { vekB64: cachedVek },
			})
			.catch(() => {
				offscreenHasKey = false;
			});
	}
	const response = (await api.runtime.sendMessage({ ...message, target: "offscreen" })) as
		| { ok: boolean; data?: unknown; error?: string }
		| undefined;
	return response ?? { ok: false, error: "no response from offscreen" };
}
