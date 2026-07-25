/// <reference types="chrome" />

// The background's per-vault VEK map: the only durable key state now that the offscreen
// WASM holds nothing across ops (its single slot is a per-op scratch register). Every
// VEK-scoped CRYPTO_* op carries a vaultId; the seam in offscreen-client.ts injects that
// vault's key from here. Mirrored to chrome.storage.session (one key per vault) so a
// service-worker restart rehydrates it. Imports no other background module, so session.ts
// and offscreen-client.ts can both use it without a cycle. See docs/multiple-vaults.md.

import { api } from "../platform-api";
import { ACTIVE_VAULT_SESSION_KEY } from "../session-keys";

const VEK_KEY_PREFIX = "vault.vek:"; // vault.vek:<id> -> base64 VEK (session only, never local)
const MRU_KEY = "vault.unlockedMru"; // string[] of unlocked vault ids, most-recent first
const LEGACY_VEK_KEY = "vault.vek"; // the pre-per-vault single VEK; dropped on hydrate

const veks = new Map<string, string>(); // vaultId -> base64 VEK; the in-memory source of truth
let mru: string[] = []; // unlocked vault ids, most-recently-unlocked first
let activeId: string | null = null; // in-memory mirror of ACTIVE_VAULT_SESSION_KEY

const vekKey = (vaultId: string): string => `${VEK_KEY_PREFIX}${vaultId}`;

/**
 * Rebuild the map + MRU + active id from session on service-worker start. A bare legacy
 * `vault.vek` (left by the previous build) is DELETED, never attributed to a vault: nothing
 * records which vault it belonged to, and guessing would recreate the cross-key corruption
 * this design kills. Costs one forced re-unlock across the update. Awaited before any handler.
 */
export const vekStoreHydration = (async () => {
	try {
		const all = await api.storage.session.get(null);
		for (const [key, value] of Object.entries(all)) {
			if (key.startsWith(VEK_KEY_PREFIX) && typeof value === "string") {
				veks.set(key.slice(VEK_KEY_PREFIX.length), value);
			}
		}
		const storedMru = all[MRU_KEY];
		mru = Array.isArray(storedMru)
			? storedMru.filter((id): id is string => typeof id === "string" && veks.has(id))
			: [];
		const storedActive = all[ACTIVE_VAULT_SESSION_KEY];
		activeId = typeof storedActive === "string" ? storedActive : null;
		if (typeof all[LEGACY_VEK_KEY] !== "undefined") {
			await api.storage.session.remove([LEGACY_VEK_KEY]).catch(() => {});
		}
	} catch (e) {
		console.warn("[titanpass:bg] vek-store hydration failed", e);
	}
})();

// The UI writes ACTIVE_VAULT_SESSION_KEY directly (shell.setActiveVault) on unlock; keep the
// in-memory mirror fresh so activeVaultLocked() can stay synchronous like the old vaultLocked().
api.storage.session.onChanged?.addListener?.((changes) => {
	const change = changes[ACTIVE_VAULT_SESSION_KEY];
	if (!change) return;
	activeId = typeof change.newValue === "string" ? change.newValue : null;
});

// --- reads (synchronous; the in-memory map is the source of truth) ---

/** The cached base64 VEK for a vault, or null when that vault is locked. */
export function getVek(vaultId: string): string | null {
	return veks.get(vaultId) ?? null;
}

export function hasVek(vaultId: string): boolean {
	return veks.has(vaultId);
}

/** The active vault id (most recently unlocked / explicitly selected), or null. Synchronous
 * (the in-memory mirror); good enough for lock checks, but for the un-tagged-op fallback use
 * resolveActiveVaultId(), which reads session directly and can't lag the UI's latest write. */
export function getActiveVaultId(): string | null {
	return activeId;
}

/** Read the active vault id straight from session, so it reflects a just-written value even if
 * the onChanged mirror hasn't fired yet. Used only for the legacy un-tagged-op fallback. */
export async function resolveActiveVaultId(): Promise<string | null> {
	try {
		const r = await api.storage.session.get([ACTIVE_VAULT_SESSION_KEY]);
		const v = r[ACTIVE_VAULT_SESSION_KEY];
		return typeof v === "string" ? v : null;
	} catch {
		return null;
	}
}

/**
 * Re-read the active vault id from session INTO the in-memory mirror, so a synchronous
 * activeVaultLocked() taken right after an unlock isn't answered from a stale mirror (the UI
 * writes the key and the onChanged event can still be in flight). A failed read leaves the
 * mirror alone rather than clobbering a good value with null.
 */
export async function refreshActiveVaultId(): Promise<string | null> {
	try {
		const r = await api.storage.session.get([ACTIVE_VAULT_SESSION_KEY]);
		const v = r[ACTIVE_VAULT_SESSION_KEY];
		activeId = typeof v === "string" ? v : null;
	} catch {
		// Keep the current mirror; the caller's lock check is no worse off than before.
	}
	return activeId;
}

/** True when the ACTIVE vault has no cached VEK: the lock predicate the singleton services
 * (autofill, corner-prompt, backup, storage-change listeners) mean by "the vault is locked". */
export function activeVaultLocked(): boolean {
	return activeId === null || !veks.has(activeId);
}

/** Unlocked vault ids, most-recently-unlocked first (filtered to those still holding a VEK). */
export function unlockedMru(): string[] {
	return mru.filter((id) => veks.has(id));
}

// --- writes (persist to session; callers await when ordering matters) ---

/** Cache a vault's VEK and move it to the MRU front (a successful unlock). */
export async function setVek(vaultId: string, vekB64: string): Promise<void> {
	veks.set(vaultId, vekB64);
	mru = [vaultId, ...mru.filter((id) => id !== vaultId)];
	await api.storage.session.set({ [vekKey(vaultId)]: vekB64, [MRU_KEY]: mru }).catch(() => {});
}

/** Forget one vault's VEK (a per-vault lock); other vaults stay unlocked. */
export async function removeVek(vaultId: string): Promise<void> {
	veks.delete(vaultId);
	mru = mru.filter((id) => id !== vaultId);
	await api.storage.session.remove([vekKey(vaultId)]).catch(() => {});
	await api.storage.session.set({ [MRU_KEY]: mru }).catch(() => {});
}

/** Record the active vault id, mirroring the session key the UI also writes. */
export async function setActiveVaultId(id: string | null): Promise<void> {
	activeId = id;
	if (id === null) await api.storage.session.remove([ACTIVE_VAULT_SESSION_KEY]).catch(() => {});
	else await api.storage.session.set({ [ACTIVE_VAULT_SESSION_KEY]: id }).catch(() => {});
}

/** Walk-away lock: forget every vault's VEK, the MRU, and the active id. */
export async function clearAllVeks(): Promise<void> {
	const keys = [...veks.keys()].map(vekKey);
	veks.clear();
	mru = [];
	activeId = null;
	await api.storage.session.remove([...keys, MRU_KEY, ACTIVE_VAULT_SESSION_KEY]).catch(() => {});
}
