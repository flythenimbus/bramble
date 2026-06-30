/// <reference types="chrome" />

// Background service-worker entry: wires the concern modules together and
// installs the non-message listeners (offscreen bootstrap, alarms, commands,
// idle, prefs). Each concern module registers its own message handlers; the
// router (./background/router) owns the single onMessage dispatcher.

import { api } from "../platform-api";
import "./corner-prompt";
import "./popout";
import "./qr";
import "./sync";
import "./theme";
import "./webauthn-proxy-init";
import { indexHydration } from "./autofill-index";
import { CLIPBOARD_ALARM, runClipboardClear } from "./clipboard";
import { ensureOffscreen, sendToOffscreen } from "./offscreen-client";
import { getPasskeyProviderEnabled, PREF_AUTOLOCK_MINUTES } from "./prefs";
import { setReady } from "./router";
import {
	AUTOLOCK_ALARM,
	clearSession,
	scheduleAutoLock,
	sessionHydration,
	vaultLocked,
} from "./session";
import { maybeStartSync } from "./sync";
import { initWebauthnProxy } from "./webauthn-proxy-init";

// Gate every handler on both hydrations (session VEK + known hostnames) completing.
const hydrated = Promise.all([sessionHydration, indexHydration]);
setReady(hydrated);

// Resume continuous sync after a service-worker restart if the vault is unlocked.
void hydrated.then(() => {
	if (!vaultLocked()) void maybeStartSync();
});

// Attach the passkey provider proxy if the user has opted in (default off, because
// attach() intercepts all browser WebAuthn). See docs/passkey-provider.md.
void getPasskeyProviderEnabled().then((enabled) => {
	if (enabled)
		void initWebauthnProxy().catch((e) => console.warn("[titanpass:bg] passkey proxy", e));
});

api.runtime.onInstalled.addListener(() => {
	void ensureOffscreen();
});

api.runtime.onStartup.addListener(() => {
	void ensureOffscreen();
});

// Firefox stores the vault in storage.local (no File System Access), and that is the
// only copy, so ask the browser to keep this origin's storage from being evicted under
// disk pressure. Best-effort and harmless on Chrome, where unlimitedStorage already
// exempts it. See docs/firefox-port.md "Storage durability".
void navigator.storage?.persist?.().catch(() => {});

api.alarms.onAlarm.addListener((alarm) => {
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
api.commands?.onCommand.addListener((command) => {
	if (command !== "lock-vault") return;
	void (async () => {
		await clearSession();
		await sendToOffscreen({ type: "CRYPTO_LOCK" }).catch(() => {});
	})();
});

// Lock immediately on OS screen-lock. Only `locked` is acted on; `idle` would
// also fire on long reads/videos and is left to the sliding alarm.
api.idle?.onStateChanged.addListener((state) => {
	if (state !== "locked") return;
	// Already torn down: avoid needlessly spinning up the offscreen document.
	if (vaultLocked()) return;
	void (async () => {
		await clearSession();
		await sendToOffscreen({ type: "CRYPTO_LOCK" }).catch(() => {});
	})();
});

// Reschedule the auto-lock alarm live when the timeout pref changes (if unlocked).
api.storage.onChanged.addListener((changes, area) => {
	if (area !== "local") return;
	if (changes[PREF_AUTOLOCK_MINUTES] && !vaultLocked()) {
		void scheduleAutoLock();
	}
});
