// Pure auto-lock decision, split out from auto-lock.ts so it has zero Capacitor/DOM
// imports and can be unit-tested directly.

/** `idle` = a foreground inactivity tick; `left`/`returned` = the app leaving/re-entering
 * the foreground, which is what "Immediately" keys off. */
export type LockReason = "idle" | "left" | "returned";

export interface LockDecision {
	/** Lock the vault now (call lockForLifecycle). */
	lock: boolean;
	/** Clear the file-pick grace (the picker cycle is done). */
	consumeGrace: boolean;
	/** Reset the inactivity clock (the picker detour isn't idle time). */
	bumpActivity: boolean;
}

const NOOP: LockDecision = { lock: false, consumeGrace: false, bumpActivity: false };

/**
 * Decide whether a lifecycle/idle event should lock the vault.
 *  - `minutes`: 0 = "Never", <0 = "Immediately", >0 = idle-timeout in minutes.
 *  - `idleMs`: time since the last user activity.
 *  - `graceActive`: a native file picker (import/keyfile) is mid-flight, so the one
 *    background→foreground cycle it causes must not lock the vault out from under it.
 */
export function decideLock(
	reason: LockReason,
	minutes: number,
	idleMs: number,
	graceActive: boolean,
): LockDecision {
	if (minutes === 0) return NOOP; // "Never"
	// A file picker backgrounded us: skip this leave/return lock and keep the session,
	// consuming the grace once the app is back so normal locking resumes next time.
	if (reason !== "idle" && graceActive) {
		return { lock: false, consumeGrace: reason === "returned", bumpActivity: true };
	}
	if (minutes < 0) {
		// "Immediately": lock on leaving the foreground (backstopped on return).
		return { ...NOOP, lock: reason !== "idle" };
	}
	return { ...NOOP, lock: idleMs >= minutes * 60_000 };
}
