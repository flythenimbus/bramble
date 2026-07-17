/// <reference types="chrome" />

// Background service-worker entry: wires the concern modules together and
// installs the non-message listeners (offscreen bootstrap, alarms, commands,
// idle, prefs). Each concern module registers its own message handlers; the
// router (./background/router) owns the single onMessage dispatcher.

import { BACKUP_TARGETS_KEY } from "@core/backup/config";
import { api } from "../platform-api";
import { BACKUP_ALARM, runDueBackups, scheduleBackups } from "./backup";
import "./backup-connect";
import "./corner-prompt";
import "./popout";
import "./qr";
import "./sync";
import "./theme";
import "./webauthn-proxy-init";
import "./webauthn-content-transport";
import { isVaultBlobKey } from "../storage";
import { isSyncGroupKey } from "../sync/sync-config";
import { indexHydration } from "./autofill-index";
import { CLIPBOARD_ALARM, runClipboardClear } from "./clipboard";
import { ensureOffscreen, sendToOffscreen } from "./offscreen-client";
import { getLockOnScreenLock, PREF_AUTOLOCK_MINUTES } from "./prefs";
import { setReady } from "./router";
import {
	AUTOLOCK_ALARM,
	clearSession,
	scheduleAutoLock,
	sessionHydration,
	vaultLocked,
} from "./session";
import { maybeStartSync, SYNC_KEEPALIVE_ALARM } from "./sync";
import { startViewLock } from "./view-lock";
import { isProviderEnabled, loadProviderEnabled } from "./webauthn-provider";
import { initWebauthnProxy } from "./webauthn-proxy-init";

// Gate every handler on both hydrations (session VEK + known hostnames) completing.
const hydrated = Promise.all([sessionHydration, indexHydration]);
setReady(hydrated);

// Resume continuous sync after a service-worker restart if the vault is unlocked,
// re-arm the backup poke, and run any backup that's already due.
void hydrated.then(() => {
	if (!vaultLocked()) {
		void maybeStartSync();
		void runDueBackups();
	}
	void scheduleBackups();
});

// Load the passkey-provider opt-in into the in-memory flag (default off). On Chrome the
// flag also drives attach() of the webAuthenticationProxy; on Firefox the flag alone gates
// the MAIN-world content transport (which is always injected and passes through when off).
// See docs/passkey-provider.md and docs/firefox-port.md.
void loadProviderEnabled().then(() => {
	if (isProviderEnabled())
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
	if (alarm.name === SYNC_KEEPALIVE_ALARM) {
		// Firefox keep-alive: the fire already woke the event page (which re-runs the
		// resume-on-startup above); re-ensure sync in case it wasn't a cold start.
		if (!vaultLocked()) void maybeStartSync();
		return;
	}
	if (alarm.name === BACKUP_ALARM) {
		if (!vaultLocked()) void runDueBackups();
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

// "Immediate" auto-lock: lock when the last extension view (popup / pop-out / options)
// closes. The browser analog of mobile's lock-on-background.
startViewLock();

// Lock on OS screen-lock, unless the user turned off "Lock when the screen locks" (default
// on) to stay unlocked on a trusted device even under "Never" (issue #6). Only `locked` is
// acted on; `idle` would also fire on long reads/videos and is left to the sliding alarm.
api.idle?.onStateChanged.addListener((state) => {
	if (state !== "locked") return;
	// Already torn down: avoid needlessly spinning up the offscreen document.
	if (vaultLocked()) return;
	void (async () => {
		if (!(await getLockOnScreenLock())) return;
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
	// A vault-blob change (a local edit, or a remote merge that actually changed state — the merge
	// skips the write otherwise, so this can't echo) pushes to peers now instead of waiting for the
	// rebroadcast tick. Matters most on Firefox, whose event page suspends between ticks; the write
	// itself wakes it. Match any vault's namespaced `vault-blob-b64:<id>` key (only the unlocked
	// vault changes while unlocked).
	// Best-effort. See docs/p2p-sync.md.
	if (Object.keys(changes).some(isVaultBlobKey) && !vaultLocked()) {
		void (async () => {
			await maybeStartSync();
			await sendToOffscreen({ type: "SYNC_BROADCAST_NOW" }).catch(() => {});
		})();
	}
	// A group appearing (a fresh invite) or its roster growing (a device just enrolled) means this
	// vault should be syncing. Start the ongoing-sync host now instead of waiting for the first local
	// edit or the keepalive tick, so a freshly paired vault reconciles promptly. maybeStartSync is a
	// no-op if already running (its own guard), so a roster gossip write can't restart-loop it.
	if (Object.keys(changes).some(isSyncGroupKey) && !vaultLocked()) {
		void maybeStartSync();
	}
	// Re-arm or clear the backup poke when the target list or a schedule changes.
	if (changes[BACKUP_TARGETS_KEY]) void scheduleBackups();
});
