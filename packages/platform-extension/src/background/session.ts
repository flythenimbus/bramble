/// <reference types="chrome" />

import { CRYPTO_SESSION_CHANGED } from "@core/adapters/crypto";
import { api } from "../platform-api";
import { isExtensionSender } from "../sender";
import { ACTIVE_VAULT_SESSION_KEY, CORNER_HANDOFF_KEY } from "../session-keys";
import { clearIndex } from "./autofill-index";
import { runDueBackups } from "./backup";
import { CAPTURE_KEY_PREFIX } from "./corner-prompt";
import { sendToOffscreen } from "./offscreen-client";
import { closeUnlockPopout, POPOUT_HANDOFF_KEY } from "./popout";
import { getAutoLockMinutes } from "./prefs";
import { extensionOnly, type MessageEnvelope, on, onBeforeDispatch, onPrefix } from "./router";
import { maybeStartSync, stopSync } from "./sync";
import * as vekStore from "./vek-store";

const LEGACY_AUTOFILL_INDEX_KEY = "autofill.index";

export const AUTOLOCK_ALARM = "vault:autolock";

// Autofill requests must not span a vault-session transition. This state deliberately
// lives only in the background process: a service-worker restart drops pending response
// channels, so persisting it would add state without protecting an in-flight request.
let autofillSessionGeneration = 0;
let lockTransitions = 0;
let prestartedCryptoLocks = 0;
let autofillSessionTokenSerial = 0;

function nextAutofillSessionToken(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `autofill-session-${++autofillSessionTokenSerial}`;
	}
}

let autofillSessionToken = nextAutofillSessionToken();

/** The vault/key session that owns decrypted autofill data. */
export type AutofillSessionOwner = Readonly<{
	vaultId: string;
	generation: number;
	token: string;
}>;

export type AutofillSessionCapability = Readonly<{
	vaultId: string;
	token: string;
}>;

/** Snapshot used by an autofill request before it awaits hydration or scheduling work. */
export function autofillSessionSnapshot(): number {
	return autofillSessionGeneration;
}

/** True only when no lock transition happened while an autofill request was in flight. */
export function autofillSessionIsStable(generation: number): boolean {
	return lockTransitions === 0 && generation === autofillSessionGeneration;
}

/** The secret-returning path additionally requires an unlocked active vault. */
export function autofillSessionIsCurrent(generation: number): boolean {
	return autofillSessionIsStable(generation) && !vaultLocked();
}

/**
 * Capture the current unlocked vault session for a decrypted cache or async operation.
 * `generation` prevents lock/unlock ABA; `vaultId` prevents an active-vault replacement
 * from reusing a cache that happened to be built under the same process.
 */
export function autofillSessionOwner(): AutofillSessionOwner | null {
	const vaultId = getActiveVaultId();
	if (vaultId === null || !autofillSessionIsCurrent(autofillSessionGeneration)) return null;
	return { vaultId, generation: autofillSessionGeneration, token: autofillSessionToken };
}

/** True only while an owner still names this exact unlocked active-vault session. */
export function autofillSessionOwnerIsCurrent(owner: AutofillSessionOwner): boolean {
	return (
		getActiveVaultId() === owner.vaultId &&
		autofillSessionIsCurrent(owner.generation) &&
		autofillSessionToken === owner.token
	);
}

/** Match an extension view's issued capability to the current active-vault session. */
export function autofillSessionCapabilityIsCurrent(capability: AutofillSessionCapability): boolean {
	const owner = autofillSessionOwner();
	return owner !== null && owner.vaultId === capability.vaultId && owner.token === capability.token;
}

/** Begin/end are depth-counted because CRYPTO_LOCK and clearSession can nest. */
function beginAutofillLockTransition(): void {
	autofillSessionGeneration++;
	autofillSessionToken = nextAutofillSessionToken();
	lockTransitions++;
}

function endAutofillLockTransition(): void {
	lockTransitions = Math.max(0, lockTransitions - 1);
}

/** A successful unlock or active-vault replacement invalidates old autofill work. */
function advanceAutofillSession(): void {
	autofillSessionGeneration++;
	autofillSessionToken = nextAutofillSessionToken();
}

/**
 * One active-vault transition has two consumers: VEK epoch invalidation and autofill ownership.
 * Keep them together and deduplicate on the effective value, because `storage.onChanged` can be
 * delivered after a direct session read has already observed the same write.
 */
function applyActiveVaultTransition(value: unknown): boolean {
	if (!vekStore.applyActiveVaultId(value)) return false;
	advanceAutofillSession();
	return true;
}

function autofillGetSessionOwner(): MessageEnvelope {
	const owner = autofillSessionOwner();
	return owner === null
		? { ok: false, error: "unavailable" }
		: { ok: true, data: { vaultId: owner.vaultId, token: owner.token } };
}

// The router awaits background hydration before invoking handlers. Its synchronous pre-dispatch
// hook starts an incoming privileged lock before that await, so continuation revalidation cannot
// slip through a held hydration. The handler consumes this depth in its normal finally block.
onBeforeDispatch((message, sender) => {
	if (message?.type !== "CRYPTO_LOCK" || !isExtensionSender(sender)) {
		return;
	}
	beginAutofillLockTransition();
	vekStore.beginVekMutation();
	prestartedCryptoLocks++;
});

// The shell selects an active vault by writing this session key directly. Treat a
// replacement exactly like an unlock transition: a request authorized for the old
// active vault must not complete under the new one. This listener uses the standard
// storage-wide event (and is exercised by the background harness), not a tab signal.
api.storage.onChanged.addListener((changes, area) => {
	if (area !== "session") return;
	const change = changes[ACTIVE_VAULT_SESSION_KEY];
	if (change && !vekStore.consumeExpectedActiveStorageChange(change)) {
		applyActiveVaultTransition(change.newValue);
	}
});

/** True when the ACTIVE vault has no cached VEK: the lock predicate the singleton services
 * (autofill, corner-prompt, backup, storage-change listeners) mean. Backed by the vek store. */
export function vaultLocked(): boolean {
	return vekStore.activeVaultLocked();
}

/** The active/unlocked vault id (most recently unlocked / explicitly selected), or null. */
export function getActiveVaultId(): string | null {
	return vekStore.getActiveVaultId();
}

/** The active vault id, or throw when locked. Background writers (corner-prompt, passkey-store)
 * use it for both blob I/O and crypto, so the two can never disagree on which vault they touch. */
export function requireActiveVaultId(): string {
	const id = vekStore.getActiveVaultId();
	if (id === null) throw new Error("vault locked");
	return id;
}

/** Refresh the active-vault mirror from session before a lock check that races an unlock. */
export async function refreshActiveVaultId(): Promise<string | null> {
	const stored = await vekStore.readStoredActiveVaultId();
	if (stored !== undefined) applyActiveVaultTransition(stored);
	return vekStore.getActiveVaultId();
}

/** Every currently-unlocked vault id, most-recently-unlocked first. Used by backup to retry a
 * device-global target's VEK-wrapped creds across resident vaults. */
export function unlockedVaultIds(): string[] {
	return vekStore.unlockedMru();
}

// Await the vek-store rehydration (per-vault VEK map + MRU + active id, rebuilt from
// chrome.storage.session on a service-worker restart) and drop any decrypted index a previous
// build left in session. Awaited (with the index hydration) before any handler runs.
export const sessionHydration = (async () => {
	try {
		await vekStore.vekStoreHydration;
		await api.storage.session.remove([LEGACY_AUTOFILL_INDEX_KEY]).catch(() => {});
	} catch (e) {
		console.warn("[bramble:bg] session hydration failed", e);
	}
})();

export async function scheduleAutoLock(): Promise<void> {
	const minutes = await getAutoLockMinutes();
	// 0 or absent means never auto-lock.
	if (minutes <= 0) {
		void api.alarms.clear(AUTOLOCK_ALARM);
		return;
	}
	void api.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: minutes });
}

/** Push the vault's lock state to every tab's content script. Content scripts aren't trusted
 * contexts, so they can't watch storage.session for the VEK; without this push a page's autofill
 * dropdown keeps showing a stale "Vault locked" after an unlock (and stale matches after a lock).
 * Best-effort per tab; tabs with no content script (chrome://, the store) just reject. */
async function broadcastLockState(
	locked: boolean,
	generation = autofillSessionGeneration,
): Promise<void> {
	try {
		const tabs = await api.tabs.query({});
		if (generation !== autofillSessionGeneration) return;
		for (const tab of tabs) {
			if (tab.id === undefined) continue;
			void api.tabs
				.sendMessage(tab.id, { type: "VAULT_LOCK_STATE", payload: { locked } })
				.catch(() => {});
		}
	} catch {}
}

/** Drop every session item holding a plaintext handoff (corner captures, popout, corner handoff). */
async function removeHandoffKeys(): Promise<void> {
	try {
		const all = await api.storage.session.get(null);
		const toRemove: string[] = [POPOUT_HANDOFF_KEY, CORNER_HANDOFF_KEY];
		for (const key of Object.keys(all)) {
			if (key.startsWith(CAPTURE_KEY_PREFIX)) toRemove.push(key);
		}
		await api.storage.session.remove(toRemove);
	} catch {}
}

/** Walk-away lock: forget EVERY vault's VEK and all session state, and tear down the singleton
 * services. The idle auto-lock alarm, the lock-vault command, OS screen-lock, and view-lock's
 * last-view-close all land here. */
export async function clearSession(): Promise<void> {
	// This is synchronous on entry, before any VEK/session cleanup await. A caller may
	// already have begun a wider CRYPTO_LOCK transition; the counter keeps that safe.
	beginAutofillLockTransition();
	vekStore.beginVekMutation();
	try {
		// Content must cancel a pending fill/submit before the VEK/session cleanup awaits.
		// This remains best-effort, but initiating it here closes the timer race locally.
		void broadcastLockState(true, autofillSessionGeneration);
		clearIndex();
		void stopSync();
		let durableCleanupError: unknown;
		try {
			await vekStore.clearAllVeks();
		} catch (error) {
			// The caller must see this failure, but other sensitive session cleanup and the alarm
			// teardown still belong to this lock attempt.
			durableCleanupError = error;
		}
		await removeHandoffKeys();
		void api.alarms.clear(AUTOLOCK_ALARM);
		if (durableCleanupError) throw durableCleanupError;
	} finally {
		endAutofillLockTransition();
	}
}

/** Per-vault lock (a view's Lock action). One vault is active in the UI at a time (the popup and
 * pop-out share its lock state), so locking it is a CLEAN SLATE: clear every cached vek and return
 * to the picker, exactly like a walk-away lock. A stray non-active vek (e.g. left cached from
 * creating a vault while another was open) is dropped too, so "lock" never leaves a vault openable
 * without re-auth. The per-vault map still holds several veks transiently (during a create), which
 * is what fixes the build-time corruption; it just isn't a persistent multi-view unlocked state. */
async function lockVault(vaultId: string): Promise<void> {
	if (vekStore.getActiveVaultId() === vaultId) {
		await clearSession();
		return;
	}
	// Defensive: a non-active vault id isn't reachable in today's single-view UX; lock just it.
	await vekStore.removeVek(vaultId);
}

/**
 * Forward a CRYPTO_* message to the crypto host (sendToOffscreen owns the per-vault key map and
 * does the inject/cache/strip) and run the unlock/lock side effects off the already-stripped
 * result: schedule auto-lock, start the active vault's sync + due backups, broadcast lock state.
 */
async function cryptoHandler(message: any): Promise<MessageEnvelope> {
	const type = message.type as string;
	if (type === "CRYPTO_LOCK") {
		// Invalidate before the crypto host await, not after zeroization has completed.
		if (prestartedCryptoLocks > 0) prestartedCryptoLocks--;
		else beginAutofillLockTransition();
		try {
			const vaultId =
				(typeof message.vaultId === "string" ? message.vaultId : null) ??
				(await vekStore.resolveActiveVaultId());
			const response = await sendToOffscreen(message); // zeroize the scratch slot
			// The UI may have selected a vault just before dispatch while its storage event is still
			// queued. Apply that value before deciding whether this is the active-vault lock.
			await refreshActiveVaultId();
			if (vaultId !== null) await lockVault(vaultId);
			else await clearSession();
			return response;
		} finally {
			endAutofillLockTransition();
		}
	}
	const installsOrReplacesVek = vekStore.replacesVek(type);
	// Apply a just-written active id before capturing the install epoch. A storage event may arrive
	// after this direct read; applyActiveVaultTransition then recognizes the same value and does
	// nothing, rather than invalidating this completed unlock.
	if (installsOrReplacesVek) await refreshActiveVaultId();
	// sendToOffscreen installs a recovered/generated VEK before its own storage await completes.
	// Hold this nested-safe transition across that entire seam.
	const vekEpoch = installsOrReplacesVek ? vekStore.beginVekMutation() : undefined;
	if (installsOrReplacesVek) beginAutofillLockTransition();
	try {
		const response = await sendToOffscreen(message, vekEpoch);
		if (installsOrReplacesVek && !vekStore.vekMutationIsCurrent(vekEpoch!)) {
			return { ok: false, error: CRYPTO_SESSION_CHANGED };
		}
		if (response.ok) {
			if (type === "CRYPTO_GENERATE_VEK") {
				await refreshActiveVaultId();
				if (!vekStore.vekMutationIsCurrent(vekEpoch!)) {
					return { ok: false, error: CRYPTO_SESSION_CHANGED };
				}
				advanceAutofillSession();
				await scheduleAutoLock();
				if (!vekStore.vekMutationIsCurrent(vekEpoch!)) {
					return { ok: false, error: CRYPTO_SESSION_CHANGED };
				}
				void broadcastLockState(false, autofillSessionGeneration);
			} else if (type === "CRYPTO_UNLOCK_WITH_VEK" || type === "CRYPTO_ROTATE_VEK") {
				// Rollback/recovery unlocks and rotation replace the active VEK in the same
				// cache seam as slot unlocks, so old autofill work cannot cross either.
				await refreshActiveVaultId();
				if (!vekStore.vekMutationIsCurrent(vekEpoch!)) {
					return { ok: false, error: CRYPTO_SESSION_CHANGED };
				}
				advanceAutofillSession();
			} else if (type === "CRYPTO_UNWRAP_PASSWORD_SLOT" || type === "CRYPTO_UNWRAP_WEBAUTHN_SLOT") {
				// The unwrap reply was stripped to a boolean; true means the VEK was recovered and
				// cached (by sendToOffscreen). Both slot kinds count as an unlock of the active vault.
				if (response.data === true) {
					// The UI writes the active vault id to session right before the unwrap, but the
					// onChanged mirror can still be in flight - and vaultLocked() reads that mirror.
					// Refresh it BEFORE announcing the unlock, or the autofill re-query the broadcast
					// triggers is answered "locked" and the page keeps its "Vault locked" row.
					await refreshActiveVaultId();
					if (!vekStore.vekMutationIsCurrent(vekEpoch!)) {
						return { ok: false, error: CRYPTO_SESSION_CHANGED };
					}
					advanceAutofillSession();
					await scheduleAutoLock();
					if (!vekStore.vekMutationIsCurrent(vekEpoch!)) {
						return { ok: false, error: CRYPTO_SESSION_CHANGED };
					}
					void maybeStartSync(vekEpoch); // begin continuous sync if this vault is in a group
					const sessionCurrent = () => vekStore.vekMutationIsCurrent(vekEpoch!);
					void runDueBackups(sessionCurrent); // back up any target that's due, now that the VEK is live
					void broadcastLockState(false, autofillSessionGeneration);
					// If this unlock was reached from a page's "Vault locked" row, the pop-out has
					// done its job: get it off the form the user is going back to.
					void closeUnlockPopout(sessionCurrent);
				}
			}
		}
		return response;
	} finally {
		if (installsOrReplacesVek) endAutofillLockTransition();
	}
}

// CRYPTO_* reaches the offscreen crypto host (incl. CRYPTO_EXPORT_VEK); only extension
// pages may drive it, never a content script. See docs/sec-audit-7726.md (A3).
onPrefix("CRYPTO_", extensionOnly(cryptoHandler));
on(
	"AUTOFILL_GET_SESSION_OWNER",
	extensionOnly(async () => autofillGetSessionOwner()),
);
