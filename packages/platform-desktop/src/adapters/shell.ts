// ShellAdapter for the Tauri window. Much of this interface is extension-shaped (a popup
// that dismisses, a current tab, a pop-out); a desktop window has none of that, so those
// members are absent or inert exactly as they are on mobile. See docs/desktop-port.md.

import type { OptionsScreen, ShellAdapter } from "@core/adapters/shell";
import { desktopDeviceLabel } from "@core/util/device-label";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { onSyncEvent, onSyncStatus } from "../sync/bus";
import {
	signRoster,
	syncAdmissionPublicKey,
	syncAdmissionSign,
	syncDevicePublicKey,
	syncSigningPublicKey,
} from "../sync/keys";
import { ACTIVE_VAULT_KEY, retargetActiveVault } from "../sync/roster";
import {
	approveEnrollment,
	getPendingEnrollApproval,
	resetSyncState,
	startEnrollInvite,
	startEnrollJoin,
	stopEnrollInvite,
	stopSync,
} from "../sync/transport";
import { desktopStorage } from "./storage";

/** Filled once at boot; the Settings "About" row reads it synchronously. */
let appVersion = "0.0.0";

export async function resolveAppVersion(): Promise<void> {
	appVersion = await getVersion();
}

/** Proves the shared Rust crypto core is linked into this binary. */
export function coreVersion(): Promise<string> {
	return invoke<string>("core_version");
}

/** Set by main.tsx so the shell can drive the full-screen setup/import flows in-window. */
let openSetupScreen: ((screen?: OptionsScreen) => void) | null = null;

export function registerOpenSetup(fn: (screen?: OptionsScreen) => void): void {
	openSetupScreen = fn;
}

export const desktopShell: ShellAdapter = {
	appName: "Bramble",

	// The webview's user agent describes WKWebView, so sniffing it named this app "Browser on
	// Mac": wrong, and indistinguishable from a real browser in the device list.
	deviceLabel: desktopDeviceLabel,
	get version() {
		return appVersion;
	},

	// One window, so "the full-tab UI" is just a route change rather than a new context.
	openSetup: async (screen) => {
		openSetupScreen?.(screen);
	},

	// The dialog plugin picks the path; the bytes go through our own command rather than
	// the fs plugin, so there is no filesystem scope to configure and widen over time.
	exportBytes: async (suggestedName, bytes, _mimeType) => {
		const path = await save({ defaultPath: suggestedName });
		if (!path) return;
		await invoke<void>("shell_export_bytes", { path, bytes: Array.from(bytes) });
	},

	// No browser tab to read. Same as mobile.
	getCurrentTabOrigin: async () => null,
	matchCurrentTab: async () => [],
	scanQrFromActiveTab: async () => null,

	// A desktop window doesn't dismiss on focus loss, so there is nothing to pop out of
	// and no route to persist across a teardown.
	popOut: async () => {},
	consumeHandoff: async () => null,
	isDetached: () => false,

	// The panel asking this window to open an entry. One window, so this is a route change
	// rather than a new context; the router's guards still apply.
	onNavigateRequest: (callback) => {
		const pending = listen<{ href: string }>("navigate", (e) => callback(e.payload.href));
		let stop: (() => void) | null = null;
		void pending.then((un) => {
			stop = un;
		});
		return () => {
			stop?.();
			// Subscribed and unsubscribed before the listener resolved: drop it when it lands.
			void pending.then((un) => un());
		};
	},

	// No corner prompt without the extension bridge (phase 4), so nothing is ever parked.
	flushPendingCornerCapture: async () => false,

	// Which vault the app is in. Sync reads it to target that vault's namespaced keys, and
	// the registry restores it on reopen. Written on unlock, left in place on lock.
	//
	// Retarget sync BEFORE recording the new id: the live session is pinned to the old vault,
	// and a merge landing after the id moves but before the session stops writes into the
	// wrong vault's file (issue #27). retargetActiveVault stops it and drains any merge.
	setActiveVault: async (vaultId) => {
		await retargetActiveVault(vaultId ?? null);
		await (vaultId == null
			? desktopStorage.removeMeta(ACTIVE_VAULT_KEY)
			: desktopStorage.setMeta(ACTIVE_VAULT_KEY, vaultId));
	},
	getActiveVault: async () => (await desktopStorage.getMeta<string>(ACTIVE_VAULT_KEY)) ?? null,

	// This device's sync identity. Real: the keypairs live in the OS credential store and
	// only their public halves ever leave here. See ../sync/keys.
	syncDevicePublicKey,
	syncSigningPublicKey,
	signRoster,
	syncAdmissionPublicKey,
	syncAdmissionSign,
	resetSyncState,

	// Enrollment, running in this webview: WKWebView has WebRTC, so @core's transport and
	// relay client work unchanged. See ../sync/transport.
	stopSyncSpike: stopSync,
	stopEnrollInvite,
	onSyncStatus,
	onSyncEvent,
	startEnrollInvite,
	startEnrollJoin,
	approveEnrollment,
	getPendingEnrollApproval,
};
