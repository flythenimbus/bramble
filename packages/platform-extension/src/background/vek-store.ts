/// <reference types="chrome" />

// The background's per-vault VEK map: the only durable key state now that the offscreen
// WASM holds nothing across ops (its single slot is a per-op scratch register). Every
// VEK-scoped CRYPTO_* op carries a vaultId; the seam in offscreen-client.ts injects that
// vault's key from here. Mirrored to chrome.storage.session (one key per vault) so a
// service-worker restart rehydrates it. Imports no other background module, so session.ts
// and offscreen-client.ts can both use it without a cycle. See docs/multiple-vaults.md.

import { CRYPTO_PERSISTENCE_FAILED } from "@core/adapters/crypto";
import { api } from "../platform-api";
import { ACTIVE_VAULT_SESSION_KEY } from "../session-keys";

const VEK_KEY_PREFIX = "vault.vek:"; // vault.vek:<id> -> base64 VEK (session only, never local)
const MRU_KEY = "vault.unlockedMru"; // string[] of unlocked vault ids, most-recent first
const LEGACY_VEK_KEY = "vault.vek"; // the pre-per-vault single VEK; dropped on hydrate
// Written before a walk-away lock removes keys. Keeping it until the next successful install
// makes an interrupted cleanup fail closed on the next service-worker start.
const LOCKED_MARKER_KEY = "vault.vek.locked";

/** CRYPTO operations that can install or replace a vault's usable VEK. */
const VEK_REPLACEMENT_OPERATIONS = new Set([
	"CRYPTO_GENERATE_VEK",
	"CRYPTO_UNWRAP_PASSWORD_SLOT",
	"CRYPTO_UNWRAP_WEBAUTHN_SLOT",
	"CRYPTO_UNLOCK_WITH_VEK",
	"CRYPTO_ROTATE_VEK",
]);

const veks = new Map<string, string>(); // vaultId -> base64 VEK; the in-memory source of truth
let mru: string[] = []; // unlocked vault ids, most-recently-unlocked first
let activeId: string | null = null; // in-memory mirror of ACTIVE_VAULT_SESSION_KEY
// Every key installation carries the epoch captured when its dispatch began. A later lock,
// active-vault change, or replacement advances this before doing any await, so an older async
// crypto reply can never resurrect a VEK after the newer operation has completed.
let mutationEpoch = 0;
// chrome.storage writes are asynchronous and otherwise unordered across overlapping unlock and
// lock paths. Serialize their in-memory + durable commit so a later epoch can never leave an
// earlier VEK resident or persisted after it wins.
let mutationTail: Promise<void> = Promise.resolve();
// Keys that may have reached session storage, including a write whose promise rejected after
// the browser committed it. `clearAllVeks` also enumerates storage, but retaining this small
// set gives a failed cleanup a second chance when enumeration itself is unavailable.
const durableVekCandidates = new Set<string>();
let lockMarkerPresent = false;
let persistencePoisoned = false;
// storage.onChanged has no operation id. Keep a short, ordered receipt for active-id writes this
// module initiates so session.ts can consume their delayed notifications instead of applying an
// older local removal after a newer UI selection has already been refreshed.
let activeWriteRevision = 0;
// Bounded, because a receipt whose notification never arrives would otherwise live forever and
// could later swallow a genuine external change that happens to carry the same old/new pair.
// Only one active-id write is ever in flight, so anything this old is already unmatchable.
const MAX_PENDING_ACTIVE_CHANGES = 8;
const pendingActiveStorageChanges: Array<{
	revision: number;
	oldValue: string | null;
	newValue: string | null;
}> = [];

const vekKey = (vaultId: string): string => `${VEK_KEY_PREFIX}${vaultId}`;

function serializeMutation<T>(commit: () => Promise<T>): Promise<T> {
	const run = mutationTail.then(commit, commit);
	mutationTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** Code first so the UI can translate it; the rest is console detail and is never rendered. */
function persistenceError(action: string, cause: unknown): Error {
	return new Error(`${CRYPTO_PERSISTENCE_FAILED}: ${action} failed: ${String(cause)}`);
}

function activeValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** Register a local active-id storage write before issuing it. */
function expectActiveStorageChange(oldValue: unknown, newValue: unknown) {
	const expected = {
		revision: ++activeWriteRevision,
		oldValue: activeValue(oldValue),
		newValue: activeValue(newValue),
	};
	pendingActiveStorageChanges.push(expected);
	while (pendingActiveStorageChanges.length > MAX_PENDING_ACTIVE_CHANGES) {
		pendingActiveStorageChanges.shift();
	}
	return expected;
}

function forgetExpectedActiveStorageChange(expected: { revision: number }): void {
	const index = pendingActiveStorageChanges.findIndex(
		(candidate) => candidate.revision === expected.revision,
	);
	if (index >= 0) pendingActiveStorageChanges.splice(index, 1);
}

/**
 * Consume the delayed notification for a background-owned write. A revision is retained only
 * until its exact old/new notification appears; external UI writes do not create a receipt and
 * therefore still take the normal active-session transition path.
 */
export function consumeExpectedActiveStorageChange(change: {
	oldValue?: unknown;
	newValue?: unknown;
}): boolean {
	const oldValue = activeValue(change.oldValue);
	const newValue = activeValue(change.newValue);
	const index = pendingActiveStorageChanges.findIndex(
		(candidate) => candidate.oldValue === oldValue && candidate.newValue === newValue,
	);
	if (index < 0) return false;
	pendingActiveStorageChanges.splice(index, 1);
	return true;
}

function failClosed(): void {
	persistencePoisoned = true;
	veks.clear();
	mru = [];
	activeId = null;
}

/** Best-effort durable counterpart to the in-memory poison state after a failed removal. */
async function leaveLockMarker(): Promise<void> {
	lockMarkerPresent = true;
	try {
		await api.storage.session.set({ [LOCKED_MARKER_KEY]: true });
	} catch {
		// The original error is still surfaced. If storage itself is unavailable, this worker stays
		// poisoned; a future explicit full lock retries the durable cleanup.
	}
}

async function writeMru(): Promise<void> {
	await api.storage.session.set({ [MRU_KEY]: mru });
}

/** Remove one tentative install and its MRU reference. Throws if durable rollback is uncertain. */
async function rollbackInstall(vaultId: string): Promise<void> {
	const key = vekKey(vaultId);
	veks.delete(vaultId);
	mru = mru.filter((id) => id !== vaultId);
	try {
		await api.storage.session.remove([key]);
		await writeMru();
		durableVekCandidates.delete(key);
	} catch (cause) {
		await leaveLockMarker();
		failClosed();
		throw persistenceError("rollback", cause);
	}
}

/** Whether an operation can make a different VEK visible to consumers. */
export function replacesVek(type: string): boolean {
	return VEK_REPLACEMENT_OPERATIONS.has(type);
}

/** Start a VEK-state mutation and invalidate every earlier in-flight installation. */
export function beginVekMutation(): number {
	return ++mutationEpoch;
}

/** Snapshot used by callers that do not themselves start a key-state transition. */
export function vekMutationSnapshot(): number {
	return mutationEpoch;
}

/** Whether an async key installation still belongs to the newest mutation. */
export function vekMutationIsCurrent(epoch: number): boolean {
	return epoch === mutationEpoch;
}

/**
 * Rebuild the map + MRU + active id from session on service-worker start. A bare legacy
 * `vault.vek` (left by the previous build) is DELETED, never attributed to a vault: nothing
 * records which vault it belonged to, and guessing would recreate the cross-key corruption
 * this design kills. Costs one forced re-unlock across the update. Awaited before any handler.
 */
export const vekStoreHydration = (async () => {
	try {
		const all = await api.storage.session.get(null);
		lockMarkerPresent = typeof all[LOCKED_MARKER_KEY] !== "undefined";
		if (lockMarkerPresent) {
			// A previous lock was interrupted. Do not revive any remembered VEK; make a best-effort
			// completion while the marker keeps this and any restarted worker locked.
			const stale = Object.keys(all).filter((key) => key.startsWith(VEK_KEY_PREFIX));
			try {
				await api.storage.session.remove([...stale, MRU_KEY, ACTIVE_VAULT_SESSION_KEY]);
			} catch (cause) {
				failClosed();
				console.warn("[titanpass:bg] VEK lock cleanup retry failed", cause);
			}
			return;
		}
		for (const [key, value] of Object.entries(all)) {
			if (key.startsWith(VEK_KEY_PREFIX) && typeof value === "string") {
				veks.set(key.slice(VEK_KEY_PREFIX.length), value);
				durableVekCandidates.add(key);
			}
		}
		const storedMru = all[MRU_KEY];
		mru = Array.isArray(storedMru)
			? storedMru.filter((id): id is string => typeof id === "string" && veks.has(id))
			: [];
		const storedActive = all[ACTIVE_VAULT_SESSION_KEY];
		activeId = typeof storedActive === "string" ? storedActive : null;
		if (typeof all[LEGACY_VEK_KEY] !== "undefined")
			await api.storage.session.remove([LEGACY_VEK_KEY]);
	} catch (e) {
		console.warn("[titanpass:bg] vek-store hydration failed", e);
	}
})();

/**
 * Apply an active-vault value exactly once. session.ts owns the matching autofill transition
 * and calls this from both a direct refresh and storage.onChanged; a delayed duplicate event is
 * therefore a no-op instead of advancing the VEK epoch a second time.
 */
export function applyActiveVaultId(value: unknown): boolean {
	const next = activeValue(value);
	if (next === activeId) return false;
	activeId = next;
	beginVekMutation();
	return true;
}

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
 * Read the active vault id without mutating the mirror. session.ts applies the result through
 * its shared transition path, so a delayed onChanged notification for that same value is a
 * no-op instead of a second version change. `undefined` means the read itself failed.
 */
export async function readStoredActiveVaultId(): Promise<string | null | undefined> {
	try {
		const r = await api.storage.session.get([ACTIVE_VAULT_SESSION_KEY]);
		const v = r[ACTIVE_VAULT_SESSION_KEY];
		return typeof v === "string" ? v : null;
	} catch {
		return undefined;
	}
}

/** True when the ACTIVE vault has no cached VEK: the lock predicate the singleton services
 * (autofill, corner-prompt, backup, storage-change listeners) mean by "the vault is locked". */
export function activeVaultLocked(): boolean {
	return persistencePoisoned || lockMarkerPresent || activeId === null || !veks.has(activeId);
}

/** Unlocked vault ids, most-recently-unlocked first (filtered to those still holding a VEK). */
export function unlockedMru(): string[] {
	return mru.filter((id) => veks.has(id));
}

// --- writes (persist to session; callers await when ordering matters) ---

/** Cache a vault's VEK and move it to the MRU front (a successful unlock). */
export async function setVek(
	vaultId: string,
	vekB64: string,
	expectedEpoch: number = mutationEpoch,
): Promise<boolean> {
	return serializeMutation(async () => {
		if (!vekMutationIsCurrent(expectedEpoch)) return false;
		if (persistencePoisoned) throw new Error(`${CRYPTO_PERSISTENCE_FAILED}: requires lock cleanup`);
		const key = vekKey(vaultId);
		durableVekCandidates.add(key);
		veks.set(vaultId, vekB64);
		mru = [vaultId, ...mru.filter((id) => id !== vaultId)];
		try {
			await api.storage.session.set({ [key]: vekB64, [MRU_KEY]: mru });
			// A retained lock marker is deliberately fail-closed after an interrupted clear. An
			// unlock is usable only after it has durably cleared that marker too.
			if (lockMarkerPresent) {
				await api.storage.session.remove([LOCKED_MARKER_KEY]);
				lockMarkerPresent = false;
			}
		} catch (cause) {
			await rollbackInstall(vaultId);
			throw persistenceError("install", cause);
		}
		if (vekMutationIsCurrent(expectedEpoch)) return true;
		// A newer transition began while the storage write was in flight. Roll back before
		// releasing the queue, so the following lock/replacement cannot observe this VEK.
		await rollbackInstall(vaultId);
		return false;
	});
}

/** Forget one vault's VEK (a per-vault lock); other vaults stay unlocked. */
export async function removeVek(vaultId: string): Promise<void> {
	beginVekMutation();
	await serializeMutation(async () => {
		if (persistencePoisoned) throw new Error(`${CRYPTO_PERSISTENCE_FAILED}: requires lock cleanup`);
		const key = vekKey(vaultId);
		veks.delete(vaultId);
		mru = mru.filter((id) => id !== vaultId);
		try {
			await api.storage.session.remove([key]);
			await writeMru();
			durableVekCandidates.delete(key);
		} catch (cause) {
			await leaveLockMarker();
			failClosed();
			throw persistenceError("remove", cause);
		}
	});
}

/** Walk-away lock: forget every vault's VEK, the MRU, and the active id. */
export async function clearAllVeks(): Promise<void> {
	beginVekMutation();
	await serializeMutation(async () => {
		const activeBeforeClear = activeId;
		const candidateKeys = new Set(
			[...durableVekCandidates, ...veks.keys()].map((key) =>
				key.startsWith(VEK_KEY_PREFIX) ? key : vekKey(key),
			),
		);
		veks.clear();
		mru = [];
		activeId = null;
		lockMarkerPresent = true;
		let markerFailure: unknown;
		try {
			await api.storage.session.set({ [LOCKED_MARKER_KEY]: true });
		} catch (cause) {
			markerFailure = cause;
		}
		let enumerationFailure: unknown;
		let storedActive: unknown = activeBeforeClear;
		try {
			const all = await api.storage.session.get(null);
			for (const key of Object.keys(all))
				if (key.startsWith(VEK_KEY_PREFIX)) candidateKeys.add(key);
			storedActive = all[ACTIVE_VAULT_SESSION_KEY];
		} catch (cause) {
			enumerationFailure = cause;
		}
		let cleanupFailure: unknown;
		const expectedActiveRemoval =
			storedActive === undefined ? undefined : expectActiveStorageChange(storedActive, undefined);
		try {
			await api.storage.session.remove([...candidateKeys, MRU_KEY, ACTIVE_VAULT_SESSION_KEY]);
			for (const key of candidateKeys) durableVekCandidates.delete(key);
		} catch (cause) {
			cleanupFailure = cause;
			if (expectedActiveRemoval) forgetExpectedActiveStorageChange(expectedActiveRemoval);
		}
		if (markerFailure || enumerationFailure || cleanupFailure) {
			failClosed();
			throw persistenceError("lock cleanup", markerFailure ?? enumerationFailure ?? cleanupFailure);
		}
		persistencePoisoned = false;
	});
}
