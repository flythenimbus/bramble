# P2P sync: cross-device, cross-browser vault sync

Design for syncing one user's own vault across their own devices without a vault server,
without a binary to install, and without operating trusted infrastructure. With the vault
now in `chrome.storage.local` on every platform (see [storage.md](storage.md)) there is no
shared file to sync at all, so sync is a direct device-to-device channel. (Historically a
Chrome-only "drop `vault.db` in a synced folder" File System Access trick existed and had no
Firefox equivalent — the filesystem-sync gap noted in [firefox-port.md](firefox-port.md);
P2P replaces it everywhere.)

"P2P" here means *personal*: only the user's own devices, only their own vault. There is no
community network, DHT, or shared swarm.

Platform facts are dated **mid-2026**; re-verify before acting on them later. See "Sources".

## Scope (v1)

Deliberately narrow, to keep the first version shippable:

- **All devices online and active at sync time** (synchronous, no store-and-forward). Same-LAN
  peers connect via WebRTC host candidates; cross-network peers (different networks, or behind a
  full-tunnel VPN that routes the app off the LAN) relay through **TURN** (see "Transport"). A
  store-and-forward mailbox for devices that are *offline* (true async sync) is still out of
  scope: both peers must be online and unlocked at the same moment. _(Original v1 was same-network
  only; TURN landed later, see "Implementation status".)_
- **Multi-device, not just two.** The design is a sync *group* of N devices, not a pair.
- **No vault server, no installed binary, no infrastructure the project must operate and that
  users cannot verify.** See "Trust model" for how this is achieved rather than asserted.

## Architecture: one merge engine, pluggable transports

The merge engine is transport-independent and is the reusable core. Whatever moves bytes
between devices (the WebRTC channel here, a future native bridge) feeds the same merge:

- **Transport** moves an encrypted vault between devices.
- **Merge engine** reconciles two vault states into one, deterministically.

Everything below the merge engine is swappable. This doc specifies the WebRTC transport and
the merge engine.

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

### Pairing code

**The pairing code is a bearer secret equivalent to the vault.** It contains no VEK, and for a
long time the code and the docs said so and stopped there. That conclusion was wrong, and
GHSA-x4f5-4wq4-c6c8 is the report that caught it: the code's `psk` is the *sole* authenticator of
the joiner in the XXpsk3 handshake, so whoever completes that handshake is sent the bundle. What
the bundle contains is the whole vault:

| In the bundle | Consequence if it leaks |
| --- | --- |
| `vek` | Decrypts every entry, on any device, forever (v1 does not rotate the VEK). |
| `entries` | The vault contents at that moment. |
| `roster` | Group membership + device public keys. |
| `recoverySlots` | A recovery path that **survives a master-password change**, since the slots wrap the same VEK. |

So a code observed while an invite is live is a compromised vault, not a compromised session.
Say that plainly wherever the code is described; "no vault secrets in the code" is true about the
bytes and false about the consequence.

What limits the damage is the **invite lifecycle**, not the code's contents:

1. **Expiry.** The code carries `exp` (epoch ms) and the inviter arms a local timer for
   `INVITE_TTL_MS` (3 minutes) that tears down the mesh session. The timer is local rather than a
   wall-clock comparison, so device clock skew cannot extend or break the window. The joiner's
   `exp` check is a courtesy that buys a readable error, not the enforcement point.
2. **Single use.** The invite is *claimed* at handshake completion, before anything is sent, by a
   check-and-set with no `await` between the two statements. A second concurrent peer is refused.
3. **Burn on failure.** A claimed invite is never re-armed, including when the user rejects the
   approval or the flow fails afterwards. A rejection means the code demonstrably reached someone
   else, so re-arming it would hand them a second try. The user regenerates. On rejection the
   inviter sends an explicit notice (`ENROLL_REJECTED`) before tearing down, because the joiner's
   own wait is human-scale (below): without it the refused device sits on a spinner for minutes.
   It discloses nothing, since that peer can already see it got no vault.
4. **Bounded waits.** Every `recvSecure` and the handshake itself are wrapped in `withTimeout`, so
   a peer that connects and then stalls cannot hold the invite open (which is what made the
   "inviter serves one device then stops itself" comment unenforceable: `stop()` sat downstream of
   an unbounded `await`). Three budgets, because they wait on different things: `ENROLL_TIMEOUT_MS`
   (30s) for machine-speed waits, `VAULT_ACK_TIMEOUT_MS` (60s) for the flush barrier, which also
   covers the joiner's Argon2 rebuild, and `APPROVAL_WAIT_MS` for the joiner's wait on the first
   bundle frame, which spans the inviter's prompt and is therefore **human** time. That last one is
   tied to `INVITE_TTL_MS` rather than chosen separately: the inviter's approval cannot outlive the
   invite timer, so the joiner's budget cannot fall short of the real bound by construction. Giving
   it a machine-speed budget times the joiner out on the happy path whenever the user actually
   stops to compare the digits, which punishes the one behaviour the SAS depends on.
5. **The SAS gate** below, which is what makes a race visible rather than silent.

#### Short authentication string (SAS)

After the handshake, **the joiner speaks first**: it sends its roster entry, and the inviter
validates `entry.publicKey === sess.remoteStatic` *before sending anything*. Both sides then
derive 12 decimal digits and the user confirms they match before the bundle moves.

```
sas = HKDF-SHA256(ikm = psk, salt = sorted(pubA, pubB), info = "bramble/sync/sas/v1")
      -> 8 bytes -> BigInt mod 10^12 -> "NNNN NNNN NNNN"
```

Derived in TypeScript (`sync/pairing-sas.ts`) from the two Noise static public keys and the invite
PSK, not from the Noise handshake hash: `snow::TransportState` does not expose it and
`handshake.rs` drops it at `into_transport_mode()`, so using it would mean a Rust change plus a
wasm rebuild plus uniffi bindgen plus three mobile bridge layers. Deriving from the statics is
equally sound, because XXpsk3's `es`/`se` DHs prove each party owns the private key for the static
it presented: an interposer must present a *different* static, which changes the SAS. Sorting the
two keys makes it symmetric. `crypto.subtle` is used (as in `nostr.ts`), so this also works under
iOS Lockdown Mode, which disables WASM but not WebCrypto.

12 digits (~39.9 bits, Matrix's decimal SAS) rather than emoji or a word list: digits render
identically on iOS, Android and every browser, and need no 64-entry name table translated into 6
locales.

**What it defends, and what it does not.** The joiner already pins the inviter's static key from
the code, so an attacker cannot be the *joiner's* peer; the open direction was only the inviter
accepting an unknown joiner, and the SAS closes exactly that, making the authentication mutual:

- Attacker races and wins: the inviter's prompt shows `SAS(inviter, attacker)` while the real
  device shows `SAS(inviter, joiner)`. Mismatch, the user rejects, and single use means no retry.
- Real device wins: the two match, and the attacker is refused as a second peer.

Either way the theft becomes a **visible event** instead of a silent one. Note this also rules out
grinding a short SAS: grinding needs the attacker to be *both* peers, which the joiner's pin
prevents, so 40 bits is comfortable here rather than marginal.

It does **not** defend a user who approves without comparing, and it does not help against a code
leaked *before* this shipped (see "Deferred": no VEK rotation). The joiner's device label is shown
alongside the SAS as context only; it is attacker-controlled and is not proof of anything.

#### Version skew

|  | old inviter | new inviter |
| --- | --- | --- |
| **old joiner** | unchanged | the inviter's bounded wait expires and it aborts, telling the user to update Bramble on the other device |
| **new joiner** | the joiner's entry queues (`channel.ts` queues inbound); the old inviter sends the bundle and then reads that entry as its ack, so this works unchanged | full gate |

This is why the joiner sends **the existing ack frame, up front** rather than a new envelope: an
old inviter consumes it as the ack it already expects.

After the bundle the joiner sends a second, content-free frame (`VAULT_ACK`) confirming receipt.
That is not identity (identity was settled before the bundle moved); it is a **flush barrier**.
`sendSecure` resolving means the frames were handed to the channel, not that they were sent: on
the relay path `channel.send` only queues `void publish(...)`, which awaits two WebCrypto
operations before reaching the socket, and `mesh.stop()` calls `client.close()` synchronously in
the same macrotask; on WebRTC, `pc.close()` discards whatever SCTP still has queued. With `stop()`
running straight after the send, the tail of a multi-frame bundle was dropped, and losing one
frame fails the whole message. Roughly 30 entries fit in a single 32 KiB frame, so it only bites
on real vaults, and on WebRTC only when the queue happens to be non-empty: it presents as flaky
pairing rather than a clean failure.

An old inviter has already stopped by the time this frame is sent and simply never reads it. That
is the right trade: an unread frame costs nothing, a truncated vault transfer costs the pairing.
The wait is bounded and sits upstream of `stop()`, so it does not reintroduce the unbounded ack it
replaced.

**There is deliberately no downgrade path.** A new inviter that receives no hello aborts rather
than falling back, because an attacker would otherwise simply stay silent to force the legacy
flow. The cost is that un-updated devices can no longer pair with updated ones; they get an
explicit update prompt.

`exp` is purely additive: zod's `z.object` strips unknown keys, so an old client parsing a code
that carries it silently ignores it. The `v: 1` literal and the `bramble-pair-1.` prefix are
therefore kept, since bumping either would make old joiners fail with a raw zod error instead of a
readable message.

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

**This table is about the relay, and only the relay.** It says nothing about an attacker who has
seen a live pairing code, which is a different and much stronger position: such an attacker is not
trying to break the handshake, it is holding the credential that *completes* it. That class is
covered in "Pairing code" above, and the mitigations there (expiry, single use, the SAS gate) are
the ones that apply. Conflating the two is how "the relay can't read anything" got read as "the
pairing code is safe to share."

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
- **Mobile (Capacitor):** the single webview is a real DOM, so the same transport modules run
  in-process, with no offscreen indirection. WebRTC + the WebSocket relay are standard webview APIs.

So the "crypto host" the port plan already builds becomes the "sync host" too: one
transport-free core, three thin entry points (offscreen, FF event page, mobile webview).

**ICE servers: host candidates, then TURN.** A connection first tries direct **host candidates**
(LAN), which is enough when both devices share a network. When they don't (different networks,
or a full-tunnel VPN like Proton that binds the app's sockets to the tunnel so the LAN path is
gone), direct fails and the channel needs a **TURN relay** both peers can always reach. Before
each connection the client fetches ICE servers from a minting endpoint (`POST /ice-servers` on the
relay Worker, which mints short-lived Cloudflare TURN credentials server-side) and passes them to
`RTCPeerConnection`; the fetch failing degrades to host-only, not an error. TURN only ever relays
the **DTLS + Noise ciphertext**, so it is the same "dumb untrusted pipe" as the signaling relay
(it learns that the two endpoints synced and the byte volume, nothing more; behind a VPN it sees
the VPN's exit IP). The ICE endpoint **derives from the relay URL** by default (one Worker serves
both), and is separately overridable for self-hosters who put signaling on a public Nostr relay
(no `/ice-servers`) and TURN elsewhere. Both the relay and ICE URLs are configurable in Settings,
persisted, and **carried in the pairing code** so a joined device adopts and displays them.

Platform note (learned the hard way): iOS VPNs (NetworkExtension) leave local-network traffic
*outside* the tunnel by default, so same-LAN host candidates kept working with a VPN on; Android's
`VpnService` full-tunnel does not, so Android needed TURN to sync under the same VPN.

### Framing: chunk the vault across Noise frames (`secure-channel.ts`)

A Noise transport frame caps at 64 KiB (`core-rust` `MAX_MSG`), so handing the whole
`{vek, roster, entries}` bundle (enrollment) or sync envelope (roster-sync) to `handshake_encrypt`
in one call throws `message too large for one Noise frame` once a vault holds more than a few
dozen entries. `sendSecure`/`recvSecure` split the plaintext into frame-sized (`CHUNK_BYTES`,
UTF-8-boundary-safe) chunks, encrypt each into its own Noise frame, and reassemble on receipt.
Each frame is also small enough to stay under the WebRTC data-channel max message size (which
`webrtc-peer` sends unchunked), so this one seam clears both ceilings.

Noise transport is nonce-ordered, so frames must be decrypted in send order; both transports
already deliver in order (SCTP is ordered+reliable; the relay path assumed it for single messages
too). Wire compatibility is graceful: a **single-chunk** payload is sent as a bare base64
ciphertext — byte-identical to the pre-framing format — so an un-updated peer still syncs small
vaults; a **multi-chunk** payload uses JSON `{i, n, c}` frames, recognised by the leading `{`
(base64 never starts with one). A peer old enough not to understand multi-frame already couldn't
receive a large vault at all, so this is a pure improvement, not a break. This is distinct from
the relay's `relay-channel.ts` chunking, which splits the *outer* group-key ciphertext to fit the
relay's per-message cap (see docs/firefox-port.md); framing here is the *inner* Noise layer and
applies on every transport.

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
  **discarded** (see "Conflict loser" below). The loser is not kept anywhere.
- **Entry vs tombstone:** compare the entry's HLC against any tombstone for the same id; the
  greater wins. A delete is a stamped tombstone, never a silent removal, so a stale copy on
  another device cannot resurrect it. An edit stamped *after* a delete correctly undeletes.
- **Slots:** NOT merged. This describes a design that was never built: `mergeReplicas` handles
  entry records only, `apply-remote.ts` has no slot handling, and `OpaqueSlot` is purely a
  `vault-format.ts` parser fall-through for unknown slot kinds, unrelated to sync. Verified on a
  device 2026-09-01: a webauthn key registered on one browser is absent from a vault joined from
  it.

  What actually happens: **each device mints its own slots and they never travel.** A joining
  device rebuilds its vault (`enroll-host.ts` via `buildVaultBytes`) with the slot it just made,
  plus the inviter's forwarded `recoverySlots`. So the master password works everywhere because
  the same password re-derives on each device, not because a slot moved.

  Union would be valid if implemented (all slots wrap the same VEK), and the absence has real
  consequences: a key added on one device is invisible to the others, and revoking one there does
  not propagate. The only way a vault gains another device's slots today is **restoring that
  device's backup**, since a `.bramble` backup is the sealed blob (`backup/run.ts`).

### Conflict loser

When two devices edit the same entry, the losing whole-entry version is **dropped**. This is
the current behaviour, full stop: `mergeReplicas` keeps only the max-HLC record per id and the
older one is overwritten, and the entry shape (`{id, wrappedDek, dekIv, ciphertext, iv, hlc}`)
has no slot to stash a prior version. Nothing is kept in the background and nothing is surfaced
to the user.

**Planned (not built):** a setting that instead stashes the losing **sealed** version in an
entry history list, recovering the lost value without ever decrypting it to merge, plus a UI
that surfaces the conflict rather than resolving it silently. Both require adding a versions
field to the entry payload; see "Deferred / known limitations".

Not to be confused with the **password changelog** ([password-changelog.md](password-changelog.md)),
which is already built: that keeps superseded passwords from *local* rotations inside the entry
plaintext, and a conflict loser still drops its rows like any other edit.

## Deferred / known limitations (v1)

- **VEK rotation is deferred.** The shared-VEK model makes rotation a group event (peers
  holding the old VEK cannot read entries re-encrypted under a new one). v1 does not rotate.
  Consequence: **revoking a device means removing it from the roster so it cannot sync going
  forward; it is not a remote wipe.** A stolen device that already holds the VEK and a local
  vault copy still has that data offline. True lockout requires rotation, which is the natural
  follow-up. State this clearly so it is not mistaken for the stronger guarantee.
  This is also the residual behind GHSA-x4f5-4wq4-c6c8: a pairing code observed *before* the
  invite hardening shipped already yielded a VEK, and no amount of lifecycle hardening makes that
  recoverable. Rotation is what would; until then the advice for a code known to have leaked is to
  treat the vault as compromised and rotate the credentials in it.
- **Async (offline) sync is out of scope.** Cross-network sync now works (TURN, above), but it is
  still *synchronous*: both devices must be online and unlocked at once. "Edit on A now, B picks
  it up tomorrow" needs a **store-and-forward mailbox** (a server that holds encrypted deltas for
  an offline device); that's separate infrastructure over the same merge engine, and it changes
  the metadata/availability surface (the relay would then *store* ciphertext, not just relay it).
  Mobile compounds this: the OS suspends backgrounded apps and there's no FCM wake (no Google
  Play), so mobile is realistically "syncs when you open it."
- **Push latency on suspending hosts.** A local edit is pushed to peers immediately — a vault-blob
  change triggers a broadcast, so it doesn't wait for the ~4s rebroadcast tick. But where the sync
  host suspends between ticks (Firefox's background event page, like mobile), an edit made while
  suspended only lands on the next wake/reconnect, so Firefox→peer can lag (seconds up to ~a minute).
  Chromium's persistent offscreen is effectively instant both ways.
- **Cross-network first connect can be slow.** On a hard NAT / VPN the working path is the TURN relay,
  whose candidates (especially the TCP/TLS variants that beat a UDP-blocking VPN) are gathered and
  checked *last*, so the first cross-network connect may need a retry before it lands — not a failure.
  Same-network / same-machine peers connect instantly.
- **Field-level merge is deferred** (see above).
- **Conflict history + surfacing is deferred.** Today a same-entry conflict silently drops the
  losing version (see "Conflict loser"). Keeping the sealed loser in an entry history list and
  showing the conflict to the user are both unbuilt; they need a versions field on the entry
  payload. Deletes are the one exception already covered: tombstones mean a delete is never
  silently lost or resurrected.

## Device management & revocation

The Settings "Device sync" panel (shared `SyncConnectSection`, so extension + mobile get it) is
state-aware: not-in-a-group shows add/join; in-a-group shows a status dot, the **devices list**
(label, key fingerprint, added date, a "this device" marker keyed by public key), a per-device
**remove**, **Disconnect** (leave the group, go offline-only), and a demoted "Add another device".
Source of truth is the persisted `sync.group` roster.

- **Remove (revoke), built.** A trash icon on each non-"this device" row → confirm →
  `useVault.removeDevice(id)` → a roster `revoked` tombstone (`revokeDevice`) persisted to
  `sync.group`. The roster CRDT already drops revoked ids from `devices` (`mergeRosters` /
  `activeDevices`), and roster-sync auth checks membership in `devices`, so a revoked key is
  rejected once the revocation has merged in.
- **Roster propagation, built.** Ongoing sync now gossips the **roster** alongside entries (a
  `{entries, roster}` envelope in `roster-sync.ts`, with `fetchLocalRoster`/`pushRemoteRoster`
  hooks). So a removal (or an enrollment) fans out to peers and converges; the receiver merges +
  persists and nudges the popup (`SYNC_EVENT {kind: "roster"}`). Bridged on both hosts: extension
  offscreen↔background (`SYNC_LOCAL_ROSTER` / `SYNC_APPLY_ROSTER`), mobile sync-manager direct.
- **No re-auth on remove (by choice).** The panel is already behind an unlocked vault (the actor
  can read every secret), revoke is not a wipe, and it's reversible by re-pairing, so a
  *confirmation* is the right bar, not a master-password/biometric step-up. Add the step-up when
  **VEK rotation** makes revoke a true lockout (then "silently revoke the owner's other devices"
  becomes a takeover move worth gating; reuse the device's existing unlock factor).
- **Revoke is not a remote wipe.** Per "VEK rotation is deferred", a revoked device still holds the
  VEK + a local vault copy offline. True lockout requires **VEK rotation + re-wrap of every slot
  and re-encrypt of entries**, distributed over sync. Plain revoke = "stops future sync," not
  "wipes that device."
- **Live-session revocation, built.** A revoked peer is cut *mid-session* now, not just at the next
  restart: roster-sync reads the roster fresh each check (`currentRoster`), drops revoked peers from a
  running session (`reapRevoked`, outbound + inbound), and a gossiped revocation reaps across the mesh
  at once. (The old "keeps its channel until restart" edge is closed.)
- **Re-adding a removed device uses a FRESH id.** Tombstones are sticky (a revoked id stays dead, so
  gossip can't resurrect it — closes B1), and device ids are stable/persisted, so a re-add under the
  old id would be dropped everywhere (it couldn't see itself; peers couldn't see it). `joinGroup`
  therefore rotates the device id first (`rotateDeviceId`), so a re-add enters as a genuinely new
  member while the old id stays dead. See docs/p2p-sync-revocation-hardening.md.
- **A revoked device is not notified.** The tombstone can't reach it (every survivor refuses it), so
  it keeps a stale "still synced" UI but has no access. Accepted: there is deliberately **no remote
  self-destruct** (it would only fire on honest devices and arm a compromised member to wipe peers;
  see the revocation-hardening note).
- **New vault = clean sync identity.** Creating a vault wipes all local sync state
  (`shell.resetSyncState`: group, relay, device id + Noise/signing keys), so a fresh vault never
  inherits the old group/mesh. Sync identity belongs to the vault, not the device.
- **Roster entries are signed + admission-gated (Item A).** Each entry carries an Ed25519 `sigKey` +
  `sig` (TOFU id↔key binding) and, for a non-initial device, an `admission` from a member's
  password-derived key. Verify-if-present today; enforced in a later release. See
  docs/p2p-sync-revocation-hardening.md.
- **Rename** (edit `label`, propagate via the roster CRDT) is still TODO.
- **Device labels.** New enrollments self-label by platform (`defaultDeviceLabel`: "Android device",
  "Firefox on Mac", …) instead of a generic "This device"; the UI marks the current device by
  public-key match, so a label collision is only cosmetic.
- **Secure storage, done.** The device keypair (and group key) now live in Keychain/Keystore on
  mobile and `chrome.storage` on the extension (the earlier plaintext-`Preferences` note is
  resolved).

## Build / packaging notes

- Extract the WebRTC + signaling + merge into transport-free modules that touch no DOM at
  import time, so the Chrome service worker can import them and the offscreen document / FF
  event page provides the document context. This mirrors the offscreen refactor already planned
  in `firefox-port.md`.
- Ship the minimal Nostr-subset relay source in `/nostr-relay/` for users who want to self-host;
  the default relay URL is overridable in settings.

## Implementation status (built)

The design above is implemented and working across two browsers and the iOS/Android mobile
app (transport, enrollment, roster-auth, headless background sync, cross-network TURN, and
device management). Notes on how it maps to code:

- **Transport-free core** (`packages/core/src/sync/`): merge kernel + HLC, entries
  payload + tombstones, `applyRemotePayload`, roster CRDT, the nostr signaling codec
  + `connectSignaling`, the pairing/enrollment codecs. The Noise (KK + XXpsk3) and
  BIP340 primitives are in `packages/core-rust`.
- **Transport + hosts** (`packages/core/src/sync/transport/`): `mesh` (relay + discovery
  + WebRTC peers), `ice` (`deriveIceUrl` + `fetchIceServers` for STUN/TURN), `handshake`
  (one runner for KK and XXpsk3), `peer-session` (the shared mesh-session lifecycle: join
  room + per-peer handler + teardown, returned as a handle so there is no module-level
  singleton), with `enroll-host` (enrollment) and `roster-sync` (continuous sync) each a
  configuration of it. The **extension** runs these in the offscreen document (the `WEB_RTC`
  reason; no `chrome.storage`, so it bridges to the background); **mobile** runs them
  in-process in the webview (`platform-mobile/src/sync/sync-manager.ts`).
- **Cross-network TURN** (`nostr-relay/cf-worker` + `transport/ice.ts`): the relay Worker's
  `POST /ice-servers` mints short-lived Cloudflare TURN credentials; `startMeshSession`
  fetches them (URL derived from the relay, or an explicit override) and passes them to the
  peers, so enrollment *and* ongoing sync cross networks/VPNs. The relay + ICE URLs are
  configurable in Settings (persisted; the ICE field pre-fills the derived endpoint) and ride
  the pairing code so a joiner adopts them.
- **Device management** (`SyncConnectSection` + `useSyncEnrollment.removeDevice`): per-device
  revoke (roster tombstone) with the roster gossiped alongside entries in `roster-sync` (the
  `{entries, roster}` envelope) so revocations converge; see "Device management & revocation".
- **Separate rooms.** `deriveRoomId(groupKey, label)`: enrollment uses
  `bramble/enroll`, ongoing sync uses `bramble/sync`, so the enroll handshake never
  collides with running sync meshes.
- **Enrollment** seals `{vek, roster, entries}` Noise-only; the joiner rebuilds its
  vault entirely in the offscreen via `core/vault/build-vault` (the VEK never reaches
  the popup) and hands the inviter its roster entry so both rosters stay symmetric.
- **Headless sync** is background-driven: started on unlock / SW-startup, the offscreen
  runs `roster-sync` continuously; the merge runs in the background via `vault-io`
  (`SYNC_LOCAL_PAYLOAD` / `SYNC_APPLY_REMOTE`). Re-broadcast is periodic (~4s) +
  on-connect; an instant on-change nudge is a follow-up.
- **Fully headless writes:** the vault lives in `chrome.storage.local` (see
  [storage.md](storage.md)), which the background reads and writes with no gesture and no
  permission, so headless merge just writes through. The `canReadFromBackground` /
  `canWriteFromBackground` flags this used to describe are gone along with the FSA write-queue;
  nothing gates a background write today.
- **Deferred:** VEK-never-in-JS hardening (the VEK is currently a transient JS string
  during enrollment + session caching, no worse than the existing session cache);
  instant on-change nudge; VEK rotation; async (offline store-and-forward mailbox);
  device rename; mid-session revoke cutoff (see above).

Testing rig: [p2p-sync-testing.md](p2p-sync-testing.md).

## Sources

- `chrome.offscreen` reasons (incl. `WEB_RTC`): https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Offscreen documents in MV3: https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3
- WebRTC signaling over Nostr (NIP discussion): https://github.com/nostr-protocol/nips/issues/771
- Nostr ephemeral events (kind 20000..29999), NIP-01: https://github.com/nostr-protocol/nips/blob/master/01.md
- Working WebRTC-over-Nostr implementation: https://codeberg.org/cipres/nostr_webrtc
- RTCPeerConnection (document-context API): https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection
- WebRTC API: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API
