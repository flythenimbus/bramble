# Vault — Password Manager Extension

A local-first, encrypted password manager shipped as a Chromium browser
extension. No server, no sync service, no cloud backend. All cryptographic
operations happen client-side inside a Rust WASM module. The user controls
where their encrypted vault file lives, including inside a Dropbox or Google
Drive folder for transparent cloud sync.

---

## Guiding Principles

- The React UI (`core/`) has **zero imports** from any platform package.
  Dependency arrows flow one way: platform → core.
- **Every field in every entry is encrypted.** Nothing — not site, not
  username, not notes — is ever persisted in the clear. The only plaintext on
  disk is the magic bytes, version, salt, and IVs in the vault header.
- The **master key never leaves the Rust WASM heap.** JS holds only
  ciphertexts and operation results.
- Prefer **explicit over clever**. This is security software.
- Every interface in `core/adapters/` must be implementable by a future
  platform (e.g. a web app, a Tauri desktop wrapper) without touching `core/`
  itself.

---

## Locked Decisions

| Topic | Decision |
|---|---|
| Native host | Dropped. Single-step install via Chrome Web Store. |
| Crypto runtime | **Rust + `wasm-bindgen`**, shipped inside extension package. |
| KDF | **Argon2id** (`argon2` crate) — `mem=64MB, time=3, par=1`, benchmark before ship. |
| Cipher | **AES-256-GCM** (`aes-gcm` crate) with per-entry DEKs (envelope encryption). |
| Memory zeroing | `zeroize` crate, `Drop`-based; cannot be elided by the compiler. |
| Key material in JS | **Never.** Master key lives in Rust heap only. |
| WASM host context | **Offscreen document.** Service worker is a thin message router. |
| Extension targets | **Chromium MV3 only for v1.** Firefox is v2. |
| Vault encryption scope | **All entry fields encrypted.** No plaintext meta. |
| Vault file location | **File System Access API** — user picks file via OS picker (incl. Dropbox/Drive folders). |
| Handle persistence | `FileSystemFileHandle` in **IndexedDB** (structured-clone-compatible). |
| Verifier block | **HMAC(master_key, magic_bytes)** — no fixed plaintext. |
| Vault format versioning | 1-byte version field at offset 4 after `VLT1` magic. |
| Subdomain matching | `tldts` for eTLD+1 + per-entry exact/subdomain override. |
| TOTP | Encrypted field inside entry JSON; codes via `otpauth`. |
| Password recovery | **None.** Loud onboarding warning. |
| Atomic writes | FSA `createWritable()` close-commit semantics. |
| Iframes / shadow DOM | Top frame, light DOM only in v1. Deferred to v2. |
| Auto-lock | User-configurable timeout (5 / 15 / 60 min / never); all triggers active. |
| Clipboard auto-clear | `chrome.alarms`, fires even if popup closes. |
| First-time setup | Full-tab options page (avoids popup focus-loss dismissal). |
| Build tool | **Vite** + Bun workspaces. |
| Repo layout | `packages/*/src/` convention. `@core` → `packages/core/src`. |
| CI | GitHub Actions from day one; Docker-pinned Rust toolchain for reproducible WASM. |

---

## Repository Layout

```
packages/
├── core/                              # Platform-agnostic — React UI + adapter interfaces
│   └── src/
│       ├── adapters/
│       │   ├── storage.ts             # StorageAdapter interface
│       │   ├── crypto.ts              # CryptoAdapter interface
│       │   ├── autofill.ts            # AutofillAdapter interface
│       │   └── messaging.ts           # NativeMessagingAdapter (reserved)
│       ├── context/
│       │   └── PlatformContext.tsx    # Provider + usePlatform() hook
│       ├── hooks/
│       │   ├── useVault.ts
│       │   └── useCredentials.ts
│       ├── vault-format.ts            # encode/decode binary blob
│       └── components/
│           ├── App.tsx
│           ├── VaultSetup.tsx
│           ├── UnlockScreen.tsx
│           ├── EntryList.tsx
│           └── EntryDetail.tsx
│
├── platform-extension/                # Chromium MV3 implementation
│   ├── public/                        # Static assets (wasm output lives here)
│   └── src/
│       ├── background.ts              # Service worker — message router
│       ├── offscreen.html             # Offscreen document entry
│       ├── offscreen.ts               # Hosts WASM + master key
│       ├── popup.html
│       ├── popup.tsx                  # Popup entry — wires adapters, renders <App />
│       ├── options.html
│       ├── options.tsx                # First-time vault setup
│       ├── content-script.ts          # Autofill detection + fill
│       ├── storage.ts                 # StorageAdapter via FSA API
│       ├── crypto.ts                  # CryptoAdapter via offscreen messaging
│       ├── autofill.ts                # AutofillAdapter
│       └── wasm-loader.ts             # Boots wasm-bindgen runtime in offscreen
│
├── crypto-wasm/                       # Rust crate compiled to WASM
│   ├── Cargo.toml
│   └── src/
│       └── lib.rs                     # #[wasm_bindgen] exported API
│
└── manifests/
    └── chrome/
        └── manifest.json              # MV3
```

---

## Phase 1 — Monorepo Scaffold & Tooling

**Goal:** Working build pipeline producing a loadable Chromium extension from
a single codebase.

### Tasks

1. Initialise Bun workspace with the packages above.
2. Configure Vite with multiple entry points: `popup`, `options`, `background`,
   `offscreen`, `content-script`. Each with its own HTML where appropriate.
3. Path alias `@core` → `packages/core/src` via tsconfig + vite.
4. Vite plugin to copy `packages/manifests/chrome/manifest.json` → `dist/`.
5. WASM artifact (`vault_crypto_bg.wasm` + JS bindings) served as static
   assets, loaded via `chrome.runtime.getURL`.
6. `packages/core/src/adapters/*.ts` — interfaces only, no implementations.
7. `PlatformContext.tsx` with `PlatformProvider` and `usePlatform()`.
8. `manifests/chrome/manifest.json` — MV3 with `offscreen`, `storage`, `alarms`,
   `idle`, host permissions for autofill.
9. Build scripts:
   ```
   bun run build      → vite build → dist/
   bun run dev        → vite watch mode (load unpacked)
   bun run wasm:build → wasm-pack build inside crypto-wasm + copy to public/
   ```

**Milestone:** `pnpm build` produces a loadable extension that shows an empty
popup.

---

## Phase 2 — Rust WASM Crypto Module

**Goal:** A Rust WASM binary that owns all key material and crypto operations.
The master key never crosses into JavaScript as raw bytes.

### Cryptographic Design

- **KDF:** Argon2id (`argon2` crate) — `mem=64MB, time=3, par=1`, output 32 bytes.
- **Cipher:** AES-256-GCM (`aes-gcm` crate).
- **Envelope encryption:** Each vault entry has its own randomly generated
  Data Encryption Key (DEK). The DEK is wrapped (AES-GCM) by the master key
  and stored alongside the ciphertext. Password change re-wraps DEKs only.
- **Zeroization:** All sensitive byte buffers wrapped in `Zeroizing<Vec<u8>>`
  so `Drop` zeroes them deterministically.

### JS-Exported API (`#[wasm_bindgen]`)

```rust
// All inputs/outputs are base64 strings or JSON-serializable structs.
unlock(password: String, salt_b64: String) -> Result<(), JsError>
lock() -> ()
is_locked() -> bool
encrypt_entry(plaintext_json: String) -> Result<EncryptedEntryPayload, JsError>
decrypt_entry(ciphertext: String, iv: String, wrapped_dek: String, dek_iv: String) -> Result<String, JsError>
generate_salt() -> String                  // 16 random bytes, base64
verifier_for(magic_bytes: &[u8]) -> Vec<u8> // HMAC(master_key, magic_bytes)
change_password(new_password: String, new_salt_b64: String, entries: &JsValue) -> Result<JsValue, JsError>
```

### Tasks

1. Create `crypto-wasm/Cargo.toml` with `crate-type = ["cdylib"]` and deps
   `wasm-bindgen`, `argon2`, `aes-gcm`, `hmac`, `sha2`, `zeroize`, `getrandom`
   (with `js` feature), `base64`, `serde`, `serde-wasm-bindgen`.
2. Build script: `wasm-pack build --target web --out-dir ../platform-extension/public/wasm`.
3. `platform-extension/src/wasm-loader.ts` — boots wasm-bindgen module once in
   the offscreen document, returns a Promise resolving to the typed module.
4. `platform-extension/src/offscreen.ts` — hosts the WASM, accepts messages
   from background SW, dispatches to WASM functions.
5. `platform-extension/src/crypto.ts` — `CryptoAdapter` implementation that
   sends messages to offscreen via background SW.

**Milestone:** From the popup, can unlock with a password, encrypt a string,
decrypt it back. WASM state persists across SW restarts because it lives in
the offscreen document.

---

## Phase 3 — Vault File Format & Storage Adapter

**Goal:** Encrypted vault blob stored in a user-chosen file. Cloud sync is
automatic if the file lives in a synced folder.

### Blob Format (`core/src/vault-format.ts`)

```
Offset   Length   Field
0        4        Magic: 0x56 0x4C 0x54 0x31  ("VLT1")
4        1        Version: 0x01
5        16       Argon2id salt
21       32       Verifier: HMAC-SHA256(master_key, magic_bytes ++ version)
53       12       Entries IV
65       N        Entries ciphertext (AES-256-GCM of JSON array of EncryptedEntry)
```

`EncryptedEntry` (encrypted inside the entries block — every field opaque):

```ts
interface EncryptedEntry {
  id: string;          // uuid, generated client-side
  wrappedDek: string;  // base64 — DEK wrapped by master key
  dekIv: string;       // base64
  ciphertext: string;  // base64 — JSON of { site, username, password, totp?, notes? }
  iv: string;          // base64
}
```

On unlock: decrypt the entries array, decrypt each entry's metadata into an
in-memory index for search and autofill. Index lives only in offscreen
document memory while unlocked.

### Storage Adapter (`platform-extension/src/storage.ts`)

- **First-time setup** happens in the full-tab options page:
  `showSaveFilePicker()` (new vault) or `showOpenFilePicker()` (existing).
- Persist `FileSystemFileHandle` in IndexedDB (structured-clone compatible).
- On each session start: `handle.queryPermission()`; if not `"granted"`, call
  `handle.requestPermission()` — native browser prompt.
- `readVaultBlob()` returns raw `Uint8Array`.
- `writeVaultBlob(blob)` uses `handle.createWritable()` with close-commit
  atomic semantics. Note in code: this is the atomicity guarantee.
- "Change vault file" inside popup is allowed; it re-runs the picker.

**Milestone:** Create vault → write → close extension → reopen → re-grant
permission → read back. File is opaque binary.

---

## Phase 4 — Core React UI

**Goal:** A complete UI in `core/src/components/` that works purely through
`usePlatform()`.

### Screens & Flow

```
Options page (full tab)
  └─ VaultSetup — create new file or open existing → set master password

Popup (returning)
  └─ UnlockScreen — enter master password → verify against verifier block → VaultHome

VaultHome
  ├─ EntryList — shows decrypted site/username from in-memory index; client-side search
  ├─ EntryDetail — decrypt entry on demand → show password, totp → copy buttons
  ├─ AddEntry / EditEntry — form → encrypt_entry via CryptoAdapter → writeVaultBlob
  └─ Settings
       ├─ Change master password (re-wrap all DEKs)
       ├─ Move vault file (re-run picker)
       ├─ Auto-lock timeout (5 / 15 / 60 min / never)
       └─ Per-entry subdomain matching toggle
```

### Hooks

`useVault()` — orchestrates storage + crypto. Exposes
`{ entries, unlock, lock, isLocked, addEntry, updateEntry, deleteEntry, changePassword, moveVault }`.

`useCredentials(entryId)` — decrypts a single entry on demand. Returns
`{ site, username, password, totp?, notes?, isLoading }`. Generates rolling
TOTP codes via `otpauth` if a TOTP secret is present.

### UX Requirements

- Vault file shown by filename only (browsers do not expose paths).
- Auto-lock: user-configurable timeout. All triggers active by default
  (`chrome.idle.onStateChanged` + time-since-decrypt + popup `visibilitychange`).
- Password strength indicator on new/edit (use `zxcvbn-ts`).
- Copy-to-clipboard buttons schedule a `chrome.alarms` job to clear clipboard
  after 30s. Survives popup close.
- Keyboard-navigable (Tab through entries, Enter to open, Esc to lock).

**Milestone:** Full CRUD of entries. Lock/unlock cycle stable across SW
restarts. Auto-lock fires per configured trigger.

---

## Phase 5 — Autofill

**Goal:** When the user visits a site matching a vault entry, offer to fill
credentials via a content script.

### Architecture

```
Content script (top frame, light DOM only)
  └─ detects <input type="password">, sends hostname to background
Background SW
  └─ routes to offscreen; offscreen searches in-memory index
     (eTLD+1 match via tldts; respects per-entry exact/subdomain setting)
Background
  └─ sends matching entry ids+sites back to content script
Content script
  └─ shows inline dropdown of matches
User selects
  └─ background asks offscreen to decrypt the entry
     → returns { username, password } to content script
Content script
  └─ fills fields, immediately nulls local references
```

### Tasks

1. `AutofillAdapter` interface in `core/src/adapters/autofill.ts`:
   ```ts
   interface AutofillAdapter {
     findMatchingEntries(hostname: string): Promise<MatchSummary[]>;
     fillCredentials(entryId: string): Promise<void>;
   }
   ```
2. Content script: detects password input on top frame, light DOM only.
   Iframes and shadow DOM out of scope for v1 — document the limitation.
3. Background SW: receives `AUTOFILL_QUERY`, forwards to offscreen.
4. Offscreen: matches against in-memory index using `tldts` for eTLD+1; honors
   per-entry override (exact vs subdomain).
5. On user selection: offscreen decrypts the entry; SW relays credentials to
   the active tab's content script.
6. Content script registered in manifest with `all_frames: false`.

**Milestone:** Visiting github.com with a saved GitHub entry triggers an
autofill prompt. Selecting it fills the form.

---

## Phase 6 — Hardening & Polish

### Security

- Every path where plaintext could linger in JS — audit and document.
- Verifier block rejects wrong passwords before any entry decrypt is attempted.
- CSP: no `unsafe-inline`, no `unsafe-eval`. WASM uses `wasm-unsafe-eval`.
- Offscreen clears WASM state on `lock` message *and* on background-initiated
  lock (auto-lock alarm fires even if popup is gone).
- Confirm `chrome.storage.session` is not used to leak any key material —
  master key is offscreen-only.

### Testing

- Unit (Vitest): `vault-format.ts` encode/decode round-trip; index rebuild.
- Integration: unlock → encrypt → decrypt → matches original.
- Integration: wrong password rejected by verifier before entry decrypt.
- Integration: change-password re-wraps all DEKs and reads back identically.
- E2E (Playwright + extension support): full unlock → add → autofill on a
  local test page.

### Distribution

- `bun run build` → `dist/` → zip → Chrome Web Store submission.
- Reproducible WASM: Rust toolchain pinned in `rust-toolchain.toml`; CI builds
  in Docker against that exact version.
- `make all` produces a deterministic zip.

**Milestone:** Passes Chrome's manifest validator. All tests green. No
`unsafe-inline` in CSP. WASM build is byte-identical across machines.

---

## Things Explicitly Out of Scope for v1

- Firefox / Safari / mobile browsers
- File attachments on entries
- Iframe and Shadow DOM autofill
- Vault sync conflict resolution (rely on cloud provider's versioning)
- Native messaging host
- Password import from other managers
- Biometric unlock
- Browser bookmark / history integration
