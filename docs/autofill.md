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
