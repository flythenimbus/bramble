/// <reference types="chrome" />

import { type HostResponse, handleHostMessage } from "../offscreen-core";
import { api } from "../platform-api";
import { getVek } from "./session";

const OFFSCREEN_URL = "offscreen.html";

// Chrome's MV3 background is a service worker with no DOM, so the crypto + sync host
// runs in a separate offscreen document reached via runtime messaging. Firefox has
// no chrome.offscreen; its background is an event page with a DOM, so the same host
// (./offscreen-core) runs in-process here instead.
const useOffscreenDoc = typeof api.offscreen !== "undefined";

// Whether the host currently holds the VEK. Reset when a fresh offscreen document is
// created (Chrome) or when the event page was suspended and relocked (Firefox).
let offscreenHasKey = false;

/** Mark whether the host holds the VEK (set by the unlock/lock flows). */
export function markOffscreenKey(present: boolean): void {
	offscreenHasKey = present;
}

// A single in-flight createDocument, so concurrent callers (e.g. the mount probe and
// the first crypto op) don't both call createDocument and race the "Only a single
// offscreen document may be created" error.
let creating: Promise<void> | null = null;

/** Create the offscreen crypto document if absent (Chrome only); no-op on Firefox. */
export async function ensureOffscreen(): Promise<void> {
	if (!useOffscreenDoc) return;
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

// Deliver one message to the host: the offscreen document on Chrome (via runtime
// messaging), in-process on Firefox.
async function deliver(message: Record<string, unknown>): Promise<HostResponse> {
	if (useOffscreenDoc) {
		const response = (await api.runtime.sendMessage({ ...message, target: "offscreen" })) as
			| HostResponse
			| undefined;
		return response ?? { ok: false, error: "no response from offscreen" };
	}
	return handleHostMessage(message.type as string, message.payload);
}

/**
 * Forward a message to the crypto/sync host, re-injecting the cached VEK first if the
 * host was reset and the WASM relocked (Chrome: the offscreen can be killed; Firefox:
 * the event page can be suspended). Skips injection for the unlock/VEK messages
 * themselves (would infinite-loop), clipboard ops, and sync ops.
 */
export async function sendToOffscreen(message: Record<string, unknown>): Promise<HostResponse> {
	await ensureOffscreen();
	const type = message.type as string | undefined;
	const skipKeyInjection =
		type === "CRYPTO_UNWRAP_PASSWORD_SLOT" ||
		type === "CRYPTO_UNLOCK_WITH_VEK" ||
		type === "CRYPTO_GENERATE_VEK" ||
		type === "CLIPBOARD_CLEAR" ||
		type === "QR_DECODE" ||
		type?.startsWith("SYNC_") === true;
	const cachedVek = getVek();
	if (cachedVek && !offscreenHasKey && !skipKeyInjection) {
		offscreenHasKey = true;
		await deliver({
			type: "CRYPTO_UNLOCK_WITH_VEK",
			payload: { vekB64: cachedVek },
		}).catch(() => {
			offscreenHasKey = false;
		});
	}
	return deliver(message);
}

// Firefox swaps the toolbar icon declaratively via manifest action.theme_icons (it
// follows the real toolbar theme, which prefers-color-scheme in the event page does
// not reliably track). No JS reporter here: calling action.setIcon would override
// theme_icons. Chrome has no theme_icons, so its offscreen document reports the scheme
// (see offscreen.ts) and theme.ts calls setIcon.
