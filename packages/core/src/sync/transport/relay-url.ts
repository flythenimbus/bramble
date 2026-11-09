// The signalling relay a device uses, from Settings > Sync > Advanced.

export const DEFAULT_RELAY = "wss://bramble-relay.flythenimbus.workers.dev";

/** The relay to connect to. Blank means the hosted one. An address that can't work stays as it
 * is, so a typo never quietly moves someone off their own relay. */
export function relayOrDefault(saved: unknown): string {
	return (typeof saved === "string" && saved.trim()) || DEFAULT_RELAY;
}

/** Whether this can be a relay. A WebSocket resolves anything else against the app's own origin. */
export function isRelayUrl(url: string): boolean {
	try {
		return ["ws:", "wss:", "http:", "https:"].includes(new URL(url).protocol);
	} catch {
		return false;
	}
}
