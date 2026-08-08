// ShellAdapter for the Tauri window. Much of this interface is extension-shaped (a popup
// that dismisses, a current tab, a pop-out); a desktop window has none of that, so those
// members are absent or inert exactly as they are on mobile. See docs/desktop-port.md.

import type { OptionsScreen, ShellAdapter } from "@core/adapters/shell";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
	resetSyncState,
	signRoster,
	syncAdmissionPublicKey,
	syncAdmissionSign,
	syncDevicePublicKey,
	syncSigningPublicKey,
} from "../sync/keys";

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

	// No corner prompt without the extension bridge (phase 4), so nothing is ever parked.
	flushPendingCornerCapture: async () => false,

	// This device's sync identity. Real: the keypairs live in the OS credential store and
	// only their public halves ever leave here. See ../sync/keys.
	syncDevicePublicKey,
	syncSigningPublicKey,
	signRoster,
	syncAdmissionPublicKey,
	syncAdmissionSign,
	resetSyncState,

	// The transport itself is the next slice. These stay honest about that rather than
	// pretending: an enrollment that silently did nothing would be worse than one that says
	// it cannot run. See docs/desktop-port.md.
	stopSyncSpike: async () => {},
	onSyncStatus: () => () => {},
	onSyncEvent: () => () => {},
	startEnrollInvite: async () => {
		throw new Error("Device sync is not wired on desktop yet");
	},
	startEnrollJoin: async () => {
		throw new Error("Device sync is not wired on desktop yet");
	},
};
