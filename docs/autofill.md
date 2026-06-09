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

## Password generation

The login form's generator (`randomPassword` in `app/entry-modes/login.tsx`)
produces a 16-character password from an 88-character set. Because 88 does not
divide 256, `byte % n` would over-represent the first `256 % n` characters, so it
**rejection-samples**: only bytes in the largest multiple-of-n slice of `[0, 256)`
are accepted, giving every position equal probability. Bytes are drawn in 16-byte
chunks to amortise the `getRandomValues` call; worst-case expected rejection rate
at n=88 is about 12.5%.
