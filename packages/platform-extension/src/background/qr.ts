/// <reference types="chrome" />

import { api } from "../platform-api";
import { type MessageEnvelope, on } from "./router";

/** Decode a single QR code from a PNG data URL via OffscreenCanvas (no DOM); null if none found. */
async function decodeQrDataUrl(dataUrl: string): Promise<string | null> {
	// jsqr is ~250KB and only the QR-scan path needs it; load it lazily so it
	// stays out of the service-worker bundle that re-parses on every cold wake.
	const { default: jsQR } = await import("jsqr");
	const blob = await (await fetch(dataUrl)).blob();
	const bitmap = await createImageBitmap(blob);
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.drawImage(bitmap, 0, 0);
	bitmap.close();
	const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
	return jsQR(data, width, height)?.data ?? null;
}

async function captureQrScan(): Promise<MessageEnvelope> {
	// Filter to normal windows so a detached pop-out resolves the real browsing tab.
	const win = await api.windows.getLastFocused({ windowTypes: ["normal"] });
	if (win?.id === undefined) {
		return { ok: false, error: "No browser window to capture" };
	}
	// PNG, not JPEG: lossless pixels decode QR far more reliably.
	const dataUrl = await api.tabs.captureVisibleTab(win.id, { format: "png" });
	const decoded = await decodeQrDataUrl(dataUrl);
	return { ok: true, data: decoded };
}

on("CAPTURE_QR_SCAN", captureQrScan);
