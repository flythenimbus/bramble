# Vault — Password Manager Extension

A local-first, encrypted password manager shipped as a Chromium browser
extension. No server, no sync service, no cloud backend. All cryptographic
operations happen client-side inside a Rust WASM module. The user controls
where their encrypted vault file lives, including inside a Dropbox or Google
Drive folder for transparent cloud sync.

---

## Guiding Principles

- The React UI (`packages/core/`) has **zero imports** from any platform
  package. Dependency arrows flow one way: platform → core.
- **Every field in every entry is encrypted.** Nothing — not site, not
  username, not notes — is ever persisted in the clear. The only plaintext on
  disk is the magic bytes, version, salt, verifier, and IVs in the vault
  header. The hostname registry (used for the "locked" autofill hint) is the
  one exception — see "Session lifecycle" below.
- **All key derivation happens inside Rust WASM.** The password-derived KEK
  (Argon2id) unwraps a random **Vault Encryption Key (VEK)** generated once
  at vault creation. The VEK is the in-memory secret; a copy of its 32 raw
  bytes is held in `chrome.storage.session` (in-memory, per-extension, wiped
  on browser restart) so the WASM module can be re-hydrated after Chrome
  terminates the offscreen document. JS heap holds only ciphertexts,
  operation results, and the b64 VEK cache — never a password or KEK.
- Prefer **explicit over clever**. This is security software.
- Every interface in `core/adapters/` must be implementable by a future
  platform (web app, Tauri desktop) without touching `core/` itself.

---

## Locked Decisions

| Topic | Decision |
|---|---|
| Native host | Dropped. Single-step install via Chrome Web Store. |
| Crypto runtime | **Rust + `wasm-bindgen`**, shipped inside extension package. |
| KDF | **Argon2id** (`argon2` crate) — `mem=64MB, time=3, par=1`. |
| Cipher | **AES-256-GCM** with per-entry DEKs (envelope encryption). |
| Memory zeroing | `zeroize` crate, `Drop`-based. |
| WASM host context | **Offscreen document.** Pure WASM container — no state. |
| Session state owner | **Background service worker.** Holds autofill index, cached VEK, alarms. |
| Session persistence | `chrome.storage.session` (VEK + autofill index), `chrome.storage.local` (hostname registry). |
| Auto-lock | `chrome.alarms`, default 15 min, sliding (resets on autofill activity). |
| Extension targets | **Chromium MV3 only for v1.** Firefox is v2. |
| Vault encryption scope | **All entry fields encrypted.** No plaintext meta in the vault file. |
| Vault file location | **File System Access API** — user picks file via OS picker. Falls back to `chrome.storage.local` when FSA isn't available. |
| Handle persistence | `FileSystemFileHandle` in **IndexedDB**. |
| Per-slot verifier | **HMAC(KEK, magic ++ version ++ slotId)** — constant-time reject of wrong credentials without an AEAD unwrap attempt. |
| Vault format versioning | 1-byte version field at offset 4 after `VLT1` magic. Current version `0x02` — LUKS-style multi-key slots (see "Multi-Key Slots" below). |
| Hostname matching | `tldts` eTLD+1 collapsing — `www.ikea.com` and `ca.accounts.ikea.com` both match an entry stored as `ikea.com`. |
| Password recovery | **None.** Loud onboarding warning. |
| Atomic writes | FSA `createWritable()` close-commit semantics. |
| Iframes / shadow DOM | Top frame, light DOM only in v1. |
| First-time setup | Full-tab options page (avoids popup focus-loss dismissal). |
| UI router | **TanStack Router** with memory history (popup re-mounts at `/` every open). |
| Build tool | **Vite** + Bun workspaces. |
| Repo layout | `packages/*/src/` convention. `@core` → `packages/core/src`. |
| Lint / format | **Biome**. |

---

## Repository Layout

```
packages/
├── core/                              # Platform-agnostic — React UI + adapter interfaces
│   └── src/
│       ├── adapters/
│       │   ├── storage.ts             # StorageAdapter interface
│       │   ├── crypto.ts              # CryptoAdapter interface
│       │   ├── autofill.ts            # AutofillAdapter interface (+ per-entry overrides)
│       │   ├── clipboard.ts           # ClipboardAdapter — copy + auto-clear
│       │   ├── shell.ts               # ShellAdapter (open options page, FSA capability, current tab origin)
│       │   └── messaging.ts           # NativeMessagingAdapter (reserved)
│       ├── context/
│       │   └── PlatformContext.tsx    # Provider + usePlatform() hook
│       ├── hooks/
│       │   ├── useVault.tsx           # Orchestrates storage + crypto + autofill
│       │   └── usePrefs.tsx           # User prefs (auto-lock, clipboard TTL, breach check)
│       ├── vault-format.ts            # encode/decode binary blob
│       ├── vault-format.test.ts
│       ├── util/
│       │   └── pwned.ts               # Have-I-Been-Pwned k-anonymity lookup
│       ├── index.ts                   # Public surface
│       └── app/                       # The actual React app
│           ├── App.tsx                # ThemeProvider → VaultProvider → RouterProvider
│           ├── OptionsApp.tsx         # Full-tab setup app (separate from popup)
│           ├── router.tsx             # TanStack routes
│           ├── hooks/useTheme.tsx
│           ├── layouts/AppLayout.tsx
│           ├── routes/
│           │   ├── AuthRoute.tsx      # Auto-redirects to /vault when unlocked
│           │   ├── VaultHomeRoute.tsx
│           │   ├── CreatePasswordRoute.tsx
│           │   └── SettingsRoute.tsx
│           ├── screens/
│           │   ├── Auth/
│           │   ├── VaultHome/
│           │   ├── CreatePassword/
│           │   ├── Settings/
│           │   └── VaultSetup/        # Used by options page
│           └── components/
│               ├── PasswordItem.tsx
│               ├── AddDropdown.tsx
│               └── ui/                # Shadcn-style primitives
│
├── platform-extension/                # Chromium MV3 implementation
│   ├── public/                        # Static assets (wasm output lives here)
│   │   └── wasm/                      # wasm-pack output — vault_crypto.js + .wasm
│   └── src/
│       ├── background.ts              # SW — session state, autofill index, alarms, clipboard-clear, prefs
│       ├── offscreen.html
│       ├── offscreen.ts               # WASM container + clipboard-clear (CLIPBOARD reason)
│       ├── popup.html
│       ├── popup.tsx                  # Wires adapters, renders <App />
│       ├── options.html
│       ├── options.tsx                # Renders <OptionsApp />
│       ├── content-script.ts          # Field detection + dropdown + autofill + auto-submit
│       ├── storage.ts                 # StorageAdapter — FSA + IndexedDB
│       ├── crypto.ts                  # CryptoAdapter — messages background → offscreen
│       ├── autofill.ts                # AutofillAdapter — messages background
│       ├── clipboard.ts               # ClipboardAdapter — popup-side write, background-scheduled clear
│       ├── shell.ts                   # ShellAdapter — chrome.tabs / chrome.runtime
│       └── wasm-loader.ts             # Boots wasm-bindgen runtime in offscreen
│
├── crypto-wasm/                       # Rust crate compiled to WASM
│   ├── Cargo.toml
│   └── src/lib.rs
│
└── manifests/
    └── chrome/manifest.json
```

---

## Process / Context Architecture

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  Popup / Options │   │  Content script  │   │  (any tab)       │
│  (React + UI)    │   │  (per page)      │   │                  │
└────────┬─────────┘   └────────┬─────────┘   └──────────────────┘
         │                      │
         │  chrome.runtime.sendMessage
         ▼                      ▼
┌────────────────────────────────────────────────────────────────┐
│  Background service worker (background.ts)                     │
│  ──────────────────────────────────────────                    │
│  Owns:                                                         │
│   - autofillIndex (in-memory + chrome.storage.session)         │
│   - cachedVek b64 (in-memory + chrome.storage.session)         │
│   - knownHostnames (in-memory + chrome.storage.local)          │
│   - vault:autolock alarm (sliding 15-min timeout)              │
│                                                                │
│  Handles AUTOFILL_* directly (no offscreen round-trip).        │
│  Forwards CRYPTO_* to offscreen, re-injecting cachedVek via    │
│  CRYPTO_UNLOCK_WITH_VEK whenever offscreen is fresh.           │
└────────────────────┬───────────────────────────────────────────┘
                     │  chrome.runtime.sendMessage (target=offscreen)
                     ▼
┌────────────────────────────────────────────────────────────────┐
│  Offscreen document (offscreen.ts) — ~3 kB                     │
│  ────────────────────────────────────────                      │
│  Single responsibility: hold the WASM crypto module.           │
│  No chrome.storage. No alarms. No autofill state.              │
│  Dispatches CRYPTO_* messages to wasm-bindgen exports.         │
└────────────────────────────────────────────────────────────────┘
```

Why the split: the offscreen document has flakier API access than the SW
(`chrome.storage.session` was undefined in offscreen during testing) and a
more aggressive lifecycle. Centralising session state in the SW gives us one
source of truth and reliable persistence APIs. The offscreen exists only
because the SW can't reliably host a long-lived WASM module across its own
idle-kill cycle.

---

## Session Lifecycle

The unlocked-vault session is engineered to survive every restart Chrome
throws at us except for explicit lock / timeout / browser-close.

1. **Unlock** (`CRYPTO_UNWRAP_PASSWORD_SLOT`):
   - Background forwards to offscreen → WASM derives the KEK with Argon2id,
     verifies the slot in constant time, and unwraps the VEK into memory.
   - On success, background calls `CRYPTO_EXPORT_VEK` → caches the 32-byte
     VEK as b64 in `chrome.storage.session`.
   - Background schedules the `vault:autolock` alarm (15 min from now).
2. **Populate autofill** (`AUTOFILL_SET_INDEX`):
   - Popup pushes the decrypted entries.
   - Background stores them in memory + `chrome.storage.session`.
   - Hostnames are also mirrored to `chrome.storage.local` for the
     locked-state hint.
3. **Activity** (`AUTOFILL_FIND` / `AUTOFILL_FETCH` / `AUTOFILL_SELECT`):
   - Background reschedules the alarm — sliding 15-min window.
4. **Offscreen killed by Chrome**:
   - Next `CRYPTO_*` recreates the offscreen.
   - Background detects WASM is fresh (`offscreenHasKey === false`), sends
     `CRYPTO_UNLOCK_WITH_VEK` with the cached b64 VEK before forwarding the
     real message. No re-prompt.
5. **SW killed by Chrome**:
   - On wake, hydrates `autofillIndex`, `cachedVek`, and `knownHostnames`
     from `chrome.storage.session` / `local`.
6. **Alarm fires** (15 min idle):
   - Background wipes in-memory state, removes the session-storage keys,
     forwards `CRYPTO_LOCK` to offscreen.
7. **Explicit lock** (popup): same as alarm.
8. **Browser restart**: `chrome.storage.session` is wiped by Chrome. The
   hostname registry survives in `local` (low sensitivity — just "which sites
   have entries").

---

## Adapter Surface (`packages/core/src/adapters/`)

```ts
// storage.ts
interface StorageAdapter {
  hasVaultHandle(): Promise<boolean>;
  selectVaultFile(mode: "create" | "open"): Promise<void>;
  readVaultBlob(): Promise<Uint8Array>;
  writeVaultBlob(blob: Uint8Array): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta<T>(key: string, value: T): Promise<void>;
}

// crypto.ts — slot-aware. All entry / outer crypto is keyed by the in-memory
// VEK; password slots wrap a copy of the VEK (LUKS-style multi-key layout).
interface CryptoAdapter {
  // VEK lifecycle.
  generateVek(): Promise<string>;                  // creates VEK + loads it
  unlockWithVek(vekB64: string): Promise<void>;    // session resume / rollback
  exportVek(): Promise<string>;                    // session resume
  rotateVek(): Promise<string>;                    // full rotation
  lock(): Promise<void>;
  isLocked(): Promise<boolean>;

  // Slot operations.
  generateSalt(): Promise<string>;
  generateSlotId(): Promise<string>;
  wrapVekPassword(in: WrapPasswordSlotInput): Promise<PasswordSlotBlob>;
  unwrapVekPassword(in: UnwrapPasswordSlotInput): Promise<boolean>;
  verifyPasswordSlot(in: VerifyPasswordSlotInput): Promise<boolean>;

  // Entry / outer crypto, keyed by the loaded VEK.
  encryptEntry(plaintextJson: string): Promise<EncryptedPayload>;
  decryptEntry(payload: EncryptedPayload): Promise<string>;
  encryptWithVek(plaintext: string): Promise<VekEncrypted>;
  decryptWithVek(iv: string, ciphertext: string): Promise<string>;
}

// autofill.ts
interface AutofillAdapter {
  setIndex(entries: IndexEntry[]): Promise<void>;
  clearIndex(): Promise<void>;
  findMatchingEntries(hostname: string): Promise<FindResult>;
  fetchCredentials(entryId: string): Promise<Credentials>;
}
// FindResult  = { matches, locked, hasPotentialMatch }
// MatchSummary = { id, name, username, autofillEnabled?, autoSubmit? }
// IndexEntry  = { id, hostname, name, username, password,
//                 autofillEnabled?, autoSubmit?, subdomainMatch? }
// Credentials = { username, password, autoSubmit? }
// SubdomainMatchMode = "etld1" | "exact" | "subdomain"

// clipboard.ts
interface ClipboardAdapter {
  // Writes the value to the OS clipboard (from a context with permission,
  // i.e. the popup) and schedules a background-driven auto-clear. The clear
  // wipes only if the clipboard still contains the original value at the
  // time the alarm fires.
  copy(text: string): Promise<void>;
}

// shell.ts
interface ShellAdapter {
  openSetup(): Promise<void>;
  hasFilePicker(): boolean;
  getCurrentTabOrigin(): Promise<string | null>;
  popOut(): Promise<void>;       // open current UI in a detached window
  isDetached(): boolean;         // true when running in the popped-out window
}

// messaging.ts (reserved)
interface NativeMessagingAdapter { ... }
```

---

## WASM Crypto API (`packages/crypto-wasm/src/lib.rs`)

```rust
// VEK lifecycle (the in-memory key slot now holds the Vault Encryption Key).
generate_vek() -> Result<String, JsError>                // vault create
unlock_with_vek(vek_b64: String) -> Result<(), JsError>  // session resume / rotation rollback
export_vek() -> Result<String, JsError>                  // session resume
rotate_vek() -> Result<String, JsError>                  // full rotation on password change
lock()
is_locked() -> bool

// Salts / slot IDs.
generate_salt() -> Result<String, JsError>
generate_slot_id() -> Result<String, JsError>

// Password slot — wraps a copy of the VEK under a KEK = Argon2id(password, salt).
// `magic_version` binds the verifier to the format version (magic ++ version).
wrap_vek_password(password, salt_b64, slot_id_b64, magic_version)
    -> Result<JsValue, JsError>          // { verifier, wrapIv, wrappedVek }
unwrap_vek_password(password, salt_b64, slot_id_b64,
                    verifier_b64, wrap_iv_b64, wrapped_vek_b64, magic_version)
    -> Result<bool, JsError>             // true → VEK loaded; false → wrong pw
verify_password_slot(password, salt_b64, slot_id_b64, verifier_b64, magic_version)
    -> Result<bool, JsError>             // constant-time, no VEK unwrap

// Entry / outer crypto — all keyed by the VEK.
encrypt_entry(plaintext_json) -> Result<JsValue, JsError>
decrypt_entry(ct, iv, wrapped_dek, dek_iv) -> Result<String, JsError>
encrypt_with_vek(plaintext) -> Result<JsValue, JsError>
decrypt_with_vek(iv_b64, ciphertext_b64) -> Result<String, JsError>
```

Built via `bun run wasm:build` → `wasm-pack build --target web --out-dir
../platform-extension/public/wasm`. Vite copies the result into `dist/wasm/`
at build time. Loaded via `chrome.runtime.getURL` from the offscreen document
through `wasm-loader.ts`.

---

## Vault Blob Format

```
Offset   Length   Field
0        4        Magic: 0x56 0x4C 0x54 0x31  ("VLT1")
4        1        Version: 0x02
5        1        slotCount (uint8, max 16)
6        …        slots[] — each slot is TLV:
                    1 byte  kind  (0x01 password | 0x02 webauthn | 0x03 recovery)
                    2 bytes len   (big-endian)
                    N bytes payload (see per-kind layout below)
…       12        Entries IV
…        N        Entries ciphertext (AES-256-GCM of JSON EncryptedEntry[] under VEK)
```

Password slot payload (kind = 0x01, len = 124):
```
 0   16   slotId
16   16   Argon2id salt
48   32   verifier = HMAC-SHA256(KEK, magic ++ version ++ slotId)
80   12   wrapIv
92   48   wrappedVEK (32-byte VEK + 16-byte GCM tag)
```

Today the on-disk encoder only emits password slots. Unknown slot kinds
(future webauthn / recovery) are preserved verbatim across a decode → encode
round-trip so older builds don't drop slot data added by newer builds.

```ts
interface EncryptedEntry {
  id: string;          // uuid
  wrappedDek: string;  // base64 — DEK wrapped by VEK
  dekIv: string;       // base64
  ciphertext: string;  // base64 — JSON of { name, url, username, password, totp?, notes? }
  iv: string;          // base64
}
```

`useVault.loadEntries` decrypts the outer block, then each entry, and pushes
the decrypted index to the autofill adapter so the background SW can serve
queries while the popup is closed.

---

## Multi-Key Slots

LUKS-style multi-key slot layout. Same vault, unlockable by any of: a master
password, a printable recovery code, a hardware security key (FIDO2
`hmac-secret`), or future authenticator types — without re-encrypting the
entries each time a key is added or revoked.

Status: **password slot is shipped** (format v0x02). WebAuthn and recovery
slot kinds are reserved in the format; the encoder/decoder preserves their
payloads verbatim across a round-trip, but no UI yet exists to add or
remove them.

### Concept

A random **Vault Encryption Key (VEK)** is generated at vault creation. Each
entry's DEK is wrapped by the VEK; the outer entries blob is encrypted under
the VEK. Each "slot" wraps a copy of the VEK with a Key Encryption Key (KEK)
derived from one specific authenticator:

```
authenticator → KEK = kdf(authenticator-secret, slot-salt)
                ↓
       wrappedVEK = AES-GCM(KEK, VEK)
```

Add a slot → derive a new KEK, wrap the existing VEK with it, append.
Revoke a slot → drop it from the array. These keep the VEK and all entry
DEKs untouched, so entries don't need re-encryption.

**Rotating a password is different**: we deliberately rotate the VEK,
re-encrypt every entry under fresh DEKs + IVs, re-encrypt the outer entries
blob, and rewrap the new VEK under the new password slot. The slow path is
the point — a leaked old VEK or old DEK must not survive a rotation. When
recovery / WebAuthn slots exist, rotation will require re-presenting each
authenticator so the new VEK can be wrapped under every existing slot's KEK
in one atomic operation.

### Header layout

See "Vault Blob Format" above for the live layout. The encoder enforces a
non-empty slot list and a hard cap of 16 slots.

### Reserved slot payloads (not yet wired)

```
webauthn slot (kind=0x02):
  16 bytes  slotId
   2 bytes  credentialIdLen
   N bytes  credentialId
  32 bytes  hmac-secret salt (passed to authenticator on get())
  32 bytes  verifier
  12 bytes  wrapIv
  48 bytes  wrappedVEK

recovery slot (kind=0x03):
  16 bytes  slotId
  16 bytes  Argon2id salt
  32 bytes  verifier
  12 bytes  wrapIv
  48 bytes  wrappedVEK
```

### Unlock flow

1. Parse all slots.
2. For each slot of the kind the user is presenting (password / security key
   / recovery code):
   - Derive the KEK (Argon2id for password / recovery; HKDF over the
     hmac-secret output for WebAuthn).
   - Recompute the verifier; compare in constant time.
   - On match: unwrap VEK with that KEK and stop.
3. Use the VEK to unwrap entry DEKs and decrypt entries as today.

The verifier-per-slot lets us reject wrong passwords / wrong security keys
without attempting expensive VEK unwrap.

### WebAuthn `hmac-secret` (planned)

The `hmac-secret` extension lets us request a stable HMAC output from a
FIDO2 authenticator (YubiKey 5, Solo, Passkey-capable platform
authenticators) without ever extracting key material. On registration we
store `credentialId` + a 32-byte random `salt`; on unlock we call
`navigator.credentials.get({ publicKey: { ..., extensions: { hmacGetSecret:
{ salt1: ourSalt } } } })` and pass the returned 32-byte secret through HKDF
to produce the KEK. Browser support: Chrome / Edge on desktop today; not all
authenticators implement `hmac-secret` (YubiKey 5+ and most Solo keys do).

### Session-resume implications

`chrome.storage.session` caches the b64 VEK so offscreen / SW restarts can
re-inject it without prompting the user. Agnostic to which authenticator
the user originally unlocked with.

---

## Autofill Content Script (`platform-extension/src/content-script.ts`)

### Field detection

Multi-strategy `detectLoginFields()`:
1. If a password field exists, the nearest preceding text/email input in DOM
   order (within the same `<form>` when present) is the username — most
   reliable signal.
2. Otherwise: `input[autocomplete~="username"]` / `autocomplete="email"`.
3. Otherwise: first `input[type="email"]`.
4. Otherwise: heuristic on `name|id|placeholder|autocomplete|aria-label`
   matching `/email|user|login|account|signin/` minus negative hints
   `/search|captcha|coupon|otp|code/`.

This makes the email-only step of two-step logins (e.g. ikea.com) work — the
script doesn't require a password field to be present.

### Dropdown UI

Dark `rgba(28,28,30,0.96)` popover with backdrop blur, anchored just below
the focused field, sized to `max(field.width / 3, 240)`. Built via a tagged
`html` template literal with an inlined `<style>` block — styles and markup
live together in `buildDropdown` / `buildLockedDropdown`.

Each row shows:
- A 40×40 rounded-square avatar with the entry's initials (first letter of
  the first two words, else first two chars) on a deterministic colour from a
  9-swatch palette hashed off the name.
- The entry name (white) and username (grey).

### Interaction model

- `MutationObserver` (500ms debounce) re-runs `queryAutofill` when the DOM
  changes — handles SPA navigation between login steps.
- `focusin` on a candidate field shows the cached result.
- `input` events show the dropdown when the field is empty, hide it when the
  user is actively typing (unless multi-match disambiguation is needed).
- Single-match auto-fill happens once per field; `autoFilledFields` (a
  `WeakSet`) blocks re-fills triggered by MutationObserver re-queries so the
  user can clear a field without it being clobbered.
- Click anywhere outside the dropdown and the anchor field closes it.

### Stale-context guard

If `chrome.runtime.id` becomes undefined (the extension reloaded but the old
content script is still attached to the page), the script tears down its
observer and stops sending messages — prevents the "Extension context
invalidated" error storm.

---

## UI Routing

`app/router.tsx` defines a TanStack memory-history router with two top-level
trees:

```
/                            → AuthRoute     (unlock form)
_app (layout)
  /vault                     → VaultHomeRoute
  /vault/new                 → CreatePasswordRoute
  /vault/$entryId            → EntryDetailRoute
  /vault/$entryId/edit       → EntryEditRoute
  /settings                  → SettingsRoute
```

`EntryEditRoute` reuses `CreatePassword` by passing `initialValues` and a
custom `submitLabel` — one form serves both create and edit. `PasswordItem`
rows are clickable (navigate to detail) and carry a three-dots menu with
inline Edit / Delete (delete swaps to a confirm step before destroying).

`AuthRoute` watches `isLocked` and navigates to `/vault` via a `useEffect`
when it flips to `false`. Navigation is **not** explicit in the unlock
callback — that caused a render-order race where `VaultHomeRoute` would mount
before React applied the state update, see stale `isLocked: true`, and bounce
back to `/`.

`OptionsApp.tsx` is a separate React tree mounted by the options page; it
renders the `VaultSetup` flow directly without the router because file
pickers misbehave inside the popup.

### Detached window (pop-out)

The popup auto-dismisses on focus loss, which is hostile to multi-step
flows (filling a long form, copying values into another tab). A header
button calls `shell.popOut()`, which uses `chrome.windows.create` to open
`popup.html?detached=1` as a standalone type=`popup` window — 500×600,
anchored to the top-right of the currently-focused browser window with an
80px y-offset to clear the title + tab bars. State is preserved because
the background SW owns the VEK cache and autofill index, so the new
window picks up the unlocked session without re-prompting.

`shell.isDetached()` reads the `?detached=1` URL flag and is used to hide
the pop-out button when already running detached. `popup.tsx` also
switches the html/body from the fixed 500×400 popup dimensions to `100%`
when detached, so the React app fills the chrome window instead of
leaving dead space.

---

## Status

### Working

- Full CRUD loop: vault create + unlock, entry list (`VaultHome`), entry
  create (`CreatePassword`), entry detail with copy-to-clipboard
  (`EntryDetail`), edit (reuses `CreatePassword` with `initialValues`), and
  delete with confirm step. Row-level edit / delete via the three-dots
  menu on every `PasswordItem`.
- Pop-out to detached window via `shell.popOut()` — button in both
  `AppLayout` header (unlocked) and `Auth` screen (locked). Detached
  window persists the unlocked session because session state lives in the
  background SW, not the popup.
- File System Access storage with `chrome.storage.local` fallback.
- WASM crypto with Argon2id + AES-256-GCM + envelope encryption.
- **Multi-key vault slot format** (VLT1 v0x02) — random VEK at vault
  creation, password slot wraps the VEK with `KEK = Argon2id(password, salt)`,
  per-slot verifier = `HMAC-SHA256(KEK, magic ++ version ++ slotId)` for
  constant-time wrong-password rejection. Encoder/decoder reserve and
  round-trip kinds 0x02 (webauthn) / 0x03 (recovery) verbatim, so future
  builds can add them without a format bump.
- **Full-rotation password change** — changing the master password
  generates a brand-new VEK (`crypto.rotateVek`), re-encrypts every entry
  under a fresh DEK + content IV + dek-wrap IV, re-encrypts the outer
  entries blob, and rewraps the new VEK under the new password slot. Any
  leaked old VEK, old DEK, or old ciphertext is cryptographically useless
  against the rotated vault. The flow snapshots the old VEK in JS memory
  and rolls back via `unlockWithVek` if any step before the disk write
  fails. When recovery / WebAuthn slots ship, rotation will refuse vaults
  with more than one authenticator until the multi-slot re-enroll UI lands
  rather than silently dropping authenticators.
- Background-owned session state with sliding auto-lock alarm
  (user-configurable, 15 min default).
- VEK cache (`chrome.storage.session`) for seamless resume across offscreen /
  SW restarts.
- Autofill on top-frame login pages: username-only, password-only, and
  combined forms. eTLD+1 subdomain matching via `tldts` (overridable
  per entry to `exact` / `subdomain` strict modes).
- "Vault locked" hint dropdown when the vault is locked.
- Theme toggle, popup → home redirect on unlock, content script teardown on
  extension reload.
- **Clipboard auto-clear** — `ClipboardAdapter.copy()` writes the value
  from the popup (sole context with clipboard write permission) and sends
  a SHA-256 fingerprint of it to the background SW. Background schedules
  the `vault:clipboard-clear` alarm with the user's configured TTL (30 s
  default). On fire, the offscreen document (created with `CLIPBOARD` +
  `WORKERS` reasons) reads the clipboard, re-hashes, and only writes
  empty if the value still matches — so we never trash unrelated data
  the user copied in the meantime.
- **Settings screen** — auto-lock timeout (5 / 15 / 30 / 60 min / never),
  clipboard-clear TTL, breach-check toggle, **Lock now**, and an inline
  change-master-password flow (current → new → confirm). Prefs persisted
  via `storage.setMeta` in `chrome.storage.local`; background reads them
  on demand and reschedules the auto-lock alarm when the timeout changes.
  Change-master-password triggers a full rotation (new VEK, fresh DEK +
  IVs per entry, new outer blob, new password slot) — see "Full-rotation
  password change" above.
- **HIBP breach check** — `checkPasswordBreach` (in `util/pwned.ts`)
  wraps the k-anonymity range query and returns `undefined` on any
  network failure (fail-open). Stored encrypted inside the entry JSON
  as `breach: { leaked, checkedAt }`; never written to `chrome.storage`.
  Fires from the popup on entry create / edit (only when the password
  actually changed), and lazily on `EntryDetail` open if the cached
  result is older than 7 days. Red "Breached" badge on row + banner on
  detail. VaultHome's "At Risk" / "Strong" counters now reflect real
  breach state. Disabled by a single Settings toggle for users who
  don't want any outbound traffic.
- **Per-entry overrides** — new optional fields on `EntryData`:
  `autofillEnabled` (default true), `autoSubmit` (default false), and
  `subdomainMatch: "etld1" | "exact" | "subdomain"` (default `etld1`).
  Surfaced in a collapsible "Advanced" section on `CreatePassword`.
  Background's `hostnameMatches` honours `subdomainMatch`. Content
  script honours `autofillEnabled === false` (still shows in dropdown
  for manual pick, no silent fill) and `autoSubmit === true` (calls
  `form.requestSubmit()` 50 ms after fill, with a synth-Enter fallback
  for forms without a submit button). All overrides ride inside the
  encrypted entry JSON and the in-memory autofill index, so old vaults
  without these fields keep working unchanged.

### TODO (next phases)

1. **Recovery-code slot (kind 0x03)** — wire add / revoke UI to the existing
   slot-aware format. Same Argon2id-derived KEK as password slots, just
   with a printable code instead of a memorised password.
2. **WebAuthn `hmac-secret` slot (kind 0x02)** — register / unlock with a
   FIDO2 authenticator (YubiKey 5+, platform passkeys). Requires
   `navigator.credentials.create/get` from popup/options context and
   testing across authenticator vendors.
3. **Idle / visibility-based auto-lock triggers** — supplement the alarm with
   `chrome.idle.onStateChanged` + popup `visibilitychange`.
4. **TOTP code generation** in `EntryDetail` (`otpauth` dep already
   installed, encrypted `totp` field already in the entry schema).
5. **Password strength indicator** in `CreatePassword` — `check-password-strength`
   dep is installed and used by `pwned.ts`, but not surfaced in the form.
6. **E2E tests** — Playwright + extension support.
7. **Reproducible WASM build in CI** — `rust-toolchain.toml` + Docker.
8. **Chrome Web Store submission**.

---

## Out of Scope for v1

- Firefox / Safari / mobile browsers
- File attachments on entries
- Iframe and Shadow DOM autofill
- Vault sync conflict resolution (rely on cloud provider's versioning)
- Native messaging host
- Password import from other managers
- Biometric unlock
- Browser bookmark / history integration
