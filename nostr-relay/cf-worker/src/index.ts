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

// Keepalive, in parity with node/relay.mjs and @core/sync/signaling-client. Cloudflare drops an
// idle WebSocket after a minute or two, which for a password manager syncing in the background is
// most of the time. Registered as a hibernation auto-response so the runtime answers it without
// waking (and billing) the Durable Object; the explicit branch in webSocketMessage covers a socket
// that predates the registration.
const PING = "ping";
const PONG = "pong";

// Cheap abuse guards for the dumb pipe. A signaling blob is a few KB of
// encrypted SDP/ICE, so reject anything larger before parsing: Cloudflare now
// allows WebSocket frames up to 32 MiB, and parsing attacker-sized payloads on
// a single-threaded Durable Object is the obvious cost/DoS footgun. A device
// needs ~1 room subscription, so bound subs-per-connection too (caps both the
// fan-out inner loop and the serialized attachment).
const MAX_MSG_BYTES = 64 * 1024;
const MAX_SUBS_PER_CONN = 8;

// POST /ice-servers mints short-lived Cloudflare TURN creds so peers across
// networks/VPNs can relay. See docs/p2p-sync.md.
const TURN_TTL_SECONDS = 86400;
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
} as const;

// TURN secrets are `wrangler secret put`, so absent from the generated Env.
interface RelayEnv extends Env {
	TURN_KEY_TOKEN_ID?: string;
	TURN_KEY_API_TOKEN?: string;
}

const jsonCors = (body: string, status = 200): Response =>
	new Response(body, { status, headers: { "Content-Type": "application/json", ...CORS } });

// Empty list on any failure → client falls back to host-only candidates.
async function handleIceServers(env: RelayEnv): Promise<Response> {
	const { TURN_KEY_TOKEN_ID: id, TURN_KEY_API_TOKEN: token } = env;
	if (!id || !token) return jsonCors(JSON.stringify({ iceServers: [] }));
	const res = await fetch(
		`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
		},
	);
	if (!res.ok) return jsonCors(JSON.stringify({ iceServers: [], error: `turn ${res.status}` }));
	return jsonCors(await res.text());
}

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
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Answered while hibernating, so an idle-but-alive client costs nothing to keep.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
	}

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
		if (raw === PING) return void ws.send(PONG); // normally the auto-response; see PING

		let msg: unknown;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
		} catch {
			return;
		}
		if (!Array.isArray(msg)) return;

		switch (msg[0]) {
			case "REQ": {
				const [, subId, ...filters] = msg;
				const subs = ws.deserializeAttachment() as Subs;
				if (!(subId in subs) && Object.keys(subs).length >= MAX_SUBS_PER_CONN) return;
				subs[subId] = filters;
				ws.serializeAttachment(subs);
				ws.send(JSON.stringify(["EOSE", subId])); // no stored events: ephemeral only
				return;
			}
			case "CLOSE": {
				const subs = ws.deserializeAttachment() as Subs;
				delete subs[msg[1]];
				ws.serializeAttachment(subs);
				return;
			}
			case "EVENT": {
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
				return;
			}
		}
	}
}

export default {
	// Signaling WS → the global DO; POST /ice-servers handled here in the Worker.
	async fetch(req: Request, env: RelayEnv): Promise<Response> {
		const { pathname } = new URL(req.url);
		if (pathname === "/ice-servers") {
			switch (req.method) {
				case "OPTIONS":
					return new Response(null, { status: 204, headers: CORS });
				case "POST":
					return handleIceServers(env);
				default:
					return new Response("method not allowed", { status: 405, headers: CORS });
			}
		}
		return env.RELAY.getByName("relay").fetch(req);
	},
} satisfies ExportedHandler<RelayEnv>;
