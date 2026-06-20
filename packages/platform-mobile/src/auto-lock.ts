import { App as CapacitorApp } from "@capacitor/app";
import { DEFAULT_AUTOLOCK_MINUTES, PREF_AUTOLOCK_MINUTES } from "@core/hooks/usePrefs";
import { mobileCrypto } from "./adapters/crypto";
import { mobileStorage } from "./adapters/storage";
import { lockForLifecycle } from "./adapters/vault-session";

// Inactivity auto-lock honoring the user's "Auto-lock timeout" setting. We do NOT
// lock the instant the app is backgrounded; instead background time counts as
// inactivity, and the vault locks once the configured timeout has elapsed (and
// never when the setting is "Never" / 0). Foreground idle is caught by an interval;
// background idle is caught on resume.
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;
const CHECK_INTERVAL_MS = 15_000;

let lastActivity = Date.now();

async function timeoutMs(): Promise<number> {
	const m = await mobileStorage.getMeta<number>(PREF_AUTOLOCK_MINUTES);
	const minutes = typeof m === "number" ? m : DEFAULT_AUTOLOCK_MINUTES;
	return minutes <= 0 ? 0 : minutes * 60_000;
}

async function maybeLock(): Promise<void> {
	const t = await timeoutMs();
	if (t === 0) return; // "Never"
	if (Date.now() - lastActivity < t) return;
	if (await mobileCrypto.isLocked()) return;
	await lockForLifecycle();
}

/** Start inactivity tracking + auto-lock. Returns a cleanup function. */
export function startAutoLock(): () => void {
	const bump = () => {
		lastActivity = Date.now();
	};
	for (const e of ACTIVITY_EVENTS) {
		document.addEventListener(e, bump, { passive: true, capture: true });
	}
	const interval = setInterval(() => void maybeLock(), CHECK_INTERVAL_MS);
	// Coming back from the background: check immediately (the interval is suspended
	// while backgrounded, so resume is when accumulated idle time gets evaluated).
	const resume = CapacitorApp.addListener("resume", () => void maybeLock());

	return () => {
		for (const e of ACTIVITY_EVENTS) {
			document.removeEventListener(e, bump, { capture: true });
		}
		clearInterval(interval);
		void resume.then((h) => h.remove());
	};
}
