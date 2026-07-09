# P2P sync: revocation hardening (design note)

Status: **proposed**, not implemented. This note scopes the two remaining hardening items from
the security review so they can be built deliberately, with a multi-device test pass, rather than
shipped as an untested protocol change to live users. It assumes the reader knows
[p2p-sync.md](p2p-sync.md).

Platform/threat facts are dated **mid-2026**; re-verify before acting on them later.

## What is already done (context)

The security review already closed the open revocation holes:

- **Future-stamp ingest guard** (`isFutureStamp`, `mergeRemoteRoster`, `sanitizeRemoteEntriesPayload`):
  a remote roster/entries payload has its future-dated (poisoned) HLC stamps dropped before merge,
  so a member can no longer stamp its own entry years ahead to become permanently un-revocable.
- **Live-session enforcement** (`currentRoster`, `reapRevoked`, inbound refuse): the roster-auth
  gate reads the roster fresh, revoked peers are dropped from a running session (outbound and
  inbound), and a gossiped revocation reaps across the mesh at once rather than at the next tick.

Both fixes live in `packages/core/src/sync/{roster,merge,entries-payload}.ts` and
`transport/roster-sync.ts`. What remains is **incremental hardening on top of already-closed
holes**, and both items change the released, synced format, so they need version-tolerant wire
changes and a rollout plan.

The current trust model (unchanged by these items): every enrolled device shares the group key and
the VEK and is fully trusted. These items narrow what a *compromised member* can do and what a
*revoked* device retains.

---

## Item A: sign roster mutations

### Threat

The roster is an unauthenticated CRDT. Channel auth proves the *gossiping* peer is a member, but
the roster it gossips is merged verbatim. So a compromised member `M` can gossip a roster entry
that **impersonates another device**: `{ id: "laptop", publicKey: <M-controlled key>, hlc: newer }`
replaces the honest laptop's entry with `M`'s key, hijacking that identity/slot. `M` can also mint
entirely new member entries (rogue devices) without going through PSK enrollment.

The future-stamp guard already stops the *permanent-revocation* variant. Signing closes the
*impersonation* and *rogue-injection* variants.

### Design

Bind each roster entry to the key that controls its `id`:

- **Device signing key.** Each device needs a *signature* key. The existing Noise static key is
  X25519 (DH, not signatures). Two options:
  1. **Add an Ed25519 device keypair** at enrollment. Simplest; `ed25519-dalek` is already a
     transitive dep candidate. The roster entry carries the Ed25519 verify key in a new field.
  2. **XEdDSA** over the existing X25519 static key (à la libsignal), so no new key. Avoids a
     second key but requires implementing/auditing XEdDSA in `core-rust`.

  Recommend option 1 (explicit Ed25519 key) for clarity and reviewability; the extra key is
  generated alongside the Noise static key at enrollment and stored the same way (local only).

- **What is signed.** `sig = Ed25519(entry_sig_key, canonical(id, publicKey, sigKey, addedAt, hlc))`,
  where `canonical(...)` is a stable serialization (reuse the NIP-01-style approach from
  `nostr.ts serializeForId`, or a fixed field order). The signature covers the id↔key binding and
  the stamp, so neither can be forged or backdated for another id.

- **Verify on merge.** `sanitizeRemoteRoster` (or a new `verifyRemoteRoster`) rejects any device
  entry whose signature does not verify against its own `sigKey`. A member can then only create or
  update entries for ids it controls.

- **Revocations.** A tombstone is signed by the revoker (any member — revocation stays a
  member-level authority, matching today's model). Signing a tombstone mainly gives provenance; it
  does not prevent a compromised member from revoking honest devices (that is inherent to
  "any member is trusted" and is a DoS, out of scope). Keep tombstone verification lenient:
  accept a tombstone signed by *any* current member key.

- **New ids require enrollment, not gossip.** To stop a compromised member seeding rogue devices,
  gate *new* ids: a device id not previously seen is admitted only when it arrives through the
  `enroll-host` PSK path (which already binds the joiner's key to the handshake), not through plain
  gossip. Practically: `mergeRemoteRoster` may update/tombstone known ids but only `addDevice`
  (local, post-enrollment) introduces a new id. This is the higher-value half of Item A and can
  ship even before full entry signing.

### Wire format & version negotiation

- `RosterEntrySchema` gains **optional** `sigKey` and `sig` (base64). Optional so an old device's
  unsigned entries still parse during rollout.
- Enforcement is staged: **phase 1** verify-if-present (a present-but-invalid signature is
  rejected; absent is accepted); **phase 2**, once all devices emit signatures, require them.
- A `rosterVersion`/capability bit in the `hello` (see mesh discovery) lets peers know whether the
  other side signs, so phase 2 flips only when the whole group is capable.

### Offline / mixed-version

- Unsigned legacy entries remain valid through phase 1, so an offline device that predates the
  change is not evicted. Re-signing happens the next time each device re-emits its own entry.
- Never reject a *whole* roster because one entry fails; drop only the offending entry (mirrors the
  future-stamp guard), so one bad gossip can't wedge sync.

### Testing

- Pure unit tests (like the future-stamp tests): forged entry for another id rejected; backdated
  re-sign rejected; valid self-signed entry accepted; unsigned entry accepted in phase 1, rejected
  in phase 2; new-id-via-gossip rejected while update-known-id accepted.
- Multi-device: enroll 3 devices, compromise-simulate one gossiping a forged entry, confirm the
  others reject it and the honest identities survive.

---

## Item B: rotate the group key on revocation

### Threat

A revoked device is denied at the Noise/roster layer (cannot sync the vault) but **still knows the
group key**, so it can still derive every epoch's signaling room and read signaling metadata
(who is online, activity timing, device count) and, in principle, attempt to rejoin discovery.
Rotating the group key on revocation fully evicts it: new room, new signaling key, no rejoin.

### Design

- **Rekey.** On revocation, the revoking device generates `groupKey'` and bumps a `keyEpoch`
  integer stored with the group config (`sync.group`). The signaling room and signal-encryption
  subkey are already HKDF-derived from the group key (`nostr.ts`), so they change automatically.
- **Distribution.** Send `{keyEpoch, groupKey'}` to each *surviving* member over its authenticated
  Noise KK channel (the same transport that carries entries). Reuse `roster-sync` broadcast: add a
  `rekey` envelope kind alongside `entries`/`roster`. A member adopts `groupKey'` only from a peer
  it has KK-authenticated (so the revoked device, which fails KK, can never deliver a rekey).
- **Room during rotation.** The revoking device must reach survivors to hand them the key, but if it
  switches to the new room immediately, survivors still on the old room won't meet it. So: after
  rotating, **subscribe to both the old and new rooms** for a grace window (reuse the existing
  epoch-rooms current+previous mechanism, generalized to key-epochs), publishing rekeys on the old
  room until each survivor acks on the new one.

### The hard part: offline devices

A device offline during rotation never receives `groupKey'`. When it wakes it will:
- derive the **old** room from its stored (now-stale) group key, and
- find no peers there (survivors moved on), so it is **stranded**.

Options (pick one; this is the crux of Item B):

1. **Key history + grace re-admit.** Survivors keep the previous group key for a grace period
   (e.g. 30 days) and keep listening on its room. A stranded device announces on the old room; a
   survivor recognizes it (still in the roster), completes KK, and hands it `groupKey'`. Simple and
   robust *if* the stranded device wakes within the grace window and was not itself revoked. Risk: a
   *revoked* device also knows the old key and old room — so re-admission MUST re-check the roster
   (it will fail: the revoked id is tombstoned) before handing over the new key. This is the
   recommended option; it degrades to "reconnect within N days of a revocation".
2. **Out-of-band re-pair.** A stranded device re-enrolls via a fresh PSK pairing code (the
   `enroll-host` path), same as a new device. Always works, but is manual and user-visible.
3. **No rotation, accept the metadata residual.** Do nothing (today's behavior): a revoked device
   retains only signaling-metadata visibility, never vault content. Lowest effort; leaves the
   metadata leak documented in p2p-sync.md open.

Recommend **option 1 with option 2 as the manual fallback** past the grace window.

### Admin-authority variant (server-free, human-in-the-loop re-admit)

The *automatic* form of option 1 has a fail-open: a survivor may re-admit a device before the
revocation tombstone has reached it (the roster is eventually consistent), i.e. re-admit the very
device that was just revoked - worse than not rotating. Closing that window *automatically* requires
a strongly-consistent, always-available coordinator (a server / Cloudflare Durable Object holding
signed tombstones + `keyEpoch` + ack state, gossip as backstop, group key never leaving the
devices). That works, but reintroduces a semi-trusted availability dependency and a churn-metadata
surface, against this project's server-minimizing posture.

This variant keeps the design **server-free** by putting a human in the loop. Authority lives on a
user-designated **admin device**, and the human approval *is* the roster re-check that closes the
fail-open. Two mechanisms:

1. **Admin-signed revocations (authority).** Only an admin device's Ed25519 key (from Item A) may
   sign a revocation/rotation. Narrows today's "any member can revoke any member" DoS to "any admin".
   Signatures verify offline, so an admin need only be online to *author* a revocation, never to
   *serve* a registry.
2. **Admin-approved re-admit (offline fix).** A stranded (offline-then-woke) device is re-admitted
   only via an explicit approval on an admin device, which re-checks the roster at approval time
   before handing over `groupKey'`. That check - gated behind a human looking at a specific named
   device plus a channel-bound verification code - is what prevents re-admitting a revoked device.

Designation: the group creator is admin by default; **recommend >=2 admins** (a single admin cannot
revoke itself, and re-admit waits on an admin being reachable). Non-admin devices sync normally but
cannot remove or reconnect devices.

#### User flow

- **Normal removal (lost phone).** On an admin device: Settings -> Devices -> pick the device ->
  Remove, confirm with biometric / master password. The admin signs the revocation, rotates the key,
  and pushes `groupKey'` to online survivors over their authenticated channels; UI shows progress
  ("iPhone removed. Pixel updated. Work laptop is offline - it'll reconnect next time you open it").
  Online survivors update silently (optional security-log entry). The revoked device is denied *and*
  can no longer derive the new room.
- **Re-admit within the grace window (the security-critical tap).** The offline device wakes, lands
  in the now-empty old room, and a still-listening survivor answers with a *signed* "group moved to a
  newer epoch, ask an admin" notice (no key). The device shows "This device was offline when your
  group's key changed. Approve it from an admin device" + a verification code. An admin device shows
  a matching prompt ("Work laptop wants to reconnect. Code 4821 - matches? [Approve]"). On approve
  (biometric), the admin re-checks the roster, then delivers `groupKey'` over a fresh authenticated
  channel. **This approval is the roster re-check that closes the fail-open.** Feels like an
  approve-this-sign-in 2FA prompt.
- **Past the grace window.** No survivor is still listening on the old room, so it degrades to a full
  re-link: the device shows "Re-link this device", the user gets a pairing code/QR from an admin and
  re-enrolls it like a new device. Always works; more steps. (This is option 2.)

#### Edges

- **Admin offline when approval is needed:** the reconnecting device shows "Waiting for approval from
  an admin device"; with >=2 admins the user uses whichever is awake. This is the honest cost of
  server-free: authority lives on a device, so a reconnect waits on that device being reachable.
- **Admin device lost:** with >=2 admins, remove it from the other admin (normal removal). With a
  single admin that is gone, break-glass: re-found the group from a surviving device via the master
  password / recovery code and re-pair the rest. This is why the >=2-admins nudge exists and why
  dropping to one admin warns.
- **Remove attempted from a non-admin device:** the action is disabled with "Only an admin device can
  remove or reconnect devices. Your admins: ...".

#### Caveats (honest)

- It does **not** close the timing window for an automatic path - there is no automatic path. The
  window is closed by requiring a human approval that re-checks the roster.
- Availability cost: a reconnect waits on an admin device being reachable (mitigated by >=2 admins).
- Unlike the server/DO option, no third party learns group churn.
- Testing: the roster-recheck-on-approval logic is unit-testable; the multi-device grace/beacon
  behavior still needs the Chrome-profile matrix.

**Status: leading server-free candidate, not yet committed.** The fork is: accept a human in the
loop (this variant) vs. a strongly-consistent coordinator for fully-automatic re-admit (server/DO).

### Wire format & version negotiation

- `sync.group` gains `keyEpoch` and a short `keyHistory` (recent `{epoch, groupKey}` for the grace
  window). Additive.
- `hello`/discovery advertises the sender's `keyEpoch` so a peer on an older epoch knows to expect
  (or request) a rekey.
- A device tries the current key first, then recent history keys, when decrypting signaling — so it
  can still meet peers straddling a rotation boundary.

### Rollout

- Ship the *ability to adopt* a rekey before ever *triggering* one, so older devices can receive a
  key change before any device initiates rotation. Only after adoption is broadly deployed does
  revocation start triggering rotation.

### Testing

- Multi-device is mandatory here (unit tests cannot cover rekey-with-offline-peers):
  - Revoke device C with device D **online**: D adopts `groupKey'`, C cannot derive the new room.
  - Revoke device C with device D **offline**: bring D back within the grace window → D is
    re-admitted and gets `groupKey'`; C stays out.
  - Bring D back **past** the grace window → D requires re-pair (option 2).
  - Two near-simultaneous rotations converge to one `keyEpoch` (use the same HLC/`keyEpoch` max
    rule as roster merge to pick a winner deterministically).

---

## Sequencing recommendation

1. **A (new-id gate)** — small, high value, low risk: only `addDevice`/enrollment introduces a new
   roster id; gossip may only update/tombstone known ids. Ships without any signing.
2. **A (entry signing)** — add the Ed25519 device key + optional `sigKey`/`sig`, verify-if-present,
   then require. Version-negotiated.
3. **B (group-key rotation)** — the largest change; needs the key-history/grace design and a full
   multi-device test matrix. Do last, behind adopt-before-trigger rollout.

Do not start B before A is landed and the group is broadly on a signing-capable build, because B's
re-admission relies on the roster check being trustworthy.
