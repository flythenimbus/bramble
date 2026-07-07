/// <reference types="chrome" />

import { api } from "../platform-api";
import { clearIndex } from "./autofill-index";
import { CAPTURE_KEY_PREFIX, CORNER_HANDOFF_KEY } from "./corner-prompt";
import { markOffscreenKey, sendToOffscreen } from "./offscreen-client";
import { POPOUT_HANDOFF_KEY } from "./popout";
import { getAutoLockMinutes } from "./prefs";
import { extensionOnly, type MessageEnvelope, onPrefix } from "./router";
import { maybeStartSync, stopSync } from "./sync";

const VEK_KEY = "vault.vek";
const LEGACY_AUTOFILL_INDEX_KEY = "autofill.index";

export const AUTOLOCK_ALARM = "vault:autolock";

// In-memory VEK cache, hydrated lazily from chrome.storage.session. Never
// persisted to local; it stays null after a SW restart until an unlock.
let cachedVek: string | null = null;

/** The base64 session VEK, or null when locked. */
export function getVek(): string | null {
	return cachedVek;
}

/** Authoritative lock signal: a missing index only means "not hydrated yet". */
export function vaultLocked(): boolean {
	return cachedVek === null;
}

// Load the cached VEK and drop any decrypted index left in session storage by a
// previous build. Awaited (with the index hydration) before any handler runs.
export const sessionHydration = (async () => {
	try {
		const r = await api.storage.session.get([VEK_KEY]);
		const cached = r[VEK_KEY];
		if (typeof cached === "string") cachedVek = cached;
		await api.storage.session.remove([LEGACY_AUTOFILL_INDEX_KEY]).catch(() => {});
	} catch (e) {
		console.warn("[titanpass:bg] session hydration failed", e);
	}
})();

async function persistVek(): Promise<void> {
	if (cachedVek === null) return;
	try {
		await api.storage.session.set({ [VEK_KEY]: cachedVek });
	} catch (e) {
		console.warn("[titanpass:bg] persistVek failed", e);
	}
}

export async function scheduleAutoLock(): Promise<void> {
	const minutes = await getAutoLockMinutes();
	// 0 or absent means never auto-lock.
	if (minutes <= 0) {
		void api.alarms.clear(AUTOLOCK_ALARM);
		return;
	}
	void api.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: minutes });
}

async function exportAndCacheVek(): Promise<void> {
	try {
		const exported = await sendToOffscreen({ type: "CRYPTO_EXPORT_VEK" });
		if (exported.ok && typeof exported.data === "string") {
			cachedVek = exported.data;
			markOffscreenKey(true);
			await persistVek();
		}
	} catch (e) {
		console.warn("[titanpass:bg] export VEK failed", e);
	}
}

/** Lock: clear the VEK, in-memory index, and every session item holding plaintext. */
export async function clearSession(): Promise<void> {
	cachedVek = null;
	clearIndex();
	markOffscreenKey(false);
	void stopSync();
	try {
		const all = await api.storage.session.get(null);
		const toRemove: string[] = [VEK_KEY, POPOUT_HANDOFF_KEY, CORNER_HANDOFF_KEY];
		for (const key of Object.keys(all)) {
			if (key.startsWith(CAPTURE_KEY_PREFIX)) toRemove.push(key);
		}
		await api.storage.session.remove(toRemove);
	} catch {}
	void api.alarms.clear(AUTOLOCK_ALARM);
}

/**
 * Forward any CRYPTO_* message to offscreen, then keep the session VEK cache in
 * sync on creation, unlock, and rotation. Returns the raw offscreen envelope.
 */
async function cryptoHandler(message: any): Promise<MessageEnvelope> {
	const type = message.type as string;
	const response = await sendToOffscreen(message);
	if (response.ok) {
		if (type === "CRYPTO_GENERATE_VEK") {
			if (typeof response.data === "string") {
				cachedVek = response.data;
				markOffscreenKey(true);
				await persistVek();
			}
			await scheduleAutoLock();
		} else if (type === "CRYPTO_UNWRAP_PASSWORD_SLOT" || type === "CRYPTO_UNWRAP_WEBAUTHN_SLOT") {
			// Password or security-key unlock. Only count it if the verifier matched;
			// both slot kinds return true iff the VEK was recovered, so cache it the
			// same way (else a security-key unlock leaves cachedVek null and the
			// background reports the vault as locked: autofill, route restore, passkeys).
			if (response.data === true) {
				markOffscreenKey(true);
				await scheduleAutoLock();
				await exportAndCacheVek();
				void maybeStartSync(); // begin continuous sync if this vault is in a group
			}
		} else if (type === "CRYPTO_ROTATE_VEK") {
			if (typeof response.data === "string") {
				cachedVek = response.data;
				markOffscreenKey(true);
				await persistVek();
			}
		} else if (type === "CRYPTO_UNLOCK_WITH_VEK") {
			// Used by the popup for rotation rollback; keep the cache in sync.
			const payload = (message.payload ?? {}) as { vekB64?: string };
			if (typeof payload.vekB64 === "string") {
				cachedVek = payload.vekB64;
				markOffscreenKey(true);
				await persistVek();
			}
		} else if (type === "CRYPTO_LOCK") {
			await clearSession();
		}
	}
	return response;
}

// CRYPTO_* reaches the offscreen crypto host (incl. CRYPTO_EXPORT_VEK); only extension
// pages may drive it, never a content script. See docs/sec-audit-7726.md (A3).
onPrefix("CRYPTO_", extensionOnly(cryptoHandler));
