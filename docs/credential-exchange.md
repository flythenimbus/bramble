# Credential Exchange plan: CXF/CXP on iOS

Plan for supporting the FIDO Alliance credential exchange specs on the mobile app, so a user can
move passwords, TOTP seeds and passkeys between Bramble and Apple Passwords / 1Password / Bitwarden
/ Chrome without an intermediate plaintext file.

Platform facts (OS API surfaces, spec status, library availability) are dated **July 2026** and
flagged where unverified. Re-verify before acting on them later.

## Two specs, and we only implement one

- **CXF (Credential Exchange Format)** is the JSON data model: `Header` -> `Account` -> `Item` ->
  `Credential[]`, with 17 credential types. **FIDO Proposed Standard since 2025-08-14.** This is the
  part we write.
- **CXP (Credential Exchange Protocol)** is the transport: HPKE, app identity binding, out-of-process
  consent UI. Still a Working Draft. **We never implement it.** The OS performs the exchange and
  hands us a decrypted CXF payload, so the unfinished spec is not our exposure.

Apple pins the format at `"1.0"` via `SupportedCredentialExchangeVersions`, so the version we target
is fixed regardless of what CXP does next.

## Bottom line

- **iOS is a ~2 week job**, and most of it is a pure-TS mapper that is platform independent.
- **The hard parts already exist**: an OS-registered credential provider extension, a working passkey
  provider role, per-entry encryption, and an import wizard with a lossy-mapping warning convention.
- **Passkey export is nearly free.** `PasskeyCredential.privateKey` is already base64url PKCS#8,
  exactly CXF's `key` encoding, and `signCount` is already hardcoded 0, exactly what CXF requires of
  exporters.
- **Phase 0 is done and it passed** (2026-07-29, Xcode 26.4 / iOS 26.4 sim): Apple's
  `ASExportedCredentialData` encodes to **CXF-conformant JSON**, so the Swift layer is a pass-through
  and the 2-3 day contingency is off the table. Evidence below.

## Android is out of scope, and why

`androidx.credentials.providerevents` resolves its backend by reflecting over services declared in
**the calling app's own manifest** (`ProviderFactory.getBestAvailableProvider`), and the only artifact
declaring `PROVIDER_EVENTS_API_PROVIDER_KEY` is `providerevents-play-services`. Both directions
therefore require bundling a Google Play client library, which `mobile-port.md:213-215` rules out and
which would complicate the F-Droid submission in `fdroid-inclusion.md`. Bitwarden's docs put the
runtime floor at Android 14+ with Play Services 26.21+.

AOSP has no exchange API to fall back on: `frameworks/base` at `refs/heads/main` carries only
create/get/clear in `core/java/android/credentials/` and `core/java/android/service/credentials/`.
GrapheneOS inherits that gap, and because the backend class must live inside our APK, no ROM can
substitute an implementation transparently.

Revisit if Google moves the router into the framework. Until then, Phase 5 (CXF files) is the
portable consolation prize.

## What is reused as-is

| Capability | Where it lives | Notes |
|---|---|---|
| Credential provider extension | `ios/App/AutoFillProbe/` | Gains two Info.plist keys, no code change. |
| Passkey provider role | `CredentialProviderViewController.swift:503+` | Imported passkeys are usable immediately, not dead weight. |
| Capacitor local-plugin pattern | `ios/App/App/AutofillBridge.swift` | `CAPPlugin` + `CAPBridgedPlugin`, copy wholesale. |
| Import wizard + preview + warnings | `core/src/app/screens/Import/ImportShell.tsx` | Needs a non-file branch; the preview/commit half is unchanged. |
| Lossy-mapping conventions | `core/src/export/kdbx.ts`, `core/src/import/types.ts` | `ImportResult.warnings`, unique-key collision handling. |
| TOTP parse/serialize | `core/src/util/totp.ts` (`parseTotp`, otpauth) | CXF wants structured secret/period/digits/algorithm. |
| Auto-lock grace for OS UI | `platform-mobile/src/adapters/shell.ts` (`armFilePickGrace`) | The exchange sheet backgrounds the app, same trap as the file picker. |
| Per-target capability gating | `core/src/flags.ts` | New `credentialExchange` key, iOS-only. |

## Phase 0 result: the wire format is CXF (RESOLVED 2026-07-29)

Every `ASImportable*` type declares a hand-written `init(from:)` / `encode(to:)` rather than
synthesized Codable, and those hand-written coders map Swift names onto CXF names. Verified by
building a payload in a simulator CLI binary (`swiftc -target arm64-apple-ios26.0-simulator`, run
via `simctl spawn`) and encoding it:

```json
{ "accounts": [ { "id": "YWNjdC0wMDAx", "username": "ada", "email": "ada@example.com",
    "items": [ { "id": "aXRlbS0wMDAx", "title": "GitHub", "creationAt": 721692800,
      "modifiedAt": 771692800, "favorite": true,
      "scope": { "urls": ["https://github.com"], "androidApps": [] },
      "credentials": [
        { "type": "basic-auth", "username": {"fieldType":"email","value":"ada@example.com"},
          "password": {"fieldType":"concealed-string","value":"hunter2"} },
        { "type": "totp", "secret": "JJBFGV2ZGNCFARKIKBFTGUCYKA======", "period": 30,
          "digits": 6, "algorithm": "sha1", "issuer": "GitHub" },
        { "type": "passkey", "credentialId": "AQIDBA", "rpId": "github.com",
          "userHandle": "qrs", "key": "MIGHAgEA" } ] } ] } ],
  "exporterRpId": "app.bramble.mobile", "version": { "major": 1, "minor": 0 } }
```

Round-trip decode returns an identical value. What this pins down:

| Swift | JSON | Note |
|---|---|---|
| `userName` | `username` | Apple's property names are **not** the wire names. Do not infer keys from the Swift API. |
| `created` / `lastModified` | `creationAt` / `modifiedAt` | UNIX **seconds**, not ms, not ISO. |
| `credentialID` / `relyingPartyIdentifier` | `credentialId` / `rpId` | |
| `exporterRelyingPartyIdentifier` | `exporterRpId` | |
| `formatVersion: .v1` | `"version": {"major":1,"minor":0}` | An object, not the string `"1.0"`. |
| any `Data` | base64url, **unpadded** | `0x01020304` -> `"AQIDBA"`. Our `PasskeyCredential` docs say base64url but `AutofillBridge.swift` is fed standard base64, so pin the encoding explicitly in the mapper. |
| `TOTP.secret: Data` | base32 string | Apple base32-**encodes** the raw bytes. Our stored value is already base32 text, so emit it as-is in the JSON and let Apple decode it. Passing ASCII bytes of a base32 string through the Swift type double-encodes it and every imported code comes out wrong. |

Consequence for the design: **build CXF JSON in TS, `JSONDecoder().decode(ASExportedCredentialData.self, from:)` in Swift, and the reverse on import.** No Swift mapping layer.

Two caveats found while reading the interface:

- Apple's enum has **16** credential cases; CXF 1.0 defines **17**. There is no `file` case. A
  counterparty exporting `File` credentials may fail to decode, so the import path needs to survive
  a decode error on one item without losing the rest.
- `ASImportableCredentialScope.urls` is `[Foundation.URL]`, so malformed stored URLs will be dropped
  by the decoder rather than round-tripped. `login.urls` is free text in our schema; filter and warn.

## Core work: the shared CXF module

New `packages/core/src/exchange/`, mirroring the shape of `import/` and `export/`:

- `types.ts` - TS mirror of the CXF CDDL (`Header`, `Account`, `Item`, the credential union,
  `EditableField`).
- `to-cxf.ts` - `EntryData[]` -> CXF, for export.
- `from-cxf.ts` - CXF -> `ImportResult`, reusing the existing `warnings`/`skipped` contract.
- Tests, including a round-trip suite in the style of `export/kdbx.test.ts`.

### Mapping

| Bramble | CXF | Notes |
|---|---|---|
| `login.username` / `.password` | `BasicAuth{username, password}` | Values wrap in `EditableField`, not bare strings. |
| `login.urls` | `Item.scope` | Verify the exact `CredentialScope` shape against the spec. |
| `login.totp` | `TOTP{secret, period, digits, algorithm, issuer}` | `parseTotp` out; `OTPAuth.URI.stringify` back. |
| `login.passkeys[]` | `Passkey{credentialId, rpId, username, userDisplayName, userHandle, key}` | Direct: our `privateKey` is already b64url PKCS#8. `username`/`userDisplayName` are required in CXF and optional for us, so default to `""`. |
| `card` | `CreditCard{number, fullName, cardType, verificationNumber, expiryDate}` | `expMonth`/`expYear` -> one `year-month` field. `brand` -> `cardType`. |
| `note` / `.notes` | `Note{content}` | A note entry becomes an Item with a single Note credential; a login's `notes` becomes a second credential on the same Item. |
| `ssh-key` | `CustomFields`, **not** `SSHKey` | See below. |
| `customFields[]` | `CustomFields{fields[]}` | `hidden` -> `concealed-string` field type. |
| `createdAt` / `updatedAt` | `Item.creationAt` / `.modifiedAt` | ms -> UNIX seconds. |

**SSH keys are deliberately lossy.** CXF's `SSHKey.privateKey` is PKCS#8 DER base64url; we store PEM
text (OpenSSH, PKCS#1 or SEC1, per `util/ssh.ts`). Converting an OpenSSH container is real work for a
credential type no counterparty is likely to consume. Ship them as `CustomFields` carrying the PEM
verbatim plus a warning, and upgrade later if a real interop need appears. Importing a foreign
`SSHKey` gets the mirror treatment: keep the bytes, warn, do not pretend it round-trips.

Unknown CXF types on import (passport, wifi, drivers-license, ...) become custom fields on a note
entry with a warning rather than being dropped, matching how the KDBX importer handles foreign
databases.

## iOS integration

### Info.plist

Extension (`ios/App/AutoFillProbe/Info.plist`), inside the existing
`NSExtensionAttributes > ASCredentialProviderExtensionCapabilities`:

```
SupportsCredentialExchange = YES
SupportedCredentialExchangeVersions = ["1.0"]
```

App (`ios/App/App/Info.plist`): add `NSUserActivityTypes` containing the credential exchange activity
type. Verify the exact constant spelling against the SDK at build time (`ASCredentialExchangeActivity`
as the activity string, `ASCredentialExchangeActivityType` as the symbol).

### New plugin: `ios/App/App/CredentialExchange.swift`

`@objc(CredentialExchangePlugin)`, `jsName = "CredentialExchange"`, following `AutofillBridge.swift`.
Everything is `@available(iOS 26.0, *)` guarded; the deployment target stays 15.0.

| Method | Does |
|---|---|
| `isAvailable()` | `#available(iOS 26)` plus the provider extension being enabled. Gates the UI. |
| `requestExport()` | `ASCredentialExportManager(presentationAnchor:).requestExport(for:)`, returns the negotiated `ExportOptions` format version to JS. |
| `exportCredentials({ cxfJson })` | Decode into `ASExportedCredentialData`, then `exportCredentials(_:)`. |
| `consumeImportToken()` | Returns a token stashed by the AppDelegate, or null. |
| `importCredentials({ token })` | `ASCredentialImportManager().importCredentials(token:)`, encodes the result back to JSON for JS. |

### AppDelegate

`application(_:continue:restorationHandler:)` already forwards to
`ApplicationDelegateProxy`. Add a pre-check: if `userActivity.activityType` is the exchange type,
pull the `UUID` out of `userInfo[ASCredentialImportToken]`, stash it on the plugin, notify JS, and
return true without forwarding.

The token can arrive at **cold launch into a locked vault**, so the flow must be: stash token ->
unlock -> then call `importCredentials`. Do not assume the app is unlocked when the activity lands.

### Auto-lock

Both directions background the app for the OS consent sheet. Call the same grace-arming path
`exportBytes` uses (`armFilePickGrace`) before `requestExport()` and before continuing an import, or
"Immediately" auto-lock drops the transfer mid-flight. This is the trap documented for the file
picker and it applies verbatim here.

## UI

- **Import**: a new card in `IMPORT_PROVIDERS` for "Transfer from another app", gated on
  `can("credentialExchange", target)` and the plugin's runtime `isAvailable()`. It skips the file
  input and jumps straight to the existing preview step, so the review/commit half is untouched.
  `ImportProviderInfo` needs a third mode alongside `reads`/`needsCredential`.
- **Export**: a row in `Settings > DataSection`, next to the KDBX export. Requires an unlocked vault
  and an explicit confirmation, since this hands the full plaintext vault to another app.
- `flags.ts`: add `credentialExchange: { chromium: false, firefox: false, android: false, ios: true }`
  and update `flags.test.ts`, which enumerates every capability.
- Run `pnpm i18n:extract` after adding strings, or they silently fall back to English.

## Security notes

- Export is a **full plaintext vault leaving the process**. Gate on an unlocked vault plus a
  confirmation that names the destination app, and never offer it while locked.
- No file touches disk in either direction. That is the entire point of using the OS API over a CXF
  file, and it should be stated in the UI copy.
- Imported passkeys land with `signCount: 0`, matching both CXF's requirement and our existing
  invariant that a synced passkey never increments.
- After a successful import, the autofill bundle and credential identity store must be re-synced so
  imported logins and passkeys are fillable. Confirm `importEntries` already triggers that path.
- Worth a `/security-review` pass before release, focused on the token handling (a stale or replayed
  import token must not be able to pull credentials into the wrong vault when multiple vaults exist).

## Phased route

| Phase | Work | Estimate |
|---|---|---|
| 0 | ~~Spike: is Apple's Codable CXF-shaped?~~ **DONE, passed.** | - |
| 1 | Shared `core/src/exchange/` module + tests | 2-3d |
| 2 | Swift plugin, Info.plist keys, AppDelegate hook, auto-lock grace | 3-4d |
| 3 | Import card, Settings export row, flags, i18n | 1-1.5d |
| 4 | Device + interop testing: Apple Passwords, Chrome iOS, 1Password, Bitwarden. Both directions. | 1-2d |
| 5 | *Optional*: CXF file import/export through the existing file path, all targets, Android included | +1d |

**Total: 7-10 working days**, contingency retired.

## What the simulator can and cannot do

Verified 2026-07-29 on iPhone 17 Pro / iOS 26.4:

- **The Phase 0 spike runs there today.** `swiftc -sdk iphonesimulator -target
  arm64-apple-ios26.0-simulator` produces a CLI binary that `simctl spawn` runs against the real
  framework. No app target, no test target, no device. Kept at
  `packages/platform-mobile/scripts/cxf-wire-probe.swift`; re-run it whenever a wire-format question
  comes up:

  ```sh
  xcrun swiftc -sdk $(xcrun --sdk iphonesimulator --show-sdk-path) \
    -target arm64-apple-ios26.0-simulator \
    packages/platform-mobile/scripts/cxf-wire-probe.swift -o /tmp/cxf-probe
  xcrun simctl spawn booted /tmp/cxf-probe
  ```
- **The credential provider extension registers.** `pluginkit -m -v -p
  com.apple.authentication-services-credential-provider-ui` lists `app.bramble.mobile.AutoFillProbe`
  after `simctl install`.
- **It can be enabled without the Settings UI.** `xcrun simctl spawn <sim> pluginkit -e use -i
  app.bramble.mobile.AutoFillProbe` flips the status flag from blank to `+`. This is a workaround for
  the sim limitation recorded in `mobile-port.md:804`. Whether AuthenticationServices honours it for
  the live fill UI is **not** verified; the flag flip is all that was tested.
- **The exchange machinery ships in the sim runtime.** `AuthenticationServicesUI.app` contains
  `PMCredentialExchangeViewController`, and both it and `Passwords.app` reference the
  `...AuthenticationServicesAgent.CredentialExchange` service. `Passwords.app` is present as a
  potential counterparty.
- **Still device-only:** no App Store, so 1Password / Bitwarden / Chrome as counterparties. Phase 4
  interop does not move.
- **Untested:** whether a transfer actually completes in the sim. Settling it needs the Phase 2 build
  with the plist keys, plus UI taps that `simctl` cannot send. Budget for it being device-only and
  treat a working sim flow as a bonus.

Phase 1 is independent of Phase 0 and of Apple entirely, so it is also the part that survives if
Android ever unblocks.

## Unknowns to retire early

- ~~Is `ASExportedCredentialData`'s Codable representation CXF-conformant JSON?~~ **RESOLVED
  (2026-07-29): yes.** Swift is a pass-through. See the Phase 0 section.
- ~~`CredentialScope` shape.~~ **RESOLVED**: `{urls: [URL], androidApps: []}`, multi-valued, so
  `login.urls` maps without loss. Note it decodes as `Foundation.URL`, so unparseable entries drop.
- **Import token lifetime.** If it expires quickly, the "stash then unlock" flow needs a retry path
  or a pre-unlock prompt.
- **Does export require the extension to be the active AutoFill provider**, or merely installed?
  Changes the empty-state copy on the Settings row.
- **Does the OS filter by declared capability**, i.e. will an importer that only claims passwords be
  offered our passkeys? Affects what we put in `ExportOptions` handling.

## References

- [FIDO credential exchange specs](https://fidoalliance.org/specifications-credential-exchange-specifications/)
- [CXF 1.0 Proposed Standard, 2025-08-14](https://fidoalliance.org/specs/cx/cxf-v1.0-ps-20250814.html)
- [`ASCredentialExportManager`](https://developer.apple.com/documentation/authenticationservices/ascredentialexportmanager)
- [`ASCredentialImportManager`](https://developer.apple.com/documentation/authenticationservices/ascredentialimportmanager)
- [What's new in passkeys, WWDC25](https://developer.apple.com/videos/play/wwdc2025/279/)
- [bitwarden/credential-exchange](https://github.com/bitwarden/credential-exchange) (Rust CXF/CXP, MIT, useful as a cross-check on field shapes)
