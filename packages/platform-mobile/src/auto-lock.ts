import { App as CapacitorApp } from "@capacitor/app";
import { DEFAULT_AUTOLOCK_MINUTES, PREF_AUTOLOCK_MINUTES } from "@core/hooks/usePrefs";
import { mobileCrypto } from "./adapters/crypto";
import { mobileStorage } from "./adapters/storage";
import { lockForLifecycle } from "./adapters/vault-session";

// Auto-lock honoring the user's "Auto-lock timeout" setting. For a positive timeout,
// background time counts as inactivity and the vault locks once it elapses; "Never" (0)
// never locks; "Immediately" (-1) locks the moment the app leaves the foreground (and on
// return). Foreground idle is caught by an interval.
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;
const CHECK_INTERVAL_MS = 15_000;

let lastActivity = Date.now();

async function autoLockMinutes(): Promise<number> {
	const m = await mobileStorage.getMeta<number>(PREF_AUTOLOCK_MINUTES);
	return typeof m === "number" ? m : DEFAULT_AUTOLOCK_MINUTES;
}

// `reason` distinguishes a foreground idle tick from leaving/returning to the app,
// which is what "Immediately" (-1) keys off.
async function maybeLock(reason: "idle" | "left" | "returned"): Promise<void> {
	const minutes = await autoLockMinutes();
	if (minutes === 0) return; // "Never"
	if (await mobileCrypto.isLocked()) return;
	if (minutes < 0) {
		// "Immediately": lock on leaving the foreground (backstopped on return).
		if (reason !== "idle") await lockForLifecycle();
		return;
	}
	if (Date.now() - lastActivity >= minutes * 60_000) await lockForLifecycle();
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
