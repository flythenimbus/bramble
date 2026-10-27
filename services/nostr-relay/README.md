# Signaling relay

A minimal WebSocket relay for P2P sync (see
[../../docs/p2p-sync.md](../../docs/p2p-sync.md)). It speaks just enough of the Nostr
protocol (NIP-01 `REQ` / `EVENT` / `CLOSE`) to fan out **ephemeral** events
(kind 20000-29999) to current subscribers. It does not persist events or see
the vault: it only relays encrypted, group-key-addressed signaling blobs while
two peers establish a WebRTC connection. The Node relay logs startup information
and configuration errors; detailed tracing is opt-in (see below).

Because it speaks the Nostr subset, the extension can point at this relay, your
own self-hosted copy, or any public Nostr relay. The app defaults to the hosted
relay; both the signaling and ICE endpoints are configurable in Settings.

## Run locally (node)

The `ws`-based node version, for development and self-hosting:

```sh
node services/nostr-relay/node/relay.mjs            # ws://localhost:7400
PORT=9000 node services/nostr-relay/node/relay.mjs  # custom port
```

`POST /ice-servers` (same origin as the relay URL) serves the STUN/TURN list.
The default is an empty list, so the relay does not ask clients to contact any
public ICE service. Configure `ICE_SERVERS` to opt in to STUN or TURN. STUN
helps establish direct connections across common NATs; symmetric NATs or
restrictive firewalls may need a separately operated TURN server. If fetching
the ICE list fails, the client falls back to host-only candidates.

### Configure STUN and TURN

`ICE_SERVERS` is a JSON array of objects containing only `urls`, either a
non-empty string or a non-empty array of strings. URLs must use `stun:`,
`stuns:`, `turn:` or `turns:` with a valid host and optional port. TURN URLs
also accept `?transport=udp` or `?transport=tcp`; use lowercase query names
and values. Invalid JSON, URLs or TURN configuration make the relay exit
non-zero before listening. Values and credentials are not included in
configuration errors.

For STUN, explicitly choose a server you want clients to contact:

```sh
ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"}]' \
  node services/nostr-relay/node/relay.mjs
```

For TURN, use a server that supports the shared-secret, time-limited credential
mechanism described in
[A REST API For Access To TURN Services](https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00).
Configure the TURN server to verify HMAC-SHA1 credentials and expiry-prefixed
usernames, and set `TURN_SECRET` on the relay to the same shared secret.

Then start the relay with the TURN URLs:

```sh
ICE_SERVERS='[{"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"]}]' \
TURN_SECRET='replace-with-the-same-secret-configured-on-the-turn-server' \
  node services/nostr-relay/node/relay.mjs
```

Each request gets a username of `<expiry>:<tag>` and a credential computed
as `base64(HMAC-SHA1(TURN_SECRET, username))`. The TURN server verifies the credential
and expiry; the shared secret stays on the servers. The tag is an HMAC of the
requester's address under a salt the relay picks at startup, so your TURN
server's logs can tell requesters apart without naming them. `TURN_TTL_SECONDS`
defaults to 7200 (2 hours), matching the hosted Worker, and accepts an integer
from 1 to 86400. `turns:` additionally requires TLS configured on the TURN server.
Clients fetch credentials before each new WebRTC connection, including late
pairing attempts and reconnects, so a running sync session can outlive this TTL.

For Docker, put `ICE_SERVERS`, `TURN_SECRET` and optional `TURN_TTL_SECONDS`
in an environment file and pass `--env-file /path/to/relay.env`. Docker env
files use literal values: do not surround the JSON value with shell quotes.
Remove any static `username`, `credential` or provider-specific `password`
fields from existing `ICE_SERVERS` entries; they are rejected.

### Limits and private mode

The ICE endpoint is public unless you make the relay private, so it rations
TURN credentials per requester, where a requester is an IPv4 address or an IPv6
/64. Past its allowance, a request gets only the STUN entries of `ICE_SERVERS`,
so devices can still connect directly.

Each socket is given a ticket, which the app sends with its ICE requests. A
request whose ticket names an open socket that has published in the last five
minutes (a device syncing through this relay) gets `ICE_REQUESTS_PER_MINUTE`
(default 20); one without gets `ICE_TICKETLESS_PER_MINUTE` (default 4), which
covers apps from before tickets and devices signalling on another relay. With
`ICE_REQUIRE_TICKET=1`, those get STUN only.

Behind a reverse proxy every request arrives from the proxy. Set `TRUST_PROXY`
to the proxy's address (comma-separated, for example `127.0.0.1,::1`) and the
relay takes the requester from the last `X-Forwarded-For` entry, but only on
connections from those addresses; elsewhere the header is ignored.

A relay that serves only your own devices can require a token: set
`RELAY_TOKEN` (at least 16 URL-safe characters) and the relay refuses sockets
and ICE requests without `?token=` matching it. The health probe (`GET /`)
stays open. Configure the app's relay URL as `wss://relay.example.com/?token=…`;
pairing codes carry it, so a joining device needs nothing else. Clear the app's
ICE field so it derives from the relay URL, which keeps the token, or add
`?token=` to it yourself. Anyone who sees a pairing code learns the token:
change it if one leaks, and keep query strings out of your proxy's logs.

### Recommended coturn settings

A shared-secret credential cannot be revoked on its own, so the TURN server
enforces the limits that matter in the data path. A starting point for
`turnserver.conf`, to tune to your bandwidth:

```
use-auth-secret
static-auth-secret=<the same value as TURN_SECRET>
realm=turn.example.com

# Relay between peers on the internet only, never into the server's own network.
no-tcp-relay
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

# Allocations per credential (each username starts with its expiry, so this is
# per credential), and for the whole server.
user-quota=12
total-quota=1200
# Bytes per second: per session (about 100 Mbit/s) and for the whole server.
max-bps=12500000
bps-capacity=62500000
```

Changing `TURN_SECRET` on both sides invalidates every outstanding credential
at once.

### Configure the app

On the device that generates the pairing code, open Settings, then Sync,
then Advanced:

- Set **Nostr relay URL** to your relay, for example `wss://relay.example.com`.
- Set **TURN / ICE servers URL** to `https://relay.example.com/ice-servers`,
  or clear it to derive that endpoint from the relay URL.

The ICE field initially shows the hosted Worker's endpoint. Editing the relay
field does not update the ICE field alongside it, so check both before
generating a pairing code. An explicitly filled ICE URL takes priority over
the relay-derived endpoint. The device joining from the code adopts both
endpoints. The ICE URL returns a JSON list of STUN/TURN servers; it is not a
`turn:` server URL itself.

### Debug logging

Set `RELAY_DEBUG=1` to trace connections, subscriptions, EVENT fan-out,
rejections and ICE endpoint requests:

```sh
RELAY_DEBUG=1 node services/nostr-relay/node/relay.mjs
# Docker: add -e RELAY_DEBUG=1 to docker run
```

Tracing is off by default. When enabled it includes socket IP addresses,
untrusted forwarded addresses, room and author prefixes, message sizes and
fan-out counts. Event contents and ICE credentials are not logged. These
metadata can be retained by your terminal, log collector or Docker log driver;
enable tracing only while diagnosing a connection and configure log rotation.

## Run in Docker

Same relay as a container (non-root, with a healthcheck on the HTTP probe):

```sh
docker build -t bramble-relay services/nostr-relay/node
docker run -d --name bramble-relay -p 127.0.0.1:7400:7400 \
  --restart unless-stopped --log-opt max-size=10m --log-opt max-file=3 bramble-relay
# custom port: -p 127.0.0.1:9000:9000 -e PORT=9000
```

For remote devices, put a TLS reverse proxy in front and use a `wss://` relay
URL with an `https://` ICE endpoint. Forward both WebSocket upgrades and
`POST /ice-servers` to port 7400. The desktop app's CSP, Android's mixed-content
rules and iOS ATS restrict plain `ws://` connections to remote hosts. The
example binds port 7400 to loopback for a proxy on the same host; adjust the
binding if your proxy runs in a separate container. The relay handles stop
signals, and the log options bound Docker's retained output.

## Deploy to Cloudflare Workers

`cf-worker/` is the same relay as a Cloudflare Worker backed by a Durable
Object: an always-on hosted endpoint with no server to run. The DO owns the
connected sockets and fans out events (a Worker is stateless, so it can't); the
sockets are **hibernatable**, so the object is evicted while idle and billed only
when a message arrives. A signaling relay is idle almost always, so the cost is
effectively zero, and a SQLite-backed Durable Object runs on the Workers free
plan.

```sh
cd services/nostr-relay/cf-worker
pnpm exec wrangler login   # one-time
pnpm run deploy            # -> wss://bramble-relay.<subdomain>.workers.dev
pnpm run dev               # local miniflare at ws://localhost:8787
```

Then configure the app with the printed `wss://` URL and its ICE endpoint as
described above. The Worker and Node relay speak the same wire contract.

TURN on the Worker needs four secrets (`pnpm exec wrangler secret put <NAME>`):
`TURN_KEY_TOKEN_ID` and `TURN_KEY_API_TOKEN` for the Cloudflare TURN key it mints
from, and `TURN_ANALYTICS_TOKEN` (Account Analytics: Read) and `CF_ACCOUNT_ID`
for the monthly ceiling and the per-credential cap. Without the first two the
ICE endpoint returns an empty list. The limits themselves are `vars` in
`wrangler.jsonc`; see [../../docs/turn-credentials.md](../../docs/turn-credentials.md).
A `RELAY_TOKEN` secret makes a Worker private, exactly as on the Node relay
(see "Limits and private mode").

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
relay  -> client  ["NOTICE", reason]           (invalid subscription or filters)
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

The Node relay rejects malformed filters and events, and limits WebSocket
messages to 64 KiB before buffering a complete message. Invalid UTF-8 or an
oversized message closes the offending socket without stopping other peers.
