/// <reference types="chrome" />

// Background service-worker entry: wires the concern modules together and
// installs the non-message listeners (offscreen bootstrap, alarms, commands,
// idle, prefs). Each concern module registers its own message handlers; the
// router (./background/router) owns the single onMessage dispatcher.

import "./corner-prompt";
import "./popout";
import "./qr";
import { indexHydration } from "./autofill-index";
import { CLIPBOARD_ALARM, runClipboardClear } from "./clipboard";
import { ensureOffscreen, sendToOffscreen } from "./offscreen-client";
import { PREF_AUTOLOCK_MINUTES } from "./prefs";
import { setReady } from "./router";
import {
	AUTOLOCK_ALARM,
	clearSession,
	scheduleAutoLock,
	sessionHydration,
	vaultLocked,
} from "./session";

// Gate every handler on both hydrations (session VEK + known hostnames) completing.
setReady(Promise.all([sessionHydration, indexHydration]));

chrome.runtime.onInstalled.addListener(() => {
	void ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => {
	void ensureOffscreen();
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === AUTOLOCK_ALARM) {
		void (async () => {
			await clearSession();
			await sendToOffscreen({ type: "CRYPTO_LOCK" }).catch(() => {});
		})();
		return;
	}
	if (alarm.name === CLIPBOARD_ALARM) {
		void runClipboardClear();
		return;
	}
});

// Manual lock via the user-bound `lock-vault` shortcut (declared without a default chord).
chrome.commands?.onCommand.addListener((command) => {
	if (command !== "lock-vault") return;
	void (async () => {
		await clearSession();
		await sendToOffscreen({ type: "CRYPTO_LOCK" }).catch(() => {});
	})();
});

// Lock immediately on OS screen-lock. Only `locked` is acted on; `idle` would
// also fire on long reads/videos and is left to the sliding alarm.
chrome.idle?.onStateChanged.addListener((state) => {
	if (state !== "locked") return;
	// Already torn down: avoid needlessly spinning up the offscreen document.
	if (vaultLocked()) return;
	void (async () => {
		await clearSession();
		await sendToOffscreen({ type: "CRYPTO_LOCK" }).catch(() => {});
	})();
});

// Reschedule the auto-lock alarm live when the timeout pref changes (if unlocked).
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "local") return;
	if (changes[PREF_AUTOLOCK_MINUTES] && !vaultLocked()) {
		void scheduleAutoLock();
	}
});
