// STUN/TURN servers for the WebRTC data channel, so peers across networks/VPNs can
// relay (DTLS + Noise ciphertext only). Empty list = direct-only. See docs/p2p-sync.md.

/** Map the relay URL to its /ice-servers endpoint (the default Worker serves both). */
export function deriveIceUrl(relayUrl: string): string {
	try {
		const u = new URL(relayUrl);
		if (u.protocol === "ws:") u.protocol = "http:";
		else if (u.protocol === "wss:") u.protocol = "https:";
		u.pathname = "/ice-servers";
		// The query stays: a private relay's token rides in it (services/nostr-relay/README.md).
		u.hash = "";
		return u.toString();
	} catch {
		return "";
	}
}

/** Whether `iceUrl` is served by the relay at `relayUrl`, so it can check that relay's tickets. */
export function sameHost(iceUrl: string, relayUrl: string): boolean {
	try {
		return new URL(iceUrl).origin === new URL(deriveIceUrl(relayUrl)).origin;
	} catch {
		return false;
	}
}

/**
 * Fetch ICE servers from the minting endpoint; [] on any failure (→ host-only). A relay ticket goes
 * in a text/plain body, which keeps the request simple: a preflight is one more thing an older relay
 * would fail.
 */
export async function fetchIceServers(
	iceUrl: string,
	ticket?: string | null,
): Promise<RTCIceServer[]> {
	if (!iceUrl) return [];
	try {
		const res = await fetch(
			iceUrl,
			ticket
				? {
						method: "POST",
						headers: { "Content-Type": "text/plain" },
						body: JSON.stringify({ ticket }),
					}
				: { method: "POST" },
		);
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
