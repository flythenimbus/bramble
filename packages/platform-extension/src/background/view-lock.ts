/// <reference types="chrome" />

import { api } from "../platform-api";
import { sendToOffscreen } from "./offscreen-client";
import { getAutoLockMinutes } from "./prefs";
import { clearSession, vaultLocked } from "./session";

// "Immediate" auto-lock (pref.autoLockMinutes < 0): the vault is only unlocked while an
// extension view is open. Each view (popup, pop-out window, options page) holds a runtime
// port for its lifetime; when the last one disconnects we lock the vault. The extension has
// no "app backgrounded" signal like mobile, so a closed view is the analog. Timed modes
// (> 0) use the alarm in session.ts; "Never" (0) does neither.
//
// A pop-out hands off popup -> detached window, briefly leaving zero views open; the popup's
// port disconnects a beat before the new window connects. armViewGrace() (called when a
// pop-out is requested) keeps the vault unlocked across that gap.
const VIEW_PORT = "tp-view"; // must match view-port.ts (page side)
const CLOSE_DEBOUNCE_MS = 150; // near-instant lock on a real close, minus event jitter
const POPOUT_GRACE_MS = 8_000; // popup -> detached-window handoff can be slow to reconnect

const openViews = new Set<chrome.runtime.Port>();
let graceUntil = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

async function lockVault(): Promise<void> {
	try {
		await clearSession();
	} catch (error) {
		// The VEK store has failed closed; still zeroize the offscreen scratch slot and leave a
		// useful diagnostic because this timer has no response channel to report the failure.
		console.error("[titanpass:bg] view-close session cleanup failed", error);
	} finally {
		await sendToOffscreen({ type: "CRYPTO_LOCK" }).catch(() => {});
	}
}

function scheduleCheck(): void {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => void runCheck(), Math.max(CLOSE_DEBOUNCE_MS, graceUntil - Date.now()));
}

async function runCheck(): Promise<void> {
	timer = undefined;
	if (openViews.size > 0) return; // a view (re)opened before the timer fired
	if (Date.now() < graceUntil) return scheduleCheck(); // still inside a pop-out handoff window
	if (vaultLocked()) return; // already locked: don't spin the offscreen back up
	if ((await getAutoLockMinutes()) >= 0) return; // only "Immediate" (< 0) locks on close
	await lockVault();
}

/** Keep the vault unlocked across the popup -> pop-out handoff, where the popup closes a
 * beat before the detached window connects. Called when a pop-out is requested. */
export function armViewGrace(): void {
	graceUntil = Date.now() + POPOUT_GRACE_MS;
	// If the popup already closed (its disconnect scheduled a short lock), extend that
	// pending timer over the handoff window.
	if (openViews.size === 0 && timer) scheduleCheck();
}

/** Track extension views and lock on last-close in "Immediate" mode. Call once at startup. */
export function startViewLock(): void {
	api.runtime.onConnect.addListener((port) => {
		if (port.name !== VIEW_PORT) return;
		openViews.add(port);
		if (timer) {
			clearTimeout(timer); // a view is open again: cancel any pending close -> lock
			timer = undefined;
		}
		port.onDisconnect.addListener(() => {
			openViews.delete(port);
			if (openViews.size === 0) scheduleCheck();
		});
	});
}
