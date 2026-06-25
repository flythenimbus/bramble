// STUN/TURN servers for the WebRTC data channel, so peers across networks/VPNs can
// relay (DTLS + Noise ciphertext only). Empty list = direct-only. See docs/p2p-sync.md.

/** Map the relay URL to its /ice-servers endpoint (the default Worker serves both). */
export function deriveIceUrl(relayUrl: string): string {
	try {
		const u = new URL(relayUrl);
		if (u.protocol === "ws:") u.protocol = "http:";
		else if (u.protocol === "wss:") u.protocol = "https:";
		u.pathname = "/ice-servers";
		u.search = "";
		u.hash = "";
		return u.toString();
	} catch {
		return "";
	}
}

/** Fetch ICE servers from the minting endpoint; [] on any failure (→ host-only). */
export async function fetchIceServers(iceUrl: string): Promise<RTCIceServer[]> {
	if (!iceUrl) return [];
	try {
		const res = await fetch(iceUrl, { method: "POST" });
		if (!res.ok) return [];
		const data = (await res.json()) as { iceServers?: RTCIceServer[] };
		return Array.isArray(data.iceServers) ? data.iceServers : [];
	} catch {
		return [];
	}
}
