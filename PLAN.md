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
- The **master key is derived inside Rust WASM.** A copy of the derived key
  bytes is held in `chrome.storage.session` (in-memory, per-extension, wiped
  on browser restart) so the WASM module can be re-hydrated after Chrome
  terminates the offscreen document. JS heap holds only ciphertexts,
  operation results, and the b64 key cache.
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
| Session state owner | **Background service worker.** Holds autofill index, cached master key, alarms. |
| Session persistence | `chrome.storage.session` (master key + autofill index), `chrome.storage.local` (hostname registry). |
| Auto-lock | `chrome.alarms`, default 15 min, sliding (resets on autofill activity). |
| Extension targets | **Chromium MV3 only for v1.** Firefox is v2. |
| Vault encryption scope | **All entry fields encrypted.** No plaintext meta in the vault file. |
| Vault file location | **File System Access API** — user picks file via OS picker. Falls back to `chrome.storage.local` when FSA isn't available. |
| Handle persistence | `FileSystemFileHandle` in **IndexedDB**. |
| Verifier block | **HMAC(master_key, magic ++ version)** — no fixed plaintext. |
| Vault format versioning | 1-byte version field at offset 4 after `VLT1` magic. Multi-key (LUKS-style) slots planned before ship — see "Planned vault format" below. |
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
│   - cachedMasterKey b64 (in-memory + chrome.storage.session)   │
│   - knownHostnames (in-memory + chrome.storage.local)          │
│   - vault:autolock alarm (sliding 15-min timeout)              │
│                                                                │
│  Handles AUTOFILL_* directly (no offscreen round-trip).        │
│  Forwards CRYPTO_* to offscreen, re-injecting cachedMasterKey  │
│  via CRYPTO_UNLOCK_WITH_KEY whenever offscreen is fresh.       │
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

1. **Unlock** (`CRYPTO_UNLOCK`):
   - Background forwards to offscreen → WASM derives master key with Argon2id.
   - Background calls `CRYPTO_EXPORT_KEY` → caches the 32-byte master key as
     b64 in `chrome.storage.session`.
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
     `CRYPTO_UNLOCK_WITH_KEY` with the cached b64 key before forwarding the
     real message. No re-prompt.
5. **SW killed by Chrome**:
   - On wake, hydrates `autofillIndex`, `cachedMasterKey`, and `knownHostnames`
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

// crypto.ts
interface CryptoAdapter {
  unlock(password: string, saltB64: string): Promise<void>;
  lock(): Promise<void>;
  isLocked(): Promise<boolean>;
  encryptEntry(plaintextJson: string): Promise<EncryptedPayload>;
  decryptEntry(payload: EncryptedPayload): Promise<string>;
  generateSalt(): Promise<string>;
  verifierFor(magicBytes: Uint8Array): Promise<Uint8Array>;
  verifyPassword(password: string, saltB64: string): Promise<boolean>;
  encryptWithMaster(plaintext: string): Promise<MasterEncrypted>;
  decryptWithMaster(iv: string, ciphertext: string): Promise<string>;
  changePassword(newPassword: string, newSaltB64: string,
                 entries: EncryptedPayload[]): Promise<EncryptedPayload[]>;
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
unlock(password: String, salt_b64: String) -> Result<(), JsError>
unlock_with_key(key_b64: String) -> Result<(), JsError>  // session resume
export_key() -> Result<String, JsError>                  // session resume
lock()
is_locked() -> bool
generate_salt() -> Result<String, JsError>
encrypt_entry(plaintext_json: String) -> Result<JsValue, JsError>
decrypt_entry(ct, iv, wrapped_dek, dek_iv) -> Result<String, JsError>
encrypt_with_master(plaintext: String) -> Result<JsValue, JsError>
decrypt_with_master(iv_b64, ciphertext_b64) -> Result<String, JsError>
verifier_for(magic: &[u8]) -> Result<Vec<u8>, JsError>
verify_password(password: String, salt_b64: String) -> Result<bool, JsError>
change_password(new_password, new_salt_b64, entries) -> Result<JsValue, JsError>
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
4        1        Version: 0x01
5        16       Argon2id salt
21       32       Verifier: HMAC-SHA256(master_key, magic ++ version)
53       12       Entries IV
65       N        Entries ciphertext (AES-256-GCM of JSON EncryptedEntry[])
```

```ts
interface EncryptedEntry {
  id: string;          // uuid
  wrappedDek: string;  // base64 — DEK wrapped by master key
  dekIv: string;       // base64
  ciphertext: string;  // base64 — JSON of { name, url, username, password, totp?, notes? }
  iv: string;          // base64
}
```

`useVault.loadEntries` decrypts the outer block, then each entry, and pushes
the decrypted index to the autofill adapter so the background SW can serve
queries while the popup is closed.

---

## Planned Vault Format — Multi-Key Slots

The current in-repo format hard-codes one master password per vault, but
nothing has shipped yet so we'll go straight to a LUKS-style **multi-key
slot** layout before first release. Same vault, unlockable by any of: a
master password, a printable recovery code, a hardware security key (FIDO2
`hmac-secret`), or future authenticator types — without re-encrypting the
entries each time a key is added or revoked.

### Concept

Introduce a random **Vault Encryption Key (VEK)** at vault creation. Each
entry's DEK is wrapped by the VEK (today it's wrapped by the master key).
Each "slot" wraps a copy of the VEK with a Key Encryption Key (KEK) derived
from one specific authenticator:

```
authenticator → KEK = kdf(authenticator-secret, slot-salt)
                ↓
       wrappedVEK = AES-GCM(KEK, VEK)
```

Add a slot → derive a new KEK, wrap the existing VEK with it, append.
Revoke a slot → drop it from the array. The VEK and all entry DEKs are
untouched. Entries never need re-encryption.

### Header layout (sketch)

```
0        4        Magic: "VLT1"
4        1        Version: 0x01
5        1        slotCount (uint8, max 16)
6        ...      slots[] — each slot is length-prefixed TLV:
                    1 byte  kind  (0x01 password | 0x02 webauthn | 0x03 recovery)
                    2 bytes len   (big-endian)
                    N bytes payload (see per-kind layout below)
?        12       Entries IV
?        N        Entries ciphertext (AES-256-GCM under VEK)
```

Per-kind slot payload:

```
password slot (kind=0x01):
  16 bytes  slotId (uuid)
  16 bytes  Argon2id salt
  32 bytes  verifier = HMAC-SHA256(KEK, magic ++ version ++ slotId)
  12 bytes  wrapIv
  48 bytes  wrappedVEK (32 byte VEK + 16 byte GCM tag)

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

### WebAuthn `hmac-secret`

The `hmac-secret` extension lets us request a stable HMAC output from a
FIDO2 authenticator (YubiKey 5, Solo, Passkey-capable platform
authenticators) without ever extracting key material. On registration we
store `credentialId` + a 32-byte random `salt`; on unlock we call
`navigator.credentials.get({ publicKey: { ..., extensions: { hmacGetSecret:
{ salt1: ourSalt } } } })` and pass the returned 32-byte secret through HKDF
to produce the KEK. Browser support: Chrome / Edge on desktop today; not all
authenticators implement `hmac-secret` (YubiKey 5+ and most Solo keys do).

### Session-resume implications

`chrome.storage.session` currently caches the b64 master key for offscreen
restart. With key slots it caches the **VEK** instead — same shape, same
lifecycle, but now agnostic to which authenticator the user originally used.

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
the background SW owns the master-key cache and autofill index, so the
new window picks up the unlocked session without re-prompting.

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
- Verifier-block password check.
- Background-owned session state with sliding auto-lock alarm
  (user-configurable, 15 min default).
- Master-key cache (`chrome.storage.session`) for seamless resume across
  offscreen / SW restarts.
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
  Change-master-password rotates salt + verifier, re-wraps every entry's
  DEK via `crypto.changePassword`, re-encrypts the outer blob under the
  new key, and refreshes the cached master key in background.
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

1. **Multi-key vault slots** (see "Planned Vault Format" above). Land this
   *before* first release so we never have to migrate. Unblocks recovery
   codes, hardware security keys via WebAuthn `hmac-secret`, and shared-vault
   scenarios. WASM gets `unwrap_vek_*` / `wrap_vek_*` primitives, and the
   existing `unlock` / `unlock_with_key` become "unlock the VEK via slot X".
2. **Idle / visibility-based auto-lock triggers** — supplement the alarm with
   `chrome.idle.onStateChanged` + popup `visibilitychange`.
3. **TOTP code generation** in `EntryDetail` (`otpauth` dep already
   installed, encrypted `totp` field already in the entry schema).
4. **Password strength indicator** in `CreatePassword` — `check-password-strength`
   dep is installed and used by `pwned.ts`, but not surfaced in the form.
5. **E2E tests** — Playwright + extension support.
6. **Reproducible WASM build in CI** — `rust-toolchain.toml` + Docker.
7. **Chrome Web Store submission**.

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
