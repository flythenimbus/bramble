import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { OptionsScreen, ShellAdapter, Target } from "@core/index";
import { bytesToBase64 } from "@core/util/bytes";
import { armFilePickGrace } from "../auto-lock";
import { consumePendingPasskeys as drainPendingPasskeys } from "../autofill-pending-passkeys";
import { scanQrNative } from "../qr-scanner";
import { scanQrCode } from "../scan";
import {
	onSyncEvent,
	onSyncStatus,
	resetSyncState,
	signRoster,
	startEnrollInvite,
	startEnrollJoin,
	stopSync,
	syncAdmissionPublicKey,
	syncAdmissionSign,
	syncDevicePublicKey,
	syncSigningPublicKey,
} from "../sync/sync-manager";

// Single-window in-app navigation to the setup/create-vault and import flows. The
// root (main.tsx) registers a handler that swaps the mounted view; `openSetup`
// invokes it (with the optional screen) instead of opening a separate tab.
type OpenSetupHandler = (screen?: OptionsScreen) => void;
let openSetupHandler: OpenSetupHandler | null = null;
export function registerOpenSetup(fn: OpenSetupHandler): () => void {
	openSetupHandler = fn;
	return () => {
		if (openSetupHandler === fn) openSetupHandler = null;
	};
}

// Mobile is a single-window app: the pop-out / detached-window machinery and the
// "active browser tab" concept have no meaning here, so those collapse to no-ops.
// QR scanning is native AVFoundation on iOS (../qr-scanner) and jsQR on Android (../scan).
/** Build target from the Capacitor runtime; resolves platform capabilities (see @core/flags `can`). */
export const mobileTarget: Target = Capacitor.getPlatform() === "ios" ? "ios" : "android";

export const mobileShell: ShellAdapter = {
	appName: "Bramble",
	// Fallback; resolveAppVersion() overwrites from the native bundle before first render.
	version: "0.0.0-mobile",

	async openSetup(screen) {
		if (!openSetupHandler) throw new Error("setup view not mounted");
		openSetupHandler(screen);
	},
	async getCurrentTabOrigin() {
		return null;
	},
	// No browser tab on mobile, so nothing is a current-site match.
	async matchCurrentTab() {
		return [];
	},
	async popOut() {},
	async consumeHandoff() {
		return null;
	},
	isDetached() {
		return false;
	},
	// iOS + Android: the native credential provider mints passkeys during sign-in registration but
	// can't write the vault, so it hands them off (iOS App Group / Android file) and the app drains
	// them here on launch. drainPendingPasskeys reads the right per-platform source.
	consumePendingPasskeys: drainPendingPasskeys,
	async scanQrFromActiveTab() {
		// On mobile this is a camera scan (the "active tab" concept doesn't apply):
		// used for sync pairing codes and TOTP otpauth:// QRs. iOS WKWebView can't use
		// getUserMedia from the capacitor:// scheme, so iOS goes through a native
		// AVFoundation plugin; Android (served from https://localhost) uses jsQR.
		return Capacitor.getPlatform() === "ios" ? scanQrNative() : scanQrCode();
	},
	async flushPendingCornerCapture() {
		return false;
	},
	// A native file picker backgrounds the app; without this the "Immediately" auto-lock
	// would fire and drop the in-progress import. See ./auto-lock.ts.
	notifyFilePickerOpening: armFilePickGrace,

	// Save bytes the user keeps (recovery code, encrypted vault export) via the native share
	// sheet, so "Save to Files", Mail, etc. are offered - WKWebView has no <a download> or
	// navigator.share. Stage the file in the cache dir, hand its URL to the share sheet, then
	// clean up. The sheet backgrounds the app, which would trip "Immediate" auto-lock, so arm
	// the file-pick grace first (see ./auto-lock.ts).
	async exportBytes(suggestedName, bytes, _mimeType) {
		await Filesystem.writeFile({
			path: suggestedName,
			data: bytesToBase64(bytes),
			directory: Directory.Cache,
		});
		const { uri } = await Filesystem.getUri({ path: suggestedName, directory: Directory.Cache });
		armFilePickGrace();
		try {
			// `files` (not `url`) is the cross-platform file-share path: on Android it routes the
			// file:// URI through a FileProvider (a raw file:// url would throw FileUriExposedException).
			await Share.share({ title: suggestedName, files: [uri] });
		} catch (e) {
			// Dismissing the share sheet rejects; that's a normal cancel, not a failure.
			if (!/cancel/i.test(String((e as Error)?.message))) throw e;
		} finally {
			await Filesystem.deleteFile({ path: suggestedName, directory: Directory.Cache }).catch(
				() => {},
			);
		}
	},

	// P2P sync runs in-webview (the offscreen indirection collapses on mobile); the
	// transport lives in @core/sync/transport and is driven by ./sync/sync-manager.
	stopSyncSpike: stopSync,
	// Wipe all local sync state on new-vault creation (group, device keys, relay, mesh); without
	// this a fresh vault inherited the old group and reconnected to the old mesh. See sync-manager.
	resetSyncState,
	onSyncStatus,
	syncDevicePublicKey,
	// Roster-entry signing + password-authority admission (Item A). Once these are present the
	// shared core signs own entries + admission-signs joiners automatically. See docs/p2p-sync-revocation-hardening.md.
	syncSigningPublicKey,
	signRoster,
	syncAdmissionPublicKey,
	syncAdmissionSign,
	startEnrollInvite,
	startEnrollJoin,
	onSyncEvent,
};

// Set the About-row version from the native bundle (App Store / TestFlight / Play).
export async function resolveAppVersion(): Promise<void> {
	try {
		const { version, build } = await App.getInfo();
		mobileShell.version = build ? `${version} (${build})` : version;
	} catch {
		// getInfo() is web-unimplemented; keep the fallback.
	}
}
