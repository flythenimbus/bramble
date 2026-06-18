# Signaling relay

A minimal WebSocket relay for P2P sync (see
[../docs/p2p-sync.md](../docs/p2p-sync.md)). It speaks just enough of the Nostr
protocol (NIP-01 `REQ` / `EVENT` / `CLOSE`) to fan out **ephemeral** events
(kind 20000-29999) to current subscribers. It **stores nothing** and never sees
the vault: it only relays encrypted, group-key-addressed signaling blobs while
two peers establish a direct WebRTC connection.

Because it speaks the Nostr subset, the extension can point at this relay, your
own self-hosted copy, or any public Nostr relay (the relay URL is
user-configurable; there is no default).

## Run locally (node)

The `ws`-based node version, for development and self-hosting:

```sh
node nostr-relay/node/relay.mjs            # ws://localhost:7400
PORT=9000 node nostr-relay/node/relay.mjs  # custom port
```

## Deploy to Cloudflare Workers

`cf-worker/` is the same relay as a Cloudflare Worker backed by a Durable
Object: an always-on hosted endpoint with no server to run. The DO owns the
connected sockets and fans out events (a Worker is stateless, so it can't); the
sockets are **hibernatable**, so the object is evicted while idle and billed only
when a message arrives. A signaling relay is idle almost always, so the cost is
effectively zero, and a SQLite-backed Durable Object runs on the Workers free
plan.

```sh
cd nostr-relay/cf-worker
pnpm exec wrangler login   # one-time
pnpm run deploy            # -> wss://bramble-relay.<subdomain>.workers.dev
pnpm run dev               # local miniflare at ws://localhost:8787
```

Then set the extension's **Nostr relay URL** (Settings) to the printed `wss://`
URL. Nothing else changes: the worker speaks the exact same wire contract, so
the client is unaware it is talking to a Worker rather than the node relay.

All connections land on one global Durable Object; the room is addressed in-band
by the event's `#d` tag, so no per-room routing or URL is needed. Per-room
sharding is the scale lever if this ever outgrows a personal relay, but it would
require the client to carry the room in the connect URL.

## Wire contract

```
client -> relay   ["REQ", subId, { "kinds": [20000], "#d": [roomId] }]
client -> relay   ["EVENT", { kind: 20000, tags: [["d", roomId]], content, pubkey, id, sig, created_at }]
client -> relay   ["CLOSE", subId]
relay  -> client  ["EOSE", subId]              (no stored events: ephemeral only)
relay  -> client  ["EVENT", subId, event]      (a peer's relayed event)
relay  -> client  ["OK", id, accepted, msg]
```

- `roomId` = `HMAC(groupKey, "signal")`, so only group members can find the room
  and the relay cannot link rooms to identities.
- `content` is the SDP/ICE payload, encrypted under the group key. The relay sees
  ciphertext only.
- Events are BIP340-signed (the client uses the wasm `nostr_*` exports), so public
  Nostr relays accept them too.

This is a relay for development and self-hosting; it is intentionally tiny. Any
real Nostr relay also works.
