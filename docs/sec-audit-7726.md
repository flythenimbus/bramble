# Security recheck + fixing plan (A1-A4, B1-B4)

> Disposable working note. Branch: `security/review-fixes`. All eight findings re-verified
> directly against the current tree (file:line evidence below). This scopes the fixes; no code
> changed yet.

## Recheck verdicts

| # | Finding | Verdict | Evidence confirmed |
|---|---------|---------|--------------------|
| **A1** | Revocation bypass via duplicate/rogue roster entry | **CONFIRMED (MEDIUM)** - broader than stated | `inRoster` keys on `publicKey` (roster-sync.ts:133-135); `revokeDevice` tombstones by `id` (roster.ts:94-96); `sanitizeRemoteRoster` only drops future stamps (roster.ts:68-76); merge keeps records/tombstones per-`id` (merge.ts). Roster authorship is unauthenticated. |
| **A2** | Epoch rooms don't unlink | **CONFIRMED (LOW)** | `epochRooms: true` (roster-sync.ts:117); signer created once per session (peer-session.ts:51); author pubkey cleartext per event (nostr.ts). Session spans many epochs under keep-unlocked. |
| **A3** | `CRYPTO_*` host sender-ungated | **CONFIRMED (def-in-depth)** | Offscreen listener gates only on `message.target === "offscreen"`, ignores `_sender` (offscreen.ts:56-60); `CRYPTO_EXPORT_VEK` in switch (offscreen-core.ts:120). No `externally_connectable`. **Chrome-only** - Firefox routes in-process (offscreen-client.ts:68), unreachable there. |
| **A4** | `commitCornerUpdate` missing origin check | **CONFIRMED (def-in-depth)** | Only checks `type !== "login"` (corner-prompt.ts:156-160); fill path checks `hostnameMatches` (autofill-index.ts:190-195). |
| **B1** | Task 2 future-stamp guard is partial | **CONFIRMED** | `sanitizeRemoteRoster` drops only stamps `> now + 5min` (hlc.ts:54-56); a re-add stamped ~now beats an older tombstone via LWW (merge.ts:99-106). Resurrection needs no enrollment proof. |
| **B2** | Task 5 sign-in regression risk | **CONFIRMED (NEEDS DEVICE TEST)** | Browser-hash path taken only when `trustedBrowserOrigin() != null` (CredentialFulfillActivity.kt:165,204); else-branch signs an apk-key-hash clientDataJSON the browser replaces → exact `NotAllowedError` from commit `770dac3a`. Allowlist is a hand-maintained subset (TrustedBrowsers.kt:24-40; comment L18 warns to verify on-device). |
| **B3** | DAL blind SSRF | **CONFIRMED (minor)** | `fetch` HTTPS-only (L144), `instanceFollowRedirects=false` (L151), 4s timeouts, 256KB cap, response not exfiltrated; host is `label.label` from caller's own package (candidateDomains L58-62). Very constrained. |
| **B4** | Wrong-clock entries dropped | **CONFIRMED (minor)** | `sanitizeRemoteRoster` **drops** future-stamped entries rather than clamping; a persistently-fast clock (>5min) means that device's updates never converge on correct peers. |

### Two sharpenings vs the original audit

1. **A1 has no complete cheap fix.** "Revoke by key" closes only the *same-key* PoC
   (`{spare, pk_M}`). A compromised member can equally mint a rogue device with a *fresh* key it
   controls (`{spare, pk_spare}`); revoking the id you know never catches it. The only complete
   close is preventing the rogue entry at merge - the deferred design-note **Item A
   (new-id-requires-enrollment + entry signing)**. **A1 is an instance of B1's root cause.**
2. **The A1 "cheap" fix touches the synced roster format** (merge.ts drops the tombstoned record's
   data from the stored payload, so the revoked key must be recorded separately). A throwaway
   format change now + the real one in Phase 2 = two migrations of a released synced format.

→ **A3 and A4 are the genuinely cheap, complete, format-free wins. A1 folds into Phase 2 with B1.**

---

## Phase 0 - Land now (unit-tested, no device, no format change)

### A3 - Sender-gate the offscreen crypto/sync host

**Root cause:** On Chrome the crypto/sync host runs in a separate offscreen document with its own
`runtime.onMessage` listener that trusts any message setting `target: "offscreen"` - content-script
controllable. Exposes `CRYPTO_EXPORT_VEK` (master VEK) and `CRYPTO_DECRYPT*` to any content-script
context. Not page-reachable today (no `externally_connectable`; no content script forwards
page-controlled `type`s), so it's a latent primitive: any future content-script relay bug → full
key compromise.

**Fix - four edits** (the audit first scoped three; implementation found a fourth CRYPTO_* path):

1. New `packages/platform-extension/src/sender.ts`:
   ```ts
   /// <reference types="chrome" />
   import { api } from "./platform-api";
   const EXTENSION_ORIGIN = new URL(api.runtime.getURL("")).origin;
   /** True only for senders on the extension origin (background SW / offscreen / popup /
    * options), never a content script (which carries the page origin + sender.tab). */
   export function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
     const src = sender.origin ?? sender.url ?? "";
     return src === EXTENSION_ORIGIN || src.startsWith(`${EXTENSION_ORIGIN}/`);
   }
   ```
   Delete the local copy (autofill-index.ts:172,184-187), import from `../sender`. Keep
   `senderHostname` local (different job - derives the page host).

2. Gate the offscreen listener (offscreen.ts:56-60) - **critical edit**:
   ```ts
   import { isExtensionSender } from "./sender";
   api.runtime.onMessage.addListener((message: OffscreenMessage, sender, sendResponse) => {
     if (message?.target !== "offscreen") return false;
     if (!isExtensionSender(sender)) return false;   // reject content-script callers
     void handleHostMessage(message.type ?? "", message.payload).then(sendResponse);
     return true;
   });
   ```

3. Gate the background bridge/enroll handlers a content script could hit on the router -
   `SYNC_LOCAL_PAYLOAD`, `SYNC_APPLY_REMOTE`, `SYNC_LOCAL_ROSTER`, `SYNC_APPLY_ROSTER`
   (sync.ts:201-210) and `SYNC_*` enroll (sync.ts:51-77). Add to router.ts:
   ```ts
   import { isExtensionSender } from "../sender";
   export function extensionOnly(handler: MessageHandler): MessageHandler {
     return (message, sender) =>
       isExtensionSender(sender) ? handler(message, sender)
                                 : Promise.resolve({ ok: false, error: "forbidden" });
   }
   ```
   Wrap: `on("SYNC_APPLY_ROSTER", extensionOnly(async (m) => {…}))`, etc. All legit `SYNC_*`
   senders are the popup/offscreen (extension origin) → nothing breaks.

4. **Gate the `CRYPTO_*` router prefix (missed in the original scoping).** `CRYPTO_*` is not
   only reachable via the offscreen listener (edit 2): `session.ts` registers
   `onPrefix("CRYPTO_", cryptoHandler)`, so a content script can send a plain
   `{type:"CRYPTO_EXPORT_VEK"}` (no `target`) to the **SW router**, which forwards it to the
   offscreen and returns the VEK - bypassing edit 2 entirely. Wrap the registration:
   `onPrefix("CRYPTO_", extensionOnly(cryptoHandler))`. Legit `CRYPTO_*` senders are the
   popup/options (extension origin); the background's own crypto calls use `sendToOffscreen`
   directly and never traverse the router, so nothing breaks.

**Compat/risk:** none persisted. Verify SW→offscreen sender carries `sender.url`/`origin` on the
extension origin via `test-harness.ts`; fallback `sender.id === api.runtime.id && !sender.tab` if
ever absent. Firefox unaffected (in-process).
**Tests:** listener rejects `{origin:"https://evil.com", tab:{…}}`, accepts extension origin;
`extensionOnly` returns `forbidden` for a content-script sender per wrapped type.
**Note:** `CRYPTO_EXPORT_VEK` stays (used by keep-unlocked/biometric, crypto.ts:104) but is now
reachable only from the extension origin.

**Graceful failure handling (regression safety).** The dangerous failure of this fix is not
rejecting an attacker; it is *wrongly rejecting a legitimate extension sender* and bricking
unlock/sync on a shipped extension. The origin-only predicate in the plan (and the existing copy at
autofill-index.ts:184-187) keys entirely on `sender.origin ?? sender.url` matching the extension
origin, which fails closed if that field is ever absent for a legit SW->offscreen or popup->SW
message (its population has varied across Chrome versions and message paths). Handle this by making
the predicate layered and fail-safe in both directions:

1. **The origin is the authoritative discriminator - NOT `sender.tab`.** A content script always
   carries the *page* origin; every extension surface (SW, popup, popout, options, offscreen)
   carries the *extension* origin, whether or not it is hosted in a tab. `sender.tab` must **not**
   be used to reject: a popout window and an options-in-a-tab are extension pages that legitimately
   carry `sender.tab`. (An earlier draft of this fix gated on `if (sender.tab) return false` and
   was caught in smoke testing wrongly returning `forbidden` when unlocking from a **popout** - a
   real regression. The origin check alone already rejects content scripts, since the browser sets
   `sender.origin` and a content script can never forge the extension origin.)
   ```ts
   // packages/platform-extension/src/sender.ts
   export function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
     const src = sender.origin ?? sender.url ?? "";
     if (src) return src === EXTENSION_ORIGIN || src.startsWith(`${EXTENSION_ORIGIN}/`);
     return sender.id === api.runtime.id && !sender.tab; // origin absent -> same-extension, tab-free
   }
   ```
   A legit extension sender whose origin/url is unexpectedly absent still passes via the
   same-extension id fallback instead of being locked out; the `!sender.tab` guards only that
   ambiguous fallback (a content script always has `sender.url`, so it never reaches it). All
   comparisons are string-only at call time (no per-call `new URL`), so the predicate can't throw.
2. **Reject with a diagnosable envelope, never a silent drop or hang.** In the offscreen listener,
   respond explicitly rather than returning `false`; a dropped message surfaces to the caller as the
   generic `"no response from offscreen"` in `deliver` (offscreen-client.ts:66), indistinguishable
   from "offscreen not mounted yet":
   ```ts
   if (!isExtensionSender(sender)) {
     console.warn("[offscreen] rejected non-extension sender",
       { origin: sender.origin, url: sender.url, tab: sender.tab?.id });
     sendResponse({ ok: false, error: "forbidden" });
     return false;
   }
   ```
   The `extensionOnly` router wrapper stays symmetric: return the standard
   `{ ok: false, error: "forbidden" }` envelope the dispatcher already knows how to send.
3. **Fail loud.** The `console.warn` above is the most important measure for a released product: if
   the predicate ever misclassifies a real path on some browser build, a tagged log line naming the
   sender turns a silent "vault won't unlock" into a diagnosable regression.
4. **Verify against reality before shipping.** Exercise every legit surface, not just the toolbar
   popup: SW->offscreen (`sendToOffscreen`), offscreen->SW (the `chromeBridge` round-trips
   `SYNC_LOCAL_PAYLOAD` etc.), popup->SW, and crucially the **popout window** and options page
   (extension origin + `sender.tab`) - the popout regression above was invisible to the popup-only
   path and to unit tests using a tab-free `extensionSender`. Tests assert both directions, including
   the popout case (extension origin + tab is accepted) and the origin-absent fallback. The
   content-script autofill path is untouched: those messages aren't `CRYPTO_*`/`SYNC_*` and keep
   going through `senderHostname`/`authorizeFill` hostname gating.

### A4 - Corner-update origin parity

**Root cause:** `commitCornerUpdate` overwrites the chosen login's credentials checking only that
it's a login (corner-prompt.ts:156-160), unlike `authorizeFill`'s `hostnameMatches`. Not
page-reachable (closed shadow root, unguessable promptId, top-frame messaging), but a capture on
site A could be written into site B's entry if the path were reached.

**Fix - one edit** (corner-prompt.ts):
```ts
import { type DedupeOutcome, hostnameMatches, registrableDomain } from "../dedupe";
…
async function commitCornerUpdate(capture: PendingCapture, chosenEntryId: string): Promise<void> {
  const indexEntry = getIndexEntry(chosenEntryId);
  if (indexEntry?.type !== "login") {
    throw new Error(`update target not in index: ${chosenEntryId}`);
  }
  // Parity with authorizeFill: only overwrite a login the captured hostname matches.
  if (!hostnameMatches(indexEntry, capture.hostname)) {
    throw new Error("update target is not offered on this origin");
  }
  …
}
```
`hostnameMatches` exported from `../dedupe` (dedupe.ts:16). Real update candidates come from
`dedupeCapture` (hostname-matching only), so legit flows unaffected.
**Tests:** extend corner-prompt-commit.test.ts - a `chosenEntryId` on a different hostname makes
`commitCornerUpdate` throw and write nothing; same-hostname still commits.

**Phase 0 verification:** `pnpm --filter platform-extension test` + manual smoke of save/update
corner-prompt and autofill in an unpacked build.

---

## Phase 1 - Blocking gate for the committed Task 5 (device testing)

### B2 - Verify browser passkey sign-in before shipping commit `a266dfa7`

**Root cause:** Fix correctly signs a caller-supplied `clientDataHash` only when
`CallingAppInfo.getOrigin(allowlist)` is non-null (CredentialFulfillActivity.kt:165,204). If a
legit browser is missing/wrong in the allowlist, or sets no request origin, the else-branch signs a
hash over its *own* apk-key-hash `clientDataJSON`; the browser substitutes its own → hashes
disagree at the RP → `NotAllowedError` (the exact failure `770dac3a` removed the allowlist to fix).
Allowlist is a hand-maintained 6-entry subset (TrustedBrowsers.kt:24-40; L18 warns to verify
on-device).

**This is a required verification, not a blind patch.**

1. **Device-test matrix (mandatory before merge/ship):** Chrome, Firefox, Edge
   (`com.microsoft.emmx`), Brave, DuckDuckGo, Opera Mini - stable channel, real device - run
   **register + authenticate** against a live RP (e.g. webauthn.io). Confirm assertion accepted
   (no `NotAllowedError`) and that the browser-hash path (not apk fallback) fired. Add one native
   app caller to confirm the apk-origin path still works. Record which packages return non-null
   `getOrigin`.
2. **Robustness edits (alongside):**
   - **Fail loud:** when `browserHash != null` but `trustedBrowserOrigin() == null`, `Log.w` a
     tagged line naming the pkg + fingerprint ("browser sign-in will fail if this is a real
     browser"). Turns silent field failure into a diagnosable one; surfaces missing fingerprints.
   - **Bundle the full GPM privileged-apps list** (`gstatic.com/gpm-passkeys-privileged-apps/apps.json`)
     as `res/raw`, build `allowlistJson()` from it instead of the hand-maintained subset - biggest
     reducer of "missing fingerprint" regressions. Keep cert-verified `isTrustedBrowser` for the
     autofill `webDomain` path; source both from the bundled file.
   - Optionally **decline** (`GetCredentialUnknownException`) when `browserHash != null` and caller
     unrecognized, rather than signing a guaranteed-mismatching apk-origin assertion. Decide after
     the matrix (declining a real-but-unlisted browser is also bad UX → the full list matters more).

**Do not ship the Task 5 commit to users until the matrix passes.**

---

## Phase 2 - Durable revocation fix (required, multi-device tested) - closes B1 **and** A1

**Reframe:** `docs/p2p-sync-revocation-hardening.md` is written as optional hardening; the recheck
shows it is **required to close Finding 4**. Today a compromised member survives revocation via B1
(re-gossip a re-add stamped ~now, beats the tombstone by LWW) and A1 (mint a rogue entry the admin
never revokes). Neither has a complete cheap fix. Implement in order:

1. **Item A part 1 - new-id gate (highest value, no signing yet).** In
   `mergeRemoteRoster`/`sanitizeRemoteRoster`, gossip may only **update/tombstone known ids**; a new
   `id` is admitted **only** via the `enroll-host` PSK path (local `addDevice`). Kills A1's
   rogue-injection incl. the fresh-key variant.
   - **Subtlety:** in a 3+ device group, a new device's entry reaches the *third* device only via
     gossip from the inviter. Naive "reject all gossiped new ids" breaks enrollment. The gate must
     distinguish "new id backed by enrollment proof" from "member-conjured" → must be co-designed
     with entry signing (part 2), not shipped alone. Bind enrollment: inviter signs the joiner's
     entry (or the entry chains to the PSK handshake) so a third device accepts a new id iff signed.
2. **Item A part 2 - sign roster entries.** Ed25519 device key at enrollment (explicit key >
   XEdDSA). `RosterEntrySchema` gains **optional** `sigKey` + `sig` (base64, additive). `sig =
   Ed25519(canonical(id, publicKey, sigKey, addedAt, hlc))` binds id↔key↔stamp (no forge/backdate
   for another id). Verify-if-present (phase 1), require once fleet-capable (phase 2, `rosterVersion`
   capability bit in `hello`). Drop only the offending entry, never the whole roster. **A1 and B1's
   re-add both close here:** a resurrection needs a valid signed enrollment a revoked device can't
   produce.
3. **Item B - rotate the group key on revocation.** Generate `groupKey'`, bump `keyEpoch` (in
   `sync.group`, additive), distribute over authenticated Noise KK to survivors, dual-subscribe
   old+new rooms during a grace window. Offline devices: key-history + grace re-admit (30d),
   re-check roster before handing over the new key (revoked id stays out), manual re-pair past the
   window. Adopt-before-trigger rollout.

**Compat:** all additive, version-negotiated wire changes. **Multi-device testing mandatory** (unit
tests can't cover rekey-with-offline-peers): design note matrix (3 devices; compromise-simulate one;
revoke with peer online/offline; past-grace re-pair; concurrent-rotation convergence).

**Optional interim before Phase 2** (only if the rollout window's exposure is unacceptable): add
additive grow-only `revokedKeys?: string[]` to `RosterPayloadSchema`; `revokeDevice` records the
revoked `publicKey`; `activeDevices`/`inRoster` exclude keys in that set. Closes the same-key PoC
and makes revocation key-scoped - but **not** the fresh-key rogue device, and it spends a migration
you redo in Item A. Recommend skipping straight to Item A unless the window is unacceptable.

---

## Phase 3 - Low-priority hardening

### A2 - Rotate Nostr signing key per epoch (or correct the claim)
Make the mesh signer mutable (`newSigner?: () => Promise<SignerPair>` in `MeshOptions`); in
`maybeRoll()` swap to a fresh `SignerPair` with a one-epoch grace on self-echo/`to` checks; pass
`newSigner: () => makeNostr(opts.wasm)` from peer-session.ts only for the `epochRooms` session; in
roster-sync `syncPeer` close an existing `AuthedPeer` for the same device key before replacing.
**Nuance:** even rotated, a *live* relay operator links epochs via the persistent socket, reused
subId, and IP (signaling-client.ts reuses the connection). So either accept the churn (hourly
re-handshakes - real mobile battery/traffic cost) for retained-log/authors-filter unlinkability,
**or** just correct the over-claim in mesh.ts:45-46 + docs/p2p-sync.md. Lean toward the doc
correction unless metadata-unlinkability is a stated goal.

### B3 - Constrain the DAL fetch
Already HTTPS-only, no redirects, bounded, own-identity-triggered, no exfil → minor. If hardening:
after DNS resolution reject private/loopback/link-local addresses; require a public **registrable**
domain (public-suffix list, reuse `registrableDomain`). Localized to
`DigitalAssetLinks.fetch`/`verifyAssociation`.

### B4 - Clock-skew UX instead of silent drop
Keep the drop (per-receiver clamp breaks CRDT convergence - real tradeoff, not an oversight). Fix
the *silent* part: on connect compare local clock to peers' observed stamps; if local is
>`HLC_MAX_DRIFT_MS` fast, warn the user their device clock is wrong (the true fix). Optionally widen
`HLC_MAX_DRIFT_MS` if field reports show false drops. Document the drop-vs-clamp tradeoff in hlc.ts.

---

## Risks of executing this plan

Almost all the risk here is *regression risk on shipped code*, concentrated in Phase 2 and the
Phase 1 gate. Phase 0 is genuinely low-risk. The sequencing below is itself the mitigation; the
danger is in deviating from it.

### Cross-cutting

- **These run against released code with real users.** The Chromium extension is public, and
  iOS/Android autofill are device-tested and shipping. A regression in unlock, sync, autofill, or
  passkey sign-in hits users, so a false-positive rejection costs far more than the defense-in-depth
  findings themselves warrant.
- **Effort/value is inverted from risk/difficulty.** A3 and A4 are defense-in-depth (not
  page-reachable today), so fixing them closes latent primitives, not live holes. The one finding
  with real security meaning, a compromised device surviving revocation (A1/B1), is the hardest,
  last, and riskiest. If Phase 2 slips or lands incomplete, the meaningful hole stays open longest
  while effort was spent on the cheap wins.
- **Green unit tests will lull you.** Phase 1 and Phase 2 cannot be validated by unit tests; they
  need device and multi-device testing. The risk is not that tests fail but that they pass and hide
  a device-only failure.

### Phase 0 (A3, A4) - low risk

- **A3's real risk is a false-negative on `isExtensionSender` bricking crypto/sync.** A mocked-sender
  unit test can pass while a real build fails, because `sender.origin`/`sender.url` semantics vary by
  Chrome version and message path. Mitigated by the layered, fail-safe predicate and the fail-loud
  logging described in the A3 section above; still needs a real unpacked-build smoke test, not just
  vitest. Firefox is unaffected (in-process), which halves the blast radius.
- **A4's risk is legit "update password" prompts silently throwing.** If `hostnameMatches` uses a
  stricter matching notion than whatever `dedupeCapture` used to produce the candidate list
  (subdomain / registrable-domain / multi-URL entries), legit updates fail to save. Lower impact than
  A3 (a save fails vs. total unlock failure). Check the two matchers agree.

### Phase 1 (B2) - the risk is *not gating*

- The danger is shipping the already-committed Task 5 (`a266dfa7`) without the device matrix and
  regressing browser passkey sign-in to `NotAllowedError`, the exact bug `770dac3a` previously fixed,
  affecting every browser-based sign-in. Silent, high-impact, invisible to unit tests.
- **Bundling the full GPM privileged-apps list** trades one staleness problem for another: a static
  snapshot goes stale, and you now own parsing/format risk on a file you don't control. Better than
  the hand-maintained subset, but not free.
- **The matrix itself is the risk surface.** It is easy to do incompletely (test Chrome, miss
  Brave/DDG forks that carry different signatures), which defeats the point.

### Phase 2 (revocation) - where the real risk lives

- **You are changing a synced wire format on a fleet that versions independently** (extension, iOS,
  Android each ship their own version). Even additive and version-negotiated, old- and new-format
  devices are live simultaneously; wrong negotiation yields convergence failures, dropped entries, or
  a legit device locked out.
- **The new-id gate can break enrollment.** Naive "reject gossiped new ids" stops a third device from
  ever learning about a second one. Botching this breaks *adding a device*, a core flow, for everyone.
- **Group-key rotation with offline peers is the sharpest edge.** It can either permanently lock out a
  legitimate offline device or fail to exclude the revoked one (fail open, defeating the fix). Unit
  tests can't reach this; it needs the multi-device matrix in the design note.
- **Four implementations must agree** - Rust core (wasm + uniffi), extension, iOS, Android. Any
  divergence is a cross-platform-only convergence bug.
- **Migration churn if you also do the interim A1 fix.** The interim `revokedKeys[]` fix spends a
  released-format migration you then redo in Item A, i.e. two migrations. The recommendation is to
  skip the interim and go straight to Item A.

### Phase 3 - mostly cheap, one interaction to watch

- **A2 (Nostr key rotation)** buys little for real cost: hourly re-handshakes are genuine mobile
  battery/traffic cost, and a live relay operator still links epochs via the persistent socket and
  IP. The doc-correction option is the low-risk call.
- **B4 has a hidden coupling:** widening `HLC_MAX_DRIFT_MS` loosens a future-stamp guard that B1's
  revocation logic leans on. Do not tune that knob in isolation from Phase 2.
- **B3** is minor; the only subtlety is DNS-rebinding / IPv6 edge cases in the private-address
  rejection.

### Bottom line

Follow the sequencing as written (separate PRs, device gates enforced) and Phase 0 is safe to land
now, Phase 1 is a gate not a gamble, and Phase 2 is the one that deserves slow, multi-device care.
Treat Phase 2 as its own project, not part of a single "do all these" push.

---

## Recommended sequencing

1. **Phase 0 (A3, A4)** - now, one PR, vitest + manual smoke. Cheap, complete, format-free.
2. **Phase 1 (B2)** - device-test matrix + robustness edits; **blocks shipping the Task 5 commit**.
3. **Phase 2 (Item A new-id gate → entry signing → Item B rotation)** - durable revocation fix
   closing B1 **and** A1; additive/version-negotiated; multi-device acceptance. Update the design
   note to mark this **required** and fold A1 in as a named threat Item A closes.
4. **Phase 3 (A2, B3, B4)** - as capacity allows; A2 likely a doc correction, B3/B4 small hardening.
