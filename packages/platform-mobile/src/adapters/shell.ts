import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import type { OptionsScreen, ShellAdapter } from "@core/index";
import { armFilePickGrace } from "../auto-lock";
import { consumePendingPasskeys as drainPendingPasskeys } from "../autofill-pending-passkeys";
import { scanQrNative } from "../qr-scanner";
import { scanQrCode } from "../scan";
import {
	onSyncEvent,
	onSyncStatus,
	startEnrollInvite,
	startEnrollJoin,
	stopSync,
	syncDevicePublicKey,
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
	supportsPopOut: false,
	supportsCameraScan: true,
	supportsSecurityKeys: false,
	// Android has a native AutofillService save flow (onSaveRequest -> SaveInfo prompt ->
	// prefilled add-login). iOS has no save surface. See docs/mobile-port.md.
	supportsSaveCapture: Capacitor.getPlatform() === "android",
	// Passkey provider is the Chromium webAuthenticationProxy; mobile uses native
	// credential-provider extensions instead. supportsPasskeyProvider gates the extension's
	// runtime toggle (mobile enables the provider in OS Settings, so it stays false).
	supportsPasskeyProvider: false,
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

	// P2P sync runs in-webview (the offscreen indirection collapses on mobile); the
	// transport lives in @core/sync/transport and is driven by ./sync/sync-manager.
	stopSyncSpike: stopSync,
	onSyncStatus,
	syncDevicePublicKey,
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
