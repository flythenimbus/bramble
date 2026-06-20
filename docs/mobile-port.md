# Mobile app (Capacitor) plan: feasibility findings

Research notes on shipping Bramble as a native iOS + Android app built with Ionic Capacitor, reusing
the existing codebase. Captures what is already portable, what needs a new platform implementation,
the genuine blockers, the unknown unknowns to retire early, and a phased plan.

Fast-moving platform facts (Capacitor maturity, OS webview behaviour, store rules, plugin status) are
dated **June 2026** and flagged where they are unverified. Re-verify before acting on them later.

## Bottom line

- **Feasible, but it is not a recompile of the extension. It is "build the native shell of a
  password manager and reuse the Rust crypto/KDBX core plus the React UI."** The honest framing:
  the extension is one platform target; mobile is a second one, much further from the first than
  Firefox is from Chrome.
- **The reuse story is genuinely strong and already built for.** `packages/core` talks to its host
  only through five adapter interfaces injected by `PlatformContext`. A mobile port is, at its
  heart, a new `packages/platform-mobile` that implements those adapters against Capacitor
  plugins. The crypto crate already compiles natively (it has an `rlib` crate type and `cargo test`
  runs today), and iOS/Android icon asset catalogs are already generated under `icon/`. Someone
  anticipated this.
- **Capacitor fits this project well for one decisive reason:** the native autofill providers (the
  actual product value on mobile) are ordinary native targets in the committed `ios/` and `android/`
  Xcode/Android Studio projects, which Capacitor hands you to own and edit directly. There is no
  generated native project to fight, so the largest, riskiest workstream sits on a standard native
  development path rather than a tooling gamble.
- **Three things are hard, and two of them are net-new native subsystems, not ports:**
  1. **System autofill** (the actual product value on mobile) cannot use the webview or any of the
     `content/` code. It is a separate native iOS Credential Provider Extension (Swift) and a native
     Android autofill provider (Kotlin), each running outside the webview. This is the largest single
     workstream and shares no code with the extension's autofill.
  2. **Security-key unlock breaks on mobile.** Apple does not pass the WebAuthn `prf` extension to
     roaming authenticators at all, so hardware-key (YubiKey hmac-secret) unlock is impossible on
     iOS and NFC-blocked on Android. Mobile unlock must be re-architected around biometrics + the
     OS keystore, with platform passkeys as the only PRF-capable path (and that path needs native
     code, association files, and an Apple-gated entitlement).
  3. **Storage durability.** iOS evicts webview IndexedDB under storage pressure and inactivity, so
     the vault must live on the native filesystem via a Capacitor filesystem plugin, not in the
     webview.
- **The good news cluster:** WASM runs (WKWebView keeps JIT because the webview is out-of-process),
  WebCrypto works (Capacitor serves from a `localhost` origin, which is a secure context), the React
  UI / TanStack Router / vault logic / KDBX import / recovery codes / slot policy are all portable,
  and the offscreen-document indirection collapses (mobile has one webview with a DOM, like
  Firefox's event page, so crypto runs in-process in WASM or in a native plugin).
- **Scope note (v1).** Bramble does **not** host passkeys for other sites or apps in v1; that
  credential-provider passkey role is a deferred future feature. v1 mobile autofill fills
  **passwords and TOTP** only. This keeps the credential provider simpler (iOS one extension with
  `ProvidesPasswords`; Android just the classic `AutofillService`) and removes passkey
  attestation/assertion code and the Android Credential Manager provider from the initial build.

## Method (what the research explored)

Five reads of the codebase (tech stack and build, crypto and storage, auth and unlock, the
extension-only surface, the UI layer) and web research passes against live June-2026 sources
(Capacitor mobile fundamentals, the hard webview blockers, and the native autofill mechanics). The
codebase findings are grounded in file paths below; the platform findings carry source URLs at the
end and are flagged verified vs unconfirmed.

## The reuse seam: why this is feasible at all

The repo is a pnpm workspace with two JS packages plus a Rust crate:

- `packages/core` (`@vault/core`): React 19 + TanStack Router + the entire vault domain. Talks to
  its host **only** through adapter interfaces. This is the reusable product.
- `packages/platform-extension` (`@vault/platform-extension`): the Chrome MV3 implementation of
  those adapters, plus all the extension-only machinery (background SW, content scripts, offscreen
  doc, popup/options pages).
- `packages/crypto-wasm`: the Rust crypto + KDBX4 crate. `crate-type = ["cdylib", "rlib"]`, so it
  already builds both to WASM (`wasm:build`) and natively (`wasm:test` runs `cargo test`).

The seam is `packages/core/src/context/PlatformContext.tsx`. The whole product is parameterised over
five adapters:

```ts
interface Platform {
  storage: StorageAdapter;    // read/write the vault blob + metadata
  crypto: CryptoAdapter;      // wrap/unwrap VEK, encrypt entries, KDBX import
  autofill: AutofillAdapter;  // query/select/fill credentials
  shell: ShellAdapter;        // open settings, pop out, read active tab, QR
  clipboard: ClipboardAdapter;// copy with auto-clear
}
```

(`packages/core/src/adapters/` also defines a `messaging` adapter.) **A mobile port is a new
`packages/platform-mobile` that implements these five interfaces against Capacitor plugin APIs,
plus the native `ios/` and `android/` projects Capacitor generates and you own, plus a single SPA
entry (one `index.html` mounting `@core` App) instead of the extension's six bundles.** The extension
package is left untouched; both ship from one `core`.

### Reuse estimate

| Layer | Reuse | Notes |
|---|---|---|
| `packages/crypto-wasm` | ~100% (with a refactor) | Already compiles native. Split into a pure-Rust core + thin `wasm-bindgen` wrapper (browser) + thin `uniffi` wrapper (native Swift/Kotlin), gating `getrandom`'s js feature to `wasm32`. The core then serves three targets: WASM in the webview, and Swift + Kotlin bindings linked into both a custom Capacitor crypto plugin (main app) and the autofill providers. See OS-level autofill. |
| `packages/core` domain (vault-format, slot-policy, recovery-code, import, useVault orchestration) | ~95% | Pure logic over adapters and WASM. The one real change is the WebAuthn path (see blockers). |
| `packages/core` UI (App, router, screens, components, entry-modes) | ~85% | Ports, but needs a responsive-layout pass (today it is popup-dimensioned) and a shell-adapter rethink (no `window.close`, no pop-out). |
| `packages/platform-extension` | ~0% for mobile | This is the Chrome impl. `content/` and most of `background/` do not port. Their logic either collapses (offscreen) or becomes native (autofill). |

## What ports cleanly (low or no work)

- **WASM (KDBX parsing, all crypto).** Runs in both mobile webviews. WKWebView gets the four-tier
  JIT because the webview is out-of-process (unlike apps that embed JavaScriptCore directly, which
  are JIT-disabled). For one-shot KDBX open/decrypt the JS-WASM bridge cost is negligible. Better
  still, the same crate compiles into native Swift/Kotlin via uniffi, so crypto can move out of the
  webview entirely into a native plugin (see Storage and Hard problem 2).
- **WebCrypto / SubtleCrypto.** `crypto.subtle` and `isSecureContext` are available: Capacitor serves
  the app from `capacitor://localhost` (iOS) and `https://localhost` (Android), and `localhost` is a
  "potentially trustworthy" secure context per the W3C spec. Capacitor's docs confirm secure-context
  Web APIs work on this origin. `crypto.getRandomValues` and `crypto.randomUUID` (used in
  recovery-code and entry-id generation) are fine.
- **Password and recovery-code unlock.** Pure Argon2id + AES-256-GCM + HMAC in WASM/native, no
  browser APIs. The slot-policy invariant logic (`packages/core/src/vault/slot-policy.ts`) is pure
  and portable.
- **TanStack Router.** Client-side memory history already; works in a webview. The pop-out
  `?detached` handoff (`packages/core/src/app/hooks/usePopOut.tsx`) goes away on mobile (single
  window), which simplifies boot. Capacitor is framework-agnostic, so the React + TanStack SPA ships
  as-is with no Ionic UI framework required.
- **The offscreen-document indirection collapses.** Chrome MV3 needs an offscreen document because
  its service worker has no DOM. Capacitor mobile has a single webview with a DOM (like Firefox's
  event page, per `firefox-port.md`), so the `chrome.runtime.sendMessage` round-trips to
  `offscreen.ts` become in-process calls, or move to a native plugin call. Extract `dispatchCrypto` /
  `getWasm` (already flagged as the Firefox refactor) and the mobile crypto adapter calls them
  directly.

## What needs a new platform implementation (medium effort, mechanical)

Each is a `packages/platform-mobile` adapter plus, where noted, a Capacitor plugin (official,
community, or a small in-house one). None is conceptually hard; this is the bulk of the "make it run"
work.

| Adapter / concern | Extension uses | Capacitor mobile replacement |
|---|---|---|
| `storage` (vault blob + metadata) | FSA + `chrome.storage.local` | `@capacitor/filesystem` writes the VLT1 blob to the app-private data dir (`Directory.Data`/`Library`); small secrets (wrapping key) in a Keychain/Keystore-backed secure-storage plugin. **Not IndexedDB** (eviction) and **not `@capacitor/preferences`** (plaintext). VLT1 format is unchanged. |
| `crypto` host transport | `chrome.runtime.sendMessage` to offscreen | In-process WASM call, or a custom Capacitor plugin calling uniffi-bound Rust (iOS plugin calls run off the main thread by default). |
| VEK session cache | `chrome.storage.session` | In-webview memory while unlocked + lock-on-background; optionally held in native plugin state. Drop the pending-blob stash (the filesystem plugin can always write). |
| `clipboard` | `chrome.alarms` + offscreen clear | `@capacitor/clipboard` (mobile is plain-text only) plus our own auto-clear timer (no Capacitor plugin provides a timeout, and none exposes Android `EXTRA_IS_SENSITIVE`, so a tiny custom plugin may be wanted for the sensitive flag). |
| `shell` (pop-out, open settings, active tab, QR) | `chrome.windows` / `chrome.tabs` | In-app navigation (no pop-out, no `window.close`); settings is a route; "active tab URL" has no meaning on mobile (drop from autofill matching in-app); QR via `@capacitor-mlkit/barcode-scanning` (camera) instead of `captureVisibleTab`. |
| lifecycle / auto-lock | `chrome.idle`, `chrome.alarms`, `chrome.commands` | `@capacitor/app` `appStateChange` / `pause` / `resume`: lock on the mobile pause event; sliding auto-lock via a timer. No OS screen-lock hook needed (pause covers it). |
| build | Vite 6-bundle extension build | Single SPA: point Capacitor `webDir` at `dist`, `server.url` at the Vite dev server for live reload, `npx cap sync` to push assets + native deps. Add `packages/platform-mobile` to the pnpm workspace. No separate backend process; native code is Capacitor plugins. |
| icons | `icon/web` | `icon/ios` (full `AppIcon-*.png` + `Contents.json` asset catalog) and `icon/android/res/mipmap-*` already exist; feed them through `@capacitor/assets` or drop them into the native projects. The icon pipeline is mobile-ready. |

## The hard problems (the real unknowns)

### 1. System autofill (apps and websites): the largest workstream, all native

There are no content scripts on mobile. Filling credentials into other apps and into mobile browsers
is a single OS mechanism per platform, the **credential provider**, and it runs as native code
(Swift on iOS, Kotlin on Android) in a target **outside the webview** that must read and decrypt the
vault itself. None of `packages/platform-extension/src/content/` ports. This is the dominant
workstream and the reason the project is "a native password manager whose main UI happens to be a
Capacitor webview." Full mechanics, the app-vs-website unification, the cross-process unlock, the
memory constraint, and the shared-Rust-core enabler are in the dedicated section
[OS-level autofill](#os-level-autofill-filling-apps-and-websites-natively) below.

### 2. WebAuthn / PRF / security keys: re-architect mobile unlock

Today, security-key unlock derives the KEK from a WebAuthn authenticator's `prf`/`hmac-secret`
output via HKDF (`packages/crypto-wasm/src/lib.rs` `derive_kek_hkdf`, info `"titanpass/webauthn/v1"`;
ceremonies in `packages/core/src/hooks/useVault.tsx`). On mobile this path is constrained hard:

- `navigator.credentials` does not work in the webview by default. iOS WKWebView needs the
  Apple-gated `com.apple.developer.web-browser.public-key-credential` **browser** entitlement
  (managed capability, explicit Apple approval, no published criteria). Android System WebView
  supports it natively since `androidx.webkit` 1.12.0+ via `setWebAuthenticationSupport`, but
  conditional-UI is not supported in-webview. Both need domain association files (AASA on iOS,
  `assetlinks.json` on Android).
- **PRF key derivation is platform-dependent and the security-key story dies on iOS:**

  | Authenticator | iOS | Android |
  |---|---|---|
  | Platform passkey (iCloud Keychain / Google Password Manager) | PRF supported (iOS 18+, fixed 18.4+) | PRF supported (Google Password Manager) |
  | Roaming hardware key (YubiKey hmac-secret) | **No.** Apple does not pass `prf` to/from external authenticators at all | USB only; **NFC: no** |

  Yubico's own statement: Apple's WebAuthn on iOS/iPadOS does not pass extension data, including
  `prf`, to roaming authenticators. So the existing hardware-key unlock is **impossible on iOS** and
  NFC-blocked on Android.
- **Native path (if PRF unlock is wanted on mobile):** iOS `AuthenticationServices`
  (`ASAuthorizationPublicKeyCredentialPRFAssertionInputValues`, explicitly built for deriving a
  symmetric key) + Android Credential Manager PRF extension, both bridged to JS via a custom
  Capacitor plugin. No off-the-shelf plugin does this; it is Swift + Kotlin glue, scoped to
  **platform passkeys only**. Effort medium-high, plus the iOS entitlement and association-file infra
  (long lead, start early).
- **Recommended mobile unlock re-architecture.** Treat mobile as a new primary-unlock class:
  biometric (`@aparajita/capacitor-biometric-auth`: Face ID / Touch ID / Android `BiometricPrompt`)
  gating a wrapping key held in Keychain/Keystore, plus the existing password and recovery-code
  slots. Platform passkeys (PRF) are an optional add-on once the native bridge exists. Hardware
  security keys become a desktop/extension-tier feature, dropped on iOS and USB-only on Android. This
  intersects the existing invariant-B / slot-policy design (always one primary): mobile adds a
  "biometric/keystore" slot kind to that policy rather than porting the WebAuthn slot verbatim.

### 3. Storage durability: do not trust webview IndexedDB on iOS

WebKit evicts script-writable storage (IndexedDB, Cache API) under storage pressure, over quota, or
after ~7 days without interaction, and for non-browser apps the per-origin quota is only ~15% of
disk. Whether the 7-day purge applies to an embedded WKWebView is officially undocumented and
developers report data loss. `navigator.storage.persist()` is granted only heuristically.

**Fix:** the encrypted vault blob lives on the native filesystem through `@capacitor/filesystem`
(app-private data dir, not subject to WebKit eviction); small high-value secrets (the key that wraps
the VEK) live in Keychain/Keystore through a secure-storage plugin
(`@aparajita/capacitor-secure-storage`, iOS Keychain + Android AES-GCM with the key in Keystore).
`@capacitor/preferences` is **not** secure (plain `UserDefaults` / `SharedPreferences`), so do not
use it for secrets. If you move decryption into a native crypto plugin, the decrypted vault can live
in native-owned memory rather than the JS heap.

### 4. UI layout: popup-dimensioned, needs a responsive pass

The popup is hard-coded to 500x550 with `overflow: hidden` (`popup.html`); detached mode flips to
100%. There are essentially no responsive breakpoints, and layouts use `h-screen` (100vh).

**Fix:** drop the fixed dimensions, switch root heights to `h-dvh` (dynamic viewport height for the
mobile keyboard/notch), add `viewport-fit=cover` + safe-area insets, and do a mobile-first pass
(content is wrapped in `max-w-5xl` today, which is fine, but small-screen spacing and tap targets
need work). The autofill-ui iframe (hard-coded dark, cross-origin) is extension-only and is replaced
by native autofill UI. Medium, mechanical.

## OS-level autofill: filling apps and websites natively

The user-visible promise of a mobile password manager is filling logins into other apps and into
mobile browsers. On mobile that is not a browser extension and not the webview: it is the OS
**credential provider** mechanism, implemented as native targets (Swift on iOS, Kotlin on Android)
that run outside Bramble's webview and must read and decrypt the vault themselves. This is the
largest and riskiest workstream. None of `packages/platform-extension/src/content/` (detection,
fill, capture, picker, corner-prompt) ports; the fill engine is rebuilt natively.

### One provider serves both apps and websites

This is the point behind "apps and websites": on each OS there is a single provider mechanism, and
it covers native-app fields and mobile-browser web fields together.

- **iOS.** The system hands the extension an `ASCredentialServiceIdentifier`. For web fields (Safari,
  and Chrome/Firefox which delegate to the same API) its type is `.URL` and the value is the page
  domain. For native apps it resolves to the app's **associated domain**, not its bundle id: an app
  opts in by hosting an `apple-app-site-association` (AASA) file with a `webcredentials` service, so
  a login saved for `example.com` matches both the website and the app. Matching is domain-centric
  either way, so one extension serves both surfaces.
- **Android.** In `AutofillService.onFillRequest` you walk the `AssistStructure`: a `ViewNode`
  exposes `getIdPackage()` (native-app match) and `getWebDomain()` / `getWebScheme()` (browser
  web-field match), so the same service fills native apps and in-browser fields. For passkeys in a
  browser, the request arrives via Credential Manager and the true site origin is resolved with
  `CallingAppInfo.getOrigin()` against a privileged-browser allowlist. Caveat: per-browser fill
  fidelity varies, and some browsers fill only through the keyboard (IME), which is why managers like
  KeePassDX also ship a fallback keyboard. Budget for that if broad browser coverage matters.

### iOS: AutoFill Credential Provider Extension (Swift)

A separate app-extension target subclassing `ASCredentialProviderViewController`, with the
`com.apple.developer.authentication-services.autofill-credential-provider` entitlement (paid Apple
account, managed capability) on both app and extension, and `Info.plist` capabilities
`ProvidesPasswords` and `ProvidesOneTimeCodes` (iOS 18, TOTP) for v1; `ProvidesPasskeys` (iOS 17+) is
deferred with passkey hosting. Lifecycle:

- **QuickType bar (fast path):** `provideCredentialWithoutUserInteraction(for:)`. The OS already
  painted suggestion chips from the identity store (below) without launching Bramble. If the vault
  is unlocked (cached key available), return the secret with no UI; otherwise throw
  `ASExtensionError.userInteractionRequired`.
- **Locked / reprompt:** the OS relaunches and calls `prepareInterfaceToProvideCredential(for:)`;
  show the Face ID / unlock sheet, decrypt, complete.
- **Full list:** `prepareCredentialList(for:)` renders our searchable list.
- **Passkeys (deferred, future feature):** the `prepareInterface(forPasskeyRegistration:)` and
  assertion path (`ASPasskeyRegistrationCredential` / `ASPasskeyAssertionCredential`) is part of
  passkey hosting, not v1. See "Passkey hosting is a deferred future feature" below.

`ASCredentialIdentityStore` holds **identities only** (service + username + an opaque
`recordIdentifier`, no secret). The main app populates it while the vault is unlocked, so the OS can
show QuickType suggestions while the vault is locked; on selection the extension gets the
`recordIdentifier` back and fetches/decrypts the real secret. This maps cleanly onto Bramble's
existing design, which already separates match summaries from secrets in `autofill-index` and
`autofill-ui`.

### Android: classic `AutofillService` for v1 (Kotlin)

- **v1: classic Autofill Framework** (`AutofillService`, API 26+, **not deprecated**):
  `onFillRequest` / `onSaveRequest`, `FillResponse` + `Dataset`, `InlinePresentation` keyboard chips
  on API 30+. Covers Android 8 and up, generic native-app text fields, OTP, and browser web fields.
  For password-and-TOTP autofill this is sufficient on every Android version, so it is the only
  provider v1 ships. Manifest: `BIND_AUTOFILL_SERVICE`, action
  `android.service.autofill.AutofillService`, and an `android.autofill` meta-data resource; the user
  enables Bramble under Settings -> Passwords, passkeys and autofill.
- **Deferred: Credential Manager provider** (`CredentialProviderService`, API 34+ / Android 14):
  `onBeginGetCredentialRequest` / `onBeginCreateCredentialRequest`. This is the only path for
  **passkeys**, so it lands with passkey hosting (future), not v1. At that point you run both
  services (Bitwarden's shape: one `AutofillService` plus one `@RequiresApi(34)
  CredentialProviderService`), adding `BIND_CREDENTIAL_PROVIDER_SERVICE` and a `provider.xml` with
  `TYPE_PUBLIC_KEY_CREDENTIAL`.

### Passkey hosting is a deferred future feature

Two passkey concerns are easy to conflate, and **both are out of v1 scope**:

- **Unlocking Bramble's own vault with a passkey** (the WebAuthn/PRF question in Hard problem 2: a
  biometric or platform passkey deriving the KEK). v1 unlock is biometric + password + recovery
  code; passkey/PRF unlock is the optional long-lead item in the plan.
- **Hosting passkeys for other sites and apps** (Bramble as a passkey provider: the user's
  third-party passkeys live in Bramble and it satisfies their WebAuthn ceremonies through the
  credential provider). This is a **future feature, not built now.** It would add generating and
  storing P-256 keys and hand-building attestation/assertion (CBOR/COSE; Apple's docs are thin, so
  reference Dashlane/Bitwarden), the iOS `ProvidesPasskeys` capability + `ASPasskey*` flows, and the
  Android Credential Manager `CredentialProviderService`. It reuses the same shared-storage,
  biometric-unlock, and Rust-core plumbing built for password autofill, so it is additive once that
  exists. (Constraint for then: Android does not let third-party providers serve non-discoverable,
  2FA-style, passkeys.)

v1 autofill therefore fills **passwords and TOTP** only.

### The crux: a separate process that must decrypt the vault itself

The provider is native code with no webview and no WASM. On its own it must:

1. **Read the vault** from storage shared with the main app: on iOS via an **App Group container**
   (encrypted blob) plus a **Keychain Access Group** (keys); on Android the provider is in the same
   app/package, so it shares internal app storage and the **Keystore** directly (no App Group
   needed).
2. **Unlock via biometric**: iOS stores a wrapping key in the Keychain behind `kSecAccessControl`
   `.biometryCurrentSet` + Secure Enclave, and the Keychain read itself triggers Face ID; Android
   uses a Keystore key created `setUserAuthenticationRequired(true)`, unlocked with `BiometricPrompt`
   + a `CryptoObject`. (iOS gotcha: `LAContext.evaluatePolicy` fails with "not running foreground"
   if called too early; defer the prompt to `viewDidAppear`.)
3. **Decrypt with native crypto**, not the webview's WASM.

**The memory constraint is the design driver.** iOS credential-provider extensions run under a hard
cap of roughly 120 MB (consensus from shipping managers; Apple does not publish the exact AutoFill
figure). Bramble's password slot uses Argon2id at 64 MiB, which is impractical inside that cap (the
KeePass family reports Argon2 must stay under ~32 MiB, ~19 MiB advised, for autofill to survive). So
**do not run Argon2id in the extension.** Adopt the industry pattern: the main app, which has full
memory, runs Argon2id once at unlock, derives the VEK, then re-wraps it (or a dedicated wrapping key)
under the biometric-gated Keychain/Keystore item; the extension biometric-unwraps that and performs
only an AES-256-GCM unwrap plus the KDBX parse, never the KDF.

This is a new unlock path that intersects Bramble's VEK/KEK/slot model (`vault-format.ts`,
`slot-policy.ts`): mobile adds a **cached-wrapping-key** path distinct from the Argon2 password slot.
Be explicit that caching a hardware-gated key at rest is a deliberate attack-surface decision (it is
what Bitwarden does for biometric unlock).

### The enabler: one Rust crypto core, three compile targets

This is the largest reuse win for autofill, and it leans on a fact already true of the repo:
`crypto-wasm` compiles natively today. Refactor it into a **pure-Rust core** (Argon2id, AES-256-GCM,
HKDF, KDBX4, no platform deps) plus thin wrappers:

- a `wasm-bindgen` wrapper for the browser extension and the mobile webview (as today),
- a **`uniffi` wrapper** that generates **both Swift and Kotlin** bindings from one Rust source.

The iOS extension, the Android service, and a custom Capacitor crypto plugin for the main app then
link the **same** Argon2/AES/HKDF/KDBX code through uniffi instead of reimplementing crypto. Build a
`.xcframework` (cargo + lipo + `xcodebuild -create-xcframework`) for iOS, linked via the plugin's
`.podspec` or SPM `Package.swift`, and `.so` files via `cargo-ndk` into `jniLibs/` for Android. Gate
`getrandom`'s js backend to `wasm32` only so native builds use the OS RNG. This is how Bitwarden
(Rust SDK via uniffi) and Proton Pass (Rust common lib) are built, and Proton Pass is the closest
structural analog to a webview-plus-Rust password manager. uniffi is mature but pre-1.0 (0.31, Jan
2026), so pin it.

### Shipping it inside Capacitor (the smooth edge)

This is where Capacitor earns its place. The `ios/App/App.xcodeproj` and `android/` projects are
**first-class, committed-to-repo native projects you open and edit directly** in Xcode and Android
Studio. `npx cap copy` pushes only the web assets, and `npx cap sync` adds web assets plus native
plugin dependencies; neither regenerates your `.pbxproj` or `AndroidManifest.xml`, so a hand-added
app-extension target or `Service` survives a sync. Adding the iOS Credential Provider Extension is
ordinary "new target in Xcode" work, and adding the Android `AutofillService` is ordinary manifest +
Kotlin work. Capacitor even ships an official Password AutoFill guide.

Two practical notes, not blockers:

- Capacitor 8 generates the iOS project as **Swift Package Manager** (a `CapApp-SPM` local package,
  no CocoaPods `Podfile`/`.xcworkspace`), so an extra target links the shared Rust `.xcframework` and
  the Capacitor SPM products through its own SPM/framework references rather than a Podfile block.
- Capacitor has no official "add an arbitrary app extension" walkthrough, so the sync-survival of a
  hand-added extension target is strongly implied by the workflow docs but not stated verbatim.
  Retire it with a one-hour empirical check (add a trivial extension target, run `cap sync` a few
  times, confirm it persists) before building the real provider.

### Reference implementations to study

- **Bitwarden** (`bitwarden/ios` native Swift; `bitwarden/android` dual service): closest modern
  reference, including the locked-vault `userInteractionRequired` dance, identity-store sync gated on
  lock state, the biometric cached-key path, and the Rust-SDK-via-uniffi crypto core.
- **Proton Pass** (`protonpass/ios-pass`, `protonpass/android`): Swift/Kotlin app plus a shared Rust
  common library, the same shape this port would take.
- **Dashlane** `apple-credential-provider-example`: a clean, current passkey-provider sample and a
  good file-layout template.
- **KeePassDX**: native JNI Argon2, Keystore-gated biometric unlock, and the IME fallback for
  browsers that block autofill.

### Effort

The highest in the project, even scoped to passwords and TOTP. v1 is one iOS extension plus one
Android classic `AutofillService`, the shared-core refactor, shared-storage and biometric-unlock
plumbing, and the native target additions (no passkey attestation/assertion code, no Android
Credential Manager provider yet). Budget several weeks per platform. An MVP ships without any of it
(manual copy and paste from the vault app, Phase 1), but password autofill is the reason a password
manager exists on a phone, so it is the headline post-MVP workstream, not optional. Passkey hosting
is a later additive feature on top of this plumbing.

## Capacitor mobile platform facts (verified June 2026)

- **Maturity.** Capacitor is stable and widely deployed; the current major is **Capacitor 8**
  (announced Dec 2025), with iOS and Android both fully supported. It backs a large roster of
  production apps including finance/enterprise/healthcare (Aflac, Target, Cisco, NHS, the 86400
  neobank, Bestinvest), which de-risks the platform choice for a security product. **No password
  manager is known to ship on Capacitor specifically (unverified), so the credential-provider work
  has no direct Capacitor precedent even though every native primitive it needs exists.**
- **Project shape.** Existing Vite frontend stays; `npx cap add ios` / `cap add android` generate
  full Xcode / Gradle projects under `ios/` and `android/` that are **committed and owned** (opened
  with `cap open`). `cap copy` syncs web assets + config; `cap sync` also installs native plugin
  deps. Neither regenerates native source you have edited.
- **Toolchain.** iOS needs full Xcode on a macOS host (Capacitor 8 defaults to Swift Package Manager,
  so CocoaPods is no longer required). Android needs Android
  Studio + SDK + (for the Rust `.so`) NDK + JDK. This is the standard, well-supported Apple/Google
  native toolchain, not a bespoke one.
- **Webviews.** iOS = WKWebView (WebKit), min iOS 14 (Cap 7) / 15 (Cap 8). Android = system WebView
  (Chromium, not bundled, version varies by device), `minSdkVersion` 23. You now test three engines
  (desktop browsers for the extension, WKWebView, Android WebView); WebKit is the stricter renderer.
- **Web serving / secure context.** iOS default origin `capacitor://localhost`, Android default
  `https://localhost` (configurable via `server.iosScheme` / `server.androidScheme`). `localhost` is
  a secure context, so `crypto.subtle`, `isSecureContext`, and other secure-context-only APIs work.
- **Native bridge and threading.** Plugins are authored in Swift (iOS) and Kotlin/Java (Android) via
  the official, stable plugin generator (`npm init @capacitor/plugin`); link an `.xcframework` via
  `.podspec`/SPM and `jniLibs/*.so` via Gradle. **iOS plugin calls run on a background queue by
  default** (good: heavy Rust crypto does not block the UI thread; you dispatch UI work back to
  main). Android plugin threading is not documented as off-main, so **manage your own threads for
  Argon2id on Android** (it is deliberately slow; a main-thread call risks an ANR).
- **Relevant plugins.** `@capacitor/filesystem` (official, app-private blob storage),
  `@aparajita/capacitor-secure-storage` (Keychain/Keystore, community, maintained),
  `@aparajita/capacitor-biometric-auth` (Face ID / Touch ID / `BiometricPrompt`, community,
  maintained), `@capacitor-mlkit/barcode-scanning` (camera QR), `@capacitor/clipboard` (official,
  plain-text; **no auto-clear, no `EXTRA_IS_SENSITIVE`**, so a small custom plugin or a JS timer is
  needed), `@capacitor/app` (lifecycle `appStateChange`/`pause`/`resume`). Avoid
  `@capacitor/preferences` for secrets (plaintext).
- **Distribution.** Capacitor apps deploy to the App Store and Play Store like any other native app
  (real Xcode/Gradle outputs). **App Store review risk: Guideline 4.2 (minimum functionality /
  webview wrapper).** Capacitor bundles local web assets plus native plugins (unlike a thin remote
  URL wrapper), and a password manager clears 4.2 by leaning on genuine native integrations
  (biometric, keychain, camera, autofill). Capacitor apps are routinely approved.
- **Lifecycle.** `@capacitor/app` exposes pause/resume/appStateChange; background execution is
  OS-constrained (iOS suspends aggressively, Android needs a foreground service). For a password
  manager this is fine: we want to lock and be killed in the background. Implement lock-on-pause and
  clipboard-clear-on-timeout ourselves.

## Unknown unknowns / risks to retire early

- **No password-manager precedent on Capacitor.** Every native primitive exists, but the
  credential-provider + shared-storage + biometric-unwrap path has not been walked on Capacitor
  specifically. Retire with the Phase 0 skeleton and the autofill probe on real devices.
- **App-extension sync-survival.** Adding native autofill targets to the committed `ios/`/`android/`
  projects is standard native work, but Capacitor does not document that a hand-added extension
  target survives `cap sync`. Strongly implied; verify empirically (inject a trivial iOS Credential
  Provider target + read a value from a shared App Group, run `cap sync` repeatedly).
- **iOS WebAuthn/passkey entitlement (future only).** Relevant to the deferred passkey features, not
  v1 password autofill. If pursuing in-webview passkeys, the browser entitlement is an approval
  gamble with no published criteria; the native ASAuthorization route avoids it but is more code.
  Long lead time; start that conversation only when passkeys are scheduled.
- **Android main-thread crypto -> ANR.** Argon2id is deliberately slow, and Android plugin calls are
  not guaranteed off-main. Native crypto commands must run off the main thread on Android.
- **Webview fragmentation.** Old Android System WebView versions on low-end devices, and WKWebView
  quirks the extension never hits. Test on real low-end hardware.
- **Secret hygiene across boundaries.** Secrets crossing the JS<->native plugin boundary, the
  decrypted vault in the JS heap, and keeping the native autofill extension's view of the vault in
  sync without leaking plaintext. Design the trust boundary deliberately.
- **Sync.** Mobile has no File System Access API either, and the desktop build's "vault.db in a
  synced folder" model does not exist on a phone. This makes the sync question (already open for
  Firefox) load-bearing for mobile. The **P2P WebRTC design in [p2p-sync.md](p2p-sync.md)** (option 5
  in [firefox-port.md](firefox-port.md)) is the natural cross-platform answer and should be treated
  as a dependency of a useful multi-device mobile app, not an afterthought.

## Proposed plan (phased, each phase retires a risk)

0. **Walking skeleton (days).** Add `packages/platform-mobile`; `npx cap add ios/android`; point
   `webDir` at a minimal SPA mounting `@core` App with stub adapters. Get the real React UI + WASM +
   WebCrypto + router booting in WKWebView and Android System WebView **on real devices**. Icons
   already exist. Retires the biggest cheap unknown: does our stack even run on-device. Highest
   information per unit effort.
1. **In-app vault MVP (weeks).** Implement the five `platform-mobile` adapters: `storage`
   (`@capacitor/filesystem` + secure-storage plugin), `crypto` (in-webview WASM or a native crypto
   plugin), `clipboard` (plugin + own timer), `shell` (collapse pop-out, in-app nav), lifecycle
   lock-on-pause via `@capacitor/app`. Result: a standalone vault app: password/recovery unlock,
   view/edit/copy entries, KDBX import, TOTP. No system autofill yet (manual copy/paste). Shippable
   as a private build.
2. **Biometric + secure storage + layout (weeks).** Biometric plugin gates unlock; wrap the VEK key
   in Keychain/Keystore; add the biometric slot to slot-policy; responsive/`dvh`/safe-area UI pass.
3. **System autofill, passwords and TOTP (many weeks per platform, native, the real schedule).**
   Precursor: refactor `crypto-wasm` into a shared Rust core with a `uniffi` wrapper so Swift and
   Kotlin link the same crypto. Then: iOS AutoFill Credential Provider Extension (Swift,
   `ProvidesPasswords` + `ProvidesOneTimeCodes`) and the Android classic `AutofillService` (Kotlin,
   API 26+, covering apps and browser web fields on all versions), added as native targets in the
   committed `ios/`/`android/` projects. Each reads the vault from shared storage (App Group +
   Keychain on iOS, same-app storage + Keystore on Android) and unlocks via a biometric-gated
   **cached wrapping key** so it never runs Argon2id inside the memory-capped extension. De-risk with
   the extension-target injection probe first. See OS-level autofill.
4. **Passkeys / PRF unlock (optional, long lead).** Native ASAuthorization + Credential Manager PRF
   bridge plugin (platform passkeys only); AASA / assetlinks association files; iOS entitlement if
   the in-webview route is chosen. Hardware keys: dropped on iOS, USB-only on Android.
5. **Distribution.** Apple Developer + App Store (mitigate 4.2 with the native integrations), Play
   Console (signing, targetSdk policy).

### Deferred (future features, post-v1)

- **Passkey hosting** (Bramble as a passkey provider for other sites and apps): adds the Android
  Credential Manager `CredentialProviderService`, the iOS `ProvidesPasskeys` capability +
  `ASPasskey*` registration/assertion, and P-256 keygen + CBOR/COSE attestation. Additive on top of
  the Phase 3 credential-provider plumbing (shared storage, biometric unlock, Rust core). The iOS
  web-browser public-key-credential entitlement question below is relevant only here, not for v1.
- **Passkey / PRF unlock of our own vault** (Phase 4) stays optional and long-lead.

### Suggested spike scope (to decide go / no-go)

Do **Phase 0** and the **autofill target-injection probe** from Phase 3 (inject a trivial
credential-provider target, read the vault from a shared App Group, confirm it survives `cap sync`).
Those retire the unknowns that actually determine whether this is worth doing. Everything in Phases
1-2 is known-quantity adapter work; passkey work is deferred.

## Effort and risk at a glance

| Workstream | Effort | Risk | Reuse |
|---|---|---|---|
| Walking skeleton (Phase 0) | Low | Low | n/a |
| `platform-mobile` adapters (Phase 1) | Medium | Low | high (core unchanged) |
| Biometric + Keychain/Keystore (Phase 2) | Medium | Low-Medium | high |
| Responsive UI pass (Phase 2) | Medium | Low | high |
| Move crypto to a native plugin | Low | Low | crate already native |
| Shared Rust crypto core refactor (core + wasm + uniffi wrappers) | Medium | Low | crate logic reused, bindings new |
| **iOS autofill provider (Swift): passwords + TOTP** | **High** | **High** | **none in webview; crypto via shared Rust core** |
| **Android autofill: classic `AutofillService` (Kotlin): passwords + TOTP** | **High** | **High** | **none in webview; crypto via shared Rust core** |
| Adding extension targets to the native projects | Medium | Low-Medium (standard Xcode/Studio work; verify sync-survival) | n/a |
| Passkey hosting (future): CM provider + iOS passkeys + attestation | High | High | additive on Phase 3 plumbing |
| Passkey/PRF native bridge (Phase 4) | Medium-high | High (Apple entitlement, no plugin) | partial |
| Sync (cross-cutting) | High | Medium | shared with p2p-sync work |
| Distribution (Phase 5) | Medium | Medium (4.2, targetSdk) | n/a |

## Open questions to verify before committing

- Does a hand-added iOS Credential Provider target and Android autofill service survive `cap sync`
  durably, and read a shared vault? (Strongly implied; verify empirically.)
- (Future, passkey hosting only) Will Apple approve the web-browser public-key-credential
  entitlement, or must passkey support go fully native? Not needed for v1 password/TOTP autofill.
- Does `navigator.storage.persist()` actually exempt an embedded WKWebView from eviction, or is the
  filesystem-plugin path mandatory (assume mandatory)?
- Is `@aparajita/capacitor-secure-storage` (or another plugin) production-viable for our threat
  model today, or do we write a thin in-house Keychain/Keystore plugin?
- What is the mobile sync model, and does it share the p2p-sync engine?
- Is caching a biometric-gated wrapping key in Keychain/Keystore an acceptable attack-surface
  trade-off for skipping Argon2id in the autofill extension (industry-standard, but a deliberate
  choice)?
- Which `uniffi` version to pin (pre-1.0, churns), and `getrandom` 0.2 js-feature vs 0.3 cfg-flag?
- Per-browser autofill fidelity on Android (some browsers fill only via the IME): do we need a
  fallback keyboard like KeePassDX?
- Do we need a small custom clipboard plugin for the Android `EXTRA_IS_SENSITIVE` flag, or is the
  JS-side auto-clear timer sufficient?

## Sources (verified June 2026, re-verify later)

Capacitor platform:
- Capacitor 8 announcement: https://ionic.io/blog/announcing-capacitor-8 ; upgrade guide https://capacitorjs.com/docs/updating/8-0
- Native project workflow (`cap copy` / `cap sync`, committed `ios/`/`android/`): https://capacitorjs.com/docs/basics/workflow , https://capacitorjs.com/docs/cli/commands/copy
- Config (schemes / secure context / server): https://capacitorjs.com/docs/config
- iOS / Android webviews + min OS: https://capacitorjs.com/docs/ios , https://capacitorjs.com/docs/android , https://capacitorjs.com/docs/updating/7-0
- Plugin authoring (Swift/Kotlin, SPM/Gradle, native lib linking): https://capacitorjs.com/docs/plugins/creating-plugins , https://capacitorjs.com/docs/plugins/ios , https://capacitorjs.com/docs/plugins/android , https://capacitorjs.com/docs/ios/spm
- Password AutoFill guide: https://capacitorjs.com/docs/guides/autofill-credentials
- Plugins: filesystem https://capacitorjs.com/docs/apis/filesystem ; clipboard https://capacitorjs.com/docs/apis/clipboard ; app/lifecycle https://capacitorjs.com/docs/apis/app ; secure storage https://github.com/aparajita/capacitor-secure-storage ; biometric https://github.com/aparajita/capacitor-biometric-auth ; barcode https://github.com/capawesome-team/capacitor-mlkit
- Framework-agnostic (no Ionic UI lock-in): https://capacitorjs.com/docs/getting-started/with-ionic
- App Store deployment / 4.2 posture: https://capacitorjs.com/docs/ios/deploying-to-app-store , https://developer.apple.com/app-store/review/guidelines/
- Production roster / enterprise: https://ionic.io/customers , https://ionic.io/resources/case-studies/bestinvest

WebAuthn / PRF / autofill:
- iOS web-browser passkey entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential
- Android WebView Credential Manager bridge: https://developer.android.com/identity/sign-in/credential-manager-webview
- PRF for key derivation (iOS): https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninputvalues
- PRF guide / Apple roaming-authenticator limitation (Yubico): https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html

OS-level credential providers (autofill in apps + websites):
- iOS `ASCredentialProviderViewController`: https://developer.apple.com/documentation/AuthenticationServices/ASCredentialProviderViewController
- iOS `ASCredentialIdentityStore` (secrets-free suggestion index): https://developer.apple.com/documentation/authenticationservices/ascredentialidentitystore
- iOS `ASCredentialServiceIdentifier` (web URL + app associated-domain matching): https://developer.apple.com/documentation/authenticationservices/ascredentialserviceidentifier
- iOS passkey provider capabilities (WWDC24 10125): https://developer.apple.com/videos/play/wwdc2024/10125/
- iOS extension ~120MB / Argon2 limit (KeePassium): https://support.keepassium.com/kb/autofill-memory/
- iOS App Groups / Keychain access groups (shared storage): https://developer.apple.com/documentation/xcode/configuring-app-groups , https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps
- Android `AutofillService` (API 26, not deprecated): https://developer.android.com/identity/autofill/autofill-services , https://developer.android.com/reference/android/service/autofill/AutofillService
- Android Credential Manager provider (API 34, passwords + passkeys): https://developer.android.com/identity/sign-in/credential-provider
- Which APIs the 2024 deprecation actually covered (not autofill): https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html
- Digital Asset Links (app<->site association): https://developer.android.com/training/app-links/configure-assetlinks
- Bitwarden iOS (native Swift autofill + passkeys): https://github.com/bitwarden/ios
- Bitwarden Android (dual service + Rust SDK via uniffi): https://github.com/bitwarden/android
- Bitwarden biometric unlock bypasses the KDF (cached UserKey): https://deepwiki.com/bitwarden/mobile/7.3-biometric-authentication
- Dashlane credential provider example (passkeys): https://github.com/Dashlane/apple-credential-provider-example
- Proton Pass (Swift/Kotlin + Rust common lib): https://github.com/protonpass
- KeePassDX (JNI Argon2 + Keystore unlock + IME fallback): https://github.com/Kunzisoft/KeePassDX
- Mozilla uniffi (Swift + Kotlin bindings from one Rust source): https://github.com/mozilla/uniffi-rs
- cargo-ndk (Android .so into jniLibs): https://github.com/bbqsrc/cargo-ndk

Webview storage:
- WebKit storage eviction policy: https://webkit.org/blog/14403/updates-to-storage-policy/
- Storage quotas and eviction (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- Secure Contexts (`localhost`): https://www.w3.org/TR/secure-contexts/

Related internal docs: [firefox-port.md](firefox-port.md) (same adapter philosophy, the sync
constraint), [p2p-sync.md](p2p-sync.md) (cross-platform sync), [cryptography.md](cryptography.md),
[security-keys.md](security-keys.md), [storage.md](storage.md), [vault-format.md](vault-format.md).
