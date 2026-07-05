/// <reference types="chrome" />

import { api } from "../platform-api";
import { sendToOffscreen } from "./offscreen-client";
import { type MessageEnvelope, on } from "./router";

async function captureQrScan(): Promise<MessageEnvelope> {
	// Filter to normal windows so a detached pop-out resolves the real browsing tab.
	const win = await api.windows.getLastFocused({ windowTypes: ["normal"] });
	if (win?.id === undefined) {
		return { ok: false, error: "No browser window to capture" };
	}
	// PNG, not JPEG: lossless pixels decode QR far more reliably. Capture must stay in the
	// background (tabs API), but the decode runs in the host document, where jsqr's lazy
	// import() is reliable — it is not from an idle, restarted MV3 service worker.
	const dataUrl = await api.tabs.captureVisibleTab(win.id, { format: "png" });
	const res = await sendToOffscreen({ type: "QR_DECODE", payload: { dataUrl } });
	if (!res.ok) return { ok: false, error: res.error ?? "QR decode failed" };
	return { ok: true, data: (res.data as string | null) ?? null };
}

on("CAPTURE_QR_SCAN", captureQrScan);
