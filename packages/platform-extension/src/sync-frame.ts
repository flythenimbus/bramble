/// <reference types="chrome" />

// Firefox WebRTC host, loaded as a hidden web_accessible_resource iframe that the content
// script injects into a web page. It is the only Firefox context with RTCPeerConnection
// (the extension background and popup both lack it). Chrome runs the transport in the
// offscreen document and never loads this.
//
// For now this only probes RTCPeerConnection and records the result so the popup can
// confirm the context can host the P2P transport. Self-contained (inline api shim, no
// imports) so it bundles flat and needs no extra web-accessible chunk.

const g = globalThis as typeof globalThis & { browser?: typeof chrome; chrome?: typeof chrome };
const api = (g.browser ?? g.chrome) as typeof chrome;

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

void api.storage.local.set({ "diag.rtcFrame": `${probe()} @ ${new Date().toISOString()}` });
