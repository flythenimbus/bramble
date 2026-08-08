# Security audit (GHSA-xm22-vwcg-9jqg)

> Autofill summaries and decrypted secrets were pushed to `{tabId, frameId}` after asynchronous
> work. A frame id names a browsing context, not the document in it, so a navigation landing inside
> that window delivered a secret authorized for one document to the document that replaced it.
>
> Private advisory filed 2026-08-04 by **@0cwa** (high, CVSS 4.0 7.0), who reported it, diagnosed
> it, fixed it, found three further vulnerabilities while doing so, and built the real-browser gate
> that proves the replacement transport holds in both engines.
>
> This began as @0cwa's filed plan. It has been edited into a record of what shipped, because parts
> of the plan were superseded during implementation and a stale plan is worse than no plan. The
> analysis, the research tables and the options decision are theirs. Advisory text and the reply to
> the reporter live on the GHSA itself, not here.

## Affected versions and severity

The document-identity race is present in **every released version**. Frame scoping (`4fe5c0d0`,
first shipped in Chromium 1.5.0 / Firefox 1.2.0) narrowed an earlier tab-wide broadcast that had
handed the secret to every frame in the tab, but it addressed co-resident frames rather than
document identity, so the race survived it.

| Target | Affected | Fixed in |
|---|---|---|
| Chromium extension | 1.0.0 through 1.14.1 (all releases) | 1.14.2 |
| Firefox extension | 1.0.1 through 1.11.1 (all releases) | 1.11.2 |

Mobile is unaffected: the native credential providers do not use this transport, so unlike
GHSA-x4f5 this is not a mutual change and no device is stranded by another sitting on an older
build. The two extension targets version independently and were released together.

## The finding

The background authorized the sender of `AUTOFILL_SELECT`, constructed a `FillPayload`, awaited
`scheduleAutoLock()`, and then sent `AUTOFILL_FILL` to `{tabId, frameId}`. If that frame navigated
during the await, a replacement content script received the old secret, and its uncorrelated
handler immediately filled the replacement document's current field model.

1. Document A makes a trusted picker selection and sends `AUTOFILL_SELECT`.
2. The background derives A's hostname from `MessageSender`, authorizes the entry, and
   materializes plaintext.
3. Background work awaits; a hostile top page, parent frame, or A itself navigates the same frame.
4. Document B occupies the same `{tabId, frameId}`.
5. The background sends `AUTOFILL_FILL` to that frame, and B's fresh listener writes the old
   payload into B's fields.

Same-origin navigation defeats a second hostname check, because origin is not document identity.
Cross-origin navigation demonstrates that authorizing A does not authorize B. A random request id
would correlate the operation but would not stop B from receiving the plaintext.

Evidence, as it stood before `2bac6269`:

- `background/autofill-index.ts`: `autofillQuery()` and `autofillSelect()` pushed after
  asynchronous work using `frameId`.
- `content/content.ts`: `selectMatch()` retained no target or operation identity; the
  `AUTOFILL_FILL` handler accepted an uncorrelated payload and filled the current model.
- `background/router.ts`: already kept the original one-shot response channel open with literal
  `true`, then called `sendResponse()` with the handler result. The replacement transport is built
  on that existing contract.

## Threat model

What the fix has to achieve, and what now achieves it.

| Threat | Required result |
| --- | --- |
| Hostile top page or hostile parent/child frame | It may trigger navigation, replace fields, and read values intentionally filled into its own origin, but cannot redirect a secret authorized for another document. Existing trusted-picker and anti-clickjacking gates remain. |
| Same-origin or cross-origin navigation | A replacement document never receives the old response. The old document's intent is cancelled on `pagehide`, including bfcache entry. |
| Frame-id reuse | Irrelevant to secret delivery, because no secret is addressed by frame id. |
| BFCache restore | `pagehide` consumes and cancels all operations; restoring the same document cannot revive an old query, selection, fill or submit. |
| Tab switch, browser-window deactivation, hidden document | Pending fill intent and pending auto-submit are cancelled; final application requires a focused, visible document. An authenticated picker iframe's internal focus transfer is not mistaken for tab/window deactivation. |
| Stale service-worker response or out-of-order query | Only the latest local operation generation may update cache/UI or fill. A closed request channel is a quiet cancellation and is never retried. |
| Lock, lock to unlock ABA, active-vault change | A background session generation plus an in-progress transition flag rejects an operation crossing the transition; content clears local operations on both lock-state broadcasts. |
| Synthetic page events | They cannot select a picker row. Synthetic input/change events emitted by Bramble do not cancel their own fill; only trusted user input does. |
| User interaction or DOM replacement during a request | Trusted input/focus/pointer actions cancel; final validation requires the exact stored element and current kind/writability. |
| Delayed auto-submit | The 50 ms timer rechecks the bound document and field, operation generation, focus/visibility, background session generation, and CAPTCHA before submitting. |

## Transport options considered

The source manifests support Chrome 116+ and Firefox 128+, which is what ruled out the otherwise
strongest option.

| Primitive | Chromium | Firefox | Conclusion |
| --- | --- | --- | --- |
| `tabs.sendMessage(..., {frameId})` | Supported | Supported | Rejected for summaries and secrets. `tabId + frameId` addresses a browsing context, and navigation can replace its document. [Mozilla document identity guide](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Work_with_documentId) |
| `runtime.sendMessage()` plus the original async `sendResponse` | Supported at both declared floors; literal `true` keeps the async channel open | Supported at Firefox 128 | **Selected.** The response returns to the message sender rather than performing a new tab/frame lookup. [Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [MDN `runtime.onMessage`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage) |
| `sender.documentId` plus `tabs.sendMessage(..., {documentId})` | Chrome 106+ | Firefox 153+ (released 2026-07-21) | Explicit native document targeting; an old id fails after navigation. Incompatible with the Firefox 128 floor. [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage), [Firefox 153 notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/153) |
| Content-created one-shot `runtime.Port` | Supported | Supported | Document-scoped, but adds port routing, disconnect and worker/event-page lifecycle state with no benefit for a single reply. |
| URL/origin recheck, `webNavigation`, or a nonce on a frame-targeted push | APIs vary; `webNavigation` would add a permission | APIs vary | Rejected. Origin and correlation are not document identity, and a pre-send lookup leaves another TOCTOU gap. |

| Design | Security | Complexity | Migration cost | Decision |
| --- | --- | --- | --- | --- |
| Direct request/response + local intent | High after browser proof | Low to medium | Keeps Chrome 116 / Firefox 128 | **Selected, and proven** |
| Exact `documentId` push + local intent | Highest documented binding | Low to medium | Requires Firefox 153 minimum or two transports | Fallback, not needed |
| One-shot Port + local intent | High after disconnect proof | Medium to high | More worker/event-page cases | Rejected |
| Frame push + UUID only | None against document replacement | Low | Low | Rejected |

The public request/response documentation states that the reply returns to the sender, but does not
address the navigation race as explicitly as the `documentId` documentation does. That is why the
real-browser gate below was an acceptance condition rather than a confidence test. It passed in
both engines, so the Firefox floor stays at 128 and the `documentId` fallback was not taken.

**If that gate ever fails, do not feature-detect `documentId` and silently fall back to `frameId`
for a secret.** Raise the Firefox minimum to 153 as an explicit product decision and implement
exact `documentId` targeting on both browsers, with no frame fallback.

## What shipped

### Message shapes

The existing router envelope is unchanged; the autofill responses are narrowly typed.

```ts
type AutofillQueryResponse =
	| { ok: true; data: QueryResult }
	| { ok: false; error: string };

type AutofillSelectResponse =
	| {
			ok: true;
			data: {
				payload: FillPayload;
				isAuto: boolean;
				otpOnly: boolean;
				sessionGeneration: number;
			};
	  }
	| { ok: false; error: string };

type AutofillSubmitRevalidationResponse =
	| { ok: true; data: { sessionGeneration: number } }
	| { ok: false; error: string };
```

- The background `AUTOFILL_MATCHES` and `AUTOFILL_FILL` tab sends are gone, along with their
  content `onMessage` branches. Summaries and plaintext exist only in the response to the
  initiating request.
- Content does not send a hostname. The background derives it only from `sender.origin`,
  `sender.url` or `sender.tab.url`, and rejects an unverifiable page sender.
- `AUTOFILL_SELECT` requires a page content sender. Cards remain hostname-independent, but their
  request still arrives only through the trusted picker path.
- Autofill errors are bounded generic codes. An exception carrying an entry id, credential, TOTP or
  custom-field value is never stringified into a page-facing message.

The plan reserved an optional `requestId` for PR 6B correlation. It was dropped: on a
document-bound reply channel it correlates nothing that object identity does not already, and a
correlation id that never authorizes anything is a field that invites being trusted later.

### Background sequence and session invariant

`background/session.ts` holds an in-memory autofill session generation and nested-safe
lock-transition state.

1. Every lock transition increments the generation and marks invalidation in progress
   synchronously, before `CRYPTO_LOCK` awaits the crypto host and before `clearSession()` awaits
   storage cleanup.
2. A successful unlock or active-vault replacement increments the generation. It is not persisted:
   a service-worker restart destroys all in-flight response channels anyway.
3. `autofillQuery()` and `autofillSelect()` capture the generation before hydration or scheduling.
4. After their last await they require the generation unchanged and no invalidation in progress.
   `autofillSelect()` additionally requires the vault unlocked, uses the verified sender hostname,
   re-authorizes the selected entry, and only then constructs the `FillPayload`.
5. No application-level await occurs between final session and origin validation, secret
   construction, and returning the envelope.

That closes lock-to-unlock ABA and requests that begin while a lock is already in progress. It is
one process-local generation, not a nonce registry, authorization token, timer or persisted state.

### Content operation state

`content/lifecycle.ts` gained a Promise-returning request helper that marks extension teardown on
synchronous context failure, maps a rejected or closed channel to quiet cancellation, and never
logs a response. There is no generic broker, retry layer, timeout or persistent registry.

Content owns one ordinary-query generation, one current `activeFill` record superseded by any newer
selection, and one post-fill submit generation.

```ts
type ActiveFill = {
	target: HTMLInputElement;
	targetKind: "login" | "card" | "otp";
};
```

The plan specified a richer record: a `token`, an echoed `requestId`, a `focusContract`, a `source`
and a `contentLockGeneration`. All were removed during cleanup as unreachable or redundant. The
record's own object identity replaces the token; lock cancellation already nulls the intent and
bumps the submit generation, which is what `contentLockGeneration` was for; and the only
construction site always passed `"picker-anchor"`, leaving the other two focus contracts dead.

> **PR 6B must reintroduce focus binding for its own target revalidation.** Its shortcut path has
> no trusted picker action to lean on, so it cannot reuse a record that no longer distinguishes
> `focused` from `top-fallback`. It must also not add a shortcut-only secret channel or restore the
> `AUTOFILL_MATCHES` / `AUTOFILL_FILL` pushes.

For a manual selection, `picker.anchorField()` and its current kind are captured before
`picker.remove()`. Every existing trusted-event, iframe source/origin, visibility, anti-overlay and
fallback-shadow gate is preserved.

On response, `activeFill` is consumed before any effect, and the fill requires, synchronously:

1. the record is still the current intent;
2. the document is focused and visible and has not crossed `pagehide`;
3. after `invalidatePageFields()`, one model read shows the stored element still connected, owned by
   this document, enabled, not read-only, and still the stored kind;
4. the response kind agrees with the target (card, OTP-only login, or normal login); and
5. the fill functions run against that freshly invalidated cached model with no intervening await.

Query, fill and submit state is cleared on both lock-state transitions, trusted user input, a
different trusted focus or pointer interaction, picker pick/dismiss/unlock/suggest/regenerate,
`pagehide`, hidden visibility, real browser-window deactivation, supersession, error or rejection,
and extension teardown. Focus moving into the authenticated picker iframe is deliberately not
treated as deactivation. `pageshow.persisted` starts fresh detection and never restores an intent.

After a valid fill the 50 ms auto-submit remains per-entry policy. Its callback requires the same
document and password field, the current submit generation, focus and visibility, and no trusted
intervening input. It then asks the background to revalidate the session generation
(`AUTOFILL_REVALIDATE_SUBMIT`, which the plan did not anticipate), rechecks eligibility after that
round trip, and performs the late CAPTCHA check before `submitFromField()`.

### Where it lives

| Path | Role |
| --- | --- |
| `background/autofill-index.ts` | summaries and fills returned in envelopes; final session and origin authorization; no tab pushes |
| `background/session.ts` | process-local session generation and lock-transition state |
| `background/router.ts` | retains the literal-`true` async `sendResponse` contract |
| `content/lifecycle.ts` | the safe request helper |
| `content/content.ts` | direct-response query and select, local generations, exact target validation, cancellation, bound auto-submit |
| `content/types.ts` | response types |
| `e2e/extension/transport-race/` | the real-browser gate, run by `playwright.transport.config.ts` |
| `docs/autofill.md` | the corrected message flow |

## Verification

### Automated

Background: the query derives its hostname from the sender despite a hostile body field and emits
no `AUTOFILL_MATCHES`; select returns a secret only in its direct response and emits no
`AUTOFILL_FILL`; missing or unverifiable page senders, malformed flags, wrong-origin logins, missing
entries, a locked vault and payload-kind mismatches all fail closed with generic errors; delaying
hydration and then locking yields no payload, and lock-then-unlock before release stays cancelled;
no await occurs between the final check and the secret; a closed response channel produces no retry.

Content: out-of-order query responses cannot overwrite newer state; a manual selection captures the
exact anchor and kind before removal and fills once; target removal, adoption, identical
replacement, disable or read-only, kind change, focus or pointer change, hidden document, real
window deactivation, trusted input, lock or unlock, `pagehide`, teardown, malformed response and
supersession each make a late response inert; bfcache `pagehide` then `pageshow.persisted` cannot
revive a response or an auto-submit; page-generated untrusted input neither cancels nor authorizes,
while Bramble's own synthetic events do not cancel their own fill; auto-submit is suppressed by
lock, trusted input, focus or visibility loss, `pagehide`, field replacement, or a late CAPTCHA.

```sh
pnpm --filter @vault/platform-extension test     # 589 tests
pnpm --filter @vault/core test                   # 709 tests
pnpm test:e2e                                    # 56, the extension suite
pnpm test:e2e:sync                               # 3
pnpm test:transport-race                         # 3 per browser
pnpm -r run typecheck
pnpm --filter @vault/platform-extension build
pnpm --filter @vault/platform-extension lint:firefox
```

### Real-browser gate

A tiny test-only WebExtension fixture, never Bramble, implements the selected request/reply
primitive: a hostile parent embeds child document A, A makes a request, and the background holds
the response until the parent has replaced the same child frame with B. Three cases run in both
engines: B on the same origin, B cross-origin, and a Back navigation restoring A from bfcache after
the response is held.

Each case asserts the browsing context was reused **and** that the two documents reported different
nonces, before asserting that neither B nor a restored A ever observed the sentinel. Those first two
assertions are the positive control: without them a green run would not distinguish a safe
transport from a race that never happened.

Chromium runs on Playwright directly. Firefox runs on `web-ext`, because Playwright cannot install a
Firefox add-on; for that project Playwright is only the runner. jsdom and mocked WebExtension APIs
cannot prove this property. CI runs Chromium plus Firefox at both the declared 128 floor and latest.

### Manual

Sync restart after a password unlock was checked by hand on Chromium and Firefox, because it is the
one path the suites do not reach: only `session.ts`'s post-unlock call passes a VEK epoch, the unit
tests all call `maybeStartSync()` bare, and the sync e2e suite only ever creates vaults. That gate
now logs when it abandons a start, since it is otherwise silent and sync self-heals from the next
blob write, which would make a regression there present as "sync is occasionally late".

## Security invariants

- Authorization derives from the initiating `MessageSender`. Correlation never authorizes.
- Summaries and secrets return only on the initiating request channel. No autofill summary or
  secret is addressed by frame id, broadcast, logged, persisted, snapshotted or retried.
- A replacement document has neither the old response Promise nor the old local intent.
- A bfcache-restored document had its intent cancelled on `pagehide`.
- Every fill requires one current local intent, the exact still-valid element, a compatible payload
  kind, a focused and visible document, and an unchanged background session generation.
- An operation crossing lock, unlock, active-vault replacement or lock-in-progress cannot release
  or apply a secret.
- Existing trusted-event, isolated iframe origin/source, visibility, anti-clickjacking,
  sender-origin, card and capture defenses are not weakened.
- Per-entry `autoSubmit` and CAPTCHA policy is retained, with added continuation cancellation and
  revalidation.
- No new permission, manifest change, timer, persistent nonce registry, background request map,
  generic broker, retry, storage or mobile work was introduced.

## The other three findings

Found by @0cwa while fixing the above, each landed as its own commit and each a distinct
vulnerability rather than a refinement of the reported one.

| Commit | Finding |
| --- | --- |
| `fix(autofill): bind the decrypted index to the vault session that built it` | The decrypted autofill cache recorded no owner, so a lock-then-unlock or an active-vault switch left the previous vault's plaintext readable, and an in-flight hydration could publish it into the session that replaced it. Caches now carry an opaque vault id, generation and token; hydration publishes only while still current; view-driven writes need a lease. |
| `fix(extension): make VEK install and removal transactional and fail closed` | Key writes were neither ordered nor atomic, so a slow unlock could resurrect a key after a later lock, and a failed durable removal still reported a clean lock. Mutations are serialized and epoch-tagged, a lock marker is written before removal so an interrupted cleanup fails closed on restart, and failed writes now propagate. |
| `fix(extension): stop a superseded session from firing sync, backup and pop-out work` | Sync startup, due backups and unlock pop-out closure outlived the session that started them. Those continuations now carry the VEK mutation epoch and bail. |
