/// <reference types="chrome" />

import { type HostResponse, handleHostMessage } from "../offscreen-core";
import { api } from "../platform-api";
import * as vekStore from "./vek-store";

const OFFSCREEN_URL = "offscreen.html";

// Chrome's MV3 background is a service worker with no DOM, so the crypto + sync host
// runs in a separate offscreen document reached via runtime messaging. Firefox has
// no chrome.offscreen; its background is an event page with a DOM, so the same host
// (./offscreen-core) runs in-process here instead.
const useOffscreenDoc = typeof api.offscreen !== "undefined";

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
			.then(() => {})
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

// The VEK-scoped ops that consume an injected vek. Everything else a CRYPTO_* op might be
// (verify, salt, slot id, passkey, kdbx) needs no vek and passes straight through.
const USE_VEK = new Set([
	"CRYPTO_WRAP_PASSWORD_SLOT",
	"CRYPTO_WRAP_WEBAUTHN_SLOT",
	"CRYPTO_ENCRYPT",
	"CRYPTO_DECRYPT",
	"CRYPTO_ENCRYPT_OUTER",
	"CRYPTO_DECRYPT_OUTER",
]);

/**
 * The single seam between the background and the crypto host, and the one place per-vault key
 * state is applied. Every crypto op reaches the offscreen only through here (views via the
 * router's cryptoHandler, background modules directly), so all of them are keyed the same way.
 * For a CRYPTO_* op it resolves the target vault (`message.vaultId`, else the active vault for
 * un-tagged legacy callers, removed in increment 6) and:
 *  - USE-VEK: injects that vault's vek as `payload.vekB64`; fails fast when the vault is locked.
 *  - SET-VEK (generate/rotate/unwrap): forwards, then caches the returned vek under the id;
 *    unwrap replies `{ok, vekB64}` and is stripped back to the plain boolean callers expect.
 *  - Map-only (export / is-locked / unlock-with-vek): answered from the store, no offscreen trip.
 *  - Lock: forwarded once to zeroize the scratch slot; the map entry is dropped by session.ts's
 *    lock taxonomy. Non-CRYPTO_* messages (SYNC_*, clipboard, qr) pass through untouched.
 * The offscreen retains no key state, so there is no re-injection on document recreation.
 */
export async function sendToOffscreen(message: Record<string, unknown>): Promise<HostResponse> {
	await ensureOffscreen();
	const type = message.type as string | undefined;
	if (typeof type !== "string" || !type.startsWith("CRYPTO_")) return deliver(message);

	const vaultId =
		(typeof message.vaultId === "string" ? message.vaultId : null) ??
		(await vekStore.resolveActiveVaultId());

	// Map-only ops: answered from the store, no offscreen round-trip.
	if (type === "CRYPTO_EXPORT_VEK") {
		const vek = vaultId !== null ? vekStore.getVek(vaultId) : null;
		return vek !== null ? { ok: true, data: vek } : { ok: false, error: "vault locked" };
	}
	if (type === "CRYPTO_IS_LOCKED") {
		return { ok: true, data: !(vaultId !== null && vekStore.hasVek(vaultId)) };
	}
	if (type === "CRYPTO_UNLOCK_WITH_VEK") {
		const vekB64 = (message.payload as { vekB64?: string } | undefined)?.vekB64;
		if (vaultId === null || typeof vekB64 !== "string") {
			return { ok: false, error: "unlock needs a vault id and vek" };
		}
		await vekStore.setVek(vaultId, vekB64);
		return { ok: true, data: null };
	}

	// USE-VEK ops: inject the target vault's vek; fail fast (no offscreen trip) when locked.
	if (USE_VEK.has(type)) {
		if (vaultId === null) return { ok: false, error: "vault locked" };
		const vek = vekStore.getVek(vaultId);
		if (vek === null) return { ok: false, error: "vault locked" };
		const payload = { ...(message.payload as Record<string, unknown>), vekB64: vek };
		return deliver({ ...message, payload });
	}

	// SET-VEK: generate/rotate return the vek by contract (cache it, pass through); the unwraps
	// reply {ok, vekB64} (cache the vek, strip it back to the boolean the adapter returns).
	if (type === "CRYPTO_GENERATE_VEK" || type === "CRYPTO_ROTATE_VEK") {
		const res = await deliver(message);
		if (res.ok && typeof res.data === "string" && vaultId !== null) {
			await vekStore.setVek(vaultId, res.data);
		}
		return res;
	}
	if (type === "CRYPTO_UNWRAP_PASSWORD_SLOT" || type === "CRYPTO_UNWRAP_WEBAUTHN_SLOT") {
		const res = await deliver(message);
		if (!res.ok) return res;
		const data = res.data as { ok: boolean; vekB64?: string };
		if (data.ok && typeof data.vekB64 === "string" && vaultId !== null) {
			await vekStore.setVek(vaultId, data.vekB64);
		}
		return { ok: true, data: data.ok };
	}

	// CRYPTO_LOCK (zeroize the scratch slot) and the VEK-independent ops need no key handling.
	return deliver(message);
}

// Firefox swaps the toolbar icon declaratively via manifest action.theme_icons (it
// follows the real toolbar theme, which prefers-color-scheme in the event page does
// not reliably track). No JS reporter here: calling action.setIcon would override
// theme_icons. Chrome has no theme_icons, so its offscreen document reports the scheme
// (see offscreen.ts) and theme.ts calls setIcon.
