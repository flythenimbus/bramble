// Minimal Nostr-subset signaling relay for P2P sync testing/self-hosting.
// See docs/p2p-sync.md. This is NOT a full Nostr relay: it speaks just enough of
// NIP-01 (REQ / EVENT / CLOSE) to fan out *ephemeral* events (kind 20000-29999)
// to current subscribers, and stores nothing. The vault never touches it; it
// only relays encrypted, group-key-addressed signaling blobs.
//
// Run:  node signaling/relay.mjs            (defaults to ws://localhost:7400)
//       PORT=9000 node signaling/relay.mjs
//
// Clients publish:  ["EVENT", { kind: 20000, tags: [["d", roomId]], content, ... }]
//          and sub: ["REQ", subId, { kinds: [20000], "#d": [roomId] }]

import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 7400);

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

// Plain HTTP for the health probe; the WS server shares the same listener and
// handles the Upgrade handshake itself.
const httpServer = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("bramble signaling relay");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
	ws.subs = new Map(); // per-connection: subId -> filters
	sockets.add(ws);
	ws.on("close", () => sockets.delete(ws));

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (!Array.isArray(msg)) return;
		const [type] = msg;

		if (type === "REQ") {
			const [, subId, ...filters] = msg;
			ws.subs.set(subId, filters);
			ws.send(JSON.stringify(["EOSE", subId])); // no stored events: ephemeral only
			return;
		}
		if (type === "CLOSE") {
			ws.subs.delete(msg[1]);
			return;
		}
		if (type === "EVENT") {
			const event = msg[1];
			if (!event || event.kind < 20000 || event.kind >= 30000) {
				ws.send(JSON.stringify(["OK", event?.id ?? "", false, "only ephemeral kinds"]));
				return;
			}
			// Fan out to every other socket's matching subscription; store nothing.
			for (const peer of sockets) {
				if (peer === ws) continue;
				for (const [subId, filters] of peer.subs) {
					if (filters.some((f) => matches(f, event))) {
						peer.send(JSON.stringify(["EVENT", subId, event]));
						break;
					}
				}
			}
			ws.send(JSON.stringify(["OK", event.id ?? "", true, ""]));
		}
	});
});

httpServer.listen(PORT, () => {
	console.log(`bramble signaling relay on ws://localhost:${PORT}`);
});
