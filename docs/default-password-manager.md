# Default password manager (extension)

Issue #135. The extension can switch the browser's own password manager off, so the browser and
Bramble don't both offer to save and fill.

## What it changes

`chrome.privacy.services.passwordSavingEnabled` goes to `false` on both browsers, and
`autofillCreditCardEnabled` too on Chromium (Firefox has no card setting). Addresses are left
alone: Bramble has nothing to fill them with. Turning it off calls `clear()` on each, which hands
the setting back to the browser, then gives up the permission. Chrome also reverts both when the
extension is removed.

A setting held by a policy or another extension (`not_controllable`,
`controlled_by_other_extensions`) reads as "locked", and the Settings switch is disabled.

## Where it's offered

- Settings, beside "Autofill on web pages": a "Default password manager" switch.
- The vault list: a one-time card under the list (the review-nudge slot, which wins when both
  apply). Dismissing it stores `pref.defaultManagerPromptDismissed`; taking it hides it because
  the state is no longer "browser".

## The permission is the choice

`privacy` is an optional permission, so installing or updating never asks for it, and it is held
only while Bramble is the default. That makes "do we hold `privacy`" the stored choice, with no
pref to drift from it.

The grant has the same two problems the desktop link's optional permission had (see
[desktop-link-optional-permission.md](desktop-link-optional-permission.md)):

1. In the toolbar popup the permission dialog destroys the page, so the code after `request()`
   never runs.
2. Chromium fixes a context's API bindings when it is created, so a context that existed before
   the grant may not see `chrome.privacy`.

So every context that can see the API reconciles: holding the permission with the password setting
still the browser's means "apply it now". The background does this on `permissions.onAdded` and at
every start; the page does it whenever it reads the state. A page that holds the permission but
has no binding reports "bramble" and leaves the switching to the next context.

`permissions.request()` must be the first `await` after the click: Firefox accepts the request only
while the click is being handled.

## Tests

- `clients/extension/src/browser-saving.test.ts`: the state mapping, the order of the calls, a
  refused grant, Firefox's missing card setting, reconcile with and without the binding.
- `e2e/extension/default-password-manager.spec.ts`: the shipped build holds no grant, and a build
  that holds it from install has the background take over the real Chromium settings. The grant
  itself raises native UI that Playwright can't click, so it is untested here.
