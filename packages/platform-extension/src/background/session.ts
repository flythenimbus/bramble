/// <reference types="chrome" />

import { api } from "../platform-api";
import { isExtensionSender } from "../sender";
import { ACTIVE_VAULT_SESSION_KEY, CORNER_HANDOFF_KEY } from "../session-keys";
import { clearIndex } from "./autofill-index";
import { runDueBackups } from "./backup";
import { CAPTURE_KEY_PREFIX } from "./corner-prompt";
import { sendToOffscreen } from "./offscreen-client";
import { closeUnlockPopout, POPOUT_HANDOFF_KEY } from "./popout";
import { getAutoLockMinutes } from "./prefs";
import { extensionOnly, type MessageEnvelope, onPrefix } from "./router";
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

/** Begin/end are depth-counted because CRYPTO_LOCK and clearSession can nest. */
function beginAutofillLockTransition(): void {
	autofillSessionGeneration++;
	lockTransitions++;
}

function endAutofillLockTransition(): void {
	lockTransitions = Math.max(0, lockTransitions - 1);
}

/** A successful unlock or active-vault replacement invalidates old autofill work. */
function advanceAutofillSession(): void {
	autofillSessionGeneration++;
}

// The router awaits background hydration before invoking handlers. Observe a privileged lock
// message in the dispatch task itself so continuation revalidation already sees the transition,
// even when hydration or active-vault resolution is held. The actual handler consumes this
// depth-counted transition and closes it in its normal finally block.
api.runtime.onMessage.addListener((message, sender) => {
	// Outbound background -> offscreen traffic is visible to this listener too. It is
	// already enclosed by the initiating lock path and must not leave an unconsumed prestart.
	if (
		message?.target === "offscreen" ||
		message?.type !== "CRYPTO_LOCK" ||
		!isExtensionSender(sender)
	) {
		return false;
	}
	beginAutofillLockTransition();
	prestartedCryptoLocks++;
	return false;
});

// The shell selects an active vault by writing this session key directly. Treat a
// replacement exactly like an unlock transition: a request authorized for the old
// active vault must not complete under the new one. This listener uses the standard
// storage-wide event (and is exercised by the background harness), not a tab signal.
api.storage.onChanged.addListener((changes, area) => {
	if (area !== "session") return;
	const change = changes[ACTIVE_VAULT_SESSION_KEY];
	if (change && change.oldValue !== change.newValue) advanceAutofillSession();
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
	return vekStore.refreshActiveVaultId();
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
		console.warn("[titanpass:bg] session hydration failed", e);
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
async function broadcastLockState(locked: boolean): Promise<void> {
	try {
		const tabs = await api.tabs.query({});
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
	try {
		// Content must cancel a pending fill/submit before the VEK/session cleanup awaits.
		// This remains best-effort, but initiating it here closes the timer race locally.
		void broadcastLockState(true);
		clearIndex();
		void stopSync();
		await vekStore.clearAllVeks();
		await removeHandoffKeys();
		void api.alarms.clear(AUTOLOCK_ALARM);
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
			if (vaultId !== null) await lockVault(vaultId);
			else await clearSession();
			return response;
		} finally {
			endAutofillLockTransition();
		}
	}
	const installsOrReplacesVek =
		type === "CRYPTO_GENERATE_VEK" ||
		type === "CRYPTO_UNWRAP_PASSWORD_SLOT" ||
		type === "CRYPTO_UNWRAP_WEBAUTHN_SLOT" ||
		type === "CRYPTO_UNLOCK_WITH_VEK" ||
		type === "CRYPTO_ROTATE_VEK";
	// sendToOffscreen installs a recovered/generated VEK before its own storage await
	// completes. Hold this nested-safe transition across that entire seam.
	if (installsOrReplacesVek) beginAutofillLockTransition();
	try {
		const response = await sendToOffscreen(message);
		if (response.ok) {
			if (type === "CRYPTO_GENERATE_VEK") {
				await refreshActiveVaultId();
				advanceAutofillSession();
				await scheduleAutoLock();
				void broadcastLockState(false);
			} else if (type === "CRYPTO_UNLOCK_WITH_VEK" || type === "CRYPTO_ROTATE_VEK") {
				// Rollback/recovery unlocks and rotation replace the active VEK in the same
				// cache seam as slot unlocks, so old autofill work cannot cross either.
				await refreshActiveVaultId();
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
					advanceAutofillSession();
					await scheduleAutoLock();
					void maybeStartSync(); // begin continuous sync if this vault is in a group
					void runDueBackups(); // back up any target that's due, now that the VEK is live
					void broadcastLockState(false);
					// If this unlock was reached from a page's "Vault locked" row, the pop-out has
					// done its job: get it off the form the user is going back to.
					void closeUnlockPopout();
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
