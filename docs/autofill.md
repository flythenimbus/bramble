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
`hasCard`, `hasOtp`), so the background only returns the relevant lists.

## Hostname matching and subdomain policy

`hostnameMatches` (background) returns true when the page hostname matches any of
a login's registered hostnames under that entry's **subdomain match** policy:

- `etld1` (default): the registrable domain and all its subdomains.
- `exact`: that exact hostname only.
- `subdomain`: this domain plus its subdomains.

The query hostname is derived from the **verified message sender**
(`sender.origin` / `sender.url` / `sender.tab.url`), not from the message body, so
a content script cannot request matches for a different domain.

## The fill model: secrets fetched only on explicit pick

A single login match does **not** auto-inject the password on page load. Doing so
would put the password in the DOM where scripts on a cross-registered domain
could read it. Instead:

1. On focusing a candidate field, the dropdown shows the matching entries
   (`query` returns only summaries: name plus a username or masked `•••• 1234`).
2. The user picks one.
3. Only then does `fetchFill` return the actual secrets for that entry.

Cards always used this safer pattern; logins and OTP codes follow it too.

The pick must be a **trusted gesture**: the dropdown's `mousedown` handler bails
on `event.isTrusted === false`. Without this, page script could dispatch a
synthetic `mousedown` at a dropdown row to drive `fetchFill` and read the filled
value back. It matters most for cards, which are offered on every site (not
hostname-scoped), so any page could otherwise have silently exfiltrated every
stored card. The capture listeners gate on `isTrusted` for the same reason.

The background re-checks the pick as defense-in-depth (`authorizeFill`): on
`AUTOFILL_SELECT` it resolves the chosen entry and, **for a login**, requires
`hostnameMatches` against the *verified sender* before returning secrets, so a
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
commit itself goes through the background, which writes directly when it can or
queues a pending blob when the vault is FSA-backed (see [storage.md](storage.md)).

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
still returns secrets only to the content-script tab. The trust hinges on two
origin checks the page can't forge:

- The content script honors an iframe message only when `event.source ===
  iframe.contentWindow` **and** `event.origin === <extension origin>` (both
  browser-set). A page's `window.postMessage` carries the page origin and a
  different source, so it is dropped.
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
