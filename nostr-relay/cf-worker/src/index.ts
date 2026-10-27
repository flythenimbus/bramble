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
import type { GuardEnv } from "./ice-guard";
import { policyFrom, STUN_ONLY, TICKET_ACTIVE_MS, turnUsernames } from "./ice-policy";

export { IceGuard } from "./ice-guard";

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
// fan-out inner loop and the serialized attachment). Every message is a billed
// invocation even when ignored, so a socket over MAX_MSGS_PER_MINUTE is closed;
// the cap clears an old client resending a large vault over relay-forward.
const MAX_MSG_BYTES = 64 * 1024;
const MAX_SUBS_PER_CONN = 8;
const MAX_MSGS_PER_MINUTE = 6000;

// POST /ice-servers mints short-lived Cloudflare TURN creds so peers across
// networks/VPNs can relay, rationed by the IceGuard. See docs/turn-credentials.md.
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
} as const;

// TURN secrets are `wrangler secret put`, so absent from the generated Env.
interface RelayEnv extends Env, GuardEnv {}

const jsonCors = (body: string, status = 200): Response =>
	new Response(body, { status, headers: { "Content-Type": "application/json", ...CORS } });

/** The relay ticket in an ICE request's plain-text body (see @core/sync/signaling-client). */
async function ticketOf(req: Request): Promise<string | null> {
	if (Number(req.headers.get("Content-Length") ?? 0) > 1024) return null;
	try {
		const { ticket } = JSON.parse(await req.text()) as { ticket?: unknown };
		return typeof ticket === "string" && ticket.length > 0 && ticket.length <= 128 ? ticket : null;
	} catch {
		return null;
	}
}

// Any failure hands out STUN only: devices still connect directly, and nothing is spent.
async function handleIceServers(req: Request, env: RelayEnv): Promise<Response> {
	const { TURN_KEY_TOKEN_ID: id, TURN_KEY_API_TOKEN: token } = env;
	if (!id || !token) return jsonCors(JSON.stringify({ iceServers: [] }));
	const guard = env.ICE_GUARD.getByName("guard");
	const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
	let ticketed = false;
	try {
		const ticket = await ticketOf(req);
		ticketed = ticket !== null && (await env.RELAY.getByName("relay").ticketLive(ticket));
		if ((await guard.admit(ip, ticketed)) !== "turn") return jsonCors(JSON.stringify(STUN_ONLY));
	} catch (e) {
		console.error("[ice-guard] admit failed", e);
		return jsonCors(JSON.stringify(STUN_ONLY));
	}
	const { ttlSeconds } = policyFrom(env as unknown as Record<string, unknown>);
	const res = await fetch(
		`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl: ttlSeconds }),
		},
	);
	if (!res.ok) {
		await guard.count("stun-mint-failed").catch(() => {});
		return jsonCors(JSON.stringify({ ...STUN_ONLY, error: `turn ${res.status}` }));
	}
	const body = await res.text();
	try {
		const usernames = turnUsernames(JSON.parse(body));
		await guard.record(ip, usernames, Date.now() + ttlSeconds * 1000, ticketed);
	} catch (e) {
		// Unrecorded, the credential escapes the per-credential cap: don't hand it out.
		console.error("[ice-guard] record failed", e);
		return jsonCors(JSON.stringify(STUN_ONLY));
	}
	return jsonCors(body);
}

/** A subscriber's REQ filters, keyed by subscription id. */
type Subs = Record<string, NostrFilter[]>;
/**
 * What a socket carries across hibernation, as its attachment: its subscriptions, its ICE ticket
 * (also its tag, so a lookup is direct), and when it last published. A socket accepted before
 * tickets has a bare `Subs` attachment, read here as one with no ticket.
 */
type SocketState = { v: 2; subs: Subs; ticket?: string; seenAt?: number };

function stateOf(ws: WebSocket): SocketState {
	const attached = ws.deserializeAttachment() as SocketState | Subs | null;
	if (attached && (attached as SocketState).v === 2) return attached as SocketState;
	return { v: 2, subs: (attached as Subs | null) ?? {} };
}

const randomTicket = (): string =>
	btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
		.replaceAll("+", "-")
		.replaceAll("/", "_");
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
	// In memory only: hibernation resets it, which is fine since a flooding socket keeps the DO awake.
	private readonly rates = new WeakMap<WebSocket, { start: number; count: number }>();

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
		const ticket = randomTicket();
		this.ctx.acceptWebSocket(server, [ticket]); // hibernatable
		server.serializeAttachment({ v: 2, subs: {}, ticket } satisfies SocketState);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Whether `ticket` belongs to an open socket that has published lately: a live sync device. */
	ticketLive(ticket: string): boolean {
		const [ws] = this.ctx.getWebSockets(ticket);
		if (!ws) return false;
		const state = stateOf(ws);
		return state.ticket === ticket && Date.now() - (state.seenAt ?? 0) < TICKET_ACTIVE_MS;
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		if (this.overRate(ws)) return;
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
				const state = stateOf(ws);
				if (!(subId in state.subs) && Object.keys(state.subs).length >= MAX_SUBS_PER_CONN) return;
				state.subs[subId] = filters;
				ws.serializeAttachment(state);
				ws.send(JSON.stringify(["EOSE", subId])); // no stored events: ephemeral only
				return;
			}
			case "CLOSE": {
				const state = stateOf(ws);
				delete state.subs[msg[1]];
				ws.serializeAttachment(state);
				return;
			}
			case "BRAMBLE_TICKET": {
				ws.send(JSON.stringify(["BRAMBLE_TICKET", stateOf(ws).ticket ?? null]));
				return;
			}
			case "EVENT": {
				const event = msg[1] as NostrEvent;
				if (!event || event.kind < 20000 || event.kind >= 30000) {
					ws.send(JSON.stringify(["OK", event?.id ?? "", false, "only ephemeral kinds"]));
					return;
				}
				// Publishing is what keeps a ticket live; noted at most once a minute.
				const own = stateOf(ws);
				if (own.ticket && Date.now() - (own.seenAt ?? 0) > 60_000) {
					own.seenAt = Date.now();
					ws.serializeAttachment(own);
				}
				// Fan out to every other socket's matching subscription; store nothing.
				for (const peer of this.ctx.getWebSockets()) {
					if (peer === ws) continue;
					for (const [subId, filters] of Object.entries(stateOf(peer).subs)) {
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

	/** Count `ws`'s message in its one-minute window; close it the first time it goes over. */
	private overRate(ws: WebSocket): boolean {
		const now = Date.now();
		let window = this.rates.get(ws);
		if (!window || now - window.start >= 60_000) {
			window = { start: now, count: 0 };
			this.rates.set(ws, window);
		}
		if (++window.count <= MAX_MSGS_PER_MINUTE) return false;
		if (window.count === MAX_MSGS_PER_MINUTE + 1) ws.close(1008, "rate limited");
		return true;
	}
}

/** Private mode (a self-deployed Worker with RELAY_TOKEN set): the token from the URL's query. */
function tokenOk(url: URL, token: string | undefined): boolean {
	if (!token) return true;
	const enc = new TextEncoder();
	const given = enc.encode(url.searchParams.get("token") ?? "");
	const want = enc.encode(token);
	return given.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(given, want);
}

export default {
	// Signaling WS → the global DO; POST /ice-servers handled here in the Worker.
	async fetch(req: Request, env: RelayEnv): Promise<Response> {
		const url = new URL(req.url);
		const { pathname } = url;
		// The health probe and CORS preflights stay open; sockets and mints need the token.
		const guarded =
			req.headers.get("Upgrade") === "websocket" ||
			(pathname === "/ice-servers" && req.method === "POST");
		if (guarded && !tokenOk(url, env.RELAY_TOKEN)) {
			return new Response(null, { status: 401, headers: CORS });
		}
		if (pathname === "/ice-servers") {
			switch (req.method) {
				case "OPTIONS":
					return new Response(null, { status: 204, headers: CORS });
				case "POST":
					return handleIceServers(req, env);
				default:
					return new Response("method not allowed", { status: 405, headers: CORS });
			}
		}
		return env.RELAY.getByName("relay").fetch(req);
	},
	// The ceiling and the per-credential cap, checked against Cloudflare's usage analytics.
	async scheduled(_controller: ScheduledController, env: RelayEnv): Promise<void> {
		await env.ICE_GUARD.getByName("guard").enforce();
	},
} satisfies ExportedHandler<RelayEnv>;
