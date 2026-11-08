# Launch and fill (extension)

Status: plan, 2026-11-07, revised 2026-11-08 for same-site frames. Builds on #141 (open a login's
website from the vault) and answers #156 (autofill on page load) with a narrower rule.

## What it does

Clicking "Open website" on a login in the extension, on its vault-list row or in its view, opens
the site in a new tab and fills that login there once, with no pick from the dropdown.

Nothing else about filling changes. A page opened any other way still waits for a pick (see
[autofill.md](autofill.md), "The fill model"). The desktop and mobile apps keep plain links: they
hand the URL to the system browser, which Bramble can't fill this way.

## The rules

A launch creates a **grant**: the tab id, the login id, the unlocked session it was made in, and
an expiry. It lives in the background's memory and holds no secret.

The tab is filled when all of these hold:

- the request comes from that tab's top frame (`frameId` 0), as the browser reports the sender,
  or from a frame that passes "Same-site frames" below;
- the page's host matches the login, by `authorizeFill`'s rule (subdomain policy and port
  included). For a frame, that is the frame's own host;
- the grant is under 60 seconds old (`LAUNCH_FILL_TTL_MS`);
- the session that made it is still the unlocked one, so a lock or a vault switch ends it;
- the page has a rendered, empty password field on a form that isn't setting a password
  (`shouldSuggestPassword` says no);
- autofill is on in Settings, and the login's own "Enable autofill" is on.

The first fill spends the grant. Closing the tab ends it. Navigating inside the tab doesn't: the
launch itself navigates, and a redirect to the login page is the common case. A page that fails
the host check gets nothing and leaves the grant for the real site.

The fill is the dropdown's own fill with `isAuto`: the same field choice, the login's own
auto-submit setting, and the same captcha check before submitting.

A two-step login (an email page, then a password page) fills on the password page. The email page
waits for a pick, because a lone email box looks the same as a newsletter signup.

A login form shown by CSS after load, with no DOM change, fills when one of its fields is first
focused: the content script checks again on focus.

## Same-site frames

A login form in an iframe on the site's own domain fills too, like `accounts.example.com` inside
`www.example.com`. On top of the rules above, a frame needs all of these:

- the tab's top page matches the login, by the same host rule;
- the frame is same-site as the top page (`sameSiteAsTop`, from the browser's account of the
  sender);
- the frame is visible on the page. A field can be rendered inside a frame that is zero-size,
  offscreen or covered, so each parent's content script checks the iframe element, over the
  relay's per-hop frame binding (see "Relayed placement" in [autofill.md](autofill.md)). Unlike
  the picker's checks, this one fails closed;
- the top frame has queried and reported no login field.

The last rule stops a same-site widget with its own password field from spending the grant ahead
of the real form. A frame that asks before the top frame has queried doesn't get `launch: true`.
It shows the dropdown, unless a later re-check, such as the one on focus, finds the top frame has
answered.

## How it flows

1. **Popup.** `OpenWebsiteLink` calls `shell.launchLogin(entryId, url)` on a plain left click.
   Modifier and middle clicks keep the browser's own link behaviour. If the background can't be
   reached, the shell opens the URL itself.
2. **Background, `AUTOFILL_LAUNCH`** (extension pages only). Opens the URL in a new tab in the last
   focused normal window, or a new window when there is none, and arms the grant when the login
   qualifies. The tab opens either way.
3. **Background, `AUTOFILL_QUERY`.** The page's query answer carries `launch: true` when a live
   grant matches it. Never the login's id.
4. **Content script.** Sends `AUTOFILL_LAUNCH_CLAIM` once per page when the password field
   qualifies and, in a frame, the frame is visible. The answer has the same shape as
   `AUTOFILL_SELECT`'s.
5. **Background, `AUTOFILL_LAUNCH_CLAIM`.** Re-checks every rule against the verified sender,
   spends the grant and returns the fill.

## Immediate auto-lock

With auto-lock set to "Immediately", the vault locks when the last extension view closes, and
opening a tab closes the toolbar popup. A qualifying launch therefore holds the vault open for 15
seconds (`LAUNCH_VIEW_GRACE_MS`), the way a pop-out holds it across its handoff (`armViewGrace`).
A page slower than that finds the vault locked and shows the locked dropdown, as today.

## Threat model

- **No page can start it.** Only an extension page can send `AUTOFILL_LAUNCH`; a content
  script's request is refused.
- **The wrong site.** The host check runs on the browser-verified sender, so a redirect, an open
  redirect or an ad landing in the tab gets nothing.
- **Cross-site frames.** Never filled. The grant survives navigation, so an open redirect could
  land the tab on a page that embeds the real login in an iframe. The frame's host would pass the
  host check, and the fill would happen with no pick, inside a page the attacker controls. The
  attacker can't read a cross-origin frame, but could log the user in and frame the session for
  clickjacking. Requiring the top page to match the login stops this.
- **Hidden frames.** Silently filling a hidden frame is the classic password manager attack, which
  is why a frame has to be visible on the page and why that check fails closed.
- **A script on the right site.** It can read what was filled, without the pick a normal fill
  waits for. That is the cost of the feature, bounded to the site the user chose to open, once,
  within 60 seconds. #156 asked for the same risk on every page load; here it applies to one page
  opened on purpose.
- **A service worker restart** drops the grant (it is in memory), and the page falls back to the
  dropdown.

## Not covered

- Forms inside cross-site iframes, such as a login frame hosted on a vendor's domain. They keep the
  dropdown, because the page can't vouch for them.
- The email step of a two-step login.
- The desktop and mobile apps.

## Tests

- `clients/extension/src/background/launch-fill.test.ts`: opening the tab, arming only for a
  qualifying login, the query flag, the claim's checks, one fill per grant, expiry, tab close,
  lock, and the frame rules (top page match, same-site, the top frame reporting a login field).
- `clients/extension/src/background/view-lock.test.ts`: the Immediate-mode hold.
- `clients/extension/src/content/content.dom.test.ts`: when the page claims, when it doesn't, and
  a frame that isn't visible not claiming.
- `packages/core/src/app/components/OpenWebsiteLink.test.tsx` and
  `clients/extension/src/shell.test.ts`: the click.
- `e2e/extension/launch-fill.spec.ts`: a real launch fills; a reload doesn't; another site doesn't;
  a same-site frame fills; a cross-site frame doesn't; a matching frame under a mismatched top page
  doesn't; a hidden frame doesn't.
