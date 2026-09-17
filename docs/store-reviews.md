# Asking for a store review

Bramble asks for a store review at most twice per install, and only after it has been used for a
while. This describes what decides that, why it is shaped differently on iOS than in the browser,
and what to check before shipping a change to it.

## What exists

| Piece | Where |
| --- | --- |
| The policy (thresholds, state, store URLs) | `packages/core/src/app/review-nudge.ts` |
| The hook that counts usage and decides | `packages/core/src/app/hooks/useReviewNudge.ts` |
| The card (extension only) | `packages/core/src/app/components/ReviewNudgeCard.tsx` |
| The permanent link | Settings -> About -> "Rate Bramble" |
| iOS native prompt | `packages/platform-mobile/ios/App/App/AppReview.swift` |
| Persisted counters | `pref.reviewNudge`, device-scoped |

## Tuning it

Every number lives in one object, `REVIEW_NUDGE` in `review-nudge.ts`:

```ts
export const REVIEW_NUDGE: ReviewNudgeTuning = {
	minInstallAgeDays: 14,
	minSessions: 10,
	minEntries: 3,
	maxAsks: 2,
	daysBetweenAsks: 90,
};
```

Change those and nothing else needs touching. `shouldAskForReview` takes the tuning as a defaulted
third argument, so a test can pin its own values rather than inheriting whatever shipped, and
`review-nudge.test.ts` derives its fixtures from the constants rather than hardcoding 14 and 10.

A "session" is one mount of the vault list with the vault open. On the extension the popup is a
fresh document per open, so that is one per open; on a long-lived mobile or desktop window it is one
per mount. Counting stops for good once `isReviewNudgeDone` is true, so a settled install is not
writing a storage key on every popup open to increment a number nothing will read.

## Why iOS has no card

Apple supplies the prompt (`AppStore.requestReview`, falling back to
`SKStoreReviewController.requestReview(in:)` below iOS 18) and owns its frequency policy: at most
three per app per year, suppressed once the current version has been rated, and we are never told
whether anything appeared. The HIG forbids firing it from a button, so `useReviewNudge` calls it
from a moment the policy picked and renders nothing. Our own counters still spend an ask, because
the alternative is asking StoreKit on every launch forever.

The Settings "Rate Bramble" row is the button path, and it deliberately does not use the API: it
opens `https://apps.apple.com/app/id6783071787?action=write-review`, which is what Apple expects a
tap to do.

## Why the browser has a card

Neither the Chrome Web Store nor addons.mozilla.org has an in-product review API. There is no
equivalent of `SKStoreReviewController`, so the only mechanism available is a link to the listing's
reviews tab, and the only frequency policy is the one we impose.

The card offers "Leave a review" and "Report an issue" side by side, flat, with no question in front
deciding which one a person sees. Sending the happy answers to the store and the unhappy ones
somewhere quieter is review manipulation whatever the wording, both stores prohibit it, and someone
with a complaint is better served by the issue tracker being offered than withheld.

## Store policy

Both stores forbid incentivised or manipulated reviews. Neither forbids asking. Chrome's quality
guidelines additionally forbid unexpected or interrupting UI, which is part of why this is an inline
card under the list rather than a dialog: a password manager that blocks the path between someone
and their password to ask a favour has earned the one-star review it is about to get.

## Seeing it without waiting a fortnight

The dev flag panel (Cmd/Ctrl + Shift + Alt + F) has **Arm review ask** and **Reset review ask**.
Arm writes `qualifyingReviewNudgeState`, which is derived from `REVIEW_NUDGE` rather than
hardcoded, so it keeps qualifying after a retune. Reopen the view to pick the change up: the panel
sits above `PrefsProvider` so it writes storage directly, and on the extension popup reopening is
the normal way you would look anyway.

It deliberately does not fake the entries gate, so the vault still needs its three. And it is two
actions rather than a toggle: a switch that forced the card on would bypass the policy you are
trying to look at. It is not a flag either, because `flags.json` is compiled into core-rust key by
key and a UI-only entry there would put a review-prompt constant in the crypto core.

## Testing it on iOS

Two things get in the way, and only one of them is ours.

**No keyboard.** The flag panel's shortcut cannot be pressed on a phone, so Settings -> About
opens it too: tap the version number seven times inside three seconds. A pause abandons the run
rather than banking it, so idle taps never accumulate into an opening in front of a user. The
request travels through `app/dev-flags-open.ts`, because the panel is mounted above every provider
and has no props from Settings.

**StoreKit does nothing in TestFlight.** That is Apple's design, not a bug to chase. The rating
sheet appears in a debug build (device or simulator) and in an App Store build, and nowhere else.
So arm the ask in a build you ran from Xcode, not in the TestFlight one.

Remember there is no card on iOS. A successful test looks like Apple's own rating sheet appearing,
or like nothing at all if StoreKit decides it has shown enough of them this year. Our side spending
its ask is the only thing we can actually observe: `asks` goes from 0 to 1 in `pref.reviewNudge`.

Failing all that, mobile prefs are Capacitor Preferences under a `meta:` prefix, so Safari Web
Inspector attached to the webview can arm it directly:

```js
await Capacitor.Plugins.Preferences.set({
  key: "meta:pref.reviewNudge",
  value: JSON.stringify({
    installedAt: Date.now() - 15 * 86400000,
    sessions: 10,
    asks: 0,
    rated: false,
  }),
});
```

## Before shipping a change

- **Click all three URLs.** The CWS and AMO path formats have both changed in the last few years,
  and `STORE_REVIEW_URL` is the only place they are written down.
- **The iOS prompt cannot be seen in TestFlight.** StoreKit does nothing there by design. Use a
  debug build or the simulator; an App Store build is the only other place it appears.
- **New copy needs `pnpm i18n`.** The card and the Settings row use Lingui macros, so untranslated
  strings silently fall back to English.
