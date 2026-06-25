import { Capacitor } from "@capacitor/core";
import { loadNativeCrypto } from "../native-crypto";
import { loadWasm } from "../wasm-loader";

// The vault session lifecycle, kept separate from crypto operations. Three signals:
//  - onExternalLock: the vault was locked from outside the UI flow (app background) —
//    useVault drops decrypted state and bounces to the unlock screen.
//  - onExternalChange: a sync merge wrote new entries out-of-band — useVault reloads.
//  - onVaultStateChange: lock/unlock transitions — the sync runtime starts/stops
//    roster sync (the VEK is gone while locked, so merges can't decrypt).
// The crypto adapter reports transitions via markLocked/markUnlocked; it no longer
// owns this machinery.

const lockListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();
const stateListeners = new Set<(locked: boolean) => void>();

export function onExternalLock(cb: () => void): () => void {
	lockListeners.add(cb);
	return () => lockListeners.delete(cb);
}
export function onExternalChange(cb: () => void): () => void {
	changeListeners.add(cb);
	return () => changeListeners.delete(cb);
}
export function onVaultStateChange(cb: (locked: boolean) => void): () => void {
	stateListeners.add(cb);
	return () => stateListeners.delete(cb);
}

/** Reported by the crypto adapter after a successful unlock. */
export function markUnlocked(): void {
	for (const fn of stateListeners) fn(false);
}
/** Reported by the crypto adapter after a lock. */
export function markLocked(): void {
	for (const fn of stateListeners) fn(true);
}
/** A sync merge wrote new entries out-of-band; tell the UI to reload. */
export function notifyExternalChange(): void {
	for (const fn of changeListeners) fn();
}

/** Lock on app background: lock the wasm, relock the UI (onExternalLock), and signal
 * the transition (stops sync). Distinct from the UI-driven crypto adapter `lock()`. */
export async function lockForLifecycle(): Promise<void> {
	// Native on device (no WASM under Lockdown Mode); WASM only in the dev browser.
	const crypto = Capacitor.isNativePlatform() ? await loadNativeCrypto() : await loadWasm();
	await crypto.lock();
	for (const fn of lockListeners) fn();
	markLocked();
}
