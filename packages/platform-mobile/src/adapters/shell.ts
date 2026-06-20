import type { ShellAdapter } from "@core/index";
import {
	onSyncEvent,
	onSyncStatus,
	startEnrollInvite,
	startEnrollJoin,
	stopSync,
	syncDevicePublicKey,
} from "../sync/sync-manager";

// Single-window in-app navigation to the setup/create-vault flow. The root
// (main.tsx) registers a handler that swaps the mounted view; `openSetup` invokes
// it instead of opening a separate tab the way the extension does.
let openSetupHandler: (() => void) | null = null;
export function registerOpenSetup(fn: () => void): () => void {
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
	version: "0.0.0-mobile",

	async openSetup() {
		if (!openSetupHandler) throw new Error("setup view not mounted");
		openSetupHandler();
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
	async scanQrFromActiveTab() {
		// TODO: @capacitor-mlkit/barcode-scanning (camera) in the QR phase.
		return null;
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
