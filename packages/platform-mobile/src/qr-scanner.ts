import { registerPlugin } from "@capacitor/core";

// Native iOS QR scanner (ios/App/App/QrScanner.swift). iOS WKWebView can't reach the
// camera via getUserMedia on the capacitor:// scheme, so iOS uses this AVFoundation
// scanner instead of the web jsQR path in ./scan. Resolves the decoded text, or null
// when the user cancels; rejects (surfaced to the sync log) on permission denial.
interface QrScannerPlugin {
	scan(): Promise<{ value: string | null }>;
}

const Native = registerPlugin<QrScannerPlugin>("QrScanner");

export async function scanQrNative(): Promise<string | null> {
	return (await Native.scan()).value ?? null;
}
