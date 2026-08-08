// The vault session lifecycle, kept separate from crypto operations.
//
// Three signals, mirroring mobile's:
//  - onExternalLock: the vault was locked from outside the UI flow, so useVault drops decrypted
//    state and bounces to the unlock screen.
//  - onExternalChange: a sync merge wrote new entries out of band, so useVault reloads.
//  - onVaultStateChange: lock and unlock transitions, which start and stop roster sync. While
//    locked the VEK is gone from the Rust process, so a merge could not decrypt anything.
//
// The crypto adapter reports the transitions; nothing here reaches into it.

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
	for (const fn of lockListeners) fn();
}

/** A sync merge wrote new entries out of band; tell the UI to reload rather than leaving it
 * showing a list the file no longer matches. */
export function notifyExternalChange(): void {
	for (const fn of changeListeners) fn();
}
