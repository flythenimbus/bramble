# VEK residency hardening (design note)

Status: **planned, nothing built** (scoped 2026-09-04). Ordered list of changes that shrink where
and how long the in-memory VEK exists outside the Rust core, with what each one costs. Assumes the
reader knows the key hierarchy in [cryptography.md](cryptography.md) and the enrollment flow in
[p2p-sync.md](p2p-sync.md). This supersedes the "Deferred hardening: VEK never in JS" paragraph in
cryptography.md, which described the goal without an inventory.

Platform facts are dated **September 2026**; re-verify before acting on them later.

## Why this list looks the way it does

The prompt was GrapheneOS's memory hardening. Most of it does not transfer, and saying why fixes
the scope:

- **hardened_malloc's layout defenses** (out-of-line metadata, guard slabs, randomized slots,
  quarantine, canaries) make heap corruption non-exploitable in C/C++. `core-rust` has no `unsafe`,
  and on the extension it runs in WASM linear memory, which has no page protection, no ASLR, and
  addresses starting at zero. There is no corruption bug to contain and no page to guard.
- **The process boundary they assume is absent on the extension.** Code running as the extension
  reads `WebAssembly.Memory.buffer` directly. No allocator changes that.

What does transfer is the *residency* half: keep the key in as few places as possible, for as
short a time as possible, and out of swap and dumps. Every item below is one of those.

## Where the VEK lives today (inventory)

The Rust core holds it in one place, `vek_slot()` in `packages/core-rust/src/lib.rs`: a static
`Mutex<Option<Zeroizing<[u8; 32]>>>`, so the bytes sit inline in the library's data segment and
are wiped on drop. KEKs, DEKs, file keys and decrypted plaintexts are `Zeroizing` too. Every copy
outside that slot is a base64 **string**, and a string in JS, Swift or Java is immutable,
GC-copied, and cannot be wiped. The crossings that mint one:

| Crossing | Where | How often |
| --- | --- | --- |
| Mobile biometric enable | `vault/biometric-unlock.ts` `enableBiometricUnlock`: `crypto.exportVek()` then `biometric.enable(vek)` | On enable, and on iOS **after every unlock** via `reconcileBiometricGate` (the gate is re-armed to pick up `allowPasscode`; skipped on Android because `enableRequiresAuth`) |
| Mobile biometric unlock | `unlockVekWithBiometric`: `biometric.unlock()` then `crypto.unlockWithVek(vek)` | Every biometric unlock |
| Unused return values | `useVault.tsx` awaits `generateVek()` and `rotateVek()` and discards the result; the mobile plugin and the Tauri commands still return the fresh key to the webview | Vault creation, VEK rotation |
| Enrollment, inviter | `sync-manager.ts` (mobile) and `sync/transport.ts` (desktop) call `exportVek()` explicitly and pass `vekB64` to `sendBundle`, which puts it in the bundle JSON | Every pairing |
| Enrollment, joiner | `receiveBundle` keeps `bundle.vek` for the whole vault rebuild: `loadThen` re-injects it before every wrap because the single global slot can be clobbered by a concurrent op | Every pairing |
| Extension session | `vek-store.ts` holds a `Map<vaultId, base64>` mirrored to `chrome.storage.session`; every VEK-scoped op ships the key to the offscreen scratch slot over `chrome.runtime` messaging | Every crypto op |

Two facts checked while scoping: `chrome.storage.session` is never widened with `setAccessLevel`,
so it stays trusted-contexts-only and content scripts cannot read it; and mobile **password**
unlock is already clean (`unwrapVekPassword` returns a bool and installs the key natively).

**The bridge cannot carry bytes, on any platform.** `chrome.runtime` messaging is JSON. Capacitor
serializes plugin calls as JSON, `WKScriptMessageHandler` bodies are plist types, and Android's
`@JavascriptInterface` takes strings. So "pass a `Uint8Array` instead of a string" is not
available; the only achievable form is **the VEK does not cross at all**. Each item below removes
a crossing rather than changing its type.

## Update order

| # | Item | Scope | Effort | Removes |
| --- | --- | --- | --- | --- |
| 1 | Stop returning unused VEKs | Mobile plugin + Tauri commands for `generateVek` / `rotateVek` resolve with nothing | ~1 hour | Two crossings, no behaviour change |
| 2 | Android manifest hardening | `android:memtagMode="sync"`; decide `allowBackup` | ~1 hour + one device check | Nothing about residency; MTE coverage of native code |
| 3 | Pin the slot page | `mlock` + `MADV_DONTDUMP` on `vek_slot()`, `PR_SET_DUMPABLE=0` in the Tauri app | ~half a day | Swap and core-dump exposure on native builds |
| 4 | Native-only biometric gate | Arm and unlock the OS-gated cache inside the native plugins; JS only triggers | ~1.5 to 2 days incl. device testing on both platforms | The most frequent crossing (twice per iOS unlock) |
| 5 | Enrollment without a JS copy | Session-scoped VEK holder in Rust + the VEK as its own Noise frame | 1 to 1.5 weeks; protocol change; coordinated release | The last avoidable crossing |

Items 1 to 4 are about three days together and are independent of each other. Item 5 is a
separate decision (see below) and is deliberately last.

### 1. Stop returning unused VEKs

`useVault.tsx` does `await bound.generateVek()` at vault creation and `await crypto.rotateVek()`
on rotation, and uses neither result: on mobile and desktop the native slot already holds the new
key. Make `NativeCryptoPlugin` (`generateVek`, `rotateVek`) and the Tauri `crypto_generate_vek` /
`crypto_rotate_vek` commands resolve with nothing. Leave the extension alone: its offscreen returns
the key to the background on purpose, because `vek-store.ts` is the durable copy there.

### 2. Android manifest hardening

`compileSdk` is 36 and `memtagMode` is present in the android-35/36 platform attrs, so
`android:memtagMode="sync"` on `<application>` compiles today and is inert on hardware without
MTE. It covers the app's own processes, including `:autofill`; the WebView renderer is a separate
system-spawned process and is unaffected. With zero `unsafe` in our Rust the payoff is bounded to
dependencies and whatever is C-compiled underneath, so treat it as cheap insurance, not a defense.
Confirming it engages needs a Pixel 8 or newer.

`allowBackup` is currently `true`. Flipping it is one line but a product decision: it also
disables device-to-device transfer of app data, so users rely on Bramble's own backup and sync,
which is arguably right for a password manager. Decide it in the same change.

### 3. Pin the slot page

`vek_slot()` has a stable address for the process lifetime, so this is a one-time call at first
init, under `cfg(not(target_arch = "wasm32"))`, with `libc` added as a non-wasm target
dependency:

- `mlock(addr, 32)`: page-granular, so it pins the page containing the static (fine). Best-effort:
  `RLIMIT_MEMLOCK` can refuse it and the failure is ignored.
- `madvise(addr, len, MADV_DONTDUMP)`: Linux and Android only. No macOS/iOS equivalent.
- `prctl(PR_SET_DUMPABLE, 0)` in the Tauri app: disables core dumps process-wide and blocks
  non-root ptrace, which is the strongest of the three and costs nothing on a desktop app.

Transient KEK/DEK/plaintext copies are not covered; they are stack or short-lived heap values that
are already zeroed on drop. Value by platform: macOS/Linux desktop (real swap, real core dumps) >
Android (zram) > iOS (no swap file).

### 4. Native-only biometric gate

The `BiometricUnlock` interface loses the key: `enable(vaultId, allowPasscode)` reads it from the
native session, and `unlock(vaultId, allowPasscode)` installs it there and resolves `void`.

- **iOS.** `BiometricVault.swift` is in the same App module as the uniffi free functions, so
  `setSecret` calls `exportVek()` itself and `getSecret` calls `unlockWithVek` itself. The
  credential provider already performs its biometric unlock natively against the shared keychain
  group, so the pattern exists in the repo.
- **Android.** `BiometricVaultPlugin.java` calls the Kotlin top-level uniffi functions, as
  `NativeCryptoPlugin.kt` already does.
- **Core.** `enableBiometricUnlock` and `unlockVekWithBiometric` in `vault/biometric-unlock.ts`
  drop their `crypto` step; `biometric-unlock.test.ts` fakes are rewritten. Mobile is the only
  implementer, so nothing else breaks.
- **At rest, nothing changes.** Both plugins store the base64 string's UTF-8 bytes today; keep
  doing that and existing armed gates need no migration.

Residual: a Swift/Java `String` inside the app process for the length of one call, no longer a
copy in the WebView process's heap. Optional polish later: uniffi `bytes` exports (`Data` /
`ByteArray`) so even that copy is wipeable.

### 5. Enrollment without a JS copy (separate decision)

The inviter half is cheap: seal the bundle in Rust so `exportVek()` is never called. The cost is
the **joiner**. `receiveBundle` holds `bundle.vek` in JS for the entire vault rebuild and
re-injects it through `loadThen` before every wrap, because the single global slot can be
clobbered between ops. Removing that copy needs:

- a session-scoped Rust object that holds the group VEK privately and exposes
  `wrap_vek_password` / `encrypt_with_vek` on itself, replacing `wasmSlotCrypto`;
- the VEK travelling as its own Noise frame, sealed from the slot on the inviter and opened into
  the holder on the joiner, both inside Rust, instead of as a JSON field of the bundle;
- that surface on every binding: wasm-bindgen, uniffi + Swift + Kotlin + `native-crypto.ts`, and
  the Tauri commands + `sync-crypto.ts`;
- `enroll-host.ts` on both sides with version-skew handling, the `enroll-host.test.ts` frame
  ordering, and pairing tests across iOS, Android, Chrome, Firefox and desktop.

Old and new devices will not pair, so it is a coordinated release across every target, as the SAS
change was. For a copy that exists only during pairing, that is a week-plus and a forced update.
Do it when the next enrollment protocol bump is needed anyway, and until then this is the known
remaining crossing.

## Not scheduled (considered, with the reason)

- **Zero-on-free global allocator in `core-rust`.** The most literal hardened_malloc borrow that
  works in WASM: a `#[global_allocator]` that wipes in `dealloc` would catch every temporary the
  targeted `Zeroizing` misses (base64 reallocs, wasm-bindgen's copy of the password argument), and
  WASM linear memory never shrinks, so freed pages stay readable. One file, small perf cost.
  Parked only because it is orthogonal to the crossings above; worth doing on its own.
- **Absolute session ceiling.** The GrapheneOS lesson that matters most is reboot-to-BFU: evict
  the key rather than fortify its home. Auto-lock is idle-reset with a `Never` option and no
  ceiling. A wall-clock cap independent of activity, and on mobile a lock that ends the
  `:autofill` process rather than dropping a reference, is a product/UX change and is tracked
  separately from this list.

## What remains after all five

- **Extension per-op shipping.** `chrome.runtime` is JSON and the per-vault design injects the key
  into the offscreen scratch slot on every op on purpose (the multi-vault race fix in
  [multiple-vaults.md](multiple-vaults.md)). This is the platform floor for a browser extension;
  lock policy bounds it, not storage location.
- **Transient native strings** inside the app process (item 4 residual) until the uniffi `bytes`
  polish is done.
