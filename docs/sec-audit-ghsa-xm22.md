# Security audit + fixing plan (GHSA-xm22-vwcg-9jqg)

> Working note. Private advisory filed 2026-08-04 by **@0cwa** (high, CVSS 4.0 7.0): autofill
> summaries and decrypted secrets were pushed to `{tabId, frameId}` after asynchronous work, and a
> frame id names a browsing context rather than the document in it, so a navigation landing inside
> that window delivered a secret to a replacement document. Reported, diagnosed and fixed by the
> same person, who also built the real-browser gate that proves the replacement transport.
>
> Everything from "Security finding" down is @0cwa's plan, kept verbatim as filed, including its
> own STATUS line and its forward-looking wording. What actually shipped is recorded below; where
> the two differ, this section wins.
>
> Advisory text and the reply to the reporter live on the GHSA itself, not here.

## Affected versions and severity

The document-identity race is present in **every released version**. Frame scoping (`4fe5c0d0`,
first shipped in Chromium 1.5.0 / Firefox 1.2.0) narrowed an earlier tab-wide broadcast, which had
handed the secret to every frame in the tab, but it addressed co-resident frames rather than
document identity, so the race survived it.

| Target | Affected | Fixed in |
|---|---|---|
| Chromium extension | all through 1.14.1 | _pending release_ |
| Firefox extension | all through 1.11.1 | _pending release_ |

Mobile is unaffected: the native credential providers do not use this transport.

## What shipped, and how it differs from the plan

The plan below scopes one PR. Three further vulnerabilities were found while fixing it, each
landed as its own commit:

| Landed as | Finding |
|---|---|
| `fix(autofill): deliver picker secrets on the requesting document's own channel` | the reported transport race |
| `fix(autofill): bind the decrypted index to the vault session that built it` | stale plaintext cache across lock/unlock ABA and active-vault switch |
| `fix(extension): make VEK install and removal transactional and fail closed` | non-atomic key writes; a failed durable removal reported a clean lock |
| `fix(extension): stop a superseded session from firing sync, backup and pop-out work` | side effects outliving the session that started them |

Deliberate divergences from the plan as written:

- **`requestId` was dropped.** The plan allowed an optional correlation UUID; on a document-bound
  reply channel it correlates nothing that object identity does not already, so it is not there.
- **`focusContract` and `contentLockGeneration` were removed** during cleanup. Both were
  scaffolding for the shortcut path in PR 6B: the only `activeFill` construction site always passed
  `"picker-anchor"`, so the `"focused"` branch was unreachable, and lock cancellation already
  nulls the intent and bumps the submit generation. **PR 6B must reintroduce focus binding for its
  own target revalidation; it cannot reuse a record that no longer carries it.**
- **`AUTOFILL_REVALIDATE_SUBMIT` was added**, which the plan did not anticipate. The delayed
  auto-submit needs the background session generation, and this is how it asks.
- **The browser gate moved** to `e2e/extension/transport-race/` behind
  `playwright.transport.config.ts`, with Chromium and Firefox as two projects sharing one contract.

## Verification at merge

Chromium and Firefox both pass the same-origin, cross-origin and bfcache races. The gate asserts
the frame **was** reused by two documents with different nonces before asserting neither observed
the sentinel, so a green run cannot be vacuous. Firefox runs the declared 128 floor and latest in
CI. Sync restart after a password unlock was verified by hand on both engines: it is the one path
the automated suites do not reach, since the unit tests call `maybeStartSync()` without an epoch
and the sync e2e suite only ever creates vaults.

> **STATUS: APPROVED SECURITY PR — LAND BEFORE PR 6B.** This independently mergeable prerequisite fixes an existing manual-picker vulnerability. It changes autofill summaries and secrets from a later background push to the original content script's one-shot request/response channel, adds local one-shot intent and target binding, and rejects operations that cross a vault-session transition.

## Security finding

The current background authorizes the sender of `AUTOFILL_SELECT`, constructs a `FillPayload`, awaits `scheduleAutoLock()`, and then sends `AUTOFILL_FILL` to `{tabId, frameId}`. A frame ID identifies a browsing context, not the document in it. If that frame navigates during the await, a replacement content script can receive an old secret. Its uncorrelated handler immediately fills the replacement document's current field model.

Concrete existing timeline:

1. Document A makes a trusted picker selection and sends `AUTOFILL_SELECT`.
2. The background derives A's hostname from `MessageSender`, authorizes the entry, and materializes plaintext.
3. Background work awaits; a hostile top page, parent frame, or A itself navigates the same frame.
4. Document B occupies the same `{tabId, frameId}`.
5. The background sends `AUTOFILL_FILL` to that frame, and B's fresh listener writes the old payload into B's fields.

Same-origin navigation defeats a second hostname check because origin is not document identity. Cross-origin navigation demonstrates that authorizing A does not authorize B. A random request ID would correlate the operation but would not stop B from receiving the plaintext.

Repository evidence:

- `packages/platform-extension/src/background/autofill-index.ts`: `autofillQuery()` at lines 338–365 and `autofillSelect()` at lines 367–391 push after asynchronous work using `frameId`.
- `packages/platform-extension/src/content/content.ts`: `selectMatch()` at lines 110–120 retains no target/operation identity; the `AUTOFILL_FILL` handler at lines 349–382 accepts an uncorrelated payload and fills the current model.
- `packages/platform-extension/src/background/router.ts`: lines 68–80 already keep the original one-shot response channel open with literal `true`, then call `sendResponse()` with the handler result.

## Threat model and required result

| Threat | Required result |
| --- | --- |
| Hostile top page or hostile parent/child frame | It may trigger navigation, replace fields, and read values intentionally filled into its own origin, but cannot redirect a secret authorized for another document. Existing trusted-picker and anti-clickjacking gates remain. |
| Same-origin or cross-origin navigation | A replacement document never receives the old response. The old document's intent is cancelled on `pagehide`, including bfcache entry. |
| Frame-ID reuse | Irrelevant to secret delivery because no secret is addressed by frame ID. |
| BFCache restore | `pagehide` consumes/cancels all operations; restoring the same document cannot revive an old query, selection, fill, or submit. |
| Tab switch, browser-window deactivation, hidden document | Pending fill/shortcut intent and pending auto-submit are cancelled; final application requires a focused, visible document. An authenticated picker iframe's internal focus transfer must not be mistaken for tab/window deactivation. |
| Stale service-worker response or out-of-order query | Only the latest local operation generation may update cache/UI or fill. A closed request channel is a quiet cancellation and is never retried. |
| Lock, lock→unlock ABA, active-vault change | A background session generation plus an in-progress transition flag rejects an operation crossing the transition; content clears local operations on both lock-state broadcasts. |
| Synthetic page events | They cannot select a picker row. Synthetic input/change events emitted by Bramble do not cancel their own fill; only trusted user input does. |
| User interaction or DOM replacement during a request | Trusted input/focus/pointer actions cancel; final validation requires the exact stored element and current kind/writability. |
| Delayed auto-submit | The existing 50 ms timer rechecks the bound document/field, operation generation, focus/visibility, lock generation, and CAPTCHA before submitting. |

## Browser compatibility and transport research

Current source manifests support Chrome 116+ and Firefox 128+.

| Primitive | Chromium | Firefox | Security/compatibility conclusion |
| --- | --- | --- | --- |
| `tabs.sendMessage(..., {frameId})` | Supported | Supported | Reject for summaries/secrets. `tabId + frameId` addresses a browsing context, and navigation can replace its document. [Mozilla document identity guide](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Work_with_documentId) |
| `runtime.sendMessage()` plus the original async `sendResponse` | Supported at both declared floors; literal `true` keeps the async channel open | Supported at Firefox 128 | **Selected.** The response returns to the message sender rather than performing a new tab/frame lookup. [Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [MDN `runtime.onMessage`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage) |
| `sender.documentId` plus `tabs.sendMessage(..., {documentId})` | Chrome 106+ | Firefox 153+ (released 2026-07-21) | Explicit native document targeting; an old ID fails after navigation. Not compatible with the current Firefox 128 floor. [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage), [Firefox 153 notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/153) |
| Content-created one-shot `runtime.Port` | Supported | Supported | Document-scoped but adds port routing, disconnect, and worker/event-page lifecycle state without benefit for one reply. [Chrome port lifetime](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#port-lifetime), [Firefox background lifecycle](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts) |
| URL/origin recheck, `webNavigation`, or nonce on a frame-targeted push | APIs vary and `webNavigation` would add a permission | APIs vary | Reject. Origin and correlation are not document identity, and a pre-send lookup leaves another TOCTOU gap. |

The public request/response documentation says the reply is returned to the sender but does not state the navigation race as explicitly as the `documentId` documentation. Therefore real Chromium and Firefox navigation-race tests are an acceptance gate, not optional confidence tests.

## Options decision

| Design | Security | Complexity | Performance | Migration/support cost | Decision |
| --- | --- | --- | --- | --- | --- |
| Direct request/response + local intent | High after browser proof | Low–medium | One request/reply; no second tab lookup | Keeps Chrome 116 / Firefox 128 | **Preferred** |
| Exact `documentId` push + local intent | Highest documented document binding | Low–medium | One request plus one targeted push | Requires Firefox 153 minimum or two transports | **Fallback if browser proof fails** |
| One-shot Port + local intent | High after disconnect proof | Medium–high | Port setup/teardown per operation | More worker/event-page cases | Rejected unless both preferred and fallback are unavailable |
| Frame push + UUID only | None against document replacement | Low | Current cost | Low | Rejected |

Do not feature-detect `documentId` and silently fall back to `frameId` for a secret. If the selected response-channel tests fail in either browser, stop this PR, raise the Firefox minimum to 153 as an explicit product decision, and implement exact `documentId` targeting on both browsers with no frame fallback.

## Selected protocol

### Message shapes

Keep the existing router envelope and add narrow typed autofill responses:

```ts
type AutofillQueryRequest = {
	type: "AUTOFILL_QUERY";
	hasLogin: boolean;
	hasCard: boolean;
	hasOtp: boolean;
	requestId?: string; // canonical UUID only; PR 6B correlation, never authority
};

type AutofillQueryResponse =
	| { ok: true; data: QueryResult; requestId?: string }
	| { ok: false; error: AutofillErrorCode };

type AutofillSelectRequest = {
	type: "AUTOFILL_SELECT";
	requestId?: string;
	payload: { entryId: string; isAuto: boolean; otpOnly: boolean };
};

type AutofillSelectResponse =
	| {
			ok: true;
			data: { payload: FillPayload; isAuto: boolean; otpOnly: boolean };
			requestId?: string;
	  }
	| { ok: false; error: AutofillErrorCode };
```

- `requestId`, when present, must be a bounded canonical UUID and is echoed unchanged. Absence preserves ordinary manual behavior. It never authorizes an origin, entry, document, or fill.
- Remove background `AUTOFILL_MATCHES` and `AUTOFILL_FILL` tab sends and their content `onMessage` branches. Summaries and plaintext exist only in the response to the initiating request.
- Content must not send a hostname. Background continues deriving hostname only from `sender.origin`, `sender.url`, or `sender.tab.url` and rejects an unverifiable page sender.
- `AUTOFILL_SELECT` must require a page content sender. Cards remain hostname-independent, but their request still comes only from the existing trusted picker path.
- Autofill errors are bounded generic codes. Never stringify an exception containing an entry ID, credential, TOTP, or custom-field value.

### Background sequence and lock invariant

Add an in-memory autofill session generation and nested-safe lock-transition state in `background/session.ts`:

1. Increment the generation and mark invalidation in progress synchronously at the beginning of every lock transition, before `CRYPTO_LOCK` awaits the crypto host and before `clearSession()` awaits storage/session cleanup.
2. Increment the generation on a successful unlock or active-vault replacement. A service-worker restart naturally destroys all in-flight response channels, so do not persist it.
3. `autofillQuery()` and `autofillSelect()` capture the generation before asynchronous hydration/scheduling work.
4. After their last await, require the generation unchanged and no invalidation in progress. `autofillSelect()` also requires the vault unlocked, re-derives/uses the verified sender hostname, re-authorizes the selected entry, and only then constructs `FillPayload`.
5. There is no application-level await between final session/origin validation, secret construction, and returning the response envelope.

This prevents lock→unlock ABA and requests that begin while lock is in progress. It is one process-local generation, not a nonce registry, authorization token, timer, or persisted state.

### Content operation state

Add a Promise-returning lifecycle-safe request helper that marks extension teardown on synchronous context failure, maps a rejected/closed channel to quiet cancellation, and never logs a response. Do not build a generic broker, retry layer, timeout, or persistent registry.

Content owns:

- one ordinary-query generation so late responses cannot replace newer cache/UI state;
- one current `activeFill` record, replaced by any newer selection; and
- one post-fill submit generation for the already-existing 50 ms auto-submit continuation.

`activeFill` stores only local identity and DOM references:

```ts
{
	token: object;
	requestId?: string;
	target: HTMLInputElement;
	targetKind: "login" | "card" | "otp";
	focusContract: "picker-anchor" | "focused" | "top-fallback";
	source: "picker" | "shortcut";
	otpOnly: boolean;
	contentLockGeneration: number;
}
```

For a manual selection, capture `picker.anchorField()`, its current kind, and the operation record before `picker.remove()`. Preserve every existing trusted-event, iframe `source`/origin, visibility, anti-overlay, and fallback-shadow gate. PR 6B creates the same shared record after its own target revalidation.

On response, consume `activeFill` before any effect and synchronously require:

1. the local token is still current and any echoed request ID is valid and matches;
2. the document is focused and visible and has not crossed `pagehide`;
3. after `invalidatePageFields()`, one model read shows the stored element still connected, owned by this document, enabled, non-read-only, and still the stored kind;
4. `focused` means `deepActiveElement() === target`; `top-fallback` means the complete PR 6B fallback rule still chooses that exact element; `picker-anchor` relies on the already trusted picker action plus cancellation of later focus/pointer/input activity and does not substitute a selector for element identity;
5. response kind agrees with the target (`card`; OTP-only login; or normal login); and
6. the fill functions run synchronously against that freshly invalidated cached model, with no intervening await.

Clear query/fill/submit generations on both lock-state transitions, trusted user input before the listener's early returns, a different trusted focus/pointer interaction, picker pick/dismiss/unlock/suggest/regenerate, `pagehide`, hidden visibility, actual browser-window deactivation, supersession, error/rejection, and extension teardown. Do not treat focus moving into the authenticated extension picker iframe as deactivation; the existing real-browser iframe-pick tests must remain green. `pageshow.persisted` starts fresh ordinary detection/query behavior and never restores an intent.

After a valid fill, the existing 50 ms auto-submit remains per-entry policy. Its callback requires the same document and password field, current submit generation, focus/visibility, unchanged content lock generation, and no trusted intervening input, then performs the existing late CAPTCHA check before `submitFromField()`.

## Files and symbols

Production/docs:

- `packages/platform-extension/src/background/autofill-index.ts`: return summaries/fills in envelopes; UUID validation; final session/origin authorization; no autofill tab pushes.
- `packages/platform-extension/src/background/session.ts`: process-local session generation and lock-transition state.
- `packages/platform-extension/src/background/router.ts`: response typing only if needed; retain the literal-`true` async `sendResponse` contract.
- `packages/platform-extension/src/content/lifecycle.ts`: narrow Promise-returning safe request helper.
- `packages/platform-extension/src/content/content.ts`: direct-response query/select, local generations, exact target validation, cancellation, removal of `AUTOFILL_MATCHES`/`AUTOFILL_FILL` handlers, bound auto-submit.
- `packages/platform-extension/src/content/types.ts` and `packages/core/src/adapters/autofill.ts`: response/request types where sharing is useful; do not put DOM state in core types.
- `docs/autofill.md`: document-bound transport, session/cancellation invariants, and corrected message flow.

Tests/harness:

- `packages/platform-extension/src/test/test-harness.ts`: deferred hydration/session transitions and direct response assertions; retain tab-message recording to prove no autofill push occurs.
- `packages/platform-extension/src/background/autofill-index.test.ts`.
- `packages/platform-extension/src/background/session.test.ts`.
- `packages/platform-extension/src/content/content.dom.test.ts`.
- A small browser-contract fixture and runner under `e2e/` for Chromium and Firefox navigation races. Do not add a production delay/test hook.

Do not edit either manifest, generated distributions, localization, picker implementation, entry schemas, settings/preferences, detector internals, mobile projects, or vault storage format in this PR.

## Deterministic tests

Background:

- Query derives hostname from the sender despite a hostile body field, returns summaries only in the direct response, and emits no `AUTOFILL_MATCHES` tab message.
- Select returns a secret only in its direct response and emits no `AUTOFILL_FILL` tab message.
- Missing/unverifiable page sender, malformed capabilities/flags/UUID, wrong-origin login, missing entry, locked vault, and payload-kind mismatch fail closed with generic errors.
- Untagged ordinary query/select remains supported; a valid optional UUID is echoed exactly and never changes authorization.
- Delay hydration/scheduling, start lock, then release: no payload. Lock then unlock before release remains cancelled. A request started during the lock transition also fails.
- After the final generation/lock/origin check, no await occurs before secret response construction/return.
- Service-worker restart/closed response channel produces no retry or persisted operation.

Content:

- Out-of-order ordinary query responses: only the latest may cache/display.
- Manual selection captures the exact anchor/kind before removal and fills once on a valid response.
- Target removal, adoption, identical replacement, disable/read-only, kind change, focus/pointer change, hidden document, actual browser-window deactivation, trusted input, lock/unlock, pagehide, teardown, malformed response, or supersession makes a late response inert.
- BFCache `pagehide` followed by `pageshow.persisted` cannot revive a response or auto-submit; a new query is required.
- Payload/target/`otpOnly` mismatch is inert. A second selection supersedes the first.
- Page-generated untrusted input does not cancel or authorize anything; Bramble's synthetic input/change events do not cancel their own fill.
- Existing trusted picker, iframe source/origin, visibility/anti-clickjacking, cards, custom fields, OTP, capture suppression, and event behavior remain green.
- Auto-submit is suppressed by lock, trusted input, focus/visibility loss, pagehide, field replacement, or late CAPTCHA during the 50 ms delay.

## Real-browser acceptance gate

Use one tiny test-only WebExtension fixture implementing the selected request/reply primitive. A hostile parent embeds child document A; A makes a request and the background holds the response until the parent navigates the same child frame to B. Run these cases in current supported Chromium and Firefox:

1. B is a different path on the same origin.
2. B is cross-origin.
3. Navigate Back to restore A from bfcache after the held response; A must not apply it without a new intent.

For each case, assert the browsing context/frame is reused, the replacement document nonce differs, B never observes/applies the sentinel secret, and restored A remains inert. Chromium may reuse the existing Playwright extension launcher. Firefox must use a real headless `web-ext`/WebDriver-compatible runner and the same fixture contract; jsdom and mocked WebExtension APIs cannot prove this property.

These browser-contract tests must run in CI or in a required release/security job. If either browser redirects the response or resumes it in a way that bypasses `pagehide` cancellation, do not ship this design; take the exact-`documentId` fallback and raise Firefox's minimum to 153.

## Focused verification

```text
pnpm --filter @vault/platform-extension test -- src/background/session.test.ts src/background/autofill-index.test.ts src/content/content.dom.test.ts
pnpm --filter @vault/platform-extension typecheck
pnpm --filter @vault/platform-extension test
pnpm --filter @vault/platform-extension build
pnpm --filter @vault/platform-extension lint:firefox
<new Chromium + Firefox transport-race command>
```

## Security invariants and acceptance criteria

- Authorization is derived from the initiating `MessageSender`; correlation IDs never authorize.
- Summaries and secrets return only on the initiating request channel. No autofill summary/secret is addressed by frame ID, broadcast, logged, persisted, snapshotted, or retried.
- A replacement document has neither the old response callback/Promise nor the old local operation token.
- A bfcache-restored document had its token cancelled on `pagehide`.
- Every fill requires one current local intent, the exact still-valid element, compatible payload kind, focused/visible document, unchanged content lock generation, and unchanged background session generation.
- An operation crossing lock, unlock, active-vault replacement, or lock-in-progress cannot release or apply a secret.
- Existing trusted-event, isolated iframe origin/source, visibility, anti-clickjacking, sender-origin, card, and capture defenses are not weakened.
- The existing per-entry `autoSubmit` and CAPTCHA policy remains, with added continuation cancellation/revalidation.
- No new permission, manifest change, timer, persistent nonce registry, background request map, generic broker, retry, storage, or mobile work is introduced.
- Real Chromium and Firefox same-origin, cross-origin, and bfcache races pass before merge.

## Merge order

Land this PR immediately as the first independently valuable security fix. Then land PR 6B, which must consume the shared request/response and `activeFill` path. PR 6B must not add a shortcut-only secret channel or restore `AUTOFILL_MATCHES`/`AUTOFILL_FILL` pushes.
