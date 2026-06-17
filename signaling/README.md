# Signaling relay

A minimal, zero-dependency WebSocket relay for P2P sync (see
[../docs/p2p-sync.md](../docs/p2p-sync.md)). It speaks just enough of the Nostr
protocol (NIP-01 `REQ` / `EVENT` / `CLOSE`) to fan out **ephemeral** events
(kind 20000-29999) to current subscribers. It **stores nothing** and never sees
the vault: it only relays encrypted, group-key-addressed signaling blobs while
two peers establish a direct WebRTC connection.

Because it speaks the Nostr subset, the extension can point at this relay, your
own self-hosted copy, or any public Nostr relay (the relay URL is
user-configurable; there is no default).

## Run

```sh
bun signaling/relay.mjs            # ws://localhost:7400
PORT=9000 bun signaling/relay.mjs  # custom port
```

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
