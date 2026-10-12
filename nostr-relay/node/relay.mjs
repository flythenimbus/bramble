// Minimal Nostr-subset signaling relay for P2P sync testing/self-hosting.
// See docs/p2p-sync.md. This is NOT a full Nostr relay: it speaks just enough of
// NIP-01 (REQ / EVENT / CLOSE) to fan out *ephemeral* events (kind 20000-29999)
// to current subscribers, and stores no events. The vault never touches it; it
// only relays encrypted, group-key-addressed signaling blobs.
//
// Run:  node nostr-relay/node/relay.mjs            (defaults to ws://localhost:7400)
//       PORT=9000 node nostr-relay/node/relay.mjs
//
// Clients publish:  ["EVENT", { kind: 20000, tags: [["d", roomId]], content, ... }]
//          and sub: ["REQ", subId, { kinds: [20000], "#d": [roomId] }]
//
// Configure ICE_SERVERS and TURN_SECRET for cross-network peers; see ../README.md.

import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 7400);

// Cheap abuse guards (kept in parity with cf-worker): a signaling blob is a few
// KB of encrypted SDP/ICE, so reject larger frames before parsing, and bound
// subscriptions per connection (a device needs ~1).
const MAX_MSG_BYTES = 64 * 1024;
const MAX_SUBS_PER_CONN = 8;

// Keepalive, in parity with cf-worker (where it is a hibernation auto-response) and
// @core/sync/signaling-client. Clients ping a quiet socket so an intermediary doesn't drop it, and
// read the answer as proof the relay is still there.
const PING = "ping";
const PONG = "pong";

// Connection metadata is only traced with RELAY_DEBUG=1; see ../README.md.
const DEBUG = process.env.RELAY_DEBUG === "1";
let logAvailable = true;
process.stdout.on("error", (error) => {
	if (error.code !== "EPIPE") throw error;
	logAvailable = false;
});
const log = (message) => {
	if (!logAvailable) return;
	// Escape client-controlled text so each entry stays on one line.
	const line = JSON.stringify(message)
		.slice(1, -1)
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
	console.log(new Date().toISOString(), line);
};
const trace = (message) => {
	if (DEBUG) log(message);
};
const short = (s) => (typeof s === "string" ? s.slice(0, 8) : typeof s);

// Forwarded addresses are untrusted debug data, never used for access control.
const clientOf = (req) => {
	const xff = req.headers["x-forwarded-for"];
	const last = typeof xff === "string" ? xff.split(",").pop().trim() : "";
	return last ? `${req.socket.remoteAddress} xff=${last}` : req.socket.remoteAddress;
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isTurnUrl = (url) => /^turns?:/i.test(url);

function validIceUrl(url) {
	if (typeof url !== "string") return false;
	const match =
		/^(stun|stuns|turn|turns):(\[[^\]]+\]|[a-z0-9.-]+)(?::(\d+))?(?:\?(transport=(?:udp|tcp)))?$/i.exec(
			url,
		);
	if (!match) return false;
	const [, scheme, host, port, query] = match;
	// WebRTC requires lowercase query names and values.
	if (query && (!isTurnUrl(`${scheme}:`) || !["transport=udp", "transport=tcp"].includes(query))) {
		return false;
	}
	if (port && (Number(port) < 1 || Number(port) > 65535)) return false;
	try {
		new URL(`http://${host}${port ? `:${port}` : ""}`);
		return true;
	} catch {
		return false;
	}
}

function parseIceServers() {
	const raw = process.env.ICE_SERVERS;
	if (!raw) return [];
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Invalid ICE_SERVERS JSON; see nostr-relay/README.md");
	}
	if (!Array.isArray(parsed)) {
		throw new Error("ICE_SERVERS must be a JSON array");
	}
	return parsed.map((server) => {
		if (!isObject(server) || Object.keys(server).some((key) => key !== "urls")) {
			throw new Error(
				"ICE_SERVERS entries must contain urls only; use TURN_SECRET for TURN credentials",
			);
		}
		const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
		if (!Array.isArray(urls) || urls.length === 0 || !urls.every(validIceUrl)) {
			throw new Error("ICE_SERVERS urls must contain valid stun:, stuns:, turn: or turns: URLs");
		}
		return { urls };
	});
}

const TURN_SECRET = process.env.TURN_SECRET ?? "";
const TURN_TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS ?? 86400);
let ICE_SERVERS;
try {
	ICE_SERVERS = parseIceServers();
	const hasTurn = ICE_SERVERS.some((server) => server.urls.some(isTurnUrl));
	if (hasTurn && !TURN_SECRET.trim()) {
		throw new Error("TURN URLs in ICE_SERVERS require TURN_SECRET");
	}
	if (!hasTurn && TURN_SECRET) {
		throw new Error("TURN_SECRET requires at least one TURN URL in ICE_SERVERS");
	}
	if (!Number.isInteger(TURN_TTL_SECONDS) || TURN_TTL_SECONDS < 1 || TURN_TTL_SECONDS > 86400) {
		throw new Error("TURN_TTL_SECONDS must be an integer between 1 and 86400");
	}
} catch (error) {
	log(error.message);
	process.exit(1);
}

function mintIceServers() {
	if (!TURN_SECRET) return { iceServers: ICE_SERVERS };
	// The TURN server verifies the REST API credential's HMAC and username expiry.
	const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS}:bramble`;
	const credential = createHmac("sha1", TURN_SECRET).update(username).digest("base64");
	return {
		iceServers: ICE_SERVERS.map((server) =>
			server.urls.some(isTurnUrl) ? { ...server, username, credential } : server,
		),
		ttl: TURN_TTL_SECONDS,
	};
}

function validFilter(filter) {
	if (!isObject(filter)) return false;
	return Object.entries(filter).every(([key, values]) => {
		if (key === "kinds") return Array.isArray(values) && values.every(Number.isInteger);
		if (key === "authors" || key.startsWith("#")) {
			return Array.isArray(values) && values.every((value) => typeof value === "string");
		}
		return true;
	});
}

function validEventFields(event) {
	return (
		(event.id === undefined || typeof event.id === "string") &&
		(event.pubkey === undefined || typeof event.pubkey === "string") &&
		(event.content === undefined || typeof event.content === "string") &&
		(event.tags === undefined ||
			(Array.isArray(event.tags) &&
				event.tags.every(
					(tag) => Array.isArray(tag) && tag.every((value) => typeof value === "string"),
				)))
	);
}

/** True if `event` matches a single REQ `filter` (kinds, authors, #<tag>). */
function matches(filter, event) {
	if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
	if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
	for (const [key, vals] of Object.entries(filter)) {
		if (!key.startsWith("#") || !Array.isArray(vals)) continue;
		const tag = key.slice(1);
		const present = event.tags?.filter((t) => t[0] === tag).map((t) => t[1]) ?? [];
		if (!vals.some((v) => present.includes(v))) return false;
	}
	return true;
}

const sockets = new Set();
let connSeq = 0;

// Plain HTTP for the health probe and the ICE mint; the WS server shares the
// same listener and handles the Upgrade handshake itself.
const httpServer = createServer((req, res) => {
	if (req.method === "POST" && req.url.split("?")[0] === "/ice-servers") {
		trace(`http  ice-servers  ${clientOf(req)}`);
		res.writeHead(200, {
			"content-type": "application/json",
			"cache-control": "no-store",
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "POST, OPTIONS",
			"access-control-allow-headers": "Content-Type",
		});
		res.end(JSON.stringify(mintIceServers()));
		return;
	}
	if (req.url.split("?")[0] === "/ice-servers") {
		res.writeHead(req.method === "OPTIONS" ? 204 : 405, {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "POST, OPTIONS",
			"access-control-allow-headers": "Content-Type",
		});
		res.end(req.method === "OPTIONS" ? undefined : "method not allowed");
		return;
	}
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("bramble signaling relay");
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MSG_BYTES });

wss.on("connection", (ws, req) => {
	ws.subs = new Map(); // per-connection: subId -> filters
	const id = `conn${String(++connSeq).padStart(3, "0")}`;
	const openedAt = Date.now();
	sockets.add(ws);
	ws.on("error", () => trace(`${id} drop  websocket frame`));
	trace(`${id} open  ${clientOf(req)} (${sockets.size} peers)`);
	ws.on("close", () => {
		sockets.delete(ws);
		trace(`${id} close ${Math.round((Date.now() - openedAt) / 1000)}s (${sockets.size} peers)`);
	});

	ws.on("message", (raw) => {
		if (raw.length > MAX_MSG_BYTES) {
			trace(`${id} drop  frame ${raw.length}B > ${MAX_MSG_BYTES}B`);
			return;
		}
		if (raw.toString() === PING) return ws.send(PONG);

		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			trace(`${id} drop  unparseable ${raw.length}B`);
			return;
		}
		if (!Array.isArray(msg)) return;
		const [type] = msg;

		if (type === "REQ") {
			const [, subId, ...filters] = msg;
			if (
				typeof subId !== "string" ||
				!subId.length ||
				subId.length > 64 ||
				!filters.length ||
				!filters.every(validFilter)
			) {
				trace(`${id} drop  invalid REQ`);
				ws.send(JSON.stringify(["NOTICE", "invalid: subscription or filters"]));
				return;
			}
			if (!ws.subs.has(subId) && ws.subs.size >= MAX_SUBS_PER_CONN) {
				trace(`${id} drop  REQ ${short(subId)}: over ${MAX_SUBS_PER_CONN} subs`);
				return;
			}
			ws.subs.set(subId, filters);
			if (DEBUG) {
				const rooms = filters.flatMap((f) => (Array.isArray(f?.["#d"]) ? f["#d"].map(short) : []));
				trace(`${id} REQ   ${short(subId)} rooms=${rooms.join(",") || "?"}`);
			}
			ws.send(JSON.stringify(["EOSE", subId])); // no stored events: ephemeral only
			return;
		}
		if (type === "CLOSE") {
			ws.subs.delete(msg[1]);
			return;
		}
		if (type === "EVENT") {
			const event = msg[1];
			const kind = typeof event?.kind === "number" ? event.kind : typeof event?.kind;
			if (
				!isObject(event) ||
				!Number.isInteger(event.kind) ||
				event.kind < 20000 ||
				event.kind >= 30000
			) {
				trace(`${id} rej   kind=${kind}`);
				ws.send(
					JSON.stringify([
						"OK",
						typeof event?.id === "string" ? event.id : "",
						false,
						"only ephemeral kinds",
					]),
				);
				return;
			}
			if (!validEventFields(event)) {
				trace(`${id} rej   invalid EVENT`);
				ws.send(
					JSON.stringify([
						"OK",
						typeof event.id === "string" ? event.id : "",
						false,
						"invalid: event fields",
					]),
				);
				return;
			}
			let serializedEvent;
			try {
				serializedEvent = JSON.stringify(event);
			} catch {
				trace(`${id} rej   event nesting`);
				ws.send(JSON.stringify(["OK", event.id ?? "", false, "invalid: event nesting"]));
				return;
			}
			// Fan out to every other socket's matching subscription; store nothing.
			let fanout = 0;
			for (const peer of sockets) {
				if (peer === ws || peer.readyState !== WebSocket.OPEN) continue;
				for (const [subId, filters] of peer.subs) {
					if (filters.some((f) => matches(f, event))) {
						peer.send(`["EVENT",${JSON.stringify(subId)},${serializedEvent}]`);
						fanout++;
						break;
					}
				}
			}
			if (DEBUG) {
				const room = Array.isArray(event.tags)
					? short(event.tags.find((t) => Array.isArray(t) && t[0] === "d")?.[1])
					: "?";
				trace(
					`${id} EVENT kind=${kind} room=${room} author=${short(event.pubkey)} ${raw.length}B -> ${fanout} peer(s)`,
				);
			}
			ws.send(JSON.stringify(["OK", event.id ?? "", true, ""]));
		}
	});
});

// Explicit handlers also let Node exit promptly when it is the container's PID 1.
const shutdown = () => {
	wss.close();
	for (const ws of sockets) ws.terminate();
	httpServer.close();
	httpServer.closeAllConnections();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

httpServer.listen(PORT, () => {
	log(
		`bramble signaling relay on ws://localhost:${httpServer.address().port} (${ICE_SERVERS.length} ice server entries)`,
	);
});
