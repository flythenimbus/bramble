import { App } from "@capacitor/app";
import type { OptionsScreen, ShellAdapter } from "@core/index";
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
// QR scanning (barcode-scanner plugin) and the sync host are later phases.
export const mobileShell: ShellAdapter = {
	appName: "Bramble",
	// Fallback; resolveAppVersion() overwrites from the native bundle before first render.
	version: "0.0.0-mobile",

	async openSetup(screen) {
		if (!openSetupHandler) throw new Error("setup view not mounted");
		openSetupHandler(screen);
	},
	hasFilePicker() {
		return false;
	},
	async getCurrentTabOrigin() {
		return null;
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
	// No save-capture surface on mobile yet; see docs/mobile-port.md.
	supportsSaveCapture: false,
	async scanQrFromActiveTab() {
		// On mobile this is a camera scan (the "active tab" concept doesn't apply):
		// used for sync pairing codes and TOTP otpauth:// QRs.
		return scanQrCode();
	},
	async flushPendingCornerCapture() {
		return false;
	},

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
