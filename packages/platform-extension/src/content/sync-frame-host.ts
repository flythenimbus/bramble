/// <reference types="chrome" />

// Firefox only: find a context that can host WebRTC. Firefox disables RTCPeerConnection in
// every moz-extension context (background, popup, AND web_accessible_resource iframe), so
// the transport must run in a WEB-page context instead. This probes the two candidates —
// the content-script isolated world and the page's MAIN world — plus the (known-bad)
// extension iframe for comparison, writing each result to storage for the popup to show.
// Chrome uses the offscreen document and never runs this.

import { api } from "./content-api";

const FRAME_ID = "bramble-sync-frame";

function probe(): string {
	if (typeof RTCPeerConnection === "undefined") return "undefined";
	try {
		const pc = new RTCPeerConnection();
		pc.close();
		return "works";
	} catch (e) {
		return `error: ${(e as Error).message}`;
	}
}

const stamp = (r: string) => `${r} @ ${new Date().toISOString()}`;

export function ensureSyncFrame(): void {
	// Firefox exposes `browser`; Chrome does not (Chrome runs sync in the offscreen doc).
	const isFirefox = typeof (globalThis as { browser?: unknown }).browser !== "undefined";
	if (!isFirefox) return;
	if (window.top !== window) return; // top frame only

	// 1. This context: the content-script isolated world.
	void api.storage.local.set({ "diag.rtcContent": stamp(probe()) });

	// 2. The page's MAIN world (a real web context), via an injected inline script that
	//    posts its result back. Blocked by a strict page CSP; use a permissive test page.
	try {
		window.addEventListener("message", (e: MessageEvent) => {
			const r = (e.data as { __brambleRtcMain?: string })?.__brambleRtcMain;
			if (e.source === window && typeof r === "string") {
				void api.storage.local.set({ "diag.rtcMain": stamp(r) });
			}
		});
		const s = document.createElement("script");
		s.textContent =
			'(()=>{let r;try{const p=new RTCPeerConnection();p.close();r="works"}catch(e){r=typeof RTCPeerConnection==="undefined"?"undefined":"error: "+e.message}window.postMessage({__brambleRtcMain:r},"*")})()';
		(document.documentElement ?? document.body)?.appendChild(s);
		s.remove();
	} catch {
		// ignore (CSP blocked the inline probe)
	}

	// 3. Extension iframe (moz-extension WAR) — known to lack it; kept for comparison.
	if (!document.getElementById(FRAME_ID)) {
		const frame = document.createElement("iframe");
		frame.id = FRAME_ID;
		frame.src = api.runtime.getURL("sync-frame.html");
		frame.style.cssText = "display:none;width:0;height:0;border:0;";
		(document.documentElement ?? document.body)?.appendChild(frame);
	}
}
