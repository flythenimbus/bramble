// Bramble signaling relay as a Cloudflare Worker + Durable Object.
//
// Behaviourally identical to signaling/relay.mjs (the node self-host version):
// a minimal Nostr subset (REQ / EVENT / CLOSE) that fans out *ephemeral* events
// (kind 20000-29999) to current subscribers and stores nothing. The vault never
// trusts it; it only relays encrypted, group-key-addressed signaling blobs.
//
// Why a Durable Object: Workers are stateless, so the set of connected sockets
// can't live in a module global. One global DO ("relay") owns every socket and
// does the fan-out, mirroring the node Set. Sockets are accepted as hibernatable
// (`acceptWebSocket`), so the DO is evicted from memory while idle and billed
// only when a message arrives; per-connection REQ subscriptions ride along on
// the socket attachment so they survive that eviction.

import { DurableObject } from "cloudflare:workers";

// Cheap abuse guards for the dumb pipe. A signaling blob is a few KB of
// encrypted SDP/ICE, so reject anything larger before parsing: Cloudflare now
// allows WebSocket frames up to 32 MiB, and parsing attacker-sized payloads on
// a single-threaded Durable Object is the obvious cost/DoS footgun. A device
// needs ~1 room subscription, so bound subs-per-connection too (caps both the
// fan-out inner loop and the serialized attachment).
const MAX_MSG_BYTES = 64 * 1024;
const MAX_SUBS_PER_CONN = 8;

/** A subscriber's REQ filters, keyed by subscription id. Stored as the socket
 *  attachment so it persists across hibernation. */
type Subs = Record<string, NostrFilter[]>;
type NostrFilter = {
	kinds?: number[];
	authors?: string[];
	[tag: `#${string}`]: string[] | undefined;
};
type NostrEvent = {
	id?: string;
	kind: number;
	pubkey?: string;
	tags?: string[][];
	content?: string;
};

/** True if `event` matches a single REQ `filter` (kinds, authors, #<tag>). */
function matches(filter: NostrFilter, event: NostrEvent): boolean {
	if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
	if (filter.authors && !(event.pubkey && filter.authors.includes(event.pubkey))) return false;
	for (const [key, vals] of Object.entries(filter)) {
		if (!key.startsWith("#") || !Array.isArray(vals)) continue;
		const tag = key.slice(1);
		const present = event.tags?.filter((t) => t[0] === tag).map((t) => t[1]) ?? [];
		// key starts with "#", so this is a tag filter: values are strings.
		if (!(vals as string[]).some((v) => present.includes(v))) return false;
	}
	return true;
}

export class Relay extends DurableObject {
	async fetch(req: Request): Promise<Response> {
		// Non-WebSocket hits (health probe) get the banner, same as the node relay.
		if (req.headers.get("Upgrade") !== "websocket")
			return new Response("bramble signaling relay", { status: 200 });

		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server); // hibernatable
		server.serializeAttachment({} satisfies Subs);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		if ((typeof raw === "string" ? raw.length : raw.byteLength) > MAX_MSG_BYTES) return;

		let msg: unknown;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
		} catch {
			return;
		}
		if (!Array.isArray(msg)) return;
		const [type] = msg;

		if (type === "REQ") {
			const [, subId, ...filters] = msg;
			const subs = ws.deserializeAttachment() as Subs;
			if (!(subId in subs) && Object.keys(subs).length >= MAX_SUBS_PER_CONN) return;
			subs[subId] = filters;
			ws.serializeAttachment(subs);
			ws.send(JSON.stringify(["EOSE", subId])); // no stored events: ephemeral only
			return;
		}
		if (type === "CLOSE") {
			const subs = ws.deserializeAttachment() as Subs;
			delete subs[msg[1]];
			ws.serializeAttachment(subs);
			return;
		}
		if (type === "EVENT") {
			const event = msg[1] as NostrEvent;
			if (!event || event.kind < 20000 || event.kind >= 30000) {
				ws.send(JSON.stringify(["OK", event?.id ?? "", false, "only ephemeral kinds"]));
				return;
			}
			// Fan out to every other socket's matching subscription; store nothing.
			for (const peer of this.ctx.getWebSockets()) {
				if (peer === ws) continue;
				const subs = peer.deserializeAttachment() as Subs | null;
				if (!subs) continue;
				for (const [subId, filters] of Object.entries(subs)) {
					if (filters.some((f) => matches(f, event))) {
						peer.send(JSON.stringify(["EVENT", subId, event]));
						break;
					}
				}
			}
			ws.send(JSON.stringify(["OK", event.id ?? "", true, ""]));
		}
	}
}

export default {
	// All connections land on one global DO instance; the room is addressed
	// in-band by the event's #d tag, exactly as with the node relay.
	fetch(req: Request, env: Env): Response | Promise<Response> {
		return env.RELAY.getByName("relay").fetch(req);
	},
} satisfies ExportedHandler<Env>;
