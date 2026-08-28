import { Capacitor, registerPlugin } from "@capacitor/core";
import { armFilePickGrace } from "./auto-lock";
import { scanQrCode } from "./scan";

// Native iOS QR scanner (ios/App/App/QrScanner.swift). iOS WKWebView can't reach the
// camera via getUserMedia on the capacitor:// scheme, so iOS uses this AVFoundation
// scanner instead of the web jsQR path in ./scan. Resolves the decoded text, or null
// when the user cancels; rejects (surfaced to the sync log) on permission denial.
interface QrScannerPlugin {
	scan(): Promise<{ value: string | null }>;
}

const Native = registerPlugin<QrScannerPlugin>("QrScanner");

/**
 * Scan one QR code (TOTP setup, sync pairing code): native AVFoundation on iOS, jsQR in
 * the webview on Android. Resolves the decoded text, or null if denied/cancelled.
 *
 * The camera permission prompt takes the app out of the foreground, which trips
 * "Immediately" auto-lock and locks the vault out from under the scan (issue #80). Both
 * platforms hit it by a different route: iOS fires appStateChange(false) on
 * willResignActive, while Android's permission dialog never stops the activity and so
 * only lands on the resume backstop. The grace covers either. See ./auto-lock.
 */
export async function scanQr(): Promise<string | null> {
	armFilePickGrace();
	if (Capacitor.getPlatform() !== "ios") return scanQrCode();
	return (await Native.scan()).value ?? null;
}
