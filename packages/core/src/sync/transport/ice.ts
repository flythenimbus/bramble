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
		return normalizeIceServers(await res.json());
	} catch {
		return [];
	}
}

const hasUrls = (s: { urls?: unknown }): boolean =>
	typeof s.urls === "string" || Array.isArray(s.urls);

// Accept the WebRTC-native shapes: { iceServers: [...] } (Cloudflare/standard), a bare
// array, or a single { iceServers: {...} } object. Entries must already be RTCIceServer
// ({ urls, username?, credential? }); provider-specific schemas (Twilio ice_servers/url,
// coturn-rest uris/password) aren't remapped — wrap those server-side.
function normalizeIceServers(data: unknown): RTCIceServer[] {
	const unwrapped =
		data && typeof data === "object" && !Array.isArray(data)
			? (data as { iceServers?: unknown }).iceServers
			: data;
	const list = Array.isArray(unwrapped) ? unwrapped : unwrapped ? [unwrapped] : [];
	return list.filter(
		(s): s is RTCIceServer => !!s && typeof s === "object" && hasUrls(s as { urls?: unknown }),
	);
}
