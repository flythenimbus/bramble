# Mailbox Plan 2: Client Crypto

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every app can derive its group's mailbox id and seal and open mailbox messages under a
key derived from the vault key, with the vault key never leaving the Rust core.

**Architecture:** One new module in `packages/core-rust` (`mailbox.rs`) does the key derivation
and AEAD. It is exported the way `encrypt_with_vek` is: through wasm (the extension's offscreen,
and the mobile dev browser), uniffi (the iOS and Android native plugin) and the `native` feature
(the desktop Tauri commands). Each host surfaces it as three optional `CryptoAdapter` methods.
A small TypeScript module in `packages/core` composes those with the existing roster signing into
the message envelope Plan 3's transport will post: a signature followed by the sealed bytes.

**Tech Stack:** Rust (aes-gcm 0.10, hkdf 0.12, base64 0.22; no new crates), wasm-bindgen,
uniffi, Tauri 2, TypeScript, Vitest, Swift, Kotlin.

**Spec:** [mailbox-service.md](mailbox-service.md) (milestone and Plan 1:
[mailbox-service-plan-1-server.md](mailbox-service-plan-1-server.md))

## Global Constraints

- The VEK never leaves Rust. Derivation and AEAD run inside the core against the in-memory VEK
  (`with_vek`). TypeScript sees only the mailbox id, base64 sealed bytes and plaintext.
- Derivation, exactly (HKDF-SHA256, `ikm` = VEK, `salt` = the group key's 32 raw bytes):
  - `mailboxId` = base64url without padding of 32 bytes from
    `info = "bramble/mailbox/v1/id"`. It must match `MAILBOX_ID_RE`.
  - `sealKey` = 32 bytes from `info = "bramble/mailbox/v1/seal"`.
  - A group key that is not base64 or not 32 bytes is an error, never a panic.
- Sealed format v1: `0x01 || nonce (12 random bytes) || AES-256-GCM(sealKey, nonce, plaintext,
  aad)`, standard base64 across every bridge.
- Message envelope (the bytes Plan 3 posts as a message body):
  `signature (64 bytes) || sealed bytes`.
  - The signature is the sender's roster Ed25519 key (`roster_sign`) over
    `bramble-mailbox-sig/v1\n<mailboxId>\n<messageId>\n<sha256 hex of the sealed bytes>`.
  - The AAD is `bramble-mailbox-aad/v1\n<mailboxId>\n<messageId>\n<sender sigKey>`.
  - File blobs are not enveloped: they are already sealed under their own file keys.
- On the extension, every new op is in `USE_VEK` (the background injects the tagged vault's
  `vekB64`). The offscreen loads the VEK and runs the op in one synchronous section, with no
  `await` between them (`withVek` in `offscreen-core.ts`; docs/multiple-vaults.md, "Atomicity
  trap").
- Rust tests that load or clear the VEK take `crate::tests::VEK_SLOT_LOCK`. Desktop tests take
  `crate::pairing::test_lock()`, the crate's shared lock for `vault_crypto` state.
- `packages/core` tests import nothing from `node:` (platform-extension typechecks core with only
  chrome/vite types). Real-wasm tests live in `clients/mobile`, beside
  `vault-key-routing.integration.test.ts`.
- `rustfmt` only the files this plan creates; `packages/core-rust` and the desktop crate are not
  rustfmt-clean as a whole.
- Run tests with `CI=true`. Commits use the repo's conventional style, carry no co-author trailer,
  and say nothing about verification status.

## Review Focus

1. **A locked vault, or the wrong vault.**
   - Deriving, sealing or opening while locked must error ("vault is locked"), never use a stale
     key. Pinned in Task 1.
   - On the extension, an op tagged with vault A must use A's VEK even when B is active. Pinned in
     Task 4.
2. **A message moved or reattributed.** Sealed bytes from message X, posted as message Y or
   claimed by another sender, must fail to open: the AAD binds both, and the signature binds the
   message id. Pinned in Task 3.
3. **Malformed input.** An envelope shorter than its signature plus a header, an unknown version
   byte, a non-base64 or wrong-length group key: each is a clean error, never a panic or a crash
   across the FFI. Pinned in Tasks 1 and 3.
4. **Large envelopes.** Snapshots carry a whole vault: a 1 MiB plaintext round-trips natively
   (Task 1) and through wasm (Task 2).
5. **Nonce reuse.** Two seals of the same plaintext under the same key must differ. Pinned in
   Task 1.

---

### Task 1: The Rust core: `mailbox.rs`

**Files:**
- Create: `packages/core-rust/src/mailbox.rs`
- Modify: `packages/core-rust/src/lib.rs` (declare `pub mod mailbox;` beside `pub mod
  roster_sig;`, with a one-line comment in the same style)

**Interfaces:**
- Produces three exports, each with both `#[cfg_attr(feature = "wasm", wasm_bindgen)]` and
  `#[cfg_attr(feature = "ffi", uniffi::export)]` (like `decrypt_with_vek`):
  - `mailbox_id(group_key_b64: String) -> Result<String, CryptoError>`
  - `mailbox_seal(group_key_b64: String, aad: String, plaintext: String) -> Result<String, CryptoError>`
  - `mailbox_open(group_key_b64: String, aad: String, sealed_b64: String) -> Result<String, CryptoError>`
- Errors: "vault is locked" (from `with_vek`), `group key must be 32 bytes`,
  `not a sealed mailbox message`, `mailbox open failed`, and `plaintext is not utf-8`.
- Core helpers stay private and native-testable: `derive(vek, group_key, info) ->
  Zeroizing<[u8; 32]>`, `seal(key, aad, plaintext) -> Vec<u8>`,
  `open(key, aad, sealed) -> Result<Zeroizing<Vec<u8>>, CryptoError>`. They use
  `Hkdf::<Sha256>::new(Some(group_key), vek)` (the first salted HKDF in the crate) and
  `aes_gcm::aead::Payload { msg, aad }`. Parent helpers are reached via `super::` (`with_vek`,
  `err`, `random_bytes`, `b64_decode`).

- [ ] **Step 1: Write the failing tests** (in `mailbox.rs`'s `#[cfg(test)] mod tests`, each taking
  `crate::tests::VEK_SLOT_LOCK` and loading a fixed VEK with `crate::unlock_with_vek`)

```rust
#[test] fn the_id_is_43_base64url_chars_and_deterministic() { /* id(g) == id(g); len 43; only [A-Za-z0-9_-] */ }
#[test] fn the_id_differs_by_group_key_and_by_vault_key() { /* id(g1) != id(g2); reload another VEK -> id(g1) changes */ }
#[test] fn the_id_and_the_seal_key_are_different_derivations() { /* derive(v, g, ID_INFO) != derive(v, g, SEAL_INFO) */ }
#[test] fn sealing_round_trips_and_binds_the_aad() { /* open(seal(p, aad), aad) == p; open(.., "other aad") -> Err("mailbox open failed") */ }
#[test] fn opening_under_another_group_key_fails() { /* seal with g1, open with g2 -> Err */ }
#[test] fn a_flipped_byte_or_an_unknown_version_is_refused() { /* tamper ct -> "mailbox open failed"; first byte 0x02 or < 13 bytes -> "not a sealed mailbox message" */ }
#[test] fn two_seals_of_the_same_plaintext_differ() { /* seal(p) != seal(p) */ }
#[test] fn a_1_mib_plaintext_round_trips() { /* 1 MiB string */ }
#[test] fn a_bad_group_key_is_an_error_not_a_panic() { /* "!!" and 16-byte key -> "group key must be 32 bytes" (or the base64 error) */ }
#[test] fn everything_refuses_a_locked_vault() { /* crate::lock(); id/seal/open -> Err("vault is locked") */ }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/core-rust && cargo test mailbox`
Expected: FAIL to compile (module and functions missing).

- [ ] **Step 3: Implement `mailbox.rs` and declare the module**

The constants are `ID_INFO`, `SEAL_INFO` and `VERSION: u8 = 1`. The id uses
`base64::engine::general_purpose::URL_SAFE_NO_PAD`; everything else uses `STANDARD`. A module doc
comment says what the file is for and points to docs/mailbox-service.md, "Keys and identity".

- [ ] **Step 4: Run the crate's tests and both feature builds**

Run: `cd packages/core-rust && cargo test && cargo check --no-default-features --features ffi && rustfmt --edition 2021 --check src/mailbox.rs`
Expected: all pass; the ffi build compiles; rustfmt clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core-rust/src/mailbox.rs packages/core-rust/src/lib.rs
git commit -m "feat(mailbox): derive the mailbox id and seal messages in the core"
```

### Task 2: The wasm surface and `CryptoAdapter`

**Files:**
- Modify: `packages/core/src/wasm.ts` (`VaultCrypto` gains the three functions)
- Modify: `packages/core/src/adapters/crypto.ts` (`CryptoAdapter` gains three optional methods)
- Modify: `packages/core/src/adapters/crypto-wasm.ts`, `packages/core/src/adapters/crypto-wasm.test.ts`
- Modify: `packages/core-rust/verify.ts`

**Interfaces:**
- Consumes: Task 1's exports.
- Produces:
  - On `VaultCrypto` (required, since every host implements them in this plan):
    - `mailbox_id(groupKeyB64: string): Awaitable<string>`
    - `mailbox_seal(groupKeyB64: string, aad: string, plaintext: string): Awaitable<string>`
    - `mailbox_open(groupKeyB64: string, aad: string, sealedB64: string): Awaitable<string>`
  - On `CryptoAdapter`, optional, so the repo's many test doubles need not change:
    - `mailboxId?(groupKeyB64: string): Promise<string>`
    - `mailboxSeal?(groupKeyB64: string, aad: string, plaintext: string): Promise<string>`
    - `mailboxOpen?(groupKeyB64: string, aad: string, sealedB64: string): Promise<string>`
  - `buildCryptoAdapter` maps each of them positionally to the wasm call, as `encryptWithVek`
    does.

- [ ] **Step 1: Write the failing test** (extend `fakeWasm()` with the three `vi.fn`s)

```ts
it("maps the mailbox calls to the core positionally", async () => {
	const wasm = fakeWasm();
	const a = buildCryptoAdapter(asWasm(wasm));
	await a.mailboxId!("G");
	await a.mailboxSeal!("G", "AAD", "plain");
	await a.mailboxOpen!("G", "AAD", "SEALED");
	expect(wasm.mailbox_id).toHaveBeenCalledWith("G");
	expect(wasm.mailbox_seal).toHaveBeenCalledWith("G", "AAD", "plain");
	expect(wasm.mailbox_open).toHaveBeenCalledWith("G", "AAD", "SEALED");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `CI=true pnpm --filter @vault/core exec vitest run src/adapters/crypto-wasm.test.ts`
Expected: FAIL (`a.mailboxId` is not a function).

- [ ] **Step 3: Implement the type additions and the mapping**

- [ ] **Step 4: Rebuild the wasm and extend `verify.ts`**

Add checks in `verify.ts`'s existing style (`assertEq`, `expectThrow`), with a VEK loaded:
- `mailbox_id(g)` matches `/^[A-Za-z0-9_-]{43}$/` and is stable;
- `mailbox_open(g, aad, mailbox_seal(g, aad, p)) === p`, for `p` short and for 1 MiB;
- opening with another aad throws;
- after `lock()`, `mailbox_seal` throws.

Run: `pnpm run wasm:build && pnpm run wasm:build:mobile && pnpm run wasm:verify && CI=true pnpm --filter @vault/core exec vitest run src/adapters && pnpm run typecheck`
Expected: `ALL CHECKS PASSED`, tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/wasm.ts packages/core/src/adapters packages/core-rust/verify.ts
git commit -m "feat(mailbox): mailbox crypto on the wasm surface and CryptoAdapter"
```

### Task 3: The message envelope

**Files:**
- Create: `packages/core/src/sync/mailbox/envelope.ts`, `packages/core/src/sync/mailbox/envelope.test.ts`

This module is client-only: unlike `protocol.ts` it may import other core modules (it uses
`@core/util/bytes` and `sha256Hex` from `./protocol`), because the server never imports it.

**Interfaces:**
- Consumes: Task 2's `CryptoAdapter` method shapes; `sha256Hex` from `protocol.ts`.
- Produces:
  - `interface MailboxCryptoPort { mailboxId(groupKeyB64: string): Promise<string>; mailboxSeal(groupKeyB64: string, aad: string, plaintext: string): Promise<string>; mailboxOpen(groupKeyB64: string, aad: string, sealedB64: string): Promise<string>; sign(message: string): Promise<string>; verify(sigKey: string, message: string, sigB64: string): Promise<boolean> }`.
    `sign` is bound by the host to the device's roster key; Plan 3 builds the port.
  - `messageAad(r: { mailboxId: string; messageId: string; sender: string }): string`
  - `signedText(r: { mailboxId: string; messageId: string; sealedSha256: string }): string`
  - `sealMessage(port, r: { groupKeyB64: string; mailboxId: string; messageId: string; sender: string; plaintext: string }): Promise<Uint8Array>`,
    returning signature (64 bytes) then sealed bytes.
  - `openMessage(port, r: { groupKeyB64: string; mailboxId: string; messageId: string; sender: string; body: Uint8Array }): Promise<string>`
  - `class MailboxOpenError extends Error { readonly reason: "malformed" | "bad_signature" | "unopenable" }`.
    `openMessage` checks, in order: the length (`malformed`), the signature against `sender`
    (`bad_signature`), then the AEAD (`unopenable`). It verifies before it decrypts.

- [ ] **Step 1: Write the failing tests**

The test port is fake but honest:
- seal and open are a reversible encoding that refuses a mismatched AAD;
- sign and verify are real Ed25519 via WebCrypto.

```ts
it("round-trips a message and lays the body out as signature then sealed bytes", async () => { /* body.length === 64 + sealed length; openMessage -> plaintext */ });
it("binds the AAD to mailbox, message id and sender, in that canonical form", () => {
	expect(messageAad({ mailboxId: "M", messageId: "I", sender: "S" })).toBe("bramble-mailbox-aad/v1\nM\nI\nS");
});
it("signs the mailbox, the message id and the sealed bytes' hash", async () => { /* port.sign called with signedText({ ..., sealedSha256: sha256Hex(sealed) }) */ });
it("refuses a body claimed by another sender as bad_signature", async () => { /* open with sender = B's key -> MailboxOpenError bad_signature */ });
it("refuses a body moved to another message id", async () => { /* open with messageId Y -> bad_signature (signature binds the id) */ });
it("refuses a short body as malformed without calling the port", async () => { /* 64 + 12 bytes -> malformed; port.mailboxOpen not called */ });
it("refuses sealed bytes that do not open as unopenable", async () => { /* valid signature over garbage sealed bytes -> unopenable */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter @vault/core exec vitest run src/sync/mailbox/envelope.test.ts`
Expected: FAIL, cannot resolve `./envelope`.

- [ ] **Step 3: Implement `envelope.ts`**

- [ ] **Step 4: Run the tests and typecheck**

Run: `CI=true pnpm --filter @vault/core exec vitest run src/sync/mailbox && pnpm --filter @vault/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sync/mailbox/envelope.ts packages/core/src/sync/mailbox/envelope.test.ts
git commit -m "feat(mailbox): the signed message envelope"
```

### Task 4: Extension: the offscreen ops

**Files:**
- Modify: `clients/extension/src/crypto/messages.ts` (three schemas, each with the `vekInject` spread)
- Modify: `clients/extension/src/background/offscreen-client.ts` (`USE_VEK` gains the three ops)
- Modify: `clients/extension/src/offscreen-core.ts` (`SyncVek` gains the three functions;
  `dispatchCrypto` gains three cases mirroring `CRYPTO_ENCRYPT_OUTER`)
- Modify: `clients/extension/src/crypto.ts` (`makeCrypto` gains `mailboxId`, `mailboxSeal`, `mailboxOpen`)
- Modify: `clients/extension/src/test/test-harness.ts` (`defaultOffscreen` stubs)
- Modify: `clients/extension/src/offscreen-atomicity.test.ts`, `clients/extension/src/background/offscreen-client.test.ts`

**Interfaces:**
- Consumes: Task 2's `VaultCrypto` functions.
- Produces:
  - Ops `CRYPTO_MAILBOX_ID` `{ groupKeyB64 }`, `CRYPTO_MAILBOX_SEAL`
    `{ groupKeyB64, aad, plaintext }` and `CRYPTO_MAILBOX_OPEN` `{ groupKeyB64, aad, sealedB64 }`.
    Each answers its string result the way `CRYPTO_ENCRYPT_OUTER` answers its own, with the same
    error shape.
  - The extension's `CryptoAdapter` implements the three optional methods by sending those ops.

- [ ] **Step 1: Write the failing tests**

```ts
// offscreen-atomicity.test.ts, in the style of its CRYPTO_ENCRYPT_OUTER case:
it("loads the tagged vault's VEK and seals in the same synchronous section", async () => { /* stub wasm records unlock_with_vek then mailbox_seal with nothing between; result returned */ });

// offscreen-client.test.ts, in the style of the existing injection tests (117-153):
it("injects the tagged vault's VEK into the mailbox ops, not the active vault's", async () => { /* vault A tagged while B active -> payload.vekB64 === A's */ });
it("fails a mailbox op fast while that vault is locked", async () => { /* no VEK cached for the vault -> "vault locked", nothing sent */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter @vault/platform-extension exec vitest run src/offscreen-atomicity.test.ts src/background/offscreen-client.test.ts`
Expected: FAIL (unknown op; not in `USE_VEK`).

- [ ] **Step 3: Implement the schemas, registrations, dispatch cases and adapter methods**

- [ ] **Step 4: Run the extension suite and typecheck**

Run: `CI=true pnpm --filter @vault/platform-extension test && pnpm --filter @vault/platform-extension typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add clients/extension/src
git commit -m "feat(mailbox): mailbox crypto ops in the extension's offscreen"
```

### Task 5: Mobile: the TypeScript bridge and a real-wasm round trip

**Files:**
- Modify: `clients/mobile/src/native-crypto.ts` (the plugin interface gains `mailboxId`,
  `mailboxSeal` and `mailboxOpen`; `nativeModule` maps `mailbox_id`, `mailbox_seal` and
  `mailbox_open` to them)
- Create: `clients/mobile/src/native-crypto.test.ts`
- Create: `clients/mobile/src/sync/mailbox-crypto.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces the plugin calls `mailboxId({ groupKeyB64 }) -> { value: string }`,
  `mailboxSeal({ groupKeyB64, aad, plaintext }) -> { value: string }` and
  `mailboxOpen({ groupKeyB64, aad, sealedB64 }) -> { value: string }`, shaped as the existing
  string-returning methods are.

- [ ] **Step 1: Write the failing tests**

```ts
// native-crypto.test.ts: mock @capacitor/core's registerPlugin to capture calls
it("sends the mailbox calls to the native plugin by name and returns their value", async () => { /* nativeModule.mailbox_seal("G","A","P") -> plugin.mailboxSeal({groupKeyB64:"G",aad:"A",plaintext:"P"}) and resolves its value */ });

// mailbox-crypto.integration.test.ts: the real wasm, loaded as vault-key-routing.integration.test.ts loads it
it("seals with one device's roster key and opens on another of the same vault", async () => {
	// buildCryptoAdapter(wasm); generate_vek; two roster keys (roster_sig_generate_key);
	// port.sign = roster_sign(senderSecret, msg), port.verify = roster_verify
	// id matches MAILBOX_ID_RE; openMessage(sealMessage(...)) === plaintext
});
it("refuses the same body under a different vault key", async () => { /* unlock_with_vek(other) -> MailboxOpenError unopenable */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter @vault/platform-mobile exec vitest run src/native-crypto.test.ts src/sync/mailbox-crypto.integration.test.ts`
Expected: FAIL (the mapping is missing; the integration test fails until Task 2's wasm is built, which it is).

- [ ] **Step 3: Implement the interface and mapping**

- [ ] **Step 4: Run the mobile suite and typecheck**

Run: `CI=true pnpm --filter @vault/platform-mobile test && pnpm --filter @vault/platform-mobile typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add clients/mobile/src
git commit -m "feat(mailbox): the mobile bridge for mailbox crypto"
```

### Task 6: Mobile: Swift and Kotlin

**Files:**
- Modify: `clients/mobile/ios/App/App/NativeCrypto.swift` (three `pluginMethods` entries and three
  `@objc func`s, beside `encryptWithVek`)
- Modify: `clients/mobile/android/app/src/main/java/app/bramble/mobile/NativeCryptoPlugin.kt`
  (three `@PluginMethod`s, beside `encryptWithVek`)

**Interfaces:**
- Consumes: Task 1's uniffi exports. The generated Swift and Kotlin names follow uniffi's
  camelCase: `mailboxId(groupKeyB64:)`, `mailboxSeal(groupKeyB64:aad:plaintext:)` and
  `mailboxOpen(groupKeyB64:aad:sealedB64:)`. Read the generated file for the exact spelling.
- Produces: the plugin methods Task 5 calls. Each resolves `["value": ...]`, and errors go through
  the existing `fail()` (Swift) and `runCrypto` (Kotlin) mapping.

There is no unit-test harness for the plugins: the Android instrumented tests need a device, and
there are no iOS unit tests. The checks here are the two native builds against freshly generated
bindings, plus Task 5's tests of the TypeScript side of the same contract.

- [ ] **Step 1: Regenerate the bindings and confirm the new functions are in them**

Run: `pnpm run ffi:build:ios && pnpm run ffi:build:android && grep -c "mailboxSeal" clients/mobile/ios/App/VaultCryptoFFI/vault_crypto.swift clients/mobile/android/app/src/main/java/uniffi/vault_crypto/vault_crypto.kt`
Expected: both builds succeed; each file counts at least 1.

- [ ] **Step 2: Add the Swift and Kotlin methods**

- [ ] **Step 3: Build both apps**

Run: `xcodebuild -project clients/mobile/ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug build CODE_SIGNING_ALLOWED=NO | tail -3`
Expected: `** BUILD SUCCEEDED **`.
Run, with Android Studio's JBR 21 as `JAVA_HOME`: `cd clients/mobile/android && ./gradlew :app:compileDebugKotlin`
Expected: `BUILD SUCCESSFUL`.

If the iOS build fails for a reason unrelated to this change (a stale SPM checkout or an unmounted
drive, see the project's known "exit 74" causes), clear DerivedData once and retry. If it still
fails, record the error and continue: Task 5's tests and the Kotlin build still cover the
contract.

- [ ] **Step 4: Commit**

```bash
git add clients/mobile/ios/App/App/NativeCrypto.swift clients/mobile/android/app/src/main/java/app/bramble/mobile/NativeCryptoPlugin.kt
git commit -m "feat(mailbox): native mailbox crypto on iOS and Android"
```

### Task 7: Desktop

**Files:**
- Modify: `clients/desktop/src-tauri/src/crypto.rs` (three commands beside
  `crypto_encrypt_with_vek`, and a `#[cfg(test)] mod tests`)
- Modify: `clients/desktop/src-tauri/src/lib.rs` (register the three in `generate_handler!`)
- Modify: `clients/desktop/src/adapters/crypto.ts`, `clients/desktop/src/adapters/crypto.test.ts`

**Interfaces:**
- Consumes: Task 1's exports through the `native` feature (`vault_crypto::mailbox_*`).
- Produces:
  - The commands `crypto_mailbox_id(group_key_b64: String) -> CmdResult<String>`,
    `crypto_mailbox_seal(group_key_b64: String, aad: String, plaintext: String) -> CmdResult<String>`
    and `crypto_mailbox_open(group_key_b64: String, aad: String, sealed_b64: String) -> CmdResult<String>`.
  - The desktop `CryptoAdapter`'s three methods, calling
    `invoke("crypto_mailbox_seal", { groupKeyB64, aad, plaintext })` and the rest. Tauri maps the
    camelCase keys to the snake_case parameters.

- [ ] **Step 1: Write the failing tests**

```rust
// crypto.rs tests, holding crate::pairing::test_lock() and with a VEK loaded
#[test] fn the_mailbox_commands_round_trip_through_the_core() { /* open(seal(p)) == p; id is 43 chars */ }
#[test] fn the_mailbox_commands_answer_a_locked_vault_with_an_error() { /* vault_crypto::lock(); seal -> Err containing "locked" */ }
```

```ts
// crypto.test.ts, mocking invoke as the existing tests do
it("invokes the mailbox commands with camelCase arguments", async () => { /* mailboxSeal("G","A","P") -> invoke("crypto_mailbox_seal", { groupKeyB64: "G", aad: "A", plaintext: "P" }) */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd clients/desktop/src-tauri && cargo test mailbox; cd - && CI=true pnpm --filter @vault/platform-desktop exec vitest run src/adapters/crypto.test.ts`
Expected: FAIL (the commands and methods are missing).

- [ ] **Step 3: Implement the commands, registration and adapter methods**

- [ ] **Step 4: Run the desktop suites**

Run: `pnpm run test:desktop && CI=true pnpm --filter @vault/platform-desktop test && pnpm --filter @vault/platform-desktop typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add clients/desktop/src-tauri/src/crypto.rs clients/desktop/src-tauri/src/lib.rs clients/desktop/src/adapters
git commit -m "feat(mailbox): mailbox crypto commands on desktop"
```

### Task 8: Docs and the full check

**Files:**
- Modify: `docs/mailbox-service.md`:
  - "Keys and identity": the derivation, the sealed format, the AAD and signature strings and the
    envelope layout, exactly as in this plan's Global Constraints. The AAD no longer lists the
    message kind: Plan 1 moved it inside the ciphertext, so the server never sees it.
  - The "Status" line at the top, now that Plan 1 is built.
- Modify: `docs/README.md` (a row for this plan, written now; nothing to change here)

- [ ] **Step 1: Edit the design doc**

- [ ] **Step 2: Run everything CI runs**

Run: `CI=true pnpm run test && pnpm run typecheck && pnpm run ci:check && pnpm run wasm:verify`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add docs/mailbox-service.md
git commit -m "docs(mailbox): the mailbox key derivation and message envelope"
```

### After the plan

- **Large snapshots on mobile.** This plan moves sealed messages as base64 strings, which is fine
  for deltas. A whole-vault snapshot through the Android bridge (about 0.5 MB/s) is slow. Plan 4
  decides whether mobile needs a path-based seal, as file attachments use.
- **Pushing** waits for the owner.
