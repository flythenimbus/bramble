# Passkey provider plan: becoming an authenticator

Plan for expanding Bramble (extension + iOS + Android) from a password manager into a **passkey
provider**: a WebAuthn authenticator that creates, stores, and signs passkeys for other websites and
apps. This is the credential-provider passkey role that `mobile-port.md` deferred out of v1; this
document picks it up.

Fast-moving platform facts (OS API surfaces, store rules, library availability) are dated
**June 2026** and flagged where unverified. Re-verify before acting on them later.

## Two WebAuthn roles, do not conflate them

Bramble already uses WebAuthn, but in the opposite direction from what this plan adds.

- **Consumer / relying-party (exists today).** Your security key's PRF unlocks the vault.
  `packages/core/src/vault/webauthn-ceremony.ts` calls `navigator.credentials.get()` to derive a
  KEK. Bramble *uses* an authenticator. See `docs/security-keys.md`.
- **Provider / authenticator (this plan).** Bramble *becomes* the authenticator. Other sites call
  `navigator.credentials.create()/.get()` and Bramble mints, stores, and signs with the passkey.

None of the existing WebAuthn code is reusable for the provider role. They share a name and nothing
else.

## Bottom line

- **The architecture is already ~80% there.** Every hard part of being a credential provider already
  exists and is device-tested: an encrypted vault, native crypto on all three platforms, an
  OS-registered credential-provider extension on iOS and a native autofill service on Android,
  host-based matching, biometric / keep-unlocked session unlock, and P2P E2E sync.
- **The new work is small and specific:** WebAuthn crypto in the shared Rust core (P-256 + COSE +
  attestation, which it lacks today), a passkey shape in the entry schema (no vault-format
  migration), and one platform-integration hook per surface.
- **Passkey sync is free.** Because passkeys are stored as vault entries, they ride the existing
  WebRTC E2E sync across your devices with no vendor cloud. This is a genuine differentiator over
  most synced-passkey providers.
- **Order of work:** shared core first, then iOS (lightest lift, fastest end-to-end proof), then
  Android, then the extension (trickiest). Platforms are independent once the core lands.

## What is reused as-is

| Capability | Where it lives | Notes |
|---|---|---|
| Per-entry DEK-under-VEK encryption | `packages/core/src/vault/entry-mutations.ts` | A passkey is just entry data. |
| Extensible discriminated-union entry schema | `packages/core/src/hooks/useVault.tsx` | SSH-key type already stores private keys. No format migration. |
| Shared Rust crypto core (wasm + uniffi ffi) | `packages/core-rust/` | Needs new functions (see Core work). |
| iOS credential-provider extension | `ios/App/AutoFillProbe/CredentialProviderViewController.swift` | Reads vault via App Group + native crypto. Add passkey methods to same class. |
| iOS credential identity registration | `ios/App/App/AutofillBridge.swift` | Add `ASPasskeyCredentialIdentity` alongside passwords. |
| Android `AutofillService` (`:autofill` process) | `android/.../BrambleAutofillService.kt` | Pattern reused; passkeys need a sibling `CredentialProviderService`. |
| Vault read + host matching (mobile) | `VaultReader.kt`, `AutofillUnlockActivity.kt` | `rpId` matches like a hostname; auth/selection activity pattern reused. |
| Biometric / keep-unlocked session unlock | iOS Keychain, Android Keystore | Becomes passkey user-verification. |
| P2P E2E entry sync | existing WebRTC mesh | Passkeys sync automatically. |

## Core work (do once, all platforms depend on it)

`core-rust` today has Argon2, AES-GCM, HKDF, ChaCha20, and secp256k1 (`k256`, for Nostr). It had
**no P-256, no COSE, no CBOR**, which is exactly what WebAuthn needs.

**Decision (implemented): `p256` + `coset` + `ciborium`, not the full `passkey-authenticator`.**
1Password's `passkey-authenticator` (https://github.com/1Password/passkey-rs) was evaluated first, but
its `Authenticator` is **async** and **CTAP2-transport-shaped**. The entire `core-rust` lib is sync
(tokio only enters under the iOS-only `webrtc` feature), and the OS hands a credential provider
WebAuthn-level requests, not CTAP transport, so its state machine is more than we need. Adopting it
would force an async runtime into the wasm + Android-ffi builds for no benefit. Instead the provider
crypto uses `p256` (EC keygen + ECDSA), `coset` (COSE_Key encoding), and `ciborium` (attestation
CBOR): all pure-Rust and sync. The remaining spec-critical byte assembly (authenticatorData layout)
is small and unit-tested with a real sign-then-verify round-trip.

Implemented in `packages/core-rust/src/passkey.rs`, exported from both layers
(`#[wasm_bindgen]` + `#[uniffi::export]`) mirroring the `encrypt_entry` style:

- `passkey_make_credential(rp_id, user_verified) -> { credentialId, publicKeyCose, privateKey, attestationObject, authenticatorData, publicKey }`
  (`authenticatorData` and `publicKey` (SPKI DER) are returned separately because Chrome's proxy
  requires them as siblings of `attestationObject` in the response JSON; see Cross-cutting decisions.)
- `passkey_get_assertion(rp_id, private_key_b64, client_data_hash_b64, user_verified) -> { authenticatorData, signature }`

The functions are **pure** (no VEK slot): the private key is returned at creation, stored inside the
entry via the existing DEK-under-VEK path, and handed back in for each assertion, exactly like a
password transits the boundary today.

**All passkey crypto stays in the Rust core**, not WebCrypto/Swift/Kotlin. One audited
implementation across three platforms, and it sidesteps the iOS Lockdown-Mode WASM-JIT failure the
native core was built to fix (`docs/cryptography.md`, `ios-lockdown-mode-breaks-wasm`).

Build impact is minimal: add the dep, recompile via the existing `scripts/build-crypto-ffi.sh`. P-256
adds modest size; gate behind a cargo feature if needed.

## Data model

A discoverable passkey credential needs: `credentialId`, `rpId`, `rpName`, `userHandle`, `userName`,
`userDisplayName`, `privateKey` (encrypted under the entry DEK like any field), `publicKeyCose`,
`alg` (COSE, usually -7 / ES256), `signCount`, `createdAt`, `lastUsedAt`.

**Decision: embed a `passkeys[]` array on the login entry (Bitwarden model) as primary, with a
standalone `type: "passkey"` entry as fallback** for passkey-only sites with no login. Embedding
reuses the hostname index, sync merge, and login UI, and matches the user mental model ("my GitHub
login, which now also has a passkey"). The discriminated-union schema accepts the new shape with no
vault-format change; Zod forward-compat preserves it on round-trip.

## Item UI (edit + view)

Passkeys are managed, not edited: the user never types key material, only removes a credential.

- **Item edit form (login):** render each passkey **below the TOTP field**, one row per credential
  showing its identity (rpId / userName, created date) and a **Remove** button. No fields are
  editable; Remove drops it from `passkeys[]` on save. Bramble does not add passkeys from the edit
  form (they are minted by the provider ceremony), so there is no "add passkey" control here.
- **Item view (read-only):** show only an indicator that the item **contains a passkey** (a small
  "Passkey" badge/row), never the credential id, public key, or any key material.

## Platform integrations

### iOS (lightest lift, do first)

The extension already exists and already decrypts the vault natively via App Group + uniffi. Add to
`CredentialProviderViewController`:

- `prepareInterface(forPasskeyRegistration:)` for create.
- `provideCredentialWithoutUserInteraction(for:)` and `prepareCredentialList(for:requestParameters:)`
  for assertion, handling `ASPasskeyCredentialRequest`.
- Return `ASPasskeyRegistrationCredential` / `ASPasskeyAssertionCredential` via
  `completeRegistrationRequest` / `completeAssertionRequest`.
- Register `ASPasskeyCredentialIdentity` alongside passwords in `AutofillBridge.swift`.
- Add `<key>ProvidesPasskeys</key><true/>` to the extension `Info.plist`. The autofill entitlement
  already covers both targets. Gate to iOS 17+.

Apple: developer generates the passkey; the request object carries the options.
(https://developer.apple.com/documentation/authenticationservices/supporting-passkeys)

### Android (medium lift)

Add a **new** framework `android.service.credentials.CredentialProviderService` (API 34+) as a
sibling to the autofill service. **Confirmed pure AOSP, no Google Play Services**
(https://developer.android.com/identity/sign-in/credential-provider). The
`credentials-play-services-auth` artifact is only for API <= 33 and Google Password Manager, so this
stays inside the no-Play-Services constraint (`mobile-android-no-google-play`) and works on
GrapheneOS.

- Add `androidx.credentials:credentials` (provider APIs only; verify it does not pull
  `credentials-play-services-auth`).
- Declare the service with `android.permission.BIND_CREDENTIAL_PROVIDER_SERVICE`, the
  `android.service.credentials.CredentialProviderService` intent action, and a capabilities meta-data
  XML listing `androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL`.
- Implement `onBeginCreateCredentialRequest` / `onBeginGetCredentialRequest`; reuse the
  `AutofillUnlockActivity` pattern for auth + selection.
- compileSdk / targetSdk are already 36. minSdk is 24, so guard the service to API 34+ at runtime;
  passkeys are simply unavailable below 34, which matches the platform.

### Extension (trickiest, do last)

Chrome's third-party passkey API is **`chrome.webAuthenticationProxy`**
(https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy). Chromium-only,
which matches the current extension target.

- Add the `"webAuthenticationProxy"` permission; `attach()` when enabled.
- Handle `onCreateRequest` / `onGetRequest` / `onIsUvpaaRequest` / `onRequestCanceled` in the service
  worker; reply with `completeCreateRequest` / `completeGetRequest`. Crypto goes through the existing
  offscreen document.

Two things make this the hard surface:

1. **All-or-nothing interception.** While attached you intercept *every* WebAuthn call browser-wide.
   There is no clean "let Chrome's built-in handle this one"; you either fulfill or return an error.
   Attach only on explicit user opt-in.
2. **You own origin -> rpId validation.** Mobile OSes guarantee the calling origin; in the proxy
   *we* must verify the origin matches the `rpId`, or we break passkey phishing-resistance. This is
   security-critical, not optional.
3. **Ceremony UI is a popup window**, not the in-page autofill picker, because the proxy intercepts
   below the page. Different UX path from current autofill.

## Cross-cutting decisions

- **`signCount` = 0, always.** The spec permits it and synced passkeys require it: a real counter
  regresses when the same passkey is used on two synced devices, which some RPs flag as a cloned
  authenticator. Our sync makes 0 mandatory.
- **Attestation = `"none"`.** Standard for password managers. Pick one fixed Bramble AAGUID (use the
  community AAGUID registry) so RPs can show the Bramble icon. NOTE: the strict spec reading zeroes
  the AAGUID for `none` attestation, and a minority of RPs (e.g. Quarkus-webauthn) reject a non-zero
  one. We keep a non-zero AAGUID anyway, matching 1Password / Apple / the major RPs (which accept it
  and use it for attribution); the placeholder in `passkey.rs` must be finalized + registered before
  launch.
- **Backup flags BE + BS = 1.** Bramble syncs passkeys across devices, so authenticatorData sets
  backup-eligible + backed-up (`0x18`); without them RPs treat the credential as single-device and
  may nag the user to add another. (Set in `passkey.rs`.)
- **User verification.** Honor `userVerification: "required"` with a real biometric tap *even inside
  a keep-unlocked session*. Do not let the convenience session silently satisfy UV; that is a
  passkey-specific security regression.
- **Response JSON completeness (device-verified against webauthn.io).** Chrome validates
  `completeCreateRequest` against the W3C `RegistrationResponseJSON` and rejects a partial one with
  `Invalid responseJson: field missing or invalid: <field>` (which makes `create()` hang, so the RP
  silently does nothing). The `response` object must include **all** of: `clientDataJSON`,
  `attestationObject`, `authenticatorData`, `transports`, `publicKeyAlgorithm`, and **`publicKey`**
  (SPKI DER). Note `publicKey` is marked *optional* in the W3C spec but Chrome's proxy requires it
  anyway, so the Rust core returns the SPKI alongside the attestation object. The assertion response
  needs `clientDataJSON`, `authenticatorData`, `signature`, and `userHandle` (null when absent).
- **Algorithms.** Support ES256 (COSE -7) at minimum; add Ed25519 (-8) and RS256 (-257) as RP demand
  shows. `passkey-rs` covers the common set.

## Security notes

- Passkeys are bearer private keys for authentication. They inherit the vault's at-rest encryption
  (entry DEK under VEK) with no new storage surface.
- Origin/rpId binding is the phishing-resistance guarantee. On the extension it is our code; treat it
  as the highest-risk line in the feature.
- A `security-review` pass is warranted before shipping each platform.

## Phased route

0. **Core (DONE).** `p256` + `coset` + `ciborium` in `core-rust/src/passkey.rs`; the `passkeys[]`
   entry shape in `packages/core`; `passkey_make_credential` / `passkey_get_assertion` exported on
   **both** the wasm (extension) and uniffi (iOS/Android) layers; sign-then-verify unit tests pass.
1. **TS binding (DONE).** `passkeyMakeCredential` / `passkeyGetAssertion` through `VaultCrypto` +
   `CryptoAdapter` + `buildCryptoAdapter`; the extension `CRYPTO_PASSKEY_*` messages + offscreen
   dispatch; the mobile NativeCrypto JS shim. Pure placement logic (`core/src/vault/passkey.ts`).
2. **Extension provider (built, in device testing).** DONE: WebAuthn JSON helpers,
   `handleCreate`/`handleGet` orchestration (unit-tested), ambient chrome types, the
   `webAuthenticationProxy` permission, the save-passkey **corner card** (same placement as
   save-password) for create + get, the create-time vault write (`savePlacement`), the
   **Settings → General toggle** ("Use Bramble for passkeys", gated on `shell.supportsPasskeyProvider`,
   applies live + persists), and **pause-during-own-unlock** (the proxy detaches around Bramble's own
   security-key PRF ceremony, reentrant, via PASSKEY_PROXY_PAUSE/RESUME). **Origin resolved:**
   `requestDetailsJson` carries no origin (W3C options shape) and the events carry no tab, so the
   origin comes from the **active tab** (`chrome.tabs.query({active, lastFocusedWindow})`), which is
   authoritative since WebAuthn requires a focused top-level context. **Multi-account create** is
   handled: a new passkey attaches to the login matching the request `user.name`; when several
   domain logins are ambiguous the card shows a **picker** (each candidate + "Create a new login"
   last). **Get picker** done too: when several stored passkeys match the rpId, sign-in shows a
   chooser (by account) instead of using the first. **Item UI** done: the login edit form lists
   passkeys below TOTP with a Remove each (and carries them through save so an edit never drops
   them), and the read view shows a passkey badge per account. **VERIFIED end-to-end on webauthn.io:**
   register + authenticate both succeed on a real Chrome (locked and unlocked). Device testing also
   surfaced the response-field requirements above (origin-from-tab, `authenticatorData`,
   `publicKeyAlgorithm`, `publicKey`, BE/BS flags) — all now fixed.
3. **iOS provider (TODO).** `ProvidesPasskeys`, the `ASPasskeyCredentialRequest` methods,
   `ASPasskeyCredentialIdentity`, native passkey crypto plugin methods. Needs Xcode + a device.
4. **Android provider (TODO).** `CredentialProviderService` + `androidx.credentials`, native plugin
   methods. Needs Android SDK + a device.
5. **Management UI + settings.** List / delete passkeys, per-platform enable. Sync is free.

Steps 2 to 4 are independent now that the core + TS binding (0, 1) have landed.

## Unknowns to retire early

- ~~Exact `passkey-rs` trait surface and whether to use `passkey-authenticator` or `passkey-types`.~~
  RESOLVED in Phase 0: rejected the async CTAP2 authenticator; using sync `p256` + `coset` + `ciborium`.
- Whether `androidx.credentials:credentials` pulls any Play-Services transitive dependency. Verify
  with a dependency tree before committing the Android dep.
- `webAuthenticationProxy` conditional-mediation (passkey autofill in the username dropdown) behavior
  under the proxy. Treat as a Phase 3 nicety, not a blocker.
- Current iOS deployment target vs the iOS 17 floor for passkey provider methods.
