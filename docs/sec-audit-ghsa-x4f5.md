# Security recheck + fixing plan (GHSA-x4f5-4wq4-c6c8)

> Disposable working note. Branch: `security/ghsa-x4f5-pairing-code`. Private advisory filed
> 2026-07-07 by **amanverasia** (critical): the P2P sync pairing code grants the whole vault to
> anyone who observes it while an invite is live, and it is documented as safe to share. Every
> claim re-verified directly against the tree (file:line evidence below).
>
> **Verdict: all 11 findings confirmed.** Three are worse than reported, and there is one finding
> the report does not have. The Chromium extension is publicly released, so this is live for real
> users.
>
> Engineering note only. The advisory text and the reply to the reporter are drafted and published
> on the GHSA itself, not here.

## Affected versions and severity

| Target | Affected | Fixed in |
|---|---|---|
| Chromium extension | 1.1.0 through 1.10.1 | 1.11.0 |
| Firefox extension | 1.0.1 through 1.7.1 | 1.8.0 |
| Android | 0.0.1 through 0.9.7 (all releases) | 0.9.8 |
| iOS | 1.1.0 through 1.4.2 | 1.4.3 |

Each target versions independently, but the four ship together: the fix is a mutual change, so a
device left on an older version cannot pair with an updated one.

Vaults that have never used P2P sync are unaffected: the vulnerable path is reachable only while
an invite is open.

Critical. `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:N` (9.3). CWE-287 (Improper Authentication),
CWE-522 (Insufficiently Protected Credentials), CWE-613 (Insufficient Session Expiration),
CWE-322 (Key Exchange Without Entity Authentication, the most precise fit: the inviter completes
a key exchange without establishing who the other party is).

Two judgement calls behind that vector, recorded because they are the ones an outside reviewer
would press on. `S:C` is what makes it Critical rather than High (`S:U` scores 8.1); it is
justified on the grounds that the credentials in the vault authenticate to services under other
security authorities, and the counter-argument is that CVSS says not to score collateral damage.
`A:N` is correct for the primary vulnerability even though issue 4 below is a denial of service,
because scoring them as one vector would conflate two separate issues.

**The fix is a breaking change for pairing:** an updated device can no longer pair with an
un-updated one. See "Version skew".

## Recheck verdicts

The report's paths are wrong for three files: `enroll-host.ts`, `secure-channel.ts` and `mesh.ts`
live in `packages/core/src/sync/transport/`, not `packages/core/src/sync/`. Every line number is
right. There is no `enroll-join.ts`; both roles live in `enroll-host.ts`
(`EnrollRole = "inviter" | "joiner"`, line 80).

| # | Finding | Verdict | Evidence confirmed |
|---|---------|---------|--------------------|
| **1** | The code is a bearer secret equivalent to the vault | **CONFIRMED (CRITICAL)** | The PSK is the sole authenticator of the joiner: `handshake_enroll_responder(priv, psk)` (enroll-host.ts:185) is the inviter's only check on who it is talking to. Nothing else gates `sendBundle`. |
| **2** | The bundle is the whole vault | **CONFIRMED, WORSE** | `sendBundle` ships `vek` + `roster` + `entries` (enroll-host.ts:214-220) **and `recoverySlots`** (:219), defined at enrollment.ts:63-76 as slots wrapping the same VEK. See "worse #1". |
| **3** | The code is documented as carrying no vault secrets | **CONFIRMED** | enrollment.ts:1-5 ("So a leaked code is not a leaked vault"), :19; useSyncEnrollment.ts:167-168; docs/p2p-sync-testing.md:43-44; website/src/pages/support.astro:89-92. |
| **4** | No MITM protection on the inviter side | **CONFIRMED** | The joiner pins the inviter (enroll-host.ts:188). The reverse does not exist: the inviter accepts whoever completes XXpsk3. |
| **5** | The joiner's roster entry is checked only after the bundle is sent | **CONFIRMED** | `entry.publicKey !== sess.remoteStatic` at enroll-host.ts:233, i.e. after `sendSecure(...bundle)` at :221. The vault has already left the device. |
| **6** | The invite stays open indefinitely | **CONFIRMED, WORSE** | No expiry anywhere: `PairingCodeSchema` (enrollment.ts:20-32) has no time field, and `startEnroll` (enroll-host.ts:129-143) arms no timer. See "worse #2". |
| **7** | No rate limit / no single-use | **CONFIRMED** | `onPeer` (enroll-host.ts:139) is called per peer with no counter; nothing marks the invite consumed. |
| **8** | Unbounded waits hold the session open | **CONFIRMED** | `recvSecure(() => channel.recv(), ...)` at enroll-host.ts:223 and :248 with no timeout. Contrast roster-sync.ts:290,298, which does bound its handshake. |
| **9** | A retained code still works after the invite window | **CONFIRMED, WORSE** | See "worse #3": the enrollment room id never rotates, so a retained code gets an attacker into the room even when the handshake would fail. |
| **10** | `primaryPasswordCheck` is not a defence | **CONFIRMED, weaker than stated** | It is `.optional()` (enrollment.ts:60-62) and skipped entirely when `opts.webauthn` is set (enroll-host.ts:254). See "sharpening". |
| **11** | Version skew must be stated for any fix | **CONFIRMED (process)** | Addressed in "Version skew" below. |

### Worse than reported

1. **The bundle also ships the group's recovery slots.** `enroll-host.ts:219` includes
   `recoverySlots`, defined at `enrollment.ts:63-76` as slots that wrap the same VEK. A stolen
   bundle therefore hands over the vault *and* a recovery path that survives a password change.
   Impact is VEK + entries + roster + recovery slots.
2. **Finding 6 is stronger than "the invite stays open".** Because `stop()` at
   `enroll-host.ts:197` sits downstream of the unbounded ack await at `:223`, the "inviter serves
   one device then stops itself" comment at `:138` is not racy, it is **unenforced**. No code path
   limits an invite to one peer.
3. **The room is stable, not just the PSK fresh.** `ensureGroup` (useSyncEnrollment.ts:112-129)
   reuses one group key forever and enrollment does not pass `epochRooms`
   (enroll-host.ts:131-140), so the enrollment room id never rotates. "A code leaked after the
   invite closes is inert" holds for the handshake only, not for presence.

### Not in the report

4. **Any code holder can DoS every join, and the joiner leaks its key first.** The joiner's MITM
   abort (enroll-host.ts:188-193) calls `stop()`, tearing down the joiner's whole mesh session, so
   anyone in the room can kill every join attempt by presenting a wrong static key. Related: the
   joiner is the XX initiator, so it transmits its own static in m3 before it can check the pin,
   leaking the joining device's public key to an impostor.

### Sharpening

`primaryPasswordCheck` is weaker than the report says. It is `.optional()` and skipped when the
joiner uses a security key, so an attacker joining with a security key never faces it at all. This
does not change the conclusion (it is a joiner-side check on a bundle the inviter has already
sent), but it should not be cited as partial mitigation.

---

## Sequencing

The report proposes staging. It needs one adjustment, and one thing genuinely should land first.

**Stage 2 is not an alternative to stage 3, it is stage 3's foundation.** The approval gate needs
a bounded wait (otherwise an attacker never answers the prompt, which is finding 6 reborn) and it
needs the consumed flag to claim the invite *before* prompting (otherwise two peers race the
prompt). There is no version of the real fix that does not contain it.

**The in-app strings are written once, in stage C.** They must change either way, but what they
should say depends on whether the approval gate shipped: pre-gate they have to be alarming
("anyone who sees this can take your vault"), post-gate they become "keep it private, and check
both devices show the same number". Writing them twice churns 6 Lingui catalogs for nothing.

What should land first is the subset that needs no app release to reach anyone and does not depend
on the final behaviour: the docs, the source comments the advisory links to, and the website
(Cloudflare Pages, deploys immediately).

- **Stage A** (commit 1, deploy the website today): docs, source comments, website.
- **Stage B** (commit 2): expiry, single use, timeouts. The foundation.
- **Stage C** (commit 3): joiner-hello-first reorder, SAS, approval gate, all in-app copy.

B and C ship together in one release across extension, iOS and Android.

---

## Design decisions

### The SAS needs no Rust change

`snow::TransportState` does not expose the handshake hash, and `handshake.rs:136-137` drops it at
`into_transport_mode()`. Adding it would mean a Rust change plus a wasm rebuild plus uniffi
bindgen plus three hand-written mobile bridge layers.

Instead derive the SAS in TypeScript from what both sides already hold after the handshake: the
two Noise static public keys and the invite PSK. The inviter has its own key (inject
`devicePubB64`; background/sync.ts:107-129 already holds `kp.publicKey`, and mobile's
`deviceKeypair()` returns it) and the joiner's via `sess.remoteStatic`; the joiner has
`ownEntry.publicKey` and the inviter's via `sess.remoteStatic`. Sorting the two keys makes it
symmetric.

This is sound because XXpsk3's `es`/`se` DHs prove each party owns the private key for the static
it presented, so an interposer must present a *different* static, which changes the SAS.
`packages/core/src/sync/nostr.ts:50-58` already does SHA-256 and HKDF over `crypto.subtle` in
exactly these contexts (offscreen document, mobile webview), so there is direct precedent and no
Lockdown Mode exposure (that breaks WASM, not WebCrypto).

**12 decimal digits, three groups of four** (about 39.9 bits, Matrix's decimal SAS). Chosen over
emoji or a word list because digits render identically on iOS, Android and every browser, need no
64-entry emoji name table translated into 6 locales, and are trivial to compare.

### Why this closes it, precisely

The joiner already pins the inviter's static key from the code (enroll-host.ts:188), so an
attacker cannot be the *joiner's* peer; the unprotected direction is only the inviter accepting an
unknown joiner. Adding the inviter-side SAS makes it mutual:

- If the attacker races and wins, the inviter's prompt shows `SAS(inviter, attacker)` while the
  real device shows `SAS(inviter, joiner)`: mismatch, the user rejects, and with single use the
  attacker cannot try again.
- If the real device wins, the two match and the attacker is refused as a second peer.

Either way the theft becomes a **visible event** instead of a silent one. Note this also means the
grinding attack on a short SAS is unavailable: it needs the attacker to be both peers, which the
pin prevents. 40 bits is comfortable here rather than marginal.

### Harden the pin while we are in it

`enroll-host.ts:188` reads `role === "joiner" && opts.inviterPub && ...`, so a caller that omits
`inviterPub` silently disables MITM protection. `PairingCodeSchema` requires it and `joinGroup`
always passes it, so this is latent rather than live, but the joiner should **require** it and
throw.

### The joiner speaks first, and it sends exactly today's frame

After the handshake the joiner sends `JSON.stringify(ownEntry)`, byte-identical in shape to the
current ack. The inviter waits for it (bounded), validates `entry.publicKey === sess.remoteStatic`
**before sending anything**, claims the invite, shows the SAS plus the joiner's label for
approval, and only then sends the bundle. Sending the existing frame rather than a new envelope is
what makes the skew matrix work.

### Version skew

|  | old inviter | new inviter |
|---|---|---|
| **old joiner** | unchanged | inviter's bounded wait expires, aborts with "update Bramble on your other device to pair" |
| **new joiner** | joiner's entry queues (channel.ts queues inbound), old inviter sends the bundle then reads that entry as its ack: works unchanged | full gate |

The new joiner must send its entry **once, up front, and never again**, or an old inviter is left
with a stray frame.

**There is no downgrade path.** A new inviter that gets no hello aborts. It never falls back,
because an attacker would otherwise just stay silent to force the legacy path. Old joiners
hard-fail with an update prompt; this is deliberate and is called out in the advisory.

`exp` is purely additive. Verified against this repo's zod 4: `z.object` strips unknown keys, so an
old client parsing a code carrying `exp` silently ignores it. Keep `v: 1` and the
`bramble-pair-1.` prefix (a bump would make old joiners fail with a raw zod error instead of a
readable message). An old joiner ignoring `exp` is not a downgrade risk, because expiry is enforced
inviter-side by a local timer that tears the session down; the joiner's check only buys a better
error message. The inviter uses a **local timer** rather than comparing wall clocks, so device
clock skew cannot break it.

### Invite window and burn semantics

3 minutes, with a countdown in the modal and one-tap regenerate.

**A burned invite stays burned.** If approval is rejected, or the flow fails after the claim, the
invite is dead and the user regenerates. A rejection means the code demonstrably leaked, so
re-arming it would be wrong, and it turns the attack into a visible event: "That was not your
device. Someone else may have seen the code."

---

## Stage A: make the documentation true

The three source comments are literally true that no VEK is in the code; the conclusion does not
follow, because the PSK is the sole authenticator.

- `packages/core/src/sync/enrollment.ts:1-5` and `:19`
- `packages/core/src/hooks/useSyncEnrollment.ts:167-168`
- `docs/p2p-sync-testing.md:43-44` ("The pairing code carries only `{groupKey, inviterPub, psk,
  relay}` - no vault secrets.")
- `website/src/pages/support.astro:89-92` ("The code holds no vault secrets.") Deploys
  immediately, no store review, highest-leverage line in the change.

`docs/p2p-sync.md` has no pairing-code security section at all, and the trust-model table covers
only the relay attacker; `enrollment.ts:5` cites that doc for a claim it never makes. Add a
"Pairing code" section.

(`docs/multiple-vaults.md:368` also mentions the code, but its claim is about vault identity, not
secrets, and is accurate. Left alone.)

## Stage B: expiry, single use, bounded waits

- **enrollment.ts**: add `exp` (epoch ms, optional) to `PairingCodeSchema`; export
  `INVITE_TTL_MS = 3 * 60_000` and `pairingCodeExpired(code, nowMs, graceMs)` (60s grace for
  joiner-side clock skew).
- **transport/with-timeout.ts** (new): move `withTimeout` out of roster-sync.ts:58-64 verbatim and
  re-import it there. It is the exact helper this fix needs and there should not be two copies.
- **transport/enroll-host.ts**: refactor the inviter's per-peer path into an exported handler
  factory holding `consumed` and the deadline in its closure, matching the file's existing
  "exported for unit tests" idiom at :203-204. This is the seam the concurrency test drives;
  neither enroll-host nor roster-sync currently exposes the `join` override that
  `MeshSessionOptions` has, and a factory is cleaner than adding a test-only option to the
  production interface. Check-and-set `consumed` synchronously with no `await` between the two
  statements (atomic in JS). Bound the handshake and every `recvSecure` with `withTimeout`.
  `startEnroll` arms an invite deadline that stops the mesh session. Joiner rejects an expired code
  early with a readable message.
- **UI**: the pairing modal gets a countdown and an expired state with regenerate. Closing the
  modal (SyncConnectSection.tsx:447) currently only clears React state and leaves the host
  listening; make it stop the invite.

## Stage C: reorder, SAS, approval gate

- **sync/pairing-sas.ts** (new): `pairingSas(pskB64, pubA, pubB)`. HKDF-SHA256 over
  `crypto.subtle` in the shape of nostr.ts:57-58: `ikm = psk`, `salt = sorted(pubA, pubB)`
  concatenated, `info = "bramble/sync/sas/v1"`, 8 bytes out, as a BigInt mod 10^12, zero-padded to
  12 digits, formatted `NNNN NNNN NNNN`.
- **enroll-host.ts**: protocol reorder per above. The `entry.publicKey !== sess.remoteStatic` check
  moves from :233 (after the bundle) to before it, which is the fix for finding 5. `sendBundle` no
  longer awaits an ack. Add `devicePubB64` and an `approve(sas, label)` callback to
  `EnrollOptions`; add a joiner-side `onSas` callback.
- **Host plumbing**: `adapters/shell.ts` `SyncEvent` gains kind `"enroll-approval"` with `sas` and
  `label`, plus `approveEnrollment?(approved)` and `getPendingEnrollApproval?()` (lets a popup that
  was closed and reopened pick up an in-flight prompt). `platform-extension/src/sync/messages.ts`:
  `SYNC_ENROLL_APPROVE` schema, `SyncEventMsgSchema` gains `sas`/`label`.
  `background/sync.ts` routes it and injects `devicePubB64` in `withDeviceKey`.
  `offscreen-core.ts` holds the pending approval, resolves it on the message, broadcasts the event.
  `platform-mobile/src/sync/sync-manager.ts`: the same, in-process.
- **UI**: inviter approval modal (SAS in three groups, the joiner's label and key fingerprint via
  the existing helper at SyncConnectSection.tsx:32, Approve / Reject). The label is
  attacker-controlled and is labelled as context, not proof; the SAS is the check. Joiner
  (VaultSetup.tsx:86-101) shows the same SAS while connecting. All new strings via Lingui, then
  `pnpm i18n:extract`.

## What actually landed, where it differs from the plan above

All three stages are in. Four deviations, each deliberate:

1. **`shell.stopEnrollInvite` is new.** The plan had the pairing modal's close button call
   `stopSyncSpike`, which also tears down ongoing roster sync: an already-paired device adding a
   third one would have silently lost its live sync to close a dialog. Enrollment-only teardown is
   its own message (`SYNC_ENROLL_STOP`).
2. **No key fingerprint in the approval modal.** The plan reused the devices-list fingerprint
   helper next to the SAS. Dropped: the SAS already covers *both* static keys, and a fingerprint of
   a key the user has never seen gives them nothing to compare it against, so it reads as
   corroboration while carrying no information. The modal shows the SAS (the check) and the label
   (marked in the copy as the joiner's own claim).
3. **`joinSas` lives in `OptionsApp`, not `VaultState`.** Putting it beside `joining`/`joinError`
   meant `VaultProvider` subscribing to sync events at mount, which every consumer (and every test
   mock) then has to satisfy. The setup screen is the only consumer, so it holds it.
4. **Regenerating an expired invite re-prompts for the master password** rather than being one tap.
   The password is held only for the duration of the invite it authorized (see
   `useSyncEnrollment`), and keeping it across an expiry to save a prompt is the wrong trade.

Still to do when the release ships: `website/src/pages/support.astro` describes the code as
something to keep private (true today, pre-gate). Once the apps are out it should also describe the
confirm-the-number step, which is currently a step users don't have.

### Two regressions from the stage C commit, found in review and fixed

Neither is a security hole. Both would have presented as flaky pairing.

1. **Removing the ack removed the only flush barrier.** `sendBundle` ended at `await sendSecure`,
   with `stop()` in the handler's `finally` immediately behind it. `sendSecure` resolving means the
   frames were handed to the channel, not sent: on the relay path `channel.send` queues
   `void publish(...)` (mesh.ts:350-356), which awaits two WebCrypto ops before `client.publish`,
   while `mesh.stop()` (mesh.ts:190-195) calls `client.close()` synchronously in the same
   macrotask, so those frames never went out at all; on WebRTC, `peer.close()` is
   `channel?.close(); pc.close()` (webrtc-peer.ts:123-128) with no `bufferedAmount` drain anywhere
   in the transport, and `pc.close()` discards queued SCTP. About 30 entries fit in one 32 KiB
   frame, so every real vault is multi-frame, and losing the last frame alone fails the whole
   message. Both existing tests were blind to it: the e2e pairs a two-login vault over loopback
   (single frame), and the large-vault unit test uses in-memory channels, which model framing but
   not teardown. Fixed with a bounded, content-free receipt (`VAULT_ACK`). This is not a return to
   the old design: the invite is already claimed and identity already bound before the bundle
   moves, so the wait is purely a flush barrier, and it is bounded and upstream of `stop()`.
2. **The joiner timed out while the user compared the digits.** `ENROLL_TIMEOUT_MS` (30s) applied
   per frame, including the joiner's first bundle frame, and that wait spans the whole inviter-side
   approval. But `opts.approve` is capped only by the 3-minute invite timer, so the inviter allowed
   3 minutes and the joiner allowed 30 seconds: a careful user timed out their own join on the
   happy path, with the invite already burned. It works directly against the security goal, since a
   30-second budget rewards clicking through, which is what makes SAS comparison worthless. Fixed
   with `APPROVAL_WAIT_MS = INVITE_TTL_MS` for that one frame.

Both have unit regression tests, verified to fail against the pre-fix code and pass after.

Regression 1 also has an e2e now: `e2e/sync/large-vault-pair.spec.ts` imports a 400-entry
Bitwarden export (the cheapest real path to a multi-frame bundle, versus 400 trips through the
create-entry UI) and pairs it. Two things about it are load-bearing and easy to undo by accident:

- **It forces the relay data path** by deleting `RTCPeerConnection` on the joiner, since the mesh
  only uses a data channel when both sides advertise one. Over loopback WebRTC the SCTP queue
  drains as fast as `sendSecure` fills it, so the truncation does not reproduce at all; measured,
  not assumed (the WebRTC version of this spec passed with the flush barrier removed). The relay
  path is deterministic, and is also what users on hardened Firefox or a hard NAT actually get,
  which nothing else covered end to end.
- **It waits for the import's DONE screen**, not for the "Import N items" button to disappear. The
  button's accessible name flips to "Importing…" the moment the write starts, so waiting on its
  absence returns immediately, navigating away aborts the import, and the spec then pairs an empty
  vault and passes while proving nothing. It did exactly that before the inviter-side count
  assertion caught it.

Verified to fail against the pre-fix code (the join never completes: a dropped frame leaves
`recvSecure` waiting on a frame index that never arrives) and pass after.

Still worth doing on real hardware during device testing, since a phone over WiFi or TURN is a
different transport again from a local relay.

### Found in device testing (extension, Android, iOS, Vivaldi/Firefox)

Manual passes on real hardware, covering what the automated suites structurally cannot. Tests 1-5
pass. Everything here was fixed on the branch unless marked otherwise.

1. **Expiry was not authoritative.** Pairing Vivaldi to Firefox, the joiner gave up while the
   inviter carried on offering Approve/Reject for a session already torn down. The host stopped the
   mesh but told nobody, and the only thing withdrawing a live prompt was the popup's own
   countdown. That is the wrong authority: an extension popup closes on focus loss (switching
   browsers to paste the code does exactly that) and comes back without the local pairing-code
   state the countdown derives from. `startEnroll` now fires `onInviteExpired` before `stop()`;
   both hosts settle the parked approval as a refusal and broadcast `enroll-expired`. The
   Vivaldi-to-Android run had looked fine only because no joiner had connected, so there was no
   prompt to strand.
2. **An invite could die with no user-visible feedback.** An un-updated joiner consumed the invite
   and aborted, and the modal kept showing a QR that could never work again; the reason lived only
   in a status log whose render is commented out. Failures that *consume* the invite now replace
   the code with the reason and a regenerate button. Scoped deliberately: a peer that never
   completes the handshake leaves the invite live, and tearing down the QR for that would let
   anyone in the room kill a pairing the real device is still coming for.
3. **Approving left the code on screen.** Rejecting cleared it, approving did not, so the QR sat
   there during the transfer, reading as "still waiting" and inviting a second scan. The code is
   spent either way.
4. **The rejection confirmation modal was noise.** Removed: trying again means reopening "Add a
   device", which mints a fresh code, so there was never an opportunity to misuse the old one.
5. **Backgrounding mid-join hangs, and is deliberately not handled.** The OS suspends the webview
   and the relay socket dies; the invite is already claimed so reconnecting would be refused; and
   "Immediately" auto-lock has cleared the key. A fail-fast lifecycle listener was written and then
   reverted, because it aborted on *any* background transition, including brief ones the socket may
   have survived: trading a rare long hang for breaking short pairings is the wrong way round.
   What remains is preventive copy on both sides ("keep this screen/window open until pairing
   finishes"). An interrupted join falls back to the bounded wait and the ordinary failure message.

Two known rough edges, both judged not worth covering: a joiner that enters a room with nobody in
it waits out its full budget rather than giving up early, and the inviter fires `onEnrolled` before
the receipt arrives, so a transfer that fails afterwards leaves a device listed that never got the
vault.

## Not in scope

**VEK rotation** (already a documented deferral in docs/p2p-sync.md), which is what would make a
past leak recoverable rather than permanent. This is the known residual to disclose: a code stolen
before this fix already yielded a VEK that cannot be revoked today, so rotating the master password
does not help (it re-wraps the same key, and the bundle's recovery slots survive the change). The
only remedy is changing the credentials stored in the vault.
