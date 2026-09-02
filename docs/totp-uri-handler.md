# Inbound `otpauth://` URIs on iOS and Android

How Bramble becomes one of the apps the OS offers when a user sets up a 2FA code
somewhere else: the **Set Up Codes In** list on iOS, and the ordinary app chooser on
Android.

**Status: built, not yet device-verified.** Every phase below is implemented and covered
by unit tests; nothing here has been exercised on a real iPhone or Android handset. The
device checklists in each phase are the outstanding work, and the closing table lists what
could still turn out to be wrong.

Fast-moving platform facts are dated **September 2026** and flagged where unverified.
Re-verify before acting on them later.

## This is setup, not fill

Two different capabilities share the word "codes". Do not conflate them.

- **Filling** a one-time code into a login form. Already shipped on both platforms
  through the native autofill provider; the seed stays in the vault and only digits
  reach the page. See [totp.md](totp.md) and [autofill.md](autofill.md).
- **Setting up** a code: another app or a website hands Bramble an `otpauth://` URI so
  it can be saved against a login. This is what is missing, and what this plan adds.

## What the OS actually offers

| | iOS | Android |
|---|---|---|
| Mechanism | `otpauth` in `CFBundleURLTypes` | `VIEW`/`BROWSABLE` intent filter on scheme `otpauth` |
| Where the user sees it | Settings > Apps > Passwords > **Set Up Codes In** | The standard "Open with" chooser |
| Selection model | One system-wide default handler | Per-invocation chooser, with "always" |
| API involved | None. Plain URL scheme registration | None. Plain intent filter |

Apple has confirmed the mechanism directly on the developer forums: an app appears in
that list if it registers itself as a handler of the `otpauth` URL scheme. There is no
AuthenticationServices API for it, and it is unrelated to the credential-provider
extension Bramble already ships. Android has no equivalent settings list at all; it
simply routes `otpauth://` VIEW intents through the chooser, which is what Bitwarden
and FreeOTP rely on.

**Known flakiness (iOS).** The Settings section appeared and then vanished across the
iOS 16 betas, and iOS 15 had the built-in Passwords app swallowing `otpauth://` links
outright. Treat "Bramble is listed under Set Up Codes In" as a device-test result, not
a given. The registration is worth doing regardless: it also makes Bramble the target
for any `otpauth://` link tapped anywhere on the device.

## Bottom line

- **The platform work is two lines.** One `CFBundleURLTypes` key, one `<intent-filter>`.
  Nothing to build natively: `AppDelegate.swift` already proxies `application(_:open:)`
  to Capacitor, `MainActivity` already extends `BridgeActivity`, and `@capacitor/app` is
  already a dependency wired into `main.tsx`.
- **The real work is the arrival flow**, and it is shared between the platforms: park the
  URI, survive the unlock, then ask the user where it should go. That belongs in `@core`
  where it is headlessly testable, not in either native project.
- **Nothing new is needed for parsing.** `parseTotp` and `classifyScannedQr` already
  accept exactly the shapes that arrive and already name the four ways one can be
  useless. Only the user-facing hint strings need a handoff variant.
- **Order of work:** shared core first, then iOS (where the payoff is visible in
  Settings), then Android (which is then nearly free). Phases 1 and 2 are independent
  once Phase 0 lands.

## An inbound URI is untrusted and is a secret

Both properties matter, and they pull in different directions.

**Untrusted.** Registering a scheme makes an entry point any app on the device can fire
at Bramble, unprompted, with a payload it controls. On Android that means an exported
activity reachable by any installed app. The mitigation is a rule, not a check: **an
inbound URI never writes to the vault.** It only ever prefills a form the user then
confirms. That single rule also makes intent replay harmless (see the launch-URL
hazard below), which is why it is worth stating as an invariant rather than leaving it
implicit in the routing.

**A secret.** An `otpauth://` URI carries the shared TOTP seed. It gets the same
handling as any other secret in transit:

- Memory only. Never `setMeta`, never a file, never a log line.
- Never a router search param. Mobile uses memory history, but core routes are shared
  with the extension, and a seed in a URL is a seed in a history entry.
- One-shot: taken once, then cleared, matching `pending-create-entry.ts`. Backing out of
  the setup screen discards the key rather than leaving it for the next visit.

**It is deliberately NOT dropped on lock**, which the first draft of this plan called for.
A handoff arrives with the vault locked in the ordinary case, not the exceptional one:
mobile defaults auto-lock to "Immediately", so being launched from another app means
arriving locked nearly every time. Clearing on lock would have made the feature fail on
its main path to bound a memory lifetime that the one-shot take already bounds. The key
lives from arrival until the setup screen takes it, or until the process ends.

## What is reused as-is

| Capability | Where it lives | Notes |
|---|---|---|
| URI parsing and validation | `core/src/util/totp.ts` (`parseTotp`) | Accepts `otpauth://totp/` and bare secrets. Already rejects HOTP and migration blobs. |
| Failure taxonomy | `core/src/util/totp.ts` (`classifyScannedQr`) | `not-found` / `vendor-app` / `migration` / `not-totp` is exactly the set an inbound URI can hit. Only the copy differs. |
| One-shot prefill of the create form | `core/src/app/pending-create-entry.ts` | The idiom to copy, and the destination for the "new login" leg. |
| Cold-launch vs warm-launch dual path | `platform-mobile/src/main.tsx:75-80` | The credential-exchange handoff already solved this shape. |
| Entry search and list rendering | `core/src/app/screens/VaultHome/vault-search.ts`, `list-item.ts` | The "attach to an existing login" picker should not hand-roll a list. |
| Route guards, back fallback | `core/src/app/router.tsx`, [routing.md](routing.md) | The new route is an ordinary `_app` child. |

## Vocabulary

- **TotpHandoff**: an `otpauth://` URI delivered to Bramble by the OS rather than
  scanned or typed. It is parked, not applied: it lives in memory from arrival until
  either the user confirms a destination or the vault locks.

## Phase 0: the shared arrival flow (core)

Platform-independent, and every part of it is unit-testable without a device. Do this
first; both platform phases then reduce to delivery.

1. **`core/src/app/pending-totp.ts`**, the park. Two one-shot hops, both module-level
   (not React state) so each survives the navigation that delivers it: the arriving key,
   and the key handed on to one login's edit form. The second is keyed by entry id, so a
   stray navigation cannot drop someone else's 2FA code into the wrong login's form.
2. **Handoff-specific copy.** `classifyScannedQr` returns the right verdict but
   `login.tsx`'s `scanHint()` phrases every failure as a page-scanning problem ("No QR
   code found on the page"). Add a handoff variant of the four strings; keep the
   classifier itself untouched.
3. **Route `/vault/totp-setup`** plus `screens/TotpSetup/`. It asks the one question
   worth asking: new login, or an existing one?
   - *New login* seeds `setPendingCreateEntry({ type: "login", totp: uri, name: issuer,
     username: account })` from the parsed URI and navigates to `/vault/new/$type`. The
     existing `CreateEntryRoute` already consumes that seed and already skips the
     active-tab lookup when it is present, so this leg needs no new form code.
   - *Existing login* shows a searchable list of logins and navigates to
     `/vault/$entryId/edit`.
   - Register `staticData.back` per [routing.md](routing.md).
4. **Seed the edit form.** `EntryEditRoute` built `initialEntry` from the stored entry
   alone; a one-shot read now merges a handed-over `totp` over it, the way
   `takeInitialDraft()` already takes precedence. The "this replaces a working key"
   warning lives on the picker row rather than in the form: the form would show a
   filled-in field with no sign that it had just overwritten anything, and the point of
   decision is the row the user is about to tap.
5. **Guard behaviour.** `/vault/totp-setup` is an ordinary `_app` child, so a locked
   vault bounces it to `/` and returns after unlock. The park is what survives that trip.
   Cover it in `router.guards.test.ts` alongside the existing headless guard tests.
6. **Tests.** `pending-totp.test.ts` (both hops, one-shot, entry-keyed), a `TotpSetup`
   screen test for the two legs and the four failure states, and the guard test above.
7. **i18n.** New `t`/`<Trans>` strings fall back to English silently. Run
   `pnpm i18n:extract` and follow [i18n.md](i18n.md) before this is called done.

## Phase 1: iOS

1. **Register the scheme** in `packages/platform-mobile/ios/App/App/Info.plist`. The file
   is hand-maintained and referenced by `INFOPLIST_FILE`; `cap sync` does not rewrite it.

   ```xml
   <!-- Setting up a 2FA code elsewhere hands the otpauth:// URI to whichever app the user
        picked under Settings > Apps > Passwords > Set Up Codes In. Registering the scheme
        is the whole mechanism; there is no API for that list. See docs/totp-uri-handler.md. -->
   <key>CFBundleURLTypes</key>
   <array>
     <dict>
       <key>CFBundleTypeRole</key>
       <string>Viewer</string>
       <key>CFBundleURLName</key>
       <string>app.bramble.mobile.otpauth</string>
       <key>CFBundleURLSchemes</key>
       <array><string>otpauth</string></array>
     </dict>
   </array>
   ```

   `LSApplicationQueriesSchemes` is **not** needed. That governs querying other apps,
   which Bramble does not do.
2. **No Swift changes.** `AppDelegate.swift:35` already forwards
   `application(_:open:options:)` to `ApplicationDelegateProxy`, which is what makes
   `@capacitor/app` fire `appUrlOpen`.
3. **Wire delivery in `main.tsx`**, next to the credential-exchange effects: an
   `appUrlOpen` listener for the warm case, and one `App.getLaunchUrl()` read on mount
   for the cold case, where the URL is delivered before the webview exists. Both feed
   `setPendingTotp` and navigate to `/vault/totp-setup`.
4. **Do not arm the file-pick grace.** `armFilePickGrace()` exists for pickers Bramble
   itself opens. Here Bramble is being launched from elsewhere, so locking on the way out
   was correct; the user unlocks and the parked URI is still there.
5. **Device checklist.**
   - Bramble is listed under Settings > Apps > Passwords > Set Up Codes In, and selecting
     it sticks.
   - Tap an `otpauth://` link in Safari: cold launch, warm launch, and from the app switcher.
   - Vault locked on arrival, with auto-lock set to "Immediately": the URI survives unlock.
   - The new-login leg lands on a form with the code, issuer, and account already filled.
6. **App Store.** No new entitlement and no new usage description; `NSCameraUsageDescription`
   already covers the scanning path. Nothing to declare beyond the scheme itself.

## Phase 2: Android

1. **Add the intent filter** to `.MainActivity` in
   `packages/platform-mobile/android/app/src/main/AndroidManifest.xml`. It is already
   `exported="true"` and `launchMode="singleTask"`.

   ```xml
   <!-- Inbound TOTP setup: any app or browser can hand us an otpauth:// URI, so this
        never writes to the vault, it only prefills a form the user confirms.
        Deliberately on MainActivity, not the :autofill process. -->
   <intent-filter>
     <action android:name="android.intent.action.VIEW" />
     <category android:name="android.intent.category.DEFAULT" />
     <category android:name="android.intent.category.BROWSABLE" />
     <data android:scheme="otpauth" />
   </intent-filter>
   ```

2. **No Kotlin/Java changes.** `BridgeActivity` handles `onNewIntent`, which is what
   `singleTask` delivers when the app is already running.
3. **The JS wiring from Phase 1 is shared.** Nothing platform-specific to add.
4. **The `<queries>` block is unrelated.** It governs outbound package visibility for the
   autofill browser-trust check. Being a handler needs nothing from it.
5. **Device checklist.** No website needed to exercise this:

   ```
   adb shell am start -a android.intent.action.VIEW \
     -d "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"
   ```

   Then: cold launch, warm launch, chooser shows Bramble alongside other authenticators,
   "always" sticks, and locked-on-arrival survives unlock. Build and install with JDK 21
   and `adb install` directly rather than `cap run android`.

## Phase 3: edges

- **Launch-URL replay.** `getLaunchUrl()` is not one-shot: it reports the URL that
  launched the process for that process's lifetime, and on Android a recreated activity
  is re-delivered its original intent. A replay is harmless precisely because arrival
  only ever opens a confirmation screen, but the screen must not reappear on every
  resume. `totp-handoff.ts` memoizes the read and hands it to at most one subscriber.
  Delivery is marked only once a LIVE subscriber has taken it, so a subscriber that tears
  down before the read resolves leaves the key for the next one instead of eating the
  whole cold-launch path.
- **A second handoff in one session.** Setting up 2FA on two sites in a row is ordinary,
  so `InnerApp` remembers the key it last routed rather than a spent flag. A boolean
  would have silently dropped every handoff after the first; comparing the key itself
  still refuses to route the same one twice.
- **`otpauth-migration://`.** Google Authenticator's export blob. `parseTotp` rejects it
  today by design, and the classifier already explains why. **Do not register that
  scheme**: appearing in a chooser and then refusing the payload is worse than not
  appearing. Revisit only if bulk migration import is ever built.
- **HOTP.** Parsed by the underlying library, rejected by `parseTotp` because Bramble
  only generates TOTP. The handoff copy has to say so plainly.
- **Discoverability on iOS.** The Set Up Codes In list is a single default, so Bramble is
  competing with every authenticator the user has installed. Worth a line in the release
  notes and possibly a Settings hint pointing at where to switch it.

## Non-goals

- Filling one-time codes. Already shipped through the autofill providers.
- Any change to the extension. The core route exists in the shared tree but nothing on
  the extension side parks a URI.
- Migration/export blob import.
- Becoming a standalone authenticator app. Codes stay attached to login entries.

## To verify on device before trusting this plan

| Question | Why it matters |
|---|---|
| Does Set Up Codes In actually list Bramble on the current iOS? | The section has a history of disappearing. The scheme registration still pays off via `otpauth://` links either way. |
| Does `App.getLaunchUrl()` return a custom-scheme URL at cold launch on iOS? | If not, the URI has to be parked natively the way `CredentialExchangeInbox` parks its token. |
| Do real sites emit tappable `otpauth://` links on mobile web? | Few do. On Android the QR scanner already covers most enrollment, so the intent filter mainly buys app-to-app handoff and migration off another authenticator. Sets expectations for the payoff, not the feasibility. |
