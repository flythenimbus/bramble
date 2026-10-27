# Mailbox: store-and-forward sync (planned)

Status: design, not built. Branch `feat/mailbox-service`.

Sync today needs two devices online and unlocked at the same moment (see
[p2p-sync.md](p2p-sync.md), "Deferred"). The mailbox removes that: a device drops its sealed
changes on a server, and every other device in the group collects them whenever it next runs.
The server is a waiting room, not a home. It holds ciphertext only until every device that needs
an item has confirmed it, then deletes it.

The same server runs two ways: self-hosted by anyone, or bought as a subscription from the
project's hosted instance.

## Why

The aim is the convenience of a cloud password manager (edit on the phone, the laptop has it in
the morning) without the two things that make those services a target: a long-lived vault on a
server, and an account that says who owns it.

Every device keeps the whole vault, so the mailbox is never the only copy of anything. The worst
a mailbox fault can do is make a change late, not lose it. That property is what lets the server
delete aggressively.

The trust bar is that it works as intended. A change that never arrives, a device that never
catches up, or bytes deleted before a device got them is the failure that loses users, so the
design spends most of its care there.

## Goals

- Async sync of everything P2P sync carries (entries, conflicts, tombstones, the roster, synced
  settings, the file manifest) **and the file bytes**, between devices that are never online
  together.
- Delete each item once every device that needs it has confirmed it. Hold nothing past the
  retention ceiling (default 365 days, configurable).
- End-to-end encrypted. The server sees ciphertext and the metadata listed in "What the server
  sees", never a key.
- No real identifiers. No email, username or name. The hosted service's only customer
  identifier is a random account number.
- Self-hostable, with only the code a self-hoster needs (no billing).
- A hosted subscription paid by card or crypto, walled so that neither the processor's records
  nor ours alone link a payment to a mailbox.

## Non-goals

- **Not a backup or a source of truth.** The server holds pending deliveries, nothing else.
  Backups stay in [cloud-storage-backups.md](cloud-storage-backups.md).
- **Not a replacement for P2P sync.** P2P keeps running; the mailbox is one more transport into
  the same merge.
- **Not enrollment.** Adding a device still runs the pairing flow. The VEK never touches the
  mailbox.
- **No push wake-ups.** Android has no FCM by design
  ([mobile-port.md](mobile-port.md)); devices collect when they run.
- **No mailed cash or reseller codes**, for now.
- **No unlinkable payment tokens in v1** (see "Later").

## Anti-goals

Any of these is a failure even if everything else works:

- A change acknowledged and deleted before every device that needed it has merged it.
- A user's data held hostage over payment. A lapsed, frozen or full account can always still
  collect what is waiting for it.
- Anything on our side that names a person: email, stored IP addresses, card details, or a
  processor's customer record joined to an account.
- KYC, or a bot check that profiles users (no Turnstile, no forced 3D Secure).
- A server whose honesty matters. As with the signalling relay, the design must make a
  malicious operator able to deny service and observe metadata, nothing more.

## Decisions so far

| Decision | Made by |
| --- | --- |
| Async mailbox; delete once every device has an item | owner |
| File bytes travel through the mailbox too (data integrity) | owner |
| Retention ceiling 365 days by default, configurable | owner |
| Self-hostable, split so self-hosters run only what they need | owner |
| Hosted on a Cloudflare Worker with D1 and Drizzle | owner |
| Mullvad-style random account number as the only customer identifier | owner |
| Cards through Stripe directly, not a merchant of record; tax handled with an accountant | owner |
| Crypto payments accepted: Bitcoin, Lightning, Monero | owner |
| BTCPay Server as the crypto processor | design call |
| No mailed cash or reseller codes for now | owner |
| Payment-to-account link kept 120 days | owner |
| ...stored as a keyed hash, not the charge id | design call |
| Refunds only inside a short window, and a refund removes the time | owner |
| ...the window is 14 days | design call |
| A dispute freezes the account to collect-only | owner |
| 3D Secure not forced (Stripe's default) | owner |
| Anonymous proof of work instead of Turnstile | owner |
| ...ALTCHA alone, no Anubis | owner |
| $2 per month, 1 GB of held data per account | owner |
| Sold in 6- and 12-month blocks only | owner |
| No free trial | owner |
| Purchases on the website only; no in-app purchase or purchase flow in the iOS app | owner |
| The billing Worker is public | owner |
| ...in this monorepo, not its own repo | design call |
| Server code lives in `services/mailbox` as `bramble-mailbox-server`, beside the relay in `services/nostr-relay` | owner |
| `services/mailbox` is AGPL-3.0-only; the rest stays GPL-3.0-only | owner |
| The operating company is a Canadian corporation | owner (fact) |

## How it fits

[p2p-sync.md](p2p-sync.md) already separates **transport** from **merge**: "everything below
the merge engine is swappable". The mailbox is a transport. It moves sealed envelopes; the
existing `applyRemotePayload` path merges them.

What makes a dumb store-and-forward server enough is a property of the merge that already
holds. `mergeEntriesPayload` (`core/sync/vault-merge.ts`) is commutative, associative and
idempotent, and a delete is an explicit tombstone, so **absence is not deletion**. Any subset of
versions and tombstones is a valid input. So:

- Delivering a message twice is harmless. Delivery can be at-least-once.
- Order does not matter.
- A replayed old message is a no-op.
- A partial update (a delta) is a valid input, **provided it is closed per entry** (see
  "Messages"). The merge is not purely per-version: whether a deleted entry survives as a delete
  conflict depends on its file records being in the same merge (`vault-merge.ts:164-175`), so a
  delta carrying a file record without its entry's versions can leave two devices disagreeing.

Two things a merge sets aside rather than taking, and the mailbox must not acknowledge past them:

- **Future-dated stamps.** `sanitizeRemoteEntriesPayload` drops anything stamped more than
  `HLC_MAX_DRIFT_MS` (5 minutes) ahead of the receiver's clock. P2P recovers because the whole
  envelope is resent every 10 minutes (`FULL_RESEND_MS` in `roster-sync.ts`); a mailbox message
  that was acknowledged and deleted would be gone for good.
- **Entries that don't decrypt under this vault's key.** `admit` refuses them, correctly: they
  were never this vault's data.

P2P keeps running alongside. A peer that is live on P2P may receive a change both ways, which
costs bytes and nothing else.

## The model

### Mailboxes and members

One mailbox per sync group, and a sync group is one vault (vault-scoped, per
[CONTEXT.md](../CONTEXT.md), "Vault scoping"). A user with three synced vaults has three
mailboxes, unlinkable to each other by identifier.

The server knows each device only by its roster Ed25519 `sigKey` (`core/sync/roster.ts`, "Item
A" in [p2p-sync-revocation-hardening.md](p2p-sync-revocation-hardening.md)). It holds no roster,
no labels and no device ids. A device is in one of two states:

- **Eligible.** Its `sigKey` is listed by an existing member, because it is an active roster
  device. Being eligible costs nothing: no message is addressed to it.
- **Active.** It has switched the mailbox on and activated itself with a request signed by its
  own `sigKey`. Only active members are recipients.

Two tiers, because every shipped build already carries a `sigKey` (builds since 2026-08-22
back-fill one, `ensureOwnEntrySigned` in `hooks/useSyncEnrollment.ts`). If the group registered
every roster device as a recipient, a device on an older build, or with the mailbox switched off,
would never acknowledge, and everything addressed to it would sit against the quota for a year.

**Activation is a catch-up.** A newly active device missed whatever was posted before it
activated, and enrollment gave it only the inviter's state at that moment. So activating sends a
snapshot request (see "Gaps and self-healing"), and it merges the snapshots that answer it.

### Messages

A message is a sealed envelope of the same shape roster-sync sends, `{entries, roster}`, where
`entries` is an `EntriesPayload` that may be partial. Two kinds:

- **Delta.** Whatever changed in the sender's local state since its last post, *whatever the
  source*: its own edits, and anything it merged from P2P peers. Reposting a change another
  device already posted costs bytes, never correctness, and it is what carries changes from a
  device that has no mailbox (an older build, or mailbox switched off on it) to the devices that
  do.
- **Snapshot.** The sender's whole state, used for compaction and catch-up (below).

**A delta is closed per entry.** For every entry id it touches, it carries everything the sender
holds for that id: the displayed version, its siblings, its tombstone, the file records attached
to it and their cascades. A change to a synced setting carries that setting's record. With that
closure, merging a sequence of deltas reaches the same state as merging the senders' whole
states, and a property test in the style of `vault-merge.property.test.ts` should pin exactly
that.

The server sets a message's **recipients** at post time: every active member except the sender
(or, for a targeted snapshot, the members it names). A member deactivated or removed later has its
pending deliveries dropped.

### Acknowledgement and deletion

A recipient acknowledges a message only once its merge is durably written to that device's
vault storage. Receiving is not enough. Two further rules:

- **Set aside means not acknowledged.** If the merge dropped anything as future-dated, the
  recipient does not acknowledge and retries on a later fetch. Time heals it: once the clocks
  pass the stamp, it merges.
- **Refused means quarantined.** Entries `admit` refuses, and whole messages that fail to verify
  or open, go to local quarantine (see "Gaps and self-healing") and are acknowledged, so they do
  not sit on the server.

A message is deleted when every recipient has acknowledged it, when it is replaced by a
snapshot, or when it reaches the retention ceiling. Acknowledging and the delete it triggers
are one atomic write on the server.

### Compaction

The server cannot read, so it cannot merge. Left alone, a device offline for a year would make
the others pile up a year of deltas for it.

So the sender compacts its own backlog. When its messages still pending for some recipient pass
a threshold (bytes or count), it posts a snapshot addressed only to those recipients, naming the
messages it **replaces**. The server stores the snapshot and drops the replaced messages in one
write.

Only a device's own messages can be replaced, never another's. A device's state only grows
under the join, so its snapshot provably contains everything it posted earlier; it cannot know
that about another device's messages it may not have merged yet.

The bound this gives: per mailbox, roughly one snapshot per sender plus recent deltas, plus
pending file blobs.

### Gaps and self-healing

Each message carries, inside its ciphertext, the sender's **sequence number** (a snapshot
carries the number it covers through). A recipient tracks the highest contiguous number it has
merged from each sender.

A gap means the server dropped, expired or corrupted something. The recipient then asks, with a
small sealed control message, for a snapshot from that sender, or from any member if the sender
is gone. This happens silently, per the project's rule that the app heals its own faults without
showing them.

A message that fails to verify or open is kept in local quarantine (never destroyed, as in
[sync-vault-pinning-and-quarantine.md](sync-vault-pinning-and-quarantine.md)), acknowledged so
it does not sit on the server, and treated as a gap.

### Retention

The server has a **ceiling** (default 365 days; an environment setting for self-hosters). A
vault-scoped setting can ask for less, stored per mailbox. When a message or blob reaches it, the
server deletes it and keeps a bodiless marker (sender, sequence range, expiry time) until the
recipient next checks in, so the returning device learns it missed something and takes the gap
path. It then catches up from a snapshot or over P2P.

Known limit, stated plainly: if a change's only copies are a pending mailbox message and a device
that is lost before any other device collects it, the change is gone once the ceiling passes. The
ceiling is the lever. To make a long absence visible before it matters, each device in the
devices list shows when it last checked the mailbox.

### Files

The blob store is already content-addressed by a hash over the ciphertext
([file-attachments.md](file-attachments.md), "Why the hash is over ciphertext"). The mailbox's
file side follows it:

- A blob is uploaded once per mailbox, keyed by its hash, and delivered to every other active
  member.
- **New attachments go up eagerly.** The device that attaches a file uploads the blob before
  posting the delta that names it, so recipients can fetch it as soon as they see the manifest.
- **Everything else goes up on demand.** A delta never waits for bytes (the merge does not,
  `vault-merge.ts:154-157`), so a member can pass on a file record whose bytes it lacks, for
  example one it learned over P2P from a device without the mailbox. Each active member lists the
  hashes its manifest names but its blob store lacks (a "want"), and any member holding a wanted
  hash uploads it. Switching the mailbox on therefore uploads nothing historical: storage holds
  only what some device is actually missing.
- A member that already holds that hash acknowledges without downloading. Content addressing
  makes that check free.
- Deletion and retention work as for messages.
- `MAX_ATTACHMENT_BYTES` is 90 MB, which fits one request under the Workers request-body limit
  (100 MB on Free and Pro plans; verify before relying on it), so v1 needs no multipart upload.

This is a deliberate new path for file bytes through project infrastructure. The 2026-10-12
decision in file-attachments.md admitted TURN and kept relay-forward out; the mailbox goes a step
further, at rest rather than in transit, justified by the integrity guarantee. Each file is
sealed under its own key, so the server learns sizes and timing, nothing more. The "bucket
mailbox" that doc proposes becomes this mailbox's blob store; a self-hoster can back it with S3.

A side effect: Firefox, which has no WebRTC in any extension context, gets files from the
mailbox, where today it only gets them from the desktop app.

## Keys and identity

**Nothing derives from the group key alone.** The group key rides the pairing code
(`PairingCodeSchema.groupKey` in `core/sync/enrollment.ts`), and a pairing code has leaked before
(GHSA-x4f5). Anything derived from it alone would be readable by whoever saw a code. Instead,
inside the crypto host:

```
mailboxId = HKDF-SHA256(ikm = VEK, salt = groupKey, info = "bramble/mailbox/v1/id")
sealKey   = HKDF-SHA256(ikm = VEK, salt = groupKey, info = "bramble/mailbox/v1/seal")
```

- **The VEK** keeps a pairing code's holder out.
- **The group key** makes the mailbox belong to one group, not one vault key. Restoring a backup
  keeps the VEK but resets sync identity (`resetSyncState` in `backup/restore.ts`), and leaving a
  group and pairing again does the same. Either way the new group has a new group key, so it gets
  a new mailbox. It is never locked out of an old one whose members are gone, and two groups
  sharing a VEK never collide.
- **No configuration is needed to find it.** Every member can compute the id without contacting
  anyone, so a device that has never been online with the one that switched the mailbox on can
  still find it.

The abandoned old mailbox empties itself: its messages expire at the ceiling, and a mailbox whose
members have not checked in for the ceiling is deleted.

The VEK stays in the crypto host ([vek-residency-hardening.md](vek-residency-hardening.md)); the
core exposes seal, open and id derivation through wasm and uniffi.

**Sealing.** AEAD over the envelope, with the mailbox id, message id, sender `sigKey` and kind as
associated data, then an Ed25519 signature by the sender over the result. A recipient checks the
sender is an active roster member (a revoked device's post is refused) before merging, and
`admit` still test-decrypts every incoming entry as it does for P2P.

**Requests.** Every mailbox request is signed by the device's `sigKey` over method, path, body
hash, timestamp and mailbox id. The server refuses timestamps outside a skew window. A post
carries a client-chosen message id, so a replayed post deduplicates.

**Eligibility mirrors the roster.** Whenever an active member sees the roster change, it
reconciles the server's eligible list: add active `sigKey`s that are missing, remove revoked
ones. Changing the list must be signed by an active member, so only the group admits anyone, and
a device can activate only a `sigKey` already eligible. The first device creates the mailbox and
lists every active roster device as eligible at once (their `sigKey`s are in the roster, so they
need not be online). A roster entry with no `sigKey` cannot be eligible until that device updates.

**What revocation does.** A revoked device is removed from the eligible list, which also
deactivates it, and it cannot make itself eligible again even though it still holds the VEK. That
matches P2P, where a revoked key cannot complete the roster handshake. The residual is also the
same: with no VEK rotation, a revoked device keeps what it already has, and if it ever obtained
mailbox ciphertext (say from a server breach) it could open it. VEK rotation closes both.

**Posts from a device revoked before they were collected** are not merged: a recipient merges
only senders active in its roster when it merges, so a revoked device, which still holds the VEK,
cannot inject or backdate anything. The posts are not destroyed either. They go to local
quarantine with everything else refused, which keeps a lost phone's last edits recoverable later
without trusting them now. Edits that any honest member merged before the revocation still
spread, because that member's own deltas carry them.

**One signing key per vault, per device.** If one key were a member of two mailboxes, the server
could link them. The extension already stores the signing key per vault (`getStoredSigningKey`
in `clients/extension/src/sync/sync-config.ts`); mobile and desktop store one per device
(`sync.signingKey` in `clients/mobile/src/sync/sync-manager.ts` and
`clients/desktop/src/sync/keys.ts`). Both sync one vault at a time today (`perVaultSync` in
`core/flags.ts`), but a user can still switch the mailbox on in two vaults. So on mobile and
desktop a shared key may activate in **one** mailbox; a second needs that vault's key made
per-vault first. Changing a device's `sigKey` has to get past the roster's id-to-key binding,
which is likely a fresh device id, as `rotateDeviceId` does for a re-add. The builder should
settle that migration before the second vault is allowed.

**No link to the relay by identifier.** The relay's room id derives from the group key alone and
the mailbox id needs the VEK as well, so the two services cannot be joined by any id. They can be
joined by IP address and timing, and on the hosted service both run on Cloudflare.

## Trust model

| A malicious server tries to | Result |
| --- | --- |
| Read entries or files | Sees ciphertext only. Cannot. |
| Alter or forge a message | AEAD and the sender's signature fail. Refused. |
| Replay an old message | The merge is idempotent. No effect. |
| Drop, withhold or delete early for one device | A sequence gap triggers a snapshot request; P2P is unaffected. Late, not lost. |
| Add its own member | Needs an existing member's signature. Cannot. |
| Name the user | Holds no identifier for a person; see "Accounts and payments". |
| Refuse service | Denial of service only. P2P still works. |

**What the server sees.** The mailbox id; how many members it has and their public keys; for each
message its size, time, sender key, and which members collected it and when; blob sizes. The
hosted service adds the account number's hash, its paid-through date and which mailboxes it pays
for.

**What it never stores.** Content, keys, filenames, device labels, or IP addresses. Cloudflare
sees addresses at the edge on the hosted service and that cannot be avoided; we do not log them,
and rate limits use a salted hash that rotates, as the ICE guard does
([turn-credentials.md](turn-credentials.md)).

## The server

### Modules

The server is one package, `services/mailbox` (`bramble-mailbox-server`), beside the relay in
`services/nostr-relay`. It has four parts, which the builder lays out inside it:

```
core      protocol, request auth, handlers over MailboxStore + BlobStore + Entitlement
          interfaces, the Drizzle schema (SQLite dialect); one test suite run against every
          adapter
worker    hosted: D1 + R2 + a cron trigger; Entitlement = accounts
node      self-host: Node + SQLite + disk or S3, Docker; Entitlement = none or a token
billing   hosted only: accounts, checkout, Stripe and BTCPay webhooks, the tax ledger
```

- The **Drizzle schema** in the SQLite dialect serves both D1 and the Node build's SQLite, so the
  storage seam is one interface with two thin adapters.
- **Billing is its own Worker**, with its own Wrangler config, even though it ships from the same
  package. It holds the Stripe and BTCPay secrets and the link key, and talks to the mailbox
  Worker over a service binding with one narrow call (add or remove paid time, freeze or
  unfreeze). The mailbox Worker never sees payment data. A self-hoster never deploys it, and the
  Node build must not bundle it.
- **Where it lives.** In this monorepo, as a pnpm workspace entry, deployed by its own workflow
  as the website is. One change can then move both ends of the wire (the client in
  `packages/core` and the server) in one commit, and the server can import the protocol types the
  client already defines. A separate repo would buy nothing unless the license or the
  contributors differed.
- **License.** The repo is GPL-3.0-only, which does not oblige anyone who runs a modified server
  to publish it, because serving over a network is not distribution. `services/mailbox` is
  AGPL-3.0-only, which does: whoever hosts a modified mailbox must offer its source to the people
  using it. That makes "the code that runs is the code you can read" a binding promise for the
  hosted service, which is the point of publishing it. GPLv3 and AGPLv3 each allow combining with
  the other (section 13 of both). The shared protocol stays in `packages/core` under GPL-3.0-only,
  so no client becomes AGPL. The package carries its own `LICENSE` (the AGPL text) and `license`
  field. (Not legal advice.)
- **Billing is public too** (owner). The privacy claims that matter most live there: the
  account number never reaching Stripe, the 14-day and 120-day purges, a ledger with no account.
  They are only checkable if the code is, which is the same reason the relay is public. Nothing
  in it is secret except its environment: keys, webhook secrets, and the rate-limit and fraud
  thresholds, which stay in configuration so publishing the code doesn't hand them to an
  attacker.
- **The signalling relay stays separate** (`services/nostr-relay`). A self-hoster can run the
  mailbox without it, or the reverse.

### Storage on the hosted service

- **D1 holds metadata only, R2 holds every body** (messages, snapshots, blobs). D1 caps a row at
  2 MB and a database at 10 GB on the paid plan, so bodies cannot live in rows.
- **One query at a time per database.** A D1 database is single-threaded, and a `batch()` counts
  as one query. One database is fine for this traffic; the scale lever is more databases (50,000
  per paid account) keyed by mailbox id.
- **Atomicity.** Acknowledge-and-delete and compaction's replace must each be one write. Confirm
  that `batch()` is atomic; if not, express each as a single conditional statement.
- **Expiry.** A cron trigger deletes expired rows, then their R2 objects, and a sweep removes any
  R2 object with no row.

Starting tables (the builder refines them):

```
mailboxes        id, account_id?, retention_days, created_at
members          mailbox_id, sig_key, status (eligible|active), added_at, last_checked_day
messages         id, mailbox_id, sender, kind, seq_from, seq_to, size, r2_key, created_at, expires_at
deliveries       message_id, member, acked_at
blobs            mailbox_id, hash, size, r2_key, created_at, expires_at
blob_deliveries  mailbox_id, hash, member, acked_at
blob_wants       mailbox_id, hash, member, created_at
expiry_markers   mailbox_id, member, sender, seq_from, seq_to, expired_at
accounts         id, number_hash, paid_through, frozen, quota_bytes
```

`last_checked_day` is coarse on purpose: the device list needs "checked in 40 days ago", not a
timestamp.

### API sketch

The builder settles exact shapes, status codes and versioning; this is the surface:

```
POST   /v1/mailboxes                         create; lists the first eligible members
POST   /v1/mailboxes/:id/members             add or remove eligible members (signed by an active one)
POST   /v1/mailboxes/:id/activation          activate or deactivate the caller (signed by its own key)
GET    /v1/mailboxes/:id/members             members with status and last-checked day
PUT    /v1/mailboxes/:id/wants               the blob hashes the caller is missing
POST   /v1/mailboxes/:id/messages            post a delta, snapshot (with `replaces`) or control
GET    /v1/mailboxes/:id/inbox               pending messages, blobs and expiry markers for caller
GET    /v1/mailboxes/:id/messages/:mid       one body
PUT    /v1/mailboxes/:id/blobs/:hash         upload a blob
GET    /v1/mailboxes/:id/blobs/:hash         download a blob
POST   /v1/mailboxes/:id/acks                acknowledge messages and blobs
PUT    /v1/mailboxes/:id/account             attach the mailbox to an account (hosted)

POST   /v1/accounts                          new account number (ALTCHA solution required)
GET    /v1/accounts/status                   paid-through, frozen, quota used
POST   /v1/checkout                          start a card or crypto purchase (ALTCHA required)
POST   /v1/refunds                           refund a card purchase inside the window
POST   /v1/webhooks/stripe, /v1/webhooks/btcpay
```

The account number travels in a request header, never a URL, so it cannot land in a log line.

### Limits and abuse

- **Quotas.** Hosted: per account, across its mailboxes. Self-host: per mailbox, from the
  environment. A post that would exceed it is refused with a clear error. Collection keeps
  working, the device keeps its data, and P2P is unaffected.
- **Rate limits** per mailbox and per account, and per salted address hash on the unauthenticated
  endpoints (new account, checkout).
- **ALTCHA** proof of work on new account and checkout: self-hosted, no cookies, no tracking, and
  verified in the Worker with spent challenges remembered in D1. Proof of work only raises a
  bot's cost, so it is paired with the rate limits, never relied on alone.
- **Observability.** The relay already exhausted the Workers Logs quota once. The mailbox Worker
  logs no request metadata; check what Workers Logs invocation logs capture by default and turn
  off anything that records addresses.

## Accounts and payments (hosted only)

Modelled on Mullvad, whose published policy is the reference point: the processor never receives
the account number, and the payment-side link is purged after a fixed window (20 days at
Mullvad).

### The account number

- **Creation.** Issued by the server, after an ALTCHA solution, as a random number of at least
  80 bits shown in digit groups. Stored only as a keyed hash.
- **Where it lives.** Shown once, then stored as a vault-scoped synced setting so every device in
  the group has it. Never in the pairing code.
- **No recovery.** It is a bearer secret. It grants paid storage, not data: whoever holds it can
  attach their own mailbox to the paid time but can never read a mailbox.
- **Several vaults, one account.** One account can pay for several mailboxes, and the quota is
  per account.

### Entitlement

An account is **active** while `paid_through` is in the future and it is not frozen. A mailbox
attached to an active account accepts posts and uploads. Creating a hosted mailbox takes an
account number, so an unattached mailbox can never be free storage. There is no free trial: a
new account is collect-only until its first payment lands.

**Price and quota.** $2 per month. Each account may hold 1 GB at once, across all its mailboxes:
pending messages, snapshots and blobs, each blob counted once per mailbox however many devices
still need it. Since everything is deleted on delivery, steady use sits far below that; the
quota is what bounds a long-absent device or a burst of large attachments.

Otherwise the mailbox is **collect-only**: fetching, acknowledging and deletion keep working;
new posts and uploads are refused. Retention runs as normal. Nothing waiting is ever withheld or
deleted early because of payment. The app warns before `paid_through` arrives.

### Cards: Stripe

- **Prepaid, one-time purchases** of 6 months ($12) or 12 months ($24), nothing shorter. No
  Stripe subscriptions and no auto-renew. Subscription-mode Checkout requires a Stripe Customer
  record; one-time payments do not. Mullvad dropped recurring card payments for the same reason.
- **Why no single month.** Stripe's card pricing is a percentage plus a fixed amount per charge
  (about 30 cents; confirm on Stripe's Canadian pricing page), which would have taken close to a
  fifth of a $2 purchase. At 6 and 12 months it is a few percent. A lost dispute's fee is still
  worth months of the plan.
- **Stripe never sees the account number.** Checkout gets a random reference
  (`client_reference_id`). When the webhook confirms payment, billing maps the reference to the
  account, adds the time and deletes the reference. It then keeps only:
  - an HMAC of the charge id, keyed by a Worker secret that is not in D1, mapped to the account,
    for **120 days**, so a dispute (whose webhook carries the charge id) finds its account;
  - the charge id itself, encrypted under a Worker secret, for the **14-day refund window**
    only, because issuing a refund needs it.

  The database alone cannot join to Stripe's records, and Stripe's records alone cannot reach an
  account.
- **Refunds.** Inside 14 days, on a request authenticated by the account number. A refund
  removes the time it bought. None after the window, said plainly at checkout. The EU's 14-day
  withdrawal right for digital services fits inside it (the accountant should confirm).
- **Disputes.** `charge.dispute.created` freezes the account to collect-only. A won dispute
  unfreezes it; a lost one removes the purchased time. A dispute arriving after the 120-day link
  is gone cannot be matched and is absorbed. Most disputes arrive within about 120 days, but some
  can come later, up to a card-scheme cap of around 540 days.
- **3D Secure** stays at Stripe's default, where it appears only when regulation or risk requires
  it. Forcing it would move fraud-type disputes to the buyer's bank, but it adds a step and hands
  the bank more device data, and the owner declined it.
- **Card testing.** ALTCHA and the rate limits on checkout creation, plus Stripe's own fraud
  screening.
- **Tax.** Stripe Tax computes VAT or GST from the buyer location Checkout collects. Our ledger
  keeps date, country, amount, currency and tax, and no account. Registering for the EU's
  Non-Union One Stop Shop must happen before the first EU sale; UK VAT, Canadian GST/HST/QST and
  US states are for the accountant.

### Crypto: BTCPay Server

- **Self-hosted BTCPay Server.** No KYC, no third party, Bitcoin on-chain and Lightning, and
  Monero through a plugin. Lightning matters because on-chain fees swamp a few-dollar payment.
- **It cannot run on Cloudflare.** It needs a VM, and Monero needs a full node (one source puts
  it at about 180 GB). The Monero plugin's current state is unconfirmed; check it before
  committing.
- **Same wall as cards.** The invoice carries a random reference, never the account number, and
  the webhook adds the time.
- **No crypto refunds** in v1 (design call). A refund would mean collecting a return address, a
  new data point.
- **Tax** for a payer whose country is unknown is an open question for the accountant.

### Buying from the apps

Purchases happen **only on the website** (`website/`, a checkout page that posts to the billing
Worker and hands off to Stripe or BTCPay). No app sells anything in-app.

- **iOS** shows no price, no purchase button and no link to the checkout, in any storefront, and
  it does not create account numbers. It can enter an existing one, and it shows the account
  number, paid-through date and quota used. An expiry notice states the date and nothing more: no
  "renew", no pointer to the website.

  The App Review Guidelines, read 2026-10-27, cut both ways:

  - **3.1.3(f) Free Stand-alone Apps** is the basis: "Free apps acting as a stand-alone companion
    to a paid web-based tool for VoIP, Cloud Storage, Email Services, or Web Hosting do not need to
    use in-app purchase, provided there is no purchasing inside the app, or calls to action for
    purchase outside of the app." The rules above are exactly those two conditions.
  - **3.1.3(b) Multiplatform Services** is the risk: an app may let users access "subscriptions,
    or features they have acquired in your app on other platforms or your web site ... provided
    those items are also available as in-app purchases within the app." A reviewer who reads the
    mailbox as a subscription Bramble sells, not as cloud storage the app is a client for, lands
    here.
  - **3.1.1** adds that apps "may not use their own mechanisms to unlock content or
    functionality, such as license keys". Entering an account number must therefore read as
    signing in to a storage account, not as a key that unlocks the app.

  The argument if review objects: the app is a client for a storage protocol any server can speak.
  It works the same with a self-hosted mailbox, as it already does with a user's own S3 or WebDAV
  for backups, and nothing in the app changes when an account is paid. Mullvad, whose model this
  follows, is listed as taking iOS in-app purchases (per a third-party summary, ToS;DR), but a VPN
  has no 3.1.3(f) category to stand in.
  Since 2025 the US storefront allows purchase links without an entitlement (3.1.1(a)); this
  design uses none anywhere.
- **Android** (APKs from GitHub), **the extensions** and **desktop** have no store rule in the
  way. "Add time" opens the website's checkout in the browser with the account number in the URL
  **fragment**, which browsers never send to a server, so it cannot land in a log. The page reads
  it and posts it in a request body.

## Clients

- **Where the code runs.** On the extension, mailbox HTTP runs in the background (fetch with
  `<all_urls>`, see `core/adapters/http.ts`), sealing and opening run in the crypto host
  (offscreen on Chrome, the event page on Firefox), and merging uses the existing background
  merge path. Mobile runs in-process through the native `HttpTransport`. Large file uploads and
  downloads must go native end to end, because the Android Capacitor bridge moves about
  0.5 MB/s. Desktop uses its `HttpTransport`.
- **When.** Post on local change (debounced) and on unlock. Fetch on unlock, on app open or
  resume, and periodically while running (extension alarms; mobile background refresh where the
  OS allows). There is no push.
- **Locked devices.** v1 runs the mailbox only while the vault's key is available to the sync
  host, as P2P does. Fetching while locked and merging on unlock is a later improvement.
- **Switching it on.** The group's mailbox choice (hosted, or a custom URL plus optional token),
  the account number and the retention setting are vault-scoped synced settings, so a device in
  contact with one that has them turns the mailbox on by itself. A device that has never been
  online with any of them is switched on by hand: one tap for the hosted mailbox, or the custom
  URL. It can compute the mailbox id unaided (see "Keys and identity"), activates, and then
  receives the account number and the rest through the mailbox itself.
- **Switching it off on one device** is a device-scoped override for that vault. The device
  deactivates, stays eligible, and nothing piles up for it.
- **Settings UI.** The choice above, the account number, retention (at most the server's
  ceiling), each device's last mailbox check-in in the devices list, and a status line with
  paid-through and quota used. New strings go through Lingui and `pnpm i18n:extract`.
- **Version skew.** An older device ignores the mailbox settings. It stays eligible and never
  activates, so nothing is addressed to it; it keeps syncing over P2P, and its changes reach the
  mailbox through any active device that merges them, because a delta carries everything new in
  the sender's state. Nothing in the pairing code or the enrollment bundle changes.

## Self-hosting

The Node build in Docker, configured like the relay ([../services/nostr-relay/README.md](../services/nostr-relay/README.md)):

- `PORT`
- `MAILBOX_TOKEN`: optional; when set, every request must carry it. This is the private mode, as
  `RELAY_TOKEN` is for the relay.
- `RETENTION_MAX_DAYS`: default 365.
- `QUOTA_BYTES`: per mailbox.
- `STORAGE=disk|s3`, plus S3 settings for the S3 backend.
- `TRUST_PROXY`, as on the relay.

It contains no billing code, no account numbers and no ALTCHA (the token or a private network is
the gate).

## Phasing (design call)

1. **Protocol and client.** Seal, open and id derivation in `core-rust` (wasm and uniffi), the
   mailbox transport behind a flag, and the Node server. A property test that merging closed
   deltas equals merging whole states. End-to-end tests: two profiles that are never online
   together converge on entries and files; a late activation catches up; a future-dated message is
   retried, not lost; gaps, compaction, expiry, revocation (with quarantine), quota and
   collect-only behave as described.
2. **Self-host release.** Docker image and docs.
3. **Hosted.** `cf-worker`, `billing-worker`, Stripe, the privacy page. VAT registration done
   before launch.
4. **Crypto** through BTCPay.

Later: unlinkable payment tokens (blind signatures, RFC 9474, with the Privacy Pass architecture,
RFC 9576 to 9578) dropped in behind the entitlement interface, which would cut even the
account-to-mailbox link; skipping mailbox copies for peers that are live on P2P; per-device
selective file sync on mobile.

## Open questions

For the accountant:

- Which EU member state to register in for Non-Union OSS, and whether an EU intermediary is
  needed.
- VAT and GST on crypto payments from buyers whose country is unknown.
- Whether tax record-keeping rules conflict with the 14-day and 120-day purges (the ledger keeps
  no account, which should be the answer).
- Canadian GST/HST/QST, UK VAT and US state sales tax.

## Left to the builder

- Envelope encoding, the delta computation (diffing against the last-posted index), and the
  compaction thresholds.
- The exact API, error codes, schema details and migrations.
- Polling cadence per platform, debounce intervals, and the skew window for signed requests.
- ALTCHA difficulty and the rate-limit numbers.
- The account number's encoding (at least 80 bits).
- The settings and devices-list UI, within the copy rules above.
- Test strategy beyond the scenarios named in "Phasing".

## Sources

- Mullvad's no-logging policy (what is kept for a card payment, the 20-day purge, tokens to
  processors): https://mullvad.net/en/help/no-logging-data-policy
- Stripe Checkout Sessions (`customer_creation`, subscription mode requires a Customer):
  https://docs.stripe.com/api/checkout
- Stripe dispute timing: https://docs.stripe.com/disputes/how-disputes-work and
  https://stripe.com/resources/more/chargeback-time-limits-in-the-uk
- 3D Secure liability shift:
  https://support.stripe.com/questions/liability-shift-with-frictionless-flow-for-3d-secure-v2-3ds2
- Stripe tax registration types (including `oss_non_union`): https://docs.stripe.com/tax/registering
- EU One Stop Shop: https://europa.eu/youreurope/business/taxation/vat/one-stop-shop/indexamp_hr.htm
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- BTCPay Server: https://docs.btcpayserver.org/Guide/
- ALTCHA: https://altcha.org
- App Review Guidelines, 3.1.1, 3.1.1(a), 3.1.3(b) and 3.1.3(f), read 2026-10-27:
  https://developer.apple.com/app-store/review/guidelines/
- Apple external purchase links (secondary source):
  https://www.revenuecat.com/blog/growth/apple-anti-steering-ruling-monetization-strategy
