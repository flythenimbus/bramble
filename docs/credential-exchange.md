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
- **Passkey export is nearly free.** `PasskeyCredential.privateKey` is already PKCS#8, which is what
  CXF's `key` holds, and `signCount` is already hardcoded 0, exactly what CXF requires of exporters.
  The one catch is encoding: we store standard base64 and CXF is unpadded base64url, so every passkey
  field converts at the boundary. Import is the harder direction, because CXF carries no public key.
- **Phase 0 is done and it passed** (2026-07-29, Xcode 26.4 / iOS 26.4 sim): Apple's
  `ASExportedCredentialData` encodes to **CXF-conformant JSON**, so the Swift layer is a pass-through
  and the 2-3 day contingency is off the table. Evidence below.

Every reason an individual passkey is dropped on the way in, for this path and the file
importers, is listed in [passkey-import.md](passkey-import.md).

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

## Core work: the shared CXF module (LANDED, phase 1)

`packages/core/src/exchange/`, mirroring the shape of `import/` and `export/`:

- `types.ts` - zod schemas for the CXF wire format, and the inferred types. Deliberately lenient:
  anything CXF marks required that we can recover from is optional, and objects are loose, because
  this parses another vendor's export. The strict shape is whatever `to-cxf.ts` emits, pinned by its
  tests rather than by the schema.
- `to-cxf.ts` - `Entry[]` -> CXF. Takes `Entry` (not `EntryData`) so item ids are stable across
  exports, and an injected `now` so tests don't read the clock.
- `from-cxf.ts` - CXF -> `ImportResult`, reusing the existing `warnings`/`skipped` contract and
  `import/shared.ts`'s `summarize`, so bad shapes can't reach the vault.
- `passkey-key.ts` - wraps our stored scalar as the PKCS#8 CXF wants, for export only.
- Tests: `to-cxf`, `from-cxf`, and a round trip in the style of `export/kdbx.test.ts`.

Two decisions worth knowing before Phase 3 wires the UI:

- **`parseCxf` is async and takes an `ImportParserContext`**, the same seam the Bitwarden importer
  uses. CXF ships only the PKCS#8 private key, so an imported passkey's scalar and `publicKeyCose`
  are recovered by the Rust core's `passkey_import_pkcs8`, which is the code path that mints
  passkeys and so cannot drift from it. An earlier cut derived them in TS via WebCrypto; that was a
  second COSE implementation and it is gone.
- **The two directions sit in different layers on purpose.** Import parses a real key and encodes
  canonical COSE, so it belongs in Rust. Export only wraps a 32-byte scalar in a fixed DER header
  (RFC 5915 makes the public key optional), which parses nothing and does no curve maths, so it
  stays in TS as `pkcs8FromScalar`. If it ever needs to do more than that, it should move too.
- **`parseCxf` accepts `string | Uint8Array`**, so Phase 5 (CXF files) is the same code path.

### Mapping

| Bramble | CXF | Notes |
|---|---|---|
| `login.username` / `.password` | `BasicAuth{username, password}` | Values wrap in `EditableField`, not bare strings. |
| `login.urls` | `Item.scope.urls` | Absolute URLs only (the decoder drops what `Foundation.URL` rejects), so a bare host is promoted to https. |
| `login.totp` | `TOTP{secret, period, digits, algorithm, issuer}` | `parseTotp` out, `buildTotpUri` back. An unreadable key becomes a custom field plus a warning, never a drop. |
| `login.passkeys[]` | `Passkey{credentialId, rpId, username, userDisplayName, userHandle, key}` | Ids convert from our standard base64 to unpadded base64url. **`key` is a format change, not just an encoding one**: we store the raw 32-byte P-256 scalar, CXF holds PKCS#8 DER. `username`/`userDisplayName` are required in CXF and optional for us, so they default to `""`. |
| `card` | `CreditCard{number, fullName, cardType, verificationNumber, expiryDate}` | `expMonth`/`expYear` -> one `year-month` field. `brand` -> `cardType`. |
| `note` / `.notes` | `Note{content}` | A note entry becomes an Item with a single Note credential; a login's `notes` becomes a second credential on the same Item. |
| `ssh-key` | `CustomFields`, **not** `SSHKey` | See below. |
| `customFields[]` | `CustomFields{fields[]}` | `hidden` -> `concealed-string` field type. |
| `createdAt` / `updatedAt` | `Item.creationAt` / `.modifiedAt` | ms -> UNIX seconds. |

**The passkey private key is PKCS#8 on the wire and a bare scalar at rest.** `core-rust` stores
`B64.encode(secret.to_bytes())` and signs with `SecretKey::from_slice`, i.e. the raw 32 bytes, while
CXF's `key` is PKCS#8 DER. Export wraps the scalar in a fixed 35-byte header
(`pkcs8FromScalar`; RFC 5915 makes the public key optional, so the scalar alone is enough); import
hands the DER to the Rust core's `passkey_import_pkcs8`, which returns the scalar and a canonical
COSE public key rather than storing the DER.

This one is worth knowing because **both failure modes are quiet**. Sending the raw scalar as `key`
decodes perfectly on the far side and only fails when the importer tries to use it, which iOS reports
as "some items could not be imported because they are duplicates or contain unsupported data",
naming nothing. Storing the DER on import would round-trip through our own code and fail every later
assertion. Apple's decoder does not validate the key, so `cxf-wire-probe.swift` accepts either;
`passkey-key.test.ts` checks the DER against WebCrypto instead, which is the parser a real
counterparty uses.

**SSH keys are asymmetric on purpose.** CXF's `SSHKey.privateKey` is PKCS#8 DER base64url; we store
PEM in whichever flavour the user pasted (OpenSSH, PKCS#1, SEC1, per `util/ssh.ts`). Parsing an
OpenSSH container is real work for a credential type no counterparty is known to consume, so **export**
downgrades them to `CustomFields` carrying the PEM verbatim, plus a warning. **Import** goes the other
way and builds a real `ssh-key` entry, because DER to PEM is a clean wrap. CXF carries no public key,
so that field comes back empty; we only ever copy it out.

Unknown CXF types on import (passport, wifi, drivers-license, ...) become custom fields on a note
entry with a warning rather than being dropped, matching how the KDBX importer handles foreign
databases. A credential of a type we *do* model that arrives malformed takes the same salvage path,
so one bad field can't cost the user the whole item.

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

### New plugin: `ios/App/App/CredentialExchange.swift` (BUILT)

Verified in the built Release product: the plugin symbols are in `App.app/App`, the extension
declares `SupportsCredentialExchange` + `SupportedCredentialExchangeVersions ["1.0"]`, and the app
declares `NSUserActivityTypes ["ASCredentialExchangeActivity"]`. **A real transfer is still
unverified**; see the simulator section.

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
| 1 | ~~Shared `core/src/exchange/` module + tests~~ **DONE** (31 tests, both directions + round trip). | - |
| 2 | ~~Swift plugin, Info.plist keys, AppDelegate hook, auto-lock grace~~ **BUILT, compile-verified; the transfer itself is unverified.** | - |
| 3 | ~~Import card, Settings export row, flags, i18n~~ **DONE.** | - |
| 4 | Device + interop testing. **Export -> Apple Passwords VERIFIED on device (2026-07-30), including a real webauthn.io sign-in from the transferred passkey. Import is untested.** | ~1d left |
| 5 | *Optional*: CXF file import/export through the existing file path, all targets, Android included | +1d |

**Remaining: phase 4 (device + interop testing, 1-2d), and optionally phase 5.**

**Export is done.** Bramble -> Apple Passwords on an iPhone SE (iOS 26.5.2) carried a login and a
passkey, and the transferred passkey then signed in on webauthn.io from Passwords. That is the
strongest available check: an importer will accept a structurally valid key it can never use, so
only a successful assertion proves the key material survived.

**Import has never run on a device.** It has more moving parts than export: the token handoff at a
cold launch, the claim against a locked vault, and unpacking the PKCS#8 back to a scalar, none of
which unit tests can cover.

Two defects that only a device could have found, both now fixed and both silent by nature:
a local Capacitor plugin that compiles and ships but is never registered (quirk 10), and a passkey
key sent in the wrong format, which decodes cleanly and fails only on use.

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
- **Decoding one of OUR payloads** through Apple's types: `cxf-wire-probe.swift <file.json>` reports
  what it accepted (titles, scope, credential kinds) or the decode error. This is the cheap way to
  check what iOS will take before a device says "unsupported data" and names nothing.
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
