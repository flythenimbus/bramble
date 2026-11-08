# Launch and fill (extension)

Status: built 2026-11-08, Chromium e2e only; not tried on Firefox. Builds on #141 (open a login's
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
- the frame is visible on the page;
- the top frame has no rendered password field of its own.

The last two are the top frame's to answer, so the background asks it at claim time
(`AUTOFILL_LAUNCH_TOP_CHECK`, `frameId` 0). It can't wait for the top frame's query: a page with
no fields of its own never sends one, and that is the usual page around a login frame.

A field can be rendered inside a frame that is zero-size, offscreen or covered, so the frame's own
view isn't enough. The claim carries the frame's size, and the top frame looks for an iframe of
that size that passes `isLegible`: on screen, opaque and not covered at its centre. No answer is
a no, so a top frame still loading, or a frame it can't find, leaves the dropdown, and the frame
can claim again on focus.

The password-field rule stops a same-site widget with its own password field from spending the
grant ahead of the real form.

A launch needs the page to be visible, not focused: a frame doesn't have focus on load.

## How it flows

1. **Popup.** `OpenWebsiteLink` calls `shell.launchLogin(entryId, url)` on a plain left click.
   Modifier and middle clicks keep the browser's own link behaviour. If the background can't be
   reached, the shell opens the URL itself.
2. **Background, `AUTOFILL_LAUNCH`** (extension pages only). Opens the URL in a new tab in the last
   focused normal window, or a new window when there is none, and arms the grant when the login
   qualifies. The tab opens either way.
3. **Background, `AUTOFILL_QUERY`.** The page's query answer carries `launch: true` when a live
   grant matches it. Never the login's id.
4. **Content script.** Sends `AUTOFILL_LAUNCH_CLAIM` when the password field qualifies, with its
   size if it is a frame. The answer has the same shape as `AUTOFILL_SELECT`'s. A refused claim
   shows the dropdown and can be tried again on focus; the grant still limits it to one fill.
5. **Background, `AUTOFILL_LAUNCH_CLAIM`.** Re-checks every rule against the verified sender, asks
   the top frame if the sender is a frame, spends the grant and returns the fill.

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
  is why a frame has to be visible on the page and why that check fails closed. The size match
  doesn't prove which iframe asked, so a same-site page could pair a hidden frame with a visible
  one of the same size. That falls under the next item.
- **A script on the right site.** It can read what was filled, without the pick a normal fill
  waits for. That is the cost of the feature, bounded to the site the user chose to open, once,
  within 60 seconds. #156 asked for the same risk on every page load; here it applies to one page
  opened on purpose.
- **A service worker restart** drops the grant (it is in memory), and the page falls back to the
  dropdown.

## Not covered

- Forms inside cross-site iframes, such as a login frame hosted on a vendor's domain. They keep the
  dropdown, because the page can't vouch for them.
- Frames nested inside another frame. The top frame can't see them, so they keep the dropdown.
- The email step of a two-step login.
- The desktop and mobile apps.

## Tests

- `clients/extension/src/background/launch-fill.test.ts`: opening the tab, arming only for a
  qualifying login, the query flag, the claim's checks, one fill per grant, expiry, tab close,
  lock, and the frame rules (top page match, same-site, the top frame's answer).
- `clients/extension/src/background/view-lock.test.ts`: the Immediate-mode hold.
- `clients/extension/src/content/content.dom.test.ts`: when the page claims, when it doesn't, and
  the top frame's answer.
- `packages/core/src/app/components/OpenWebsiteLink.test.tsx` and
  `clients/extension/src/shell.test.ts`: the click.
- `e2e/extension/launch-fill.spec.ts`: a real launch fills; a reload doesn't; another site doesn't;
  a same-site frame fills; a cross-site frame doesn't; a matching frame under a mismatched top page
  doesn't; a hidden frame doesn't; a frame yields to the top page's password field.
