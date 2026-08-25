# Autofill

How stored credentials reach a web page: the index, hostname matching, the fill
model, and the corner prompt for capturing new logins. Types and the adapter
contract are in `packages/core/src/adapters/autofill.ts`; the page-side logic is
in `content-script.ts`; matching and the dedupe decision live in `background.ts`.
Field detection (which page inputs are what) is its own doc:
[field-detection.md](field-detection.md).

## The index

When the vault unlocks, the popup pushes a searchable **index** of logins and
cards to the background service worker (`setIndex`), so autofill works while the
popup is closed. The index is cleared on lock. It is decrypted plaintext and is
held in background memory only, never persisted (see [storage.md](storage.md)).

- **Logins** are matched to a page by hostname. Each login carries the list of
  hostnames it is registered against, derived from its URLs at index-build time
  with empty or unparseable URLs dropped. One login can cover many sites.
- **Cards** are not tied to a hostname. Every stored card is offered on any
  detected payment form.
- **Notes and SSH keys** never participate in autofill.

A content-script `query` says which field kinds the page exposes (`hasLogin`,
`hasCard`, `hasOtp`), so the background only returns the relevant lists. Query
summaries and selected fill payloads return only on that initiating runtime
request's one-shot response channel. They are never later addressed to a tab or
frame: a frame can navigate and retain its frame id while its document changes.
The content script keeps each selection as a one-shot intent bound to the exact
field it was picked from. Lock-state changes, pagehide (including bfcache), a
hidden or unfocused page, trusted user interaction, replacement fields, and
extension teardown cancel that intent. The optional 50 ms auto-submit continuation
is similarly bound to the same live password field and rechecks for CAPTCHAs.

## Hostname matching and subdomain policy

`hostnameMatches` (background) returns true when the page hostname matches any of
a login's registered hostnames under that entry's **subdomain match** policy:

- `etld1` (default): the registrable domain and all its subdomains.
- `exact`: that exact hostname only.
- `subdomain`: this domain plus its subdomains.

The query hostname is derived from the **verified message sender**
(`sender.origin` / `sender.url` / `sender.tab.url`), not from the message body, so
a content script cannot request matches for a different domain.

### App URIs are not web hosts

An entry's URL list can contain identifiers for a mobile app rather than a
website. Bramble never writes these, but importers carry them through verbatim:
`androidapp://com.example` is Bitwarden's convention, `android://<cert-hash>@com.example`
is Google Password Manager's. `isAppUri` recognises them and `extractHostname`
returns empty for them, so they stay out of the match index and out of the
persisted known-hostname registry.

Before that, the package name was indexed as if it were a hostname:
`androidapp://se.skanetrafiken.washington` became the "host"
`se.skanetrafiken.washington`, which `registrableDomain` reduced to
`skanetrafiken.washington`. That could never match a page, but it was stored,
persisted and counted toward the locked-state "you probably have a login here"
hint (issue #46).

### Why a package name is never turned into a domain

Reversing a package name looks like it would fix cross-platform matching:
`se.skanetrafiken.washington` reverses to `washington.skanetrafiken.se`, whose
registrable domain is `skanetrafiken.se`, which is correct here. It is not sound.
`com.google.android.youtube` reverses to `google.com`, not `youtube.com`, and
nothing stops an app from choosing a package name in someone else's namespace.

Android already declines the equivalent inference in the other direction, with a
written rationale in `StructureParser.kt`: `webDomain` is attacker-controllable
and the package name is not a web identity, so a non-browser caller gets no
host-based auto-match at all and the user opens the full searchable list instead.
Deriving domains from packages in the extension would put the browser in the
position of trusting a binding the mobile app refuses to trust.

Digital Asset Links (`https://<domain>/.well-known/assetlinks.json`) is the
standard way to make the binding authoritative, and was considered and rejected
for now: it needs a network fetch per domain from the extension, which leaks
which sites the user holds entries for, and it exists to enable *silent*
matching, which is the part Android declined.

### Planned: offer the link instead of inferring it

Not built. When an entry holds an app URI whose reversed package resolves to a
real registrable domain, the entry editor should offer to add that website —
"this entry came from an Android app that looks like skanetrafiken.se, add it?"
— rather than matching on it silently. One click writes an ordinary `https://`
URL and the existing matcher takes over, with no new matching path, no network
call, and the guess visible to the person who can confirm it. `appIdFromUri`
exists for this and has no other caller.

## The fill model: secrets fetched only on explicit pick

A single login match does **not** auto-inject the password on page load. Doing so
would put the password in the DOM where scripts on a cross-registered domain
could read it. Instead:

1. On focusing a candidate field, the dropdown shows the matching entries
   (`query` returns only summaries: name plus a username or masked `•••• 1234`).
2. The user picks one.
3. Only then does the page-bound `AUTOFILL_SELECT` response return the actual
   secrets for that entry.

Cards always used this safer pattern; logins and OTP codes follow it too.

The pick must be a **trusted gesture**: the dropdown's `mousedown` handler bails
on `event.isTrusted === false`. Without this, page script could dispatch a
synthetic `mousedown` at a dropdown row to drive `fetchFill` and read the filled
value back. It matters most for cards, which are offered on every site (not
hostname-scoped), so any page could otherwise have silently exfiltrated every
stored card. The capture listeners gate on `isTrusted` for the same reason.

The background re-checks the pick as defense-in-depth (`authorizeFill`): on
`AUTOFILL_SELECT` it resolves the chosen entry and, **for a login**, requires
`hostnameMatches` against the *verified sender* before returning secrets on the
same request's response channel, so a
leaked or guessed entry id can't be filled on a non-matching site. Cards are
deliberately exempt (site-agnostic by design); their only barrier is the
trusted-gesture gate above, plus the visibility/anti-overlay checks that arrive
with the iframe UI. The adapter's request/response path (`AUTOFILL_FIND` /
`AUTOFILL_FETCH`, used by the popup) trusts the hostname in its body, so it is
restricted to **extension-origin senders**: a content script must use the
sender-verified `AUTOFILL_QUERY`/`AUTOFILL_SELECT` pair instead.

Per-login overrides ride on the summary: `autofillEnabled = false` means the
content script must not silently single-match auto-fill (the user must pick from
the dropdown), and `autoSubmit` means submit the form after filling. Auto-submit
is suppressed when an interactive captcha is present (see
[field-detection.md](field-detection.md)).

TOTP codes are computed in the background; only the resulting digits are filled,
never the seed. See [totp.md](totp.md).

## When the content script looks at the page again

An SPA can swap a login form in without a navigation, so a `childList`
MutationObserver drives the re-query. It used to do so on every batch, which on a
page that rewrites itself continuously (YouTube, a feed, a video player) meant a
full page parse twice a second in every frame, plus one on every keystroke and
click, because each of those dropped the cached field model first. That is
issue #59. The policy now:

- **A batch is ignored unless it moves something field-shaped**: an `input`,
  `select`, `textarea`, `form`, `iframe`, or a custom element (which renders its
  own subtree, possibly into a shadow root this observer cannot see). Pages known
  to use shadow DOM skip the filter entirely, since their real churn is invisible
  here anyway.
- **Re-queries coalesce** into one pending timer, at most one per 500ms, and run
  outside the observer callback.
- **A hidden tab does not re-query.** Picture-in-picture keeps a backgrounded page
  busy; the deferred re-query runs when the tab is visible again.
- **Event handlers check the target before the model.** `couldBeCandidate()` is a
  type check on the element, so typing in a comment box or clicking a button costs
  nothing. Only a real input reaches the parse behind `isCandidate()`, and an
  input the model has never seen buys exactly one re-parse (a shadow root can
  attach with no mutation to observe).

One path deliberately opts out: a **desktop fill** (`DESKTOP_FILL`, see
[desktop-port.md](desktop-port.md)) re-reads the page before choosing its target. The user picked
that entry in the desktop app, so a model stale by one unobserved change - an input whose `type`
flipped to password, say - would answer "no field to fill" for something they explicitly asked
for. One deliberate action is worth one parse.

`e2e/perf/page-blocking.mjs` is the harness for this: it reports main-thread
blocking time with and without the extension on a real page.

### The picker lets go of a field that has gone

An open picker is parked below its anchor field by a `requestAnimationFrame` loop
in `picker.ts`, because a `scroll` event is `composed: false` and never fires for a
scroll inside a shadow root or a nested modal scroller. The loop re-reads the
field's rect every frame, so it also sees the moment the field stops existing: an
SPA route change unmounts the login form, a second step replaces the first, a modal
closes. **A field that has gone measures 0x0 at the document origin**, which reads
to anything positioning against it as "the top-left corner of the page" - so the
loop used to leave the dropdown stranded up there, still offering entries for a
form that was no longer on screen. `anchorIsLive()` is the check (attached to this
document, occupying a box, and visible); failing it dismisses the picker instead
of repositioning it.

A **modal closing** is the same problem wearing four disguises, and only the first
two are answered by "is it attached and does it measure":

| the modal closes by | what the field looks like afterwards |
| --- | --- |
| unmounting | detached |
| `display: none` | attached, 0x0 at the document origin |
| `visibility: hidden` / `opacity: 0` | attached, laid out, styled invisible |
| collapsing with `overflow: hidden` | attached, laid out, and styled **visible** |

The third pair is what a transition-based modal leaves behind, and it is answered
by `checkVisibility({checkOpacity, checkVisibilityCSS})` — the same call
`isRendered` makes, shared as `isVisibleCss`. It has to answer for **ancestors**,
since what closed is the modal, not the field.

The fourth has no style to read: the field is fine, its ancestor has gone to
nothing and clipped it out of the picture. A **hit test at the field's own centre**
answers it (`anchorIsReachable`), and catches an overlay dropped on top of the
field for free. Three things make it safe:

- `elementFromPoint` answers with the **deepest** element at the point, so a field
  that is really there answers with itself or with an icon painted inside it.
  Accepting an *ancestor* would accept every clipped-away field there is, because
  `<body>` contains the field too.
- It runs on `field.getRootNode()`, not the document. For a field inside a shadow
  root the document's own hit test answers with the **host**, never the field, and
  would take the picker down on sight.
- It is skipped when the field's centre is outside the viewport, where there is
  nothing to hit. A field merely **scrolled** out of sight keeps its picker, which
  rides along with it as it always has.

It is rate-limited to ~150ms rather than run per frame: it forces a hit test, and a
dismissal does not need 60Hz. Where it is unavailable (jsdom, any engine without
CSSOM View) it fails open, the way `isVisibleCss` does without `checkVisibility` —
never dismiss on a question you cannot ask.

An `IntersectionObserver` looks like the tool for the clipping case and is not: a
**live** observer never fires when only an ancestor's clip changes, while a fresh
one on the identical page reports zero. `e2e/extension/picker-modal-close.spec.ts`
covers all four, plus the shadow-root and scrolled-away cases that the hit test
must not get wrong.

The relayed picker has no loop of its own (its rect is pushed from the field's
frame, see below), so the same check runs where that rect is taken: on
reposition, and in the MutationObserver, which is the only thing that notices a
route change when nothing scrolled.

`pagehide` takes the picker down too. bfcache freezes the DOM as it stands, and a
picker restored on the return trip would be showing a match set - and a lock
state - from before the trip.

## Writing a value into a field

`fill.ts` writes through the native `value` setter (so React's value tracker sees
a change) and then dispatches the events real input produces: `beforeinput` and
`input` as `InputEvent`s carrying the inserted text and an `inputType`, key
events around a single character, and `change`. A bare `new Event("input")`
carries none of that, and widgets that read `event.nativeEvent.data` rather than
the field's value ignore it.

**Segmented one-time-code widgets** get an extra ladder, because nothing in the
markup says which write a given widget accepts. `fillOtp` tries the code whole
in the first box (a `paste` event, then an `insertFromPaste`), then a character
per box, **checking after each attempt what the boxes actually hold** and
clearing them before falling through. A widget's own re-render overwrites
anything it didn't understand, so reading the boxes back is a truthful test.

Last comes the widget's hidden **mirror** input, if `splitOtpFields` found one:
it holds the assembled code for the form, and on widgets driven by it that write
is what makes the boxes show anything at all. It is never given a single
character, and never the empty string past the end of the code. Doing that was
the bug (see [field-detection.md](field-detection.md)).

Filling a segmented widget means focusing each box in turn, and `focus()` fires a
**trusted** `focusin`. `isFilling()` marks that window so the content script
doesn't read our own focus moves as the user's and reopen the dropdown on the box
it just filled.

### Card and custom fills never write into a hidden field

`fillCard` and `fillCustomFields` skip any field `isRendered` rejects. A form that
hides a box has taken it out of the flow, and filling it anyway can put a secret
somewhere the page never asked for one. The case that prompted the rule: the
Semafone capture frame (see [field-detection.md](field-detection.md)) tokenises
the PAN only, but keeps a `display:none` cvc box whose submit handler still
appends `sf.req.card.securityCode` when it holds a value — so filling it would
send a CVV in a request that was not collecting one. It also stops us feeding the
`data-honeypot-field` inputs Shopify ships alongside its real card number, which
carry genuine `cc-*` tokens and are visually hidden.

`fillForm` is deliberately **not** subject to this. A two-step login can keep its
password field in the DOM but hidden on the identifier step, and filling it there
is the point: the value is waiting when step two renders. The exposure that
motivates the card rule doesn't apply, because a login form isn't assembling a
request out of boxes it has disabled.

`autoFilledFields` carries the other half of the write policy. A value **we**
wrote is off-limits to auto-fill (so a re-query can't re-clobber a field the user
cleared) and fair game for an explicit pick (so choosing a second card in the
dropdown replaces the first rather than silently doing nothing). A value the
**user** typed is never clobbered by a custom-field fill, though an explicit pick
does overwrite the login and card fields — that is what choosing an entry means.

When the vault is locked, the query result still carries `hasPotentialMatch`
(derived by checking known hostnames against the page's registrable domain
without decrypting the index), enough to show a "locked, unlock to autofill" hint
without exposing data.

## Capturing a submitted credential

`capture.ts` decides *when* a typed password counts as submitted. Every path
starts from the same buffer: a trusted `input` on a `type=password` field records
the value (our own `fillField` dispatches are untrusted and don't count).

Two commit policies, because they face opposite constraints:

- **Native `submit`, and Enter inside a password field**: emit **synchronously**.
  These usually precede a full page navigation, which destroys the content
  script, so anything deferred would be lost.
- **A click on a submit control** (`<button>` / `<input type=submit|image|button>`):
  **arm, don't emit.** Formless SPA logins fire no `submit` event at all, so the
  click is the only signal. The credential is snapshotted at click time, because
  by the time we commit the form is gone and there is nothing left to read. The
  commit waits for that password field to stop being rendered, which is the
  evidence the login actually went through. A failed login leaves the field on
  screen and the attempt expires unsaved after `ARM_WINDOW_MS`.

Arming is narrow on purpose. Sites put secondary actions right beside the
password field (skanetrafiken's "Glömt lösenord?" is a `<span role="button">`,
its show-password toggle is a `role="checkbox"` label), and arming on those risks
offering to save a password that was never submitted. Role-based pseudo-buttons
are therefore excluded; relaxing that is safe only because the commit gate, not
the arm gate, is what prevents the prompt.

While armed, the commit condition is polled (`ARM_POLL_MS`, bounded by the arm
window) rather than left to the MutationObserver, which only watches `childList`
and would miss a form hidden by a class on an ancestor. `hashchange`/`popstate`
also drive a check; `history.pushState` fires no event and cannot be patched from
a content script's isolated world, so it is not a signal we can use.

Re-typing the password disarms any pending attempt, which is the ordinary
retry-after-failure path. A legacy fallback still fires when a password field
vanishes within 1500ms of the last keystroke, covering submits driven by
mechanisms none of the above observe.

"Stops being rendered" is the load-bearing wording, and it is not the same as
"is removed". Verified against skanetrafiken's own application, replayed from a
HAR recording (`e2e/hars/`): on a successful login it swaps in the account view
and leaves the password input **connected to the document at 0x0**. A gate keyed
on detachment alone never fires there, which is also why the legacy fallback,
whose check is a bare `input[type=password]` selector with no visibility filter,
could not have saved on that site even inside its window.

## The corner prompt

When the user submits a login form with credentials Bramble does not have, or
that differ from what it has stored, the content script renders an in-page
top-right card offering to save or update.

- The **background owns the dedupe decision**; the content script just renders the
  kind it is handed (`save-login` or `update-login`).
- Each capture gets a `promptId` UUID that rides the round-trip back on the
  response. A stale prompt (vault locked then unlocked, page restored from
  bfcache) cannot commit, because its id no longer matches the live stash.
- An `update-login` prompt lists candidate logins whose stored password differs
  from the submitted one. More than one candidate shows a radio group.
- On `save`, an unambiguous single update-candidate is upgraded to an update;
  multiple candidates mean the user explicitly chose "Save", so it stays a new
  entry (supports multiple accounts on one site).

When the vault is locked the background cannot dedupe (no index). The card's
primary button becomes "Unlock & save" and the response action becomes
`save-unlock-first`, which routes through the popup unlock flow. The capture is
stashed per registrable domain in `chrome.storage.session`; if the page navigates
away before the prompt is shown, the next page picks the stash back up. The
commit itself goes through the background, which writes directly to
`chrome.storage.local` (headless, no gesture; see [storage.md](storage.md)).

### Suppressing the browser's own dropdown, without blinding ourselves

While the picker is anchored to a field it writes `autocomplete="off"` on it, so
the browser's native dropdown doesn't render on top of ours, and restores the
original the moment the anchor moves.

That write is skipped for a field declaring `one-time-code`, because on a
segmented widget that token is often the only thing marking the boxes, and
detection's strongest rung is a query for it. Overwriting it took the anchor out
of the model at the next re-parse (our own host insertion triggers one), so
`currentTargetKind` came back null and the pick was refused: the dropdown opened,
the row was there, and clicking it did nothing. Cloudflare's 2FA form is the case
that showed it, and `e2e/extension/totp-segmented-fill.spec.ts` is what holds it.
Nothing is lost by skipping: a desktop browser has no stored one-time code to
offer, so there was no native dropdown to get out of the way of.

The general rule the incident leaves behind: **do not write over an attribute
detection reads**. The same hazard sits under `autocomplete="username"` on an
identifier-first page, where the token can be the only signal; that one still
suppresses, and would need the same treatment if it ever bites.

It bit a second time in a different shape: not detection reading the attribute,
but a **decision re-read after the write**. `new-password` is the token that
scores a signup, so classifying save-vs-update at the moment the user clicks the
suggestion scored a form that no longer described itself, and the signup's "save"
became an "update". Both decisions a suggestion carries -- the password and
whether accepting it creates a login -- are now settled together in
`maybeSuggest`, which runs before the picker anchors, and cached on the field.
Regenerating swaps the password and keeps the classification.

The corollary to the rule above, then: **anything derived from an attribute the
picker suppresses must be computed before it anchors, not on the pick.** Unit
tests cannot see this, because they mock the picker and it never performs the
write; `e2e/extension/suggest-password.spec.ts` is what caught it and what holds
it.

## UI isolation: extension-origin iframe and closed shadow DOM

The **match dropdown** renders in a cross-origin **iframe** served from the
extension origin (`autofill-ui.html`, a `web_accessible_resource`), injected by
the content script (`autofill-ui.ts` is the iframe document). This is a true
origin boundary: the page cannot read the iframe's DOM
(`iframe.contentDocument === null`), reach its rows, or synthesize a trusted
click inside it. Entry ids and row text live only inside the iframe, never in a
page-readable surface. Content-script-injected web-accessible-resource iframes are
exempt from the host page's `frame-src` CSP, so this works even on strict-CSP
sites; the one header that blocks it is `Cross-Origin-Embedder-Policy:
require-corp`, where a readiness race on the iframe's `AUTOFILL_UI_READY` ping
times out and the content script falls back to the closed-shadow dropdown.

The iframe holds **no secrets**. It receives only summaries (name + masked
secondary) over `postMessage` and reports the user's pick back; the fill still
happens in the content script against the real page inputs, and the background
returns secrets only to the initiating content script's original request. The trust hinges on two
origin checks the page can't forge:

- The content script honors an iframe message only when `event.source ===
  iframe.contentWindow` **and** `event.origin === <extension origin>` (both
  browser-set). A page's `window.postMessage` carries the page origin and a
  different source, so it is dropped. The extension origin is taken from the
  iframe's own `AUTOFILL_UI_READY` handshake (it must arrive from that window, on
  the extension's url scheme) and pinned for every later message in both
  directions - **not** from `runtime.getURL()`. Under Chromium's manifest
  `use_dynamic_url`, getURL hands a content script a per-session GUID origin while
  the document it loads reports the extension's static origin, so comparing
  against the src origin drops every message both ways: READY never lands and the
  picker silently falls back to the shadow renderer on every page.
- The iframe accepts a parent message only when `event.source === window.parent`
  and `event.origin === <page origin>` (passed on the iframe `src` as
  `?parentOrigin=`), and posts back pinned to that origin.

Because the page controls the iframe element's geometry, `pickIsTrustworthy()`
runs a **pick-time visibility check** before honoring a pick: the host must be
on-screen, legibly sized, opaque, visible, unclipped, and not overlaid
(`elementFromPoint` at its center must resolve to the host). This blocks a
clickjacking page that hides/moves/overlays the iframe to coax a real click - the
case that matters being cards, which are offered on every site.

### Relayed placement: hosted-fields checkouts

A card input on a hosted-fields checkout (Shopify, Stripe Elements, Braintree,
Adyen) lives in a cross-origin iframe sized to the input itself; Shopify's is 47px
tall with `scrolling="no"`. A picker mounted in that document is positioned below
the field, and therefore below the frame's viewport, and an iframe cannot paint
outside its own box. The field was always detected; there was simply nowhere to
draw, so nothing appeared at all.

The fix splits **who owns the element** from **who owns the conversation**:

- The **top frame** creates, parks, sizes and destroys the iframe element
  (`relay-host.ts`). It never sees summaries or picks.
- The **field's frame** keeps the channel with the UI document
  (`relay-client.ts`), exactly as a non-relayed picker does. It still calls
  `AUTOFILL_SELECT` on its own verified background channel and fills its own
  inputs, so the secret path is unchanged and no background message types were
  added.

Geometry walks up the frame tree in `frame-relay.ts`, each hop adding its frame
element's box plus border and padding. A hop is honoured only when `event.source`
is the `contentWindow` of a frame element in that document, which a script in that
frame cannot impersonate. **Only geometry and an opaque relay id travel this way**:
every hop is a `message` event on a window the page shares with us, so summaries,
entry ids and secrets must never ride it.

The **UI announces itself** and the field's frame **pins the announcement whose
`event.origin` is one of our own extension origins**. That check is the whole trust
boundary, so it must never be relaxed to a bare `chrome-extension://` scheme test,
which any installed extension would pass.

The handshake runs in that direction and not the other because `window.frames`
exposes only *document-tree* child browsing contexts, and the host parks the UI
inside a **closed shadow root**, which puts it in a shadow tree. The field's frame
therefore cannot reach the UI by index at all: `window.top.length` counts 1, not 2.
The UI can still walk outward from `window.top`, so it does the announcing. This
was found by e2e, not by reasoning, and reversing it keeps the closed shadow root
without weakening anything, since the pin was always decided by origin rather than
by who spoke first.
A content script cannot use `runtime.getURL()` for this: under `use_dynamic_url`
that returns a per-session GUID origin while the document reports the static
`chrome-extension://<id>`. `ext-origin.ts` accepts both, since both are ours.

Four checks carry the security of the relayed path, all in `relay-client.ts`:

1. The UI window is pinned from a probe reply on one of our origins, and never
   rebinds.
2. Summaries are posted to that pinned window with an exact `targetOrigin`, never
   `"*"`.
3. An inbound message is honoured only when `event.source` **and** `event.origin`
   both match the pinned peer.
4. A pick must name an entry we actually rendered.

Check 4 exists because the UI document is reachable by anything in the tab, so it
is treated as untrusted plumbing rather than a trusted peer. A page that posts rows
into it can relabel what is on screen (which it could equally do with its own DOM),
but it cannot name an entry we did not offer, cannot make a pick reach us from
anywhere but the pinned window, and cannot produce a pick at all without a genuine
user click inside the UI document.

The anti-clickjacking guard moves with the element. Because the pick never passes
through the top frame, `pickIsTrustworthy()` cannot run at pick time, so
`relay-host.ts` evaluates the same conditions continuously on its rAF loop and
destroys the host the moment it stops being legible. That is prevention rather than
detection, and the page cannot suppress it: the verdict comes from computed style
the top frame reads itself, not from any message.

Keyboard nav works without moving focus off the page field: when the iframe is
open, the content script forwards only Up/Down/Enter/Escape to it as `UI_KEY`
(never characters). The iframe moves a highlight and reports back whether a row
is selected (`UI_HIGHLIGHT`), which gates Enter - with a highlight, Enter picks
that row; without one, Enter falls through so the form submits normally.

The **corner prompt** (save/update) still renders in a **closed shadow root**
(`attachShadow({ mode: "closed" })`): `host.shadowRoot` is `null`, page CSS can't
reach in, and the captured username/password in its inputs aren't page-readable.
This is defense-in-depth, not a hard origin boundary (the host lives in page
light DOM, so a site can tell a prompt exists). Note the captured credential is
one the user just submitted to the page's own form, so that origin already holds
it; the boundary guards against incidental exposure, not a page-unknown secret.

## Threat model: what the fill path defends against

Two attacks a hostile page could mount to steal credentials through autofill, and
the layered defenses that stop them. Cards are the prize in both, because cards
are offered on **every** site (not hostname-scoped), so any page can list and try
to exfiltrate them.

**1. Silent (zero-click) exfiltration.** A page tries to drive a fill with no
user interaction, then reads the injected value back out of its own form. It
might dispatch a synthetic `mousedown` at a dropdown row, or post a forged
`UI_PICK` to the content script. This is the worst case: just visiting the page
would leak data, no social engineering needed. Stopped by three independent
layers:

- the dropdown's `mousedown` handler bails on `event.isTrusted === false`, so a
  synthetic event can't pick (the capture listeners gate the same way);
- the dropdown renders in a cross-origin iframe the page can neither read nor
  dispatch events into;
- the content-script bridge honors a `UI_PICK` only when its `source`/`origin`
  are the real iframe, so a page's own `postMessage` is dropped.

**2. Clickjacking (UI redress).** The page can't fake a click, so it tricks the
user into a *real* one. It makes the dropdown invisible (`opacity`), tiny, or
off-anchor, or covers it, and lines a row up under something the user means to
click (a play button, a cookie banner). The click is genuine and lands in the
iframe, so every other defense passes, but the user never knew they were filling
a credential and the page reads it back. Stopped by `pickIsTrustworthy()`, which
honors a pick only when the host is actually visible to the user: on-screen,
legibly sized, opaque, unclipped, and not overlaid (`elementFromPoint` at its
center resolves to the host).

**Blast-radius containment.** If a fill is somehow triggered anyway,
`authorizeFill` (background) still requires a **login** to match the verified
page origin before secrets are returned, so a login can't be filled on a site it
isn't registered for. Cards are deliberately site-agnostic and have no such
backstop, so the visibility guard above is their main protection, which is why it
matters most for them.

These are defense-in-depth, not guarantees: clickjacking in particular is an arms
race, and the visibility heuristics catch the obvious cases (hidden, tiny,
overlaid) rather than every clever partial overlay.

## Password generation

The login form's generator (`randomPassword` in `app/entry-modes/login.tsx`)
produces a 16-character password from an 88-character set. Because 88 does not
divide 256, `byte % n` would over-represent the first `256 % n` characters, so it
**rejection-samples**: only bytes in the largest multiple-of-n slice of `[0, 256)`
are accepted, giving every position equal probability. Bytes are drawn in 16-byte
chunks to amortise the `getRandomValues` call; worst-case expected rejection rate
at n=88 is about 12.5%.

The content script carries its own copy of the same algorithm
(`content/password-gen.ts`, 20 characters) for the signup suggestion below, since
it is a flat bundle with no cross-package runtime imports.

## Suggesting a strong password on signup and password change

When the user focuses a password field that looks like account creation or a
password rotation (see [field-detection.md](field-detection.md), "Signup
detection"), the dropdown shows a **generated-password row** above any matches: the
suggested password in monospace with a "Use suggested password" caption and a
regenerate button. Both renderers carry it (`content/html/dropdown-suggest.ts` for
the shadow fallback, `suggestRow` in `autofill-ui.ts` for the iframe), navigable by
keyboard like any other row.

The suggestion is generated **in the content script** and passed to the iframe as
render data, never fetched from the vault. Choosing it (`UI_USE_SUGGESTED`, gated
by the same anti-clickjacking `pickIsTrustworthy` check as a secret pick):

1. fills the new-password field and any confirm sibling (`fillPasswordFields`,
   which records the value so a later real submit won't re-prompt), leaving a
   change form's current-password box for the user, and
2. fires a `CORNER_PROMPT_CAPTURE` with whatever username/email the user already
   typed plus the generated password, reusing the entire corner-prompt save path
   above (including the navigation-surviving stash).

The corner prompt's own dedupe then decides the rest: on a signup form (no matching
login) it offers **Save**; on a change-password form (an existing login for the
site) it offers **Update**, and `commitCornerUpdate` rotates the password on the
chosen entry. Because a change form has no username field the capture's username is
empty, so the update **keeps the entry's existing username** rather than blanking
it. The row is offered only on an empty field, and never on the current-password
field itself.

### The rest of an account-creation form offers nothing

A signup form is where the user is **inventing** a credential, so the fields around
that password box have nothing to fill. Existing matches on the email field are
clutter, and while the vault is locked the row is worse than clutter: it offers a
window and a master password to fill a form that fills nothing. Both are now
suppressed (`isCreationField`), leaving the generated-password row as the only thing
the picker says on a signup form.

`isAccountCreationForm` answers this for the password field; its neighbours cannot
ask it, since there is nothing in an email box that says "signup".
`isOnAccountCreationForm` puts the question to the form's own new-password field
instead. The verdict is cached per field, for the reason the suggestion is: the
picker rewrites its anchor's `autocomplete` to suppress the native dropdown, so a
form re-read after it has anchored no longer describes itself. Caching also keeps
the scoring off the per-keystroke path, since `input` re-decides what to show.

A signup split across steps has no password box to score, so it is judged on a
**confirm-email pair** instead: a form that asks for the email twice. That is the
only signal safe enough to act on there. A two-step *login*'s email screen is a
signup's email screen minus one field, and the page-level signals cannot tell them
apart — a `/signin` route with a "Create account" link scores like a signup — while
getting it wrong silently kills autofill on the screen where it is worth the most.
`e2e/extension/signup-picker.spec.ts` guards every suppression case with the
two-step login screen it must not swallow.
