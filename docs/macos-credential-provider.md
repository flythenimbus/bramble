# macOS credential provider: system AutoFill for the desktop app

Plan for shipping an `ASCredentialProviderExtension` inside the macOS desktop app, so Bramble
appears in **System Settings > General > AutoFill & Passwords > AutoFill from** and fills passwords,
passkeys and one-time codes into Safari and native Mac apps.

Two classes of claim live here and they are not equally solid. **Codebase findings are verified**
and carry file paths. **Apple API and policy claims were checked against live sources on
2026-08-27** and carry a link; anything about how those APIs behave once wired into a *Tauri* bundle
is reasoning, not observation, and is marked `[unverified]`. The unverified set is concentrated in
one place (packaging and the shared container) and that is exactly where a spike should start.

## Bottom line

- **It replaces the reason auto-type existed, on macOS.** `desktop-port.md` lists auto-type
  (synthesized keystrokes plus an Accessibility permission) as the way to fill windows that are not
  a browser. The credential provider does that through a supported API, with no Accessibility
  prompt and no key synthesis. Auto-type stays interesting only for apps that adopt neither, which
  is a much smaller set than it was when that plan was written.
- **Safari comes free.** Password AutoFill in Safari is served by whatever provider the user
  designates, so this closes the Safari gap without writing, reviewing or maintaining a Safari
  extension. Combined with the existing Chromium and Firefox extension, browser coverage becomes
  complete except for Electron apps, which participate in neither.
- **Most of the extension is already written, for iOS.**
  `packages/platform-mobile/ios/App/AutoFillProbe/CredentialProviderViewController.swift` is the
  same framework, the same auth-first design, and the same `VaultCryptoFFI` core. It handles
  passwords, TOTP, and passkey get *and* create.
- **Developer ID distribution is fine**, which was the risk worth checking first. See
  [Signing and distribution](#signing-and-distribution).
- **The genuinely new work is packaging, not product**: getting an `.appex` into a bundle Tauri
  produced, and giving a sandboxed extension a way to read the vault a non-sandboxed app owns.
- **One thing it will not do: capture new passwords.** There is no save hook. See
  [The save gap](#the-save-gap).

## What one extension target buys

All of it hangs off `ASCredentialProviderViewController`
([docs](https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller),
macOS 11.0+; the user-facing designation in System Settings is macOS 13 or later per
[Apple Platform Security](https://support.apple.com/guide/security/credential-provider-extensions-sec6319ac7b9/web)).

| Capability | Entry point | Floor |
|---|---|---|
| Password fill, full picker | `prepareCredentialList(for:)` | macOS 11 |
| Password fill, no UI (QuickType) | `provideCredentialWithoutUserInteraction(for:)` + `ASCredentialIdentityStore` | macOS 11 |
| Passkey sign-in | `ASPasskeyCredentialRequest` | macOS 14 |
| Passkey **registration** | `prepareInterface(forPasskeyRegistration:)` | macOS 14 |
| One-time codes | `prepareOneTimeCodeCredentialList(for:)`, `ASOneTimeCodeCredentialIdentity` | macOS 15 |
| Arbitrary text insertion | `prepareInterfaceForUserChoosingTextToInsert()` | macOS 14 |
| Site-driven credential updates | `ASCredentialUpdater` report methods | macOS 15 |

Passkey registration is the one to notice: it is a *write* path the OS hands us, so a passkey
created in Safari lands in the vault. That makes this a delivery vehicle for
[passkey-provider.md](passkey-provider.md) on macOS, not a separate initiative.

`ASCredentialProviderViewController` inherits `NSViewController` on macOS and `UIViewController` on
iOS, so the container is per-platform even though the SwiftUI inside it is not. Apple's own note:
"This class ignores calls from Mac apps built with Mac Catalyst." Not our situation (the desktop app
is Tauri, so AppKit), but it rules out the shortcut of Catalyst-ing the iOS app.

## The save gap

**There is no API for a third party to receive a newly typed password.** Checked deliberately,
because it decides how complete the Safari win is:

- Passkey creation has a hook (`prepareInterface(forPasskeyRegistration:)`).
- Passwords have none. Safari offers to save to Apple's Passwords app, not to us.
- The 27 SDK adds nothing here; its AuthenticationServices additions are verification codes
  (`ASVerificationCode`, `DeliveredVerificationCodesManager`) and federated identity
  ([summary](https://miniswift.run/whats-new/authenticationservices/)).

So on Safari, a new login is added by hand in the app. The Chromium and Firefox extension keeps its
corner-prompt capture, so this asymmetry is Safari-only, and it is the one honest argument left for
also having a Safari extension one day. Not a reason to delay this.

## What is reused as-is

- **The extension's logic.** `CredentialProviderViewController.swift` already implements the model
  this needs: authenticate first, then decrypt. It shows an unlock screen and only then decrypts the
  credential list, so nothing about the vault is readable before the user authenticates. That
  property is worth more on macOS, where the extension's container is on a disk shared with
  everything else the user runs.
- **The crypto.** The extension calls the shared Rust core through uniffi (`VaultCryptoFFI`),
  including the native Argon2id master-password path. `packages/core-rust` already builds for macOS:
  the Tauri app links it as a plain cargo dependency under the `native` feature. What is new is
  producing *Swift* bindings for macOS targets, which is additive to the existing `ffi` feature.
- **The bundle format.** The encrypted-at-rest credential bundle the iOS app writes for its
  extension is the shape the desktop app should write too. Same producer logic, different location.
- **The entitlement layout.** `AutoFillProbe.entitlements` already declares
  `com.apple.developer.authentication-services.autofill-credential-provider`, an App Group, and a
  keychain access group. Apple's integration steps say to add the entitlement "to **both** the
  extension and its containing app", which is the same lesson that cost a debugging cycle on iOS.

## What is new

### Signing and distribution

The desktop app is Developer ID signed and notarized (`scripts/build-macos.ts`, and
`scripts/release.ts` refuses to publish an un-notarized build), distributed as a `.dmg` and a
Homebrew cask. Not the Mac App Store. That is the constraint everything here has to survive.

**It survives.** Xcode has long emitted "The AutoFill Credential Provider capability is not
available for Developer ID provisioning profiles", which reads like a policy wall. An Apple DTS
engineer's answer on [forum thread 690381](https://developer.apple.com/forums/thread/690381) is that
this is an *automatic signing* defect: the capability is listed as supported for Developer ID on
macOS, a Developer ID profile carrying the entitlement can be created manually, and the workaround
is manual signing. Precedent, as of mid-2026: 1Password (beta) and Strongbox both ship macOS
credential providers.

`[unverified]` An app carrying profile-requiring entitlements (App Groups, keychain sharing) needs
an `embedded.provisionprofile` in `Contents/`. Tauri does not put one there. Assume this is required
and plan a step for it.

### Getting an `.appex` into a Tauri bundle

`[unverified, and the main spike]` Tauri's bundler has no concept of an app extension. The shape of
the work:

1. Build the `.appex` with `xcodebuild` from a small Xcode project, universal (`arm64` + `x86_64`),
   since the release `.dmg` is universal.
2. Copy it into `Bramble.app/Contents/PlugIns/`.
3. Sign inside-out: the appex with its own entitlements, then the outer app.
4. Notarize the result as usual.

That has to happen between Tauri's bundle step and the `.dmg`, which is a seam `build-macos.ts` does
not currently have. Every other target is unaffected: this is macOS-only and the Linux path never
sees it.

Two follow-on unknowns, both `[unverified]`:

- **Does the updater survive it?** The app self-updates by replacing itself. Whether
  `pluginkit` re-registers the extension, keeps the user's designation, or silently drops it after
  an in-place update is unknown and is the failure users would actually hit. A designation that
  disappears on every release is worse than no feature.
- **Registration requires the app to be somewhere Launch Services looks.** `/Applications`, which
  both the `.dmg` drag and the Homebrew cask satisfy. Worth an explicit test rather than an
  assumption, since the iOS work already burned time on `pluginkit` discovery
  (`docs/mobile-port.md`).

### Handing a sandboxed extension the vault

`[unverified, and the main design question]` App extensions are always sandboxed. The Tauri app is
not, and its vault lives in `~/Library/Application Support/app.bramble.desktop` via Tauri's
`app_data_dir()` (`src-tauri/src/storage.rs`), which the extension cannot read.

The iOS answer is an App Group container plus a shared keychain, and it should port, with two
differences to verify on a real machine before designing around either:

- macOS App Group identifiers for Developer ID apps take a team-ID prefix
  (`BHGR3PP64J.group....`), unlike iOS's bare `group.app.bramble.mobile`. The hardcoded shared
  keychain group has already been a long debugging loop once on iOS; do not guess the macOS form,
  read it back with `codesign -d --entitlements`.
- A *non-sandboxed* app writing into `~/Library/Group Containers/<id>/` is a different case from the
  sandboxed-both-sides one iOS exercises. Expected to work, not observed to.

Whatever the container turns out to be, the contents are the iOS design: the credential bundle
encrypted under the VEK, written by the app whenever the vault changes, plus `ASCredentialIdentityStore`
populated with metadata (service and username, never the password) so entries appear in QuickType.

### Unlocking inside the extension

The extension is a separate process, so it cannot borrow the app's in-memory VEK. iOS solves this
with its own unlock UI (biometric or master password) in the extension. macOS has Touch ID through
`LocalAuthentication` on the Macs that have it, and the master-password path works everywhere. Note
this is the same Touch ID unlock the blog post lists as missing from the desktop app, so the two
pieces of work overlap and should probably be sequenced together.

## Proposed order

1. **Spike the packaging, with a stub.** An `.appex` that returns a hardcoded credential, embedded,
   signed, notarized, installed from a real `.dmg`, and appearing in AutoFill & Passwords. This
   answers every `[unverified]` above and it is the only part that can fail in a way that kills the
   plan. Nothing else should start until it passes.
2. **The shared container.** App Group wired both ways, app writing an encrypted bundle,
   extension reading it. Still no real UI.
3. **Port the iOS controller.** SwiftUI views largely carry over; the `NSViewController` host and
   the unlock screen are the new parts. Passwords first.
4. **Identity store and QuickType**, so credentials appear inline instead of only behind the picker.
5. **One-time codes** (macOS 15 floor) and **passkeys**, which lands the macOS half of
   [passkey-provider.md](passkey-provider.md).
6. **Revisit auto-type** with real usage data. It may not be worth building at all after this.

## Open questions

- Deployment floor. macOS 13 makes the feature designatable, 14 adds passkeys, 15 adds one-time
  codes. The app's current minimum is whatever Tauri and WebKitGTK imply and has not been stated
  anywhere; it should be, before this picks one.
- Whether the extension should reuse the desktop app's existing OS-credential-store usage (backup
  credentials, the browser-link pairing key) or stay strictly App Group plus its own keychain group.
- Whether a "keep unlocked" session shared between app and extension is wanted, as on Android, or
  whether each unlock stands alone.
