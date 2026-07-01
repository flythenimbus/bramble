/// <reference types="chrome" />

// Firefox only: inject the sync-frame web_accessible_resource iframe — the only Firefox
// context with RTCPeerConnection — so the P2P transport can run. Chrome uses the offscreen
// document and never injects this. Top frame only, once per page, hidden.

import { api } from "./content-api";

const FRAME_ID = "bramble-sync-frame";

export function ensureSyncFrame(): void {
	// Firefox exposes `browser`; Chrome does not. Chrome runs sync in the offscreen doc.
	const isFirefox = typeof (globalThis as { browser?: unknown }).browser !== "undefined";
	if (!isFirefox) return;
	if (window.top !== window) return; // top frame only
	if (document.getElementById(FRAME_ID)) return;
	const frame = document.createElement("iframe");
	frame.id = FRAME_ID;
	frame.src = api.runtime.getURL("sync-frame.html");
	frame.style.cssText = "display:none;width:0;height:0;border:0;";
	const root = document.documentElement ?? document.body;
	root?.appendChild(frame);
}
