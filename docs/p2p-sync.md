# P2P sync: cross-device, cross-browser vault sync

Design for syncing one user's own vault across their own devices without a vault server,
without a binary to install, and without operating trusted infrastructure. This is the
cross-browser answer to the filesystem-sync gap in [firefox-port.md](firefox-port.md): the
Chrome FSA "drop `vault.db` in a synced folder" trick has no Firefox equivalent, so sync
moves from the filesystem to a direct device-to-device channel.

"P2P" here means *personal*: only the user's own devices, only their own vault. There is no
community network, DHT, or shared swarm.

Platform facts are dated **mid-2026**; re-verify before acting on them later. See "Sources".

## Scope (v1)

Deliberately narrow, to keep the first version shippable:

- **Same network, all devices online at sync time.** This removes TURN relays (LAN peers
  connect via WebRTC host candidates) and removes any store-and-forward mailbox (no device is
  offline during a sync). Cross-internet and async sync are explicit non-goals for v1.
- **Multi-device, not just two.** The design is a sync *group* of N devices, not a pair.
- **No vault server, no installed binary, no infrastructure the project must operate and that
  users cannot verify.** See "Trust model" for how this is achieved rather than asserted.

## Architecture: one merge engine, pluggable transports

The merge engine is transport-independent and is the reusable core. Whatever moves bytes
between devices (the Chrome FSA file today, the WebRTC channel here, a future native file
bridge) feeds the same merge:

- **Transport** moves an encrypted vault between devices.
- **Merge engine** reconciles two vault states into one, deterministically.

Everything below the merge engine is swappable. This doc specifies the WebRTC transport and
the merge engine; the existing FSA path stays as another transport.

## The shared-VEK model

In [VLT1](vault-format.ts) every unlock slot wraps a copy of one random VEK, and the entries
blob plus per-entry DEKs all live under that VEK. For sync this is the whole foundation:

- A **sync group is one logical vault, one shared VEK**, held as separate physical blobs on
  each device, each with its own unlock slots.
- A "device" is just one or more slots on that shared VEK. Multi-device falls straight out of
  the existing multi-slot design.
- Because every device shares the VEK, any device can decrypt any other's vault, so **merge
  runs locally on already-decryptable data**, never on opaque blobs.

### Enrollment

Adding a device is not "pair two independent vaults"; it is joining the group around the
shared VEK:

1. The new device scans a QR shown by **any one** existing member (not pairwise against every
   device; enrollment is not O(N^2)).
2. Over the resulting authenticated channel the existing device transfers the **group key**,
   the **VEK**, the current **entries**, and the **roster** of device public keys.
3. The new device mints **its own** unlock slot (password / WebAuthn) wrapping that VEK, and
   adds its device keypair to the roster.

The VEK crosses the wire exactly once, at enrollment, over the roster-authenticated channel
(see "Trust model"). After that the VEK never crosses again; ongoing sync moves only
encrypted entry envelopes.

## Trust model: the relay is a dumb, untrusted pipe

The signaling relay (next section) is never trusted. Its honesty is made irrelevant rather
than verified, so "you cannot audit what the operator actually deployed" stops mattering.

The trust anchor is the **roster of per-device public keys** established at QR enrollment, on
the user's own devices. After the WebRTC channel opens, the devices run an **application-layer
mutual-auth handshake** (Noise / PAKE style) keyed by their roster keys, on top of the
channel's DTLS.

This closes the one real signaling attack. WebRTC's SDP carries the DTLS fingerprints, so a
relay that can rewrite SDP can substitute its own fingerprint and man-in-the-middle the DTLS;
DTLS alone does not defend against a malicious *signaling* path. The roster handshake does: a
relay is not in the roster, so it cannot complete the handshake and cannot derive the channel
key.

What a malicious or impostor relay can therefore do:

| Attack | Result |
| --- | --- |
| Rewrite SDP / swap fingerprints (MITM) | Roster handshake fails to authenticate, device aborts. Nothing gained. |
| Impersonate one of the user's devices | Lacks that device's private key. Cannot. |
| Read vault data | Only ever saw ciphertext. Cannot. |
| Tamper with synced data | Channel is authenticated and encrypted under keys it does not hold. Cannot. |
| Refuse to relay | Denial of service only. Mitigated by multi-relay + QR fallback. |
| Observe metadata | Sees that two IPs connected, when. See below. |

So the relay is reduced to connect-or-not. It can deny service or watch metadata; it can never
read, alter, or impersonate. This is why the relay need not be trustworthy, only available.

**Metadata residual:** signaling payloads are additionally encrypted under the group key (the
relay sees opaque blobs), and the room is addressed by `roomId = HMAC(groupKey, "signal")`, so
the relay cannot link rooms to identities. On a same-network sync the devices share one public
IP, so the most a relay learns is "someone at this IP synced," which is close to nothing.

## Signaling: Nostr-subset relay, user-chosen

Browsers have no LAN discovery (no mDNS, no UDP, no raw sockets in MV3), so even same-network
peers need an out-of-band introduction to exchange the initial WebRTC offer. There is no
zero-infrastructure browser discovery; this is a platform fact, not a missing optimization.

The relay is a WebSocket that speaks the **ephemeral subset of the Nostr protocol**:

- Devices publish **ephemeral events** (kind in 20000..29999) carrying the encrypted signaling
  payload, tagged with the group-derived room id; the peer subscribes and reads them. Relays
  forward ephemeral events to current subscribers and never store them, which is exactly right
  for transient SDP/ICE.
- This is a documented, real pattern (see "Sources"), not a bespoke protocol.

Why the Nostr *protocol* rather than a custom relay: it makes the relay **user-chosen in one
line of config**. The extension ships a relay URL setting; the user can point it at:

- the project's default relay,
- their own self-hosted relay, or
- **any of the existing public Nostr relays**, with no deployment, because they all speak the
  same protocol.

That last option is the one that matters: a user who distrusts the default but will not run a
server still has a frictionless, zero-deploy alternative. Roster auth (above) makes every one
of these choices equally safe.

The relay we run as the default is the **minimal ephemeral subset only** (~100 lines: accept
connections, match `REQ` filters, fan out `EVENT`s, store nothing). We do not run or ship a
full relay implementation (strfry, nostr-rs-relay, etc.); those are heavyweight event-storage
servers built for the social firehose, far more than signaling needs, and a download/ops/supply
burden we avoid. The client must produce properly signed Nostr events so public relays accept
them.

**Multi-relay + QR floor:** the client hits several relays at once and needs only one to
deliver a small message once, which makes a flaky public commons reliable enough for a
seconds-long handshake (the actual vault transfer is LAN-direct and touches no relay). If no
relay is reachable, **manual QR pairing** is the always-works fallback with zero infrastructure.

## Transport: WebRTC data channel

WebRTC needs a document context; `RTCPeerConnection` is not available in a bare service worker.
This maps onto the host abstraction the Firefox port already introduces:

- **Chrome:** run WebRTC in the **offscreen document**, created with the `WEB_RTC` reason (the
  reason exists precisely for `RTCPeerConnection` from an MV3 service worker). This is the same
  offscreen document that already hosts the WASM crypto and the live VEK.
- **Firefox:** run WebRTC in the **background event page**, which is a real DOM document. (Mark
  for smoke-test: confirm `RTCPeerConnection` is exposed in the FF MV3 event page before
  relying on it; WebRTC is a document API and the event page is a document, so it is expected.)

So the "crypto host" the port plan already builds becomes the "sync host" too: one
transport-free core, two thin entry points.

## Topology: pairwise-gossip mesh, no coordinator

Each device opens channels to whichever group peers are present, runs a pairwise merge with
each, writes the result, re-announces its version, and repeats until nothing changes. No leader
election, no central coordinator.

This converges because the merge (next section) is a deterministic function of the per-entry
stamps and tombstones, so it is order-independent: pairwise merges gossiping across the mesh
reach the same final vault on every device regardless of who synced with whom first.

## Merge engine: entry-level last-writer-wins

### Stamps

Every write stamps a **hybrid logical clock**: `(wallMillis, counter, deviceId)`, compared in
that order. `counter` breaks same-millisecond ties on one device; `deviceId` is the final
tiebreaker so the winner is identical on every device (arbitrary but deterministic, which is
all convergence needs).

### Merge metadata lives off the binary format

The current entry shape `{id, wrappedDek, dekIv, ciphertext, iv}` has no version, modified-at,
or tombstone, so it cannot merge without losing data. The fix does **not** touch the VLT1
binary layout in `vault-format.ts`:

- The metadata lives in the **decrypted entries payload** (what `entriesCiphertext` decrypts
  to), so it is encrypted under the VEK and stays end-to-end private. The on-disk container,
  magic, slot TLV, and decoder bounds-checks are unchanged.
- Add, at the outer (VEK-level, pre-DEK) layer so the host can compare without unwrapping each
  DEK: a per-entry **HLC stamp**, **modifiedAt**, and a **tombstone list** (deleted id +
  deletion HLC).

### The merge touches an index, not secrets

This is the security property behind entry-level merge. To decide a conflict the host compares
**outer metadata only** (`id`, HLC). The winning entry is carried over **as its sealed blob**
(`wrappedDek`, `dekIv`, `ciphertext`, `iv` moved as bytes). No per-entry DEK is unwrapped, no
password is ever decrypted during merge. The only thing decrypted is the envelope index, which
holds no secrets.

(Field-level merge, where concurrent edits to *different fields* of one entry both survive,
would require unwrapping DEKs and reconciling plaintext fields. That is the only variant that
exposes secrets during merge, and it is **deferred**. Entry-level is the v1 choice partly for
this reason.)

### Rules

- **Entry vs entry:** for a given `id`, the greatest HLC wins; the whole losing entry is
  discarded (see history setting below).
- **Entry vs tombstone:** compare the entry's HLC against any tombstone for the same id; the
  greater wins. A delete is a stamped tombstone, never a silent removal, so a stale copy on
  another device cannot resurrect it. An edit stamped *after* a delete correctly undeletes.
- **Slots:** union by `slotId`; revocation is a slot tombstone. All slots wrap the same VEK, so
  union is valid, and `OpaqueSlot` round-trip preserves slot kinds a device does not understand.

### Conflict loser: setting

When two devices edit the same entry, the losing whole-entry version is **dropped by default**
(simplest). A user setting, when enabled, instead stashes the losing **sealed** version in the
entry's history list, recovering the lost value without ever decrypting it to merge.

## Deferred / known limitations (v1)

- **VEK rotation is deferred.** The shared-VEK model makes rotation a group event (peers
  holding the old VEK cannot read entries re-encrypted under a new one). v1 does not rotate.
  Consequence: **revoking a device means removing it from the roster so it cannot sync going
  forward; it is not a remote wipe.** A stolen device that already holds the VEK and a local
  vault copy still has that data offline. True lockout requires rotation, which is the natural
  follow-up. State this clearly so it is not mistaken for the stronger guarantee.
- **Async / cross-internet sync is out of scope.** v1 is same-network, all-online. The natural
  upgrades (TURN for hard NATs, a store-and-forward mailbox, or the native-bridge transport
  from `firefox-port.md` Option 1) are separate workstreams over the same merge engine.
- **Field-level merge is deferred** (see above).

## Device management & revocation (TODO)

There is no UI yet to see or manage paired devices; the roster is built and merged but only
surfaced through the pairing flow. Planned:

- **Devices list.** A "Devices" section in Settings (shared `SyncConnectSection`/a new
  `RosterSection`, so extension + mobile get it) that lists the roster `devices`: label,
  added date, a "this device" marker, and (if we start tracking it) last-seen. Source of truth
  is the persisted `sync.group` roster.
- **Rename.** Edit a device's `label` (a roster-entry field) and let it propagate via the
  roster CRDT merge.
- **Revoke.** Add the selected device to the roster `revoked` tombstones and propagate. Two
  pieces of plumbing to confirm/build: (a) `roster` merge must drop revoked ids from `devices`,
  and (b) roster-sync KK auth must reject a static key that's revoked (today it only checks
  presence in the roster, see `roster-sync.ts` "not in roster — ignoring"). Result: the revoked
  device can no longer connect or sync.
- **Revoke is not a remote wipe.** Per "VEK rotation is deferred" above, a revoked device still
  holds the VEK + a local vault copy offline. True lockout requires **VEK rotation + re-wrap of
  every slot and re-encrypt of entries**, distributed to the remaining devices over sync. That
  is the load-bearing follow-up that makes revocation a real security boundary; wire the UI now
  but label plain revoke as "stops future sync," not "wipes that device."
- **Mobile note.** The device keypair currently lives in plaintext `Preferences`; move it (and
  the group key) to Keychain/Keystore in the Phase 2 secure-storage hardening before this ships.

## Build / packaging notes

- Extract the WebRTC + signaling + merge into transport-free modules that touch no DOM at
  import time, so the Chrome service worker can import them and the offscreen document / FF
  event page provides the document context. This mirrors the offscreen refactor already planned
  in `firefox-port.md`.
- Ship the minimal Nostr-subset relay source in `/nostr-relay/` for users who want to self-host;
  the default relay URL is overridable in settings.

## Implementation status (built)

The design above is implemented and working across two real browsers (transport,
enrollment, roster-auth, and headless background sync). Notes on how it maps to code:

- **Transport-free core** (`packages/core/src/sync/`): merge kernel + HLC, entries
  payload + tombstones, `applyRemotePayload`, roster CRDT, the nostr signaling codec
  + `connectSignaling`, the pairing/enrollment codecs. The Noise (KK + XXpsk3) and
  BIP340 primitives are in `packages/crypto-wasm`.
- **Transport + hosts** (`packages/platform-extension/src/sync/`): `mesh` (relay +
  discovery + WebRTC peers), `handshake` (one runner for KK and XXpsk3),
  `peer-session` (the shared mesh-session lifecycle: join room + per-peer handler +
  teardown, returned as a handle so there is no module-level singleton), with
  `enroll-host` (enrollment) and `roster-sync` (continuous sync) each a configuration
  of it. All run in the **offscreen document** (the `WEB_RTC` reason); it has no
  `chrome.storage`, so it bridges storage to the background.
- **Separate rooms.** `deriveRoomId(groupKey, label)` — enrollment uses
  `bramble/enroll`, ongoing sync uses `bramble/sync` — so the enroll handshake never
  collides with running sync meshes.
- **Enrollment** seals `{vek, roster, entries}` Noise-only; the joiner rebuilds its
  vault entirely in the offscreen via `core/vault/build-vault` (the VEK never reaches
  the popup) and hands the inviter its roster entry so both rosters stay symmetric.
- **Headless sync** is background-driven: started on unlock / SW-startup, the offscreen
  runs `roster-sync` continuously; the merge runs in the background via `vault-io`
  (`SYNC_LOCAL_PAYLOAD` / `SYNC_APPLY_REMOTE`). Re-broadcast is periodic (~4s) +
  on-connect; an instant on-change nudge is a follow-up.
- **FSA reality:** the background can read/write a file-backed vault only when its
  permission is already granted (`createWritable` needs no gesture, only
  `requestPermission` does), so `canWriteFromBackground` checks `queryPermission`;
  otherwise writes queue for the next popup. `chrome.storage.local` is fully headless.
- **Deferred:** VEK-never-in-JS hardening (the VEK is currently a transient JS string
  during enrollment + session caching, no worse than the existing session cache);
  instant on-change nudge; VEK rotation; async/cross-internet (see above).

Testing rig: [p2p-sync-testing.md](p2p-sync-testing.md).

## Sources

- `chrome.offscreen` reasons (incl. `WEB_RTC`): https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Offscreen documents in MV3: https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3
- WebRTC signaling over Nostr (NIP discussion): https://github.com/nostr-protocol/nips/issues/771
- Nostr ephemeral events (kind 20000..29999), NIP-01: https://github.com/nostr-protocol/nips/blob/master/01.md
- Working WebRTC-over-Nostr implementation: https://codeberg.org/cipres/nostr_webrtc
- RTCPeerConnection (document-context API): https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection
- WebRTC API: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API
