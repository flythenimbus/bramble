import { App as CapacitorApp } from "@capacitor/app";
import { DEFAULT_AUTOLOCK_MINUTES, PREF_AUTOLOCK_MINUTES } from "@core/hooks/usePrefs";
import { mobileCrypto } from "./adapters/crypto";
import { mobileStorage } from "./adapters/storage";
import { lockForLifecycle } from "./adapters/vault-session";
import { decideLock, type LockReason } from "./auto-lock-decision";

// Auto-lock honoring the user's "Auto-lock timeout" setting. For a positive timeout,
// background time counts as inactivity and the vault locks once it elapses; "Never" (0)
// never locks; "Immediately" (-1) locks the moment the app leaves the foreground (and on
// return). Foreground idle is caught by an interval.
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;
const CHECK_INTERVAL_MS = 15_000;
// A native file picker (import file, KDBX keyfile) backgrounds the app, which would trip
// "Immediately" auto-lock and drop the in-progress import. armFilePickGrace() opens a short
// window in which that one background→foreground cycle is skipped; it's consumed on return
// and the window itself is the backstop if the picker never opens.
const FILE_PICK_GRACE_MS = 120_000;

let lastActivity = Date.now();
let filePickGraceUntil = 0;

/** Keep the vault unlocked across the single background→foreground cycle a native file
 * picker causes. Called by the shell adapter right before a picker opens. */
export function armFilePickGrace(): void {
	filePickGraceUntil = Date.now() + FILE_PICK_GRACE_MS;
}

async function autoLockMinutes(): Promise<number> {
	const m = await mobileStorage.getMeta<number>(PREF_AUTOLOCK_MINUTES);
	return typeof m === "number" ? m : DEFAULT_AUTOLOCK_MINUTES;
}

// `reason` distinguishes a foreground idle tick from leaving/returning to the app,
// which is what "Immediately" (-1) keys off.
async function maybeLock(reason: LockReason): Promise<void> {
	if (await mobileCrypto.isLocked()) return;
	const minutes = await autoLockMinutes();
	const now = Date.now();
	const decision = decideLock(reason, minutes, now - lastActivity, now < filePickGraceUntil);
	if (decision.bumpActivity) lastActivity = now;
	if (decision.consumeGrace) filePickGraceUntil = 0;
	if (decision.lock) await lockForLifecycle();
}

/** Start inactivity tracking + auto-lock. Returns a cleanup function. */
export function startAutoLock(): () => void {
	const bump = () => {
		lastActivity = Date.now();
	};
	for (const e of ACTIVITY_EVENTS) {
		document.addEventListener(e, bump, { passive: true, capture: true });
	}
	const interval = setInterval(() => void maybeLock("idle"), CHECK_INTERVAL_MS);
	// Coming back from the background: check accumulated idle time (the interval is
	// suspended while backgrounded), and lock on return for "Immediately".
	const resume = CapacitorApp.addListener("resume", () => void maybeLock("returned"));
	// "Immediately" clears the key the moment the app leaves the foreground.
	const stateChange = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
		if (!isActive) void maybeLock("left");
	});

	return () => {
		for (const e of ACTIVITY_EVENTS) {
			document.removeEventListener(e, bump, { capture: true });
		}
		clearInterval(interval);
		void resume.then((h) => h.remove());
		void stateChange.then((h) => h.remove());
	};
}
