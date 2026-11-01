# Passkey PRF (WebAuthn `prf` extension) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bramble's passkeys answer the WebAuthn PRF extension on every provider surface (Chrome, Firefox, Android, iOS), and their PRF secrets survive every import, export and credential-exchange path.

**Architecture:** Every new passkey gets a CTAP-style pair of 32-byte secrets (`credWithUV`, `credWithoutUV`) stored inside the encrypted passkey. The shared Rust core computes PRF output (wasm for the extension, uniffi for iOS and Android), so all four surfaces produce identical bytes. Each surface only parses the site's PRF inputs and wraps the core's output in its own response format.

**Tech Stack:** Rust (`hmac` 0.12, `sha2` 0.10, both already dependencies), wasm-bindgen, uniffi 0.31, TypeScript (vitest, zod), Kotlin (androidx.credentials), Swift (AuthenticationServices, iOS 18 PRF API), Playwright.

**Spec:** the Design section below, written from issue #169 and the investigation behind it. Background: [passkey-provider.md](passkey-provider.md), [credential-exchange.md](credential-exchange.md), [passkey-import.md](passkey-import.md).

**Status:** built 2026-11-01 on all four surfaces, plus the Proton import and credential exchange.
Verified: the Rust known-answer test; the TS, Kotlin JVM and mobile unit tests; Chrome's real
webAuthenticationProxy end to end (`e2e/extension/passkey-prf.spec.ts`: registration and sign-in
give the same key, `evalByCredential` wins over `eval`); Apple's CXF decoder accepting our export
(the macOS 26.6 probe); Android and iOS compiling (Kotlin, simulator builds of both targets). Not yet
run on a device: Android, iPhone, Firefox, and the cross-device check.

## Why

Issue #169: sites that use a passkey as an encryption key (AliasVault's passkey unlock, Corbado's PRF demo, Bitwarden's passkey login) ask for PRF at registration and refuse when the response carries no `prf` output. Bramble answers every ceremony with `clientExtensionResults: {}` (`webauthn-json.ts`, `WebauthnJson.kt`), iOS never sets `extensionOutput`, and the Proton and CXF imports drop the secret.

## Design

Facts this rests on, checked 2026-11-01:

- **Chrome's proxy carries PRF both ways.** `components/webauthn/json/value_conversions.cc` writes `extensions.prf.eval` and `evalByCredential` into `requestDetailsJson` as base64url of the site's raw inputs (`authenticator.mojom`: "These are unhashed values when used as inputs"). It parses `clientExtensionResults.prf` from our response: on create `enabled` (bool) is required, and `results.first` / `second` must decode to exactly 32 bytes.
- **iOS 18 SDK** (Xcode 26.4): `ASPasskeyCredentialRequest.extensionInput` is an enum (`.assertion`, `.registration`, `.none`); `ASPasskeyCredentialRequestParameters.extensionInput` is the assertion input. PRF inputs are `inputValues` (`saltInput1`, `saltInput2`) and `perCredentialInputValues` (keyed by credential ID `Data`); registration adds `shouldCheckForSupport`. Outputs go through the `extensionOutput:` initializers of `ASPasskeyAssertionCredential` and `ASPasskeyRegistrationCredential`. Apple documents the inputs as "analogous to AuthenticationExtensionsPRFValues", which is to say raw.
- **Apple's CXF types** (iOS and macOS 26.4) carry `fido2Extensions.hmacCredentials { algorithm: "hmac-sha256", credWithUV, credWithoutUV }` (base64url) plus `largeBlob`. Probed on macOS 26.6 against the real framework: **a payload whose `hmacCredentials` lacks `credWithoutUV` is rejected whole**, and `credBlob` / `payments` are dropped by Apple's decoder. Before 26.4 the field doesn't exist, so the OS drops it without a word.
- **Proton Pass** exports `ext.hmac_secret { cred_with_uv, cred_without_uv | null }`, the shape of 1Password's passkey-rs.

Decisions:

1. **Stored shape.** `PasskeyCredential.prf?: { credWithUV: string; credWithoutUV: string }`, standard base64. Both halves are required inside `prf` because CXF (and Apple) require both. The field is optional on the passkey, since passkeys created before this change have none. The change is additive, so there is no migration: older builds keep unknown keys on read and write (`normalizeEntryData`, the mutation `validate` gate), and sync merges passkeys whole by `credentialId`.
2. **Minting.** `passkey_make_credential` returns both secrets (32 random bytes each) for every new passkey, whether or not the site asked for PRF.
3. **Never mint a secret later.** A passkey without `prf` answers PRF requests with no output. If two devices each minted one lazily before syncing, whatever the site encrypted under the losing secret would be unrecoverable.
4. **PRF only with user verification, and always `credWithUV`.** Every ceremony that answers PRF reports UV. The extension and Android already always do. iOS's no-UI fast path (`provideCredentialWithoutUserInteraction`, UV=0) must send a PRF request to the UI path (`.userInteractionRequired`) instead of answering it. So a site always gets the same output for the same input. `credWithoutUV` is stored and exported for fidelity; Bramble never evaluates it.
5. **Formula.** `salt = SHA-256("WebAuthn PRF" || 0x00 || input)`, then `output = HMAC-SHA256(credWithUV, salt)`, for `first` and the optional `second`. This is WebAuthn's PRF-to-hmac-secret mapping, so secrets imported from Proton or Apple keep producing the outputs sites already rely on. The core accepts any non-empty secret length, because CXF doesn't pin it to 32.
6. **Input selection.** On get: `evalByCredential[base64url(credentialId)]` if present, else `eval`. On create only `eval` applies. A `prf` object with no usable `eval` still counts as "requested".
7. **Responses.** Create, when requested: `clientExtensionResults.prf = { enabled: true, results? }`. Get, when inputs exist and the passkey has secrets: `{ prf: { results } }`. Otherwise there is no `prf` key at all. A failed evaluation never blocks the ceremony: it answers without results.
8. **Imports.** Proton: keep `hmac_secret`. CXF: keep `hmacCredentials` when `algorithm` is absent or `hmac-sha256`. Anything else is left out and warned about. A missing `credWithoutUV` is filled with 32 fresh random bytes: the source never produced a without-UV output, so nothing depends on it, and exporting needs both halves.
9. **Other CXF members.** Every other `fido2Extensions` member (`largeBlob`, `credBlob`, `payments`, unknown keys) is kept verbatim on `PasskeyCredential.fido2Extensions?: Record<string, unknown>` and re-emitted on export. Bramble doesn't serve a large blob to sites; it just stops dropping one.
10. **Old iOS.** `ExchangeAvailability.passkeyExtensions` is true on iOS 26.4+. Below that, export leaves `fido2Extensions` out and warns with a count, and import warns once when passkeys arrived.

## Global Constraints

- No em dashes anywhere: prose, comments, docs, commit messages.
- Comments are terse and one line; explanations belong in this doc or the topic docs.
- Stored passkey base64 is STANDARD; WebAuthn JSON and CXF are base64url. Convert only at those edges (`@core/util/bytes`, `WebauthnJson.stdToUrl` / `urlToStd`).
- No new dependencies anywhere.
- The AAGUID, `signCount` 0, ES256-only minting and the origin/rpId checks are unchanged.
- Records holding secrets (`PasskeyPrfSecrets`, `PasskeyPrfOutput`) don't derive `Debug`, matching the existing passkey records.
- iOS: PRF code is `@available(iOS 18.0, *)`, the deployment target stays 15.0, and stored request captures use plain types (no iOS 18 types in stored properties).
- Android: pure AOSP. JVM unit tests can't call `org.json` or `android.util.Base64`, so keep tested logic pure.
- The content script stays flat: `webauthn-inpage-codec.ts` imports nothing.
- `packages/core/src` imports no `node:` modules.
- Commit in `.claude/worktrees/passkey-prf`; land on main with `git cherry-pick --ff`. No `Co-Authored-By` trailer, and no testing status in commit bodies.
- Run JS tests with `CI=true`. Don't run `rustfmt` on `lib.rs` or `passkey.rs` (neither is rustfmt-clean, and `lib.rs` walks every module); hand-format the new hunks.

## Review Focus

1. **Cross-platform agreement.** The same passkey and input must give the same 32 bytes on Chrome, Firefox, Android and iOS. The Rust known-answer test pins the formula. Every surface must hand the site's raw input to the core unhashed: TS tests assert the exact `passkeyPrfEval` arguments, and Android and iOS are checked in review and on a device (create on Chrome, evaluate on the phone, compare).
2. **An old passkey asked for PRF.** It signs in normally with no `prf` key in the response, never an error (Task 3 test, mirrored in Tasks 8 and 9).
3. **An older Bramble build editing a login.** It must not strip `prf` or `fido2Extensions`. Task 2 pins that an unknown passkey-level key survives `normalizeEntryData` and the schema gate.
4. **iOS fast path.** A PRF request with a live keep-unlocked session and UV not required must reach the unlock UI rather than be answered without PRF (Task 9, then a device check).
5. **Malformed inputs.** A page passing `prf: { eval: {} }`, non-buffer values or junk `evalByCredential` keys gets a normal ceremony without PRF output. A CXF payload with a malformed `fido2Extensions` still imports the passkey (tests in Tasks 3, 4 and 7).

---

### Task 1: Rust core mints PRF secrets and evaluates PRF

**Files:**
- Modify: `packages/core-rust/src/passkey.rs` (records beside `PasskeyRegistration`, `passkey_make_credential_core`, new `passkey_prf_eval_core`, tests module)
- Modify: `packages/core-rust/src/lib.rs` (`pub use passkey::{...}` at L50, wasm exports near L979, uniffi exports near L1208)

**Interfaces:**
- Produces (Rust):
  ```rust
  #[derive(Serialize, Deserialize, Clone)] #[cfg_attr(feature = "ffi", derive(uniffi::Record))]
  pub struct PasskeyPrfSecrets {
      #[serde(rename = "credWithUV")] pub cred_with_uv: String,       // std base64, 32 bytes
      #[serde(rename = "credWithoutUV")] pub cred_without_uv: String, // std base64, 32 bytes
  }
  // PasskeyRegistration gains: pub prf: PasskeyPrfSecrets
  #[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase")] #[cfg_attr(feature = "ffi", derive(uniffi::Record))]
  pub struct PasskeyPrfOutput { pub first: String, pub second: Option<String> } // std base64, 32 bytes
  pub fn passkey_prf_eval_core(secret_b64: &str, first_b64: &str, second_b64: Option<&str>) -> Result<PasskeyPrfOutput, CryptoError>
  ```
- Produces (bindings): wasm `passkey_prf_eval(secret_b64: String, first_b64: String, second_b64: Option<String>) -> Result<JsValue, CryptoError>`; uniffi `passkey_prf_eval(..) -> Result<PasskeyPrfOutput, CryptoError>`, generated as Swift `passkeyPrfEval(secretB64:firstB64:secondB64:)` and Kotlin `passkeyPrfEval(secretB64, firstB64, secondB64)`. Registration fields appear as `reg.prf.credWithUv` / `credWithoutUv` in Swift and Kotlin.

- [ ] **Step 1: Write the failing tests** (in `mod tests` of `passkey.rs`; expected values computed independently with Python `hashlib` / `hmac`)

```rust
const PRF_SECRET: &str = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI="; // [0x42; 32]
const PRF_FIRST: &str = "YnJhbWJsZSBwcmYgZmlyc3Q="; // b"bramble prf first"
const PRF_SECOND: &str = "YnJhbWJsZSBwcmYgc2Vjb25k"; // b"bramble prf second"

#[test]
fn prf_eval_matches_the_webauthn_prf_known_answer() {
    let out = passkey_prf_eval_core(PRF_SECRET, PRF_FIRST, Some(PRF_SECOND)).unwrap();
    assert_eq!(out.first, "l17eP4YXVSoOkA30zevkt0OoDFa6lS0bFCcFIPovvvA=");
    assert_eq!(out.second.as_deref(), Some("EL5WJd9tQR3B5TfbtQ+paoqLEyi9uNnzLO3mnZRujMs="));
}

#[test]
fn prf_eval_without_a_second_input_returns_no_second_output() {
    let out = passkey_prf_eval_core(PRF_SECRET, PRF_FIRST, None).unwrap();
    assert_eq!(out.first, "l17eP4YXVSoOkA30zevkt0OoDFa6lS0bFCcFIPovvvA=");
    assert!(out.second.is_none());
}

#[test]
fn prf_eval_refuses_a_bad_secret_without_echoing_it() {
    for bad in ["", "AAAA!AAA"] {
        let Err(e) = passkey_prf_eval_core(bad, PRF_FIRST, None) else { panic!("{bad:?} must be refused") };
        assert_eq!(format!("{e}"), "invalid passkey PRF secret");
    }
}

#[test]
fn make_credential_mints_two_distinct_32_byte_prf_secrets() {
    let a = passkey_make_credential_core("rp.example", true).unwrap();
    let b = passkey_make_credential_core("rp.example", true).unwrap();
    assert_eq!(B64.decode(&a.prf.cred_with_uv).unwrap().len(), 32);
    assert_eq!(B64.decode(&a.prf.cred_without_uv).unwrap().len(), 32);
    assert_ne!(a.prf.cred_with_uv, a.prf.cred_without_uv);
    assert_ne!(a.prf.cred_with_uv, b.prf.cred_with_uv);
}
```

(If `CryptoError`'s `Display` adds a prefix, assert `contains` instead of `assert_eq!`, as the existing tests do.)

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/core-rust && cargo test --locked passkey`
Expected: compile errors (`passkey_prf_eval_core` not found, no field `prf`).

- [ ] **Step 3: Implement in `passkey.rs`**

`Hmac<Sha256>::new_from_slice(secret)` over `Sha256::new().chain_update(b"WebAuthn PRF").chain_update([0u8]).chain_update(input).finalize()`. Decode the secret into `Zeroizing`. Use fixed error messages, `"invalid passkey PRF secret"` (empty or undecodable) and `"invalid passkey PRF input"`, never `b64_decode`'s byte-naming message. An empty input is valid. Mint the two secrets with `random_bytes` into `Zeroizing<[u8; 32]>`.

- [ ] **Step 4: Export from `lib.rs`**

Add the wasm and uniffi `passkey_prf_eval`, mirroring `passkey_get_assertion` in each layer, and add `PasskeyPrfOutput, PasskeyPrfSecrets` to the `pub use passkey::{...}`.

- [ ] **Step 5: Run the tests and both binding builds**

Run: `cd packages/core-rust && cargo test --locked passkey && cargo check --locked --no-default-features --features ffi && cargo check --locked --target wasm32-unknown-unknown`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core-rust/src/passkey.rs packages/core-rust/src/lib.rs
git commit -m "feat(passkey): mint PRF secrets and evaluate the WebAuthn prf extension in the core"
```

### Task 2: TS crypto surface and the stored passkey carry PRF

**Files:**
- Modify: `packages/core/src/adapters/crypto.ts`, `packages/core/src/wasm.ts`, `packages/core/src/adapters/crypto-wasm.ts`, `packages/core/src/hooks/useVault.tsx` (`PasskeyCredential`), `packages/core/src/vault/entry-normalize.ts`
- Modify: `clients/extension/src/crypto/messages.ts`, `clients/extension/src/crypto.ts`, `clients/extension/src/offscreen-core.ts`, `clients/extension/src/background/passkey-store.ts`
- Modify: `clients/desktop/src/adapters/crypto.ts`, `clients/mobile/src/native-crypto.ts`
- Test: `packages/core/src/adapters/crypto-wasm.test.ts`, `packages/core/src/vault/entry-normalize.test.ts`, create `clients/extension/src/offscreen-passkey-prf.test.ts`; update the `PasskeyRegistration` fakes in `clients/extension/src/background/webauthn-proxy.test.ts` and `crypto-wasm.test.ts` to carry `prf`

**Interfaces:**
- Consumes: Task 1's wasm `passkey_prf_eval`.
- Produces:
  ```ts
  // adapters/crypto.ts
  export interface PasskeyPrfSecrets { credWithUV: string; credWithoutUV: string } // std base64
  export interface PasskeyPrfOutput { first: string; second?: string }             // std base64, 32 bytes
  // PasskeyRegistration gains: prf: PasskeyPrfSecrets
  // CryptoAdapter gains:
  passkeyPrfEval(secretB64: string, firstB64: string, secondB64?: string): Promise<PasskeyPrfOutput>;
  // wasm.ts VaultCrypto gains:
  passkey_prf_eval(secretB64: string, firstB64: string, secondB64?: string): Awaitable<PasskeyPrfOutput>;
  // useVault.tsx PasskeyCredential gains:
  prf?: PasskeyPrfSecrets;
  fido2Extensions?: Record<string, unknown>; // CXF members Bramble can't use, kept verbatim (base64url)
  // extension: message "CRYPTO_PASSKEY_PRF", payload { secretB64: string; firstB64: string; secondB64?: string }
  // background/passkey-store.ts:
  export async function passkeyPrfEval(secretB64: string, firstB64: string, secondB64?: string): Promise<PasskeyPrfOutput>
  ```

- [ ] **Step 1: Write the failing tests**

- `crypto-wasm.test.ts`: add `passkey_prf_eval: vi.fn(() => ({ first: "b3V0" }))` to the fake module. `expect(await adapter.passkeyPrfEval("c2Vj", "Zmlyc3Q=")).toEqual({ first: "b3V0" })` and `expect(wasm.passkey_prf_eval).toHaveBeenCalledWith("c2Vj", "Zmlyc3Q=", undefined)`.
- `offscreen-passkey-prf.test.ts`, mirroring `offscreen-passkey-import.test.ts`: `handleHostMessage("CRYPTO_PASSKEY_PRF", { secretB64: "c2Vj", firstB64: "Zmlyc3Q=", secondB64: "c2Vjb25k" })` resolves `{ ok: true, data: <stub output> }`, and the stub saw exactly those three values. With `{}`, `ok` is false and the stub was never called.
- `entry-normalize.test.ts`, `it("keeps a passkey's PRF secrets, extension data and keys it doesn't know")`: a login whose passkey carries `prf: { credWithUV: "QQ==", credWithoutUV: "Qg==" }`, `fido2Extensions: { largeBlob: { uncompressedSize: 3, data: "AAAA" } }` and `futureKey: 1` passes `entryDataSchema.safeParse(...).success`, and `normalizeEntryData(raw).passkeys[0]` deep-equals the input, `futureKey` included.

- [ ] **Step 2: Run them to see them fail**

Run: `CI=true pnpm --filter @vault/core test -- crypto-wasm entry-normalize && CI=true pnpm --filter @vault/platform-extension test -- offscreen-passkey-prf`
Expected: FAIL (`passkeyPrfEval` is not a function, unknown message `CRYPTO_PASSKEY_PRF`, `prf` stripped by the schema).

- [ ] **Step 3: Implement the surface**

Add the types and the zod mirror: `prf: z.object({ credWithUV: z.string(), credWithoutUV: z.string() }).optional()` and `fido2Extensions: z.record(z.string(), z.unknown()).optional()`. Then wire the wasm adapter, the `CryptoPasskeyPrfSchema` message plus its offscreen case and UI adapter method, and the background `passkeyPrfEval` (via `sendToOffscreen`, like `passkeyGetAssertion`). Desktop gets `passkeyPrfEval: () => notWired("Passkey PRF")`. Mobile gets `passkey_prf_eval: () => Promise.reject(new Error("passkey PRF runs in the native credential provider"))`, because the webview never acts as the provider.

- [ ] **Step 4: Run the tests and typecheck**

Run: the Step 2 command, then `pnpm -r run typecheck`
Expected: PASS everywhere.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(passkey): carry PRF secrets through the TS crypto surface and the stored passkey"
```
(`git add` the new test file first.)

### Task 3: The extension's ceremony handlers answer PRF (Chrome path, shared with Firefox)

**Files:**
- Modify: `clients/extension/src/background/webauthn-json.ts`, `clients/extension/src/background/webauthn-proxy.ts`, `clients/extension/src/background/webauthn-provider.ts` (`depsForTab` crypto adds `passkeyPrfEval`)
- Test: `clients/extension/src/background/webauthn-json.test.ts`, `clients/extension/src/background/webauthn-proxy.test.ts`

**Interfaces:**
- Consumes: Task 2's `passkeyPrfEval`, `PasskeyPrfSecrets`, `PasskeyCredential.prf`.
- Produces (`webauthn-json.ts`):
  ```ts
  export interface PrfValues { first: string; second?: string } // base64url, as on the wire
  // ParsedCreationOptions gains: prf?: { eval?: PrfValues }   (present = requested)
  // ParsedRequestOptions gains:  prf?: { eval?: PrfValues; evalByCredential?: Record<string, PrfValues> }
  export function prfInputsFor(prf: ParsedRequestOptions["prf"], credentialIdB64Url: string): PrfValues | undefined;
  // registrationResponseJSON param gains:   prf?: { enabled: boolean; results?: PrfValues }
  // authenticationResponseJSON param gains: prf?: { results: PrfValues }
  ```
  Parsing: `extensions.prf` counts as requested only when it is a plain object. A `PrfValues` needs a string `first` (and a string `second` if one is given); anything else is treated as absent. Invalid `evalByCredential` entries are dropped.
- `PasskeyProxyDeps.crypto` becomes `Pick<CryptoAdapter, "passkeyMakeCredential" | "passkeyGetAssertion" | "passkeyPrfEval">`.

- [ ] **Step 1: Write the failing tests**

`webauthn-json.test.ts`:
- `parses PRF inputs on creation`: `{ prf: { eval: { first: "AQ" } } }` gives `.prf` equal to `{ eval: { first: "AQ" } }`; `{ prf: {} }` gives `{}`; no extensions gives `undefined`.
- `parses PRF inputs on request and drops malformed ones`: `eval: { first: "Ag" }`, plus `evalByCredential: { Q0lE: { first: "AQ", second: "Aw" }, bad: { first: 5 } }`, yields `evalByCredential` equal to `{ Q0lE: { first: "AQ", second: "Aw" } }`.
- `prfInputsFor prefers the credential's own inputs over eval`: returns the `Q0lE` entry for `"Q0lE"`, `eval` for `"WFla"`, and `undefined` when neither exists.
- `response builders carry prf only when given`: the registration builder with `prf: { enabled: true, results: { first: "AQ" } }` gives `clientExtensionResults` equal to `{ prf: { enabled: true, results: { first: "AQ" } } }`; without `prf` it gives `{}`. Assert the same for the authentication builder with `{ results }`.

`webauthn-proxy.test.ts` (add `passkeyPrfEval: vi.fn(async () => ({ first: "+/8=" }))` to `deps()`; the minted fake has `prf: { credWithUV: "V1VW", credWithoutUV: "Tk9VVg==" }`):
- `create stores the minted PRF secrets on the credential`: the planned passkey's `prf` equals the fake's `prf`.
- `create answers a PRF request with enabled and the eval output`: request `extensions: { prf: { eval: { first: "-_8" } } }`. `passkeyPrfEval` is called with `("V1VW", "+/8=", undefined)` (base64url converted to standard, no hashing), and the response `clientExtensionResults.prf` equals `{ enabled: true, results: { first: "-_8" } }`.
- `create answers a bare PRF request with enabled and no results`: `prf: {}` gives `{ enabled: true }`, and `passkeyPrfEval` isn't called.
- `create without a PRF request returns no extension results`: `clientExtensionResults` equals `{}`.
- `get evaluates PRF with the chosen credential's own inputs`: the fixture passkey gets `prf`. With `evalByCredential: { Q0lE: { first: "AQ" } }` and `eval: { first: "Ag" }`, the call is `("<fixture credWithUV>", "AQ==", undefined)` and the response has `prf.results.first`.
- `get falls back to eval when the credential has no own inputs`: the call uses `"Ag=="`.
- `get signs in without PRF output for a passkey minted before PRF`: the fixture passkey has no `prf`. There is no `error`, no `prf` key, and no `passkeyPrfEval` call.
- `get gives no PRF output without user verification`: the ceremony returns `userVerified: false`, so there is no `prf` key and no call.
- `a failed PRF evaluation still completes the ceremony`: `passkeyPrfEval` rejects. Create still answers `{ enabled: true }` and get answers without `prf`, with no `error` in either case.

- [ ] **Step 2: Run them to see them fail**

Run: `CI=true pnpm --filter @vault/platform-extension test -- webauthn-json webauthn-proxy`
Expected: FAIL.

- [ ] **Step 3: Implement**

Do the parsing and builders in `webauthn-json.ts`. In `handleCreate`, the credential gets `prf: reg.prf`, and when `opts.prf` is set the response carries `{ enabled: true, results }`. Results come from `passkeyPrfEval(reg.prf.credWithUV, ..)` only when `decision.userVerified` and an `eval` exists. In `handleGet`, call `prfInputsFor(opts.prf, base64ToBase64Url(chosen.passkey.credentialId))` and evaluate only with UV and stored `prf`. Wrap evaluation in try/catch so it yields no results.

- [ ] **Step 4: Run tests and typecheck**

Run: the Step 2 command, then `pnpm --filter @vault/platform-extension typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(extension): answer the WebAuthn prf extension from the passkey provider"
```

### Task 4: The Firefox in-page codec carries PRF

**Files:**
- Modify: `clients/extension/src/content/webauthn-inpage-codec.ts`
- Test: `clients/extension/src/content/webauthn-inpage-codec.test.ts`

**Interfaces:**
- Consumes: Task 3's JSON contract (`extensions.prf.eval` / `evalByCredential` as base64url; `clientExtensionResults.prf.results` as base64url).
- Produces: `serializeCreateOptions` / `serializeGetOptions` emit `extensions: { prf: {...} }` only when `pk.extensions?.prf` is an object. `getClientExtensionResults()` returns `prf.results.first` / `second` as page-realm `ArrayBuffer`s and keeps `enabled`; `toJSON()` stays the base64url JSON.

- [ ] **Step 1: Write the failing tests**

- `serializes PRF eval on create so the background sees it`: `extensions: { prf: { eval: { first: u8(1, 2, 3) } } }`, round-tripped through `parseCreationOptions(JSON.stringify(...))`, gives `.prf` equal to `{ eval: { first: bytesToBase64Url(u8(1, 2, 3)) } }`.
- `serializes eval and evalByCredential on get`: `parseRequestOptions(...)` gives `.prf.evalByCredential.Q0lE.first` as the base64url of the buffer, plus `eval`.
- `skips PRF values that aren't buffers instead of throwing`: `eval: { first: "nope" }` doesn't throw, and the parsed `.prf` equals `{}`.
- `materializes PRF results as ArrayBuffers`: `buildGetCredential({... clientExtensionResults: { prf: { results: { first: "AQID" } } } }).getClientExtensionResults().prf.results.first` is an `ArrayBuffer` with bytes `[1, 2, 3]`. `buildCreateCredential` keeps `enabled: true` and does the same for its results.

- [ ] **Step 2: Run them to see them fail**

Run: `CI=true pnpm --filter @vault/platform-extension test -- webauthn-inpage-codec`
Expected: FAIL.

- [ ] **Step 3: Implement** (self-contained helpers, no imports; accept `ArrayBuffer` or `ArrayBuffer.isView`)

- [ ] **Step 4: Run the tests** (as Step 2; expected PASS) and check the content bundle stays flat: `pnpm --filter @vault/platform-extension build:firefox` emits no new chunk for the content script.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(extension): carry the prf extension through the Firefox in-page provider"
```

### Task 5: Chromium e2e proves PRF through the real proxy

**Files:**
- Create: `e2e/extension/passkey-prf.spec.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4, built. Helpers `createVault`, `clickCornerAction` (`e2e/extension/helpers.ts`) and the `test` fixture (`e2e/extension/fixtures.ts`).

- [ ] **Step 1: Build**

Run: `pnpm wasm:build && pnpm --filter @vault/platform-extension build:chromium`
Expected: both succeed.

- [ ] **Step 2: Write the spec**

Set up `createVault(setup, extensionId)`, then enable the provider live: `setup.evaluate(() => chrome.runtime.sendMessage({ type: "PASSKEY_PROVIDER_SET_ENABLED", payload: { enabled: true } }))`. Serve `https://prf.example/` with `context.route(/^https:\/\/prf\.example\//, ...)` (a bare HTML page), then `page.goto` and `page.bringToFront()`. Each ceremony is started with `page.evaluate` (not awaited), then `clickCornerAction(page, "passkey-approve")`, then awaited. Results come back as hex strings.

Assertions:
- create with `extensions: { prf: { eval: { first: enc("salt-a") } } }` gives `prf.enabled === true` and a `results.first` of 64 hex characters;
- get (allowCredentials = the new id) with the same salt gives the same `first` as create;
- get with `enc("salt-b")` gives a different `first`;
- get with `eval: salt-a` and `evalByCredential: { [id]: salt-b }` equals the salt-b output.

- [ ] **Step 3: Run it**

Run: `CI=true pnpm exec playwright test e2e/extension/passkey-prf.spec.ts`
Expected: 1 passed. A `completeCreateRequest failed` log or a hang means Chrome rejected our `prf` JSON; check the 32-byte and `enabled` rules first.

- [ ] **Step 4: Commit**

```bash
git add e2e/extension/passkey-prf.spec.ts
git commit -m "test(e2e): prove PRF round-trips through Chrome's webAuthenticationProxy"
```

### Task 6: The Proton Pass import keeps PRF secrets

**Files:**
- Modify: `packages/core/src/import/passkey-fields.ts` (shared helper), `packages/core/src/import/protonpass-passkey.ts`, `docs/passkey-import.md` (the `ext.hmac_secret` row near L149 and the paragraph near L173)
- Test: `packages/core/src/import/protonpass.test.ts`

**Interfaces:**
- Produces: `export function prfSecretsFrom(withUV: Uint8Array, withoutUV?: Uint8Array | null): PasskeyPrfSecrets | undefined`. It returns standard base64, `undefined` when `withUV` is empty, and fills an empty or missing `withoutUV` with 32 bytes from `crypto.getRandomValues`.

- [ ] **Step 1: Write the failing tests** (replacing `imports but says so when the counter is reset or a PRF secret is left behind`)

- `keeps the PRF secret and warns only about the counter`: `ext: { hmac_secret: { cred_with_uv: SCALAR, cred_without_uv: null } }` gives `passkeys[0].prf.credWithUV === bytesToBase64(SCALAR)`, a `credWithoutUV` that decodes to 32 bytes and differs from `credWithUV`, and warnings equal to just the counter line.
- `keeps both halves when Proton has both`: `cred_without_uv: new Uint8Array(32).fill(0x22)` is kept as its base64.
- `warns and leaves the PRF secret out when it can't be read`: `hmac_secret: "junk"` warns with `/^"Site" passkey 1 had a PRF secret Bramble couldn't read/`; the passkey is still imported, with `prf` undefined.
- `imports no PRF secret when Proton has none`: the default fixture (`hmac_secret: null`) gives `prf` undefined and no warning.

- [ ] **Step 2: Run them to see them fail**

Run: `CI=true pnpm --filter @vault/core test -- protonpass`
Expected: FAIL.

- [ ] **Step 3: Implement** (read `cred_with_uv` / `cred_without_uv` with the file's `bytesOf`; keep the warning wording parallel to the existing one)

- [ ] **Step 4: Run the tests** (as Step 2; expected PASS)

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(import): keep Proton Pass passkeys' PRF secrets"
```

### Task 7: Credential exchange carries PRF secrets and every other FIDO2 extension member

**Files:**
- Modify: `packages/core/src/exchange/types.ts`, `from-cxf.ts`, `to-cxf.ts`, `os-transfer.ts`, `packages/core/src/adapters/exchange.ts`
- Modify: `clients/mobile/src/credential-exchange.ts`, `clients/mobile/ios/App/App/CredentialExchange.swift` (`isAvailable`), `clients/mobile/scripts/cxf-wire-probe.swift`, `docs/credential-exchange.md`
- Test: `packages/core/src/exchange/from-cxf.test.ts`, `to-cxf.test.ts`, `round-trip.test.ts`, `os-transfer.test.ts`

**Interfaces:**
- Consumes: Task 6's `prfSecretsFrom`; Task 2's `PasskeyCredential.prf` / `fido2Extensions`.
- Produces: `ExchangeAvailability.passkeyExtensions?: boolean` (undefined is read as true); `CxfExportOptions.passkeyExtensions?: boolean` (default true).
- Wire (export): `fido2Extensions: { ...p.fido2Extensions, hmacCredentials: { algorithm: "hmac-sha256", credWithUV, credWithoutUV } }` (base64url), left out when empty.
- Schema: `passkeySchema` gains `fido2Extensions: z.looseObject({}).optional().catch(undefined)`, so a junk value can't fail the passkey; `hmacCredentials` is parsed separately with its own lenient schema.

- [ ] **Step 1: Write the failing tests**

`from-cxf.test.ts`:
- `keeps a passkey's PRF secrets from hmacCredentials`: base64url in, standard base64 `prf` out.
- `fills a missing credWithoutUV so the passkey can be exported again`.
- `leaves out a PRF secret with an unknown algorithm and says so`: `algorithm: "hmac-sha512"` warns with `/had a PRF secret Bramble can't use/`, the passkey is imported, and `prf` is undefined.
- `keeps other fido2Extensions members verbatim`: `largeBlob: { uncompressedSize: 3, data: "AAAA" }` and `credBlob: "AQ"` give `passkeys[0].fido2Extensions` equal to exactly those two.
- `imports the passkey when fido2Extensions is junk`: `fido2Extensions: "junk"` still imports the passkey, without `prf` or `fido2Extensions`.

`to-cxf.test.ts`:
- `exports PRF secrets as hmacCredentials with both halves`.
- `re-emits kept extension members`.
- `omits fido2Extensions for a passkey with none` (the key is absent).
- `on an OS that can't carry extensions, leaves them out and warns with a count`: `passkeyExtensions: false` with two such passkeys gives no `fido2Extensions` and one warning matching `/^2 passkeys went without/`.

`round-trip.test.ts`:
- `preserves a passkey's PRF secrets and large blob`.

`os-transfer.test.ts`:
- `export warns when the OS can't carry passkey extensions`.
- `import warns on such an OS when passkeys arrived` (and not when none did).

- [ ] **Step 2: Run them to see them fail**

Run: `CI=true pnpm --filter @vault/core test -- exchange`
Expected: FAIL.

- [ ] **Step 3: Implement**

Warning copy:
- Unknown algorithm: `A passkey on "${title}" had a PRF secret Bramble can't use, so it was left out. Signing in works, but a site that encrypted data with it can't decrypt that data.`
- Export without extensions: `${n} passkeys went without their PRF secrets or other extension data, which this iOS version can't transfer. Update to iOS 26.4 or later and transfer again to bring it.` (singular for 1).
- Import on old iOS: `This iOS version doesn't pass passkey PRF secrets between apps (iOS 26.4 and later do). If a site uses one of these passkeys to encrypt data, update iOS and transfer again.`

`exportToOs` reads `exchange.availability()` once and passes `passkeyExtensions` through. Swift `isAvailable` adds `"passkeyExtensions"` from `#available(iOS 26.4, *)`, and the mobile adapter passes it through.

- [ ] **Step 4: Run the tests** (as Step 2; expected PASS)

- [ ] **Step 5: Check Apple accepts our payload**

Extend the probe: the spike's passkey gets `fido2Extensions` (`hmacCredentials` plus `largeBlob`) behind `#available(iOS 26.4, macOS 26.4, *)`, and `inspect` prints `prf=yes|no` per passkey. Dump one `toCxf` payload holding a PRF passkey to `/tmp/prf-payload.json` (a temporary `console.log` in `to-cxf.test.ts`, removed before committing).

Run: `xcrun swiftc -target arm64-apple-macos26.4 clients/mobile/scripts/cxf-wire-probe.swift -o /tmp/cxf-probe && /tmp/cxf-probe /tmp/prf-payload.json`
Expected: `=== DECODED: 1 account(s) ===` and `prf=yes`, not `=== REJECTED ===`.

- [ ] **Step 6: Document and commit**

Add a `fido2Extensions` row to the wire table in `credential-exchange.md`, covering the 26.4 gate and the all-or-nothing `credWithoutUV` rule, and the macOS probe command.

```bash
git commit -am "feat(exchange): carry passkey PRF secrets and other FIDO2 extension data through credential exchange"
```

### Task 8: The Android Credential Manager provider answers PRF

**Files:**
- Create: `clients/mobile/android/app/src/main/java/app/bramble/mobile/PasskeyPrf.kt`
- Create: `clients/mobile/android/app/src/test/java/app/bramble/mobile/PasskeyPrfTest.kt`
- Modify: `clients/mobile/android/app/src/main/java/app/bramble/mobile/WebauthnJson.kt`, `CredentialFulfillActivity.kt` (`fillCreate`, `fillAssertion`, `pendingCredentialJson`), `VaultReader.kt` (`StoredPasskey`, one shared parser for vault and pending records)

**Interfaces:**
- Consumes: uniffi `passkeyPrfEval(secretB64, firstB64, secondB64): PasskeyPrfOutput`; `PasskeyRegistration.prf.credWithUv` / `credWithoutUv`.
- Produces:
  ```kotlin
  data class PrfSalts(val firstStd: String, val secondStd: String?)   // std base64
  class StoredPrf(val credWithUV: String, val credWithoutUV: String)
  object PasskeyPrf {
      // byCredential keys are base64url credential ids, as in the request JSON.
      fun select(eval: PrfSalts?, byCredential: Map<String, PrfSalts>, credentialIdUrl: String): PrfSalts?
  }
  // StoredPasskey gains: val prf: StoredPrf?
  // WebauthnJson gains: prfRequest(opts: JSONObject): PrfCreate? ; prfSaltsFor(opts: JSONObject, credentialIdStd: String): PrfSalts?
  //   registrationResponseJson(..., prf: JSONObject?) ; authenticationResponseJson(..., prf: JSONObject?)
  ```

- [ ] **Step 1: Regenerate the bindings**

Run: `pnpm ffi:build:android`
Expected: "installed jniLibs ... + Kotlin glue"; `vault_crypto.kt` now declares `passkeyPrfEval`.

- [ ] **Step 2: Write the failing JVM test** (`PasskeyPrfTest`)

`selectPrefersTheCredentialsOwnSalts`, `selectFallsBackToEval` and `selectReturnsNullWithNoInputs`, using plain `PrfSalts("AQ==", null)` values.

- [ ] **Step 3: Run it to see it fail**

Run: `cd clients/mobile/android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest --offline --console=plain`
Expected: compile failure, `PasskeyPrf` unresolved.

- [ ] **Step 4: Implement**

- `fillCreate`: `prfRequest(opts)`. After minting, evaluate `reg.prf.credWithUv` when the request has an `eval` (UV is always true here), and pass `{ enabled: true, results? }`.
- `pendingCredentialJson`: add `"prf": {"credWithUV", "credWithoutUV"}`.
- `fillAssertion`: `prfSaltsFor(JSONObject(option.requestJson), pk.credentialId)` plus `pk.prf` gives `{ results }`. Evaluation is wrapped in runCatching, so a failure means no `prf`.
- `VaultReader`: both readers go through one `storedPasskey(pk: JSONObject, entryId: String): StoredPasskey?` that reads `prf` only when both strings are non-empty.

- [ ] **Step 5: Compile and test**

Run: `cd clients/mobile/android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:compileDebugKotlin :app:testDebugUnitTest --offline --console=plain`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 6: Commit**

```bash
git add clients/mobile/android/app/src/main/java/app/bramble/mobile/PasskeyPrf.kt clients/mobile/android/app/src/test/java/app/bramble/mobile/PasskeyPrfTest.kt
git commit -am "feat(android): answer the prf extension from the Credential Manager provider"
```

### Task 9: The iOS credential provider answers PRF

**Files:**
- Modify: `clients/mobile/ios/App/AutoFillProbe/CredentialProviderViewController.swift`
- Modify: `clients/mobile/src/adapters/autofill.ts` (the `StoredPasskey` bundle type and projection)
- Test: `clients/mobile/src/adapters/autofill.test.ts`

**Interfaces:**
- Consumes: uniffi Swift `passkeyPrfEval(secretB64:firstB64:secondB64:) throws -> PasskeyPrfOutput`; `PasskeyRegistration.prf.credWithUv` / `credWithoutUv`.
- Produces (file-private Swift):
  ```swift
  private struct PasskeyPrf: Decodable { let credWithUV: String; let credWithoutUV: String }
  // Passkey gains: let prf: PasskeyPrf?
  private struct PrfSalts { let first: Data; let second: Data? }
  private struct PrfGet { let salts: PrfSalts?; let byCredential: [String: PrfSalts] } // std-b64 credential id keys
  private struct PrfCreate { let salts: PrfSalts? }                                   // present = requested
  // PasskeyGet gains: let prf: PrfGet? ; PasskeyCreate gains: let prf: PrfCreate?
  ```
- Produces (TS): the mobile `StoredPasskey` gains `prf?: PasskeyPrfSecrets`, projected as `prf: p.prf`.

- [ ] **Step 1: Write the failing TS test**

`autofill.test.ts`, `it("carries a passkey's PRF secrets into the encrypted passkey bundle")`: decrypting the bundle `setIndex` wrote yields `prf` equal to the entry's.

- [ ] **Step 2: Run it to see it fail, implement the projection, run it again**

Run: `CI=true pnpm --filter @vault/platform-mobile test -- autofill`
Expected: FAIL, then PASS.

- [ ] **Step 3: Regenerate the bindings**

Run: `pnpm ffi:build:ios`
Expected: `vault_crypto.autofill.swift` declares `passkeyPrfEval`.

- [ ] **Step 4: Implement the Swift side** (all PRF reads and writes inside `if #available(iOS 18.0, *)`)

- Capture `PrfGet` from `.assertion(input).prf` in `prepareInterfaceToProvideCredential` and from `requestParameters.extensionInput?.prf` in `prepareCredentialList(for:requestParameters:)`. Capture `PrfCreate` from `.registration(input).prf` in `prepareInterface(forPasskeyRegistration:)`. Key `perCredentialInputValues` by `base64EncodedString()`.
- Fast path: if the request's assertion input has `prf`, `cancel(.userInteractionRequired)` before any silent assert.
- `assertPasskey` takes the `PrfGet?`. With UV, stored `prf` and selected salts, evaluate and use the `extensionOutput:` initializer with `ASPasskeyAssertionCredentialExtensionOutput(prf: .init(first: SymmetricKey(data:), second:))`. Otherwise, or when evaluation throws, use the current initializer.
- `handlePasskeyCreateUnlocked`: if requested, use `ASPasskeyRegistrationCredentialExtensionOutput(prf: salts ? .init(first:second:) : .supported)`.
- `stashPendingPasskey` and `appendToPasskeyBundle` add `"prf": ["credWithUV": reg.prf.credWithUv, "credWithoutUV": reg.prf.credWithoutUv]`.

- [ ] **Step 5: Build both targets for the simulator**

Run: `xcodebuild -project clients/mobile/ios/App/App.xcodeproj -scheme AutoFillProbe -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`, then the same with `-scheme App` (it compiles `CredentialExchange.swift`).
Expected: `** BUILD SUCCEEDED **` for both.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(ios): answer the prf extension from the credential provider"
```

### Task 10: Docs, full verification, landing

**Files:**
- Modify: `docs/passkey-provider.md` (a short "PRF" section linking here), `docs/passkey-prf.md` (the Status line)

- [ ] **Step 1: Docs.** Update the provider doc and this doc's Status line, which names what was verified on a device and what wasn't.
- [ ] **Step 2: Full suites.** Run `cd packages/core-rust && cargo test --locked`, `CI=true pnpm -r run test`, `pnpm -r run typecheck`, `pnpm lint`, and the Task 5 e2e spec. All must pass, and any failure that predates this work gets reported against the baseline.
- [ ] **Step 3: Commit and land.** Commit the docs, then, in the checkout that has `main` (once `git diff --cached` there is empty): `git cherry-pick --ff <first>^..<last>`.
- [ ] **Step 4: Hand the device checks to the user.**
  - **Chrome and Firefox:** register and unlock with PRF at AliasVault and on the Corbado demo.
  - **Android (API 34+) and iPhone (iOS 18+):** the same two sites.
  - **Cross-device:** create on Chrome, evaluate on each phone, compare outputs.
  - **iOS 26.4+:** a credential-exchange round trip with Apple Passwords, holding a PRF passkey.
