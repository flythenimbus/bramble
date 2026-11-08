import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { markLocked } from "./adapters/vault-session";

// Input reports for the shell's auto-lock clock (src-tauri/src/autolock.rs). The clock runs in
// Rust because a hidden webview's timers are throttled.
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel"] as const;
const REPORT_EVERY_MS = 10_000;
const LOCKED_EVENT = "vault://auto-locked";

/** Tell the shell about input in this window, at most once per 10 seconds. */
export function reportActivity(target: EventTarget = document): () => void {
	let last = Number.NEGATIVE_INFINITY;
	const report = () => {
		const now = Date.now();
		if (now - last < REPORT_EVERY_MS) return;
		last = now;
		void invoke("autolock_touch").catch(() => {});
	};
	for (const e of ACTIVITY_EVENTS)
		target.addEventListener(e, report, { passive: true, capture: true });
	return () => {
		for (const e of ACTIVITY_EVENTS) target.removeEventListener(e, report, { capture: true });
	};
}

/** The main window: report input, and take the shell's auto-lock into the app. */
export function startAutoLock(target: EventTarget = document): () => void {
	const stopReporting = reportActivity(target);
	const unlisten = listen(LOCKED_EVENT, () => markLocked());
	return () => {
		stopReporting();
		void unlisten.then((off) => off());
	};
}
