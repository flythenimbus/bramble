import type { ShellAdapter } from "@core/index";

// Mobile is a single-window app: the pop-out / detached-window machinery and the
// "active browser tab" concept have no meaning here, so those collapse to no-ops.
// QR scanning (barcode-scanner plugin) and the sync host are later phases.
export const mobileShell: ShellAdapter = {
	appName: "Bramble",
	version: "0.0.0-mobile",

	async openSetup() {
		// Settings/import are in-app routes on mobile; nothing to open externally.
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

	// Sync host is a later phase; inert stubs keep the settings panel from throwing.
	async stopSyncSpike() {},
	onSyncStatus() {
		return () => {};
	},
	async syncDevicePublicKey() {
		throw new Error("sync not implemented in the mobile POC");
	},
	async startEnrollInvite() {},
	async startEnrollJoin() {},
	onSyncEvent() {
		return () => {};
	},
};
