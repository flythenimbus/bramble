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
| Hostname matching | `tldts` eTLD+1 collapsing — `www.ikea.com` and `ca.accounts.ikea.com` both match an entry stored as `ikea.com`. A login can carry multiple URLs (`urls: string[]`); a page matches if **any** of its hostnames satisfies the policy. |
| Password recovery | **None.** Loud onboarding warning. |
| Atomic writes | FSA `createWritable()` close-commit semantics. |
| Iframes / shadow DOM | Top frame, light DOM only in v1. |
| First-time setup | Full-tab options page (avoids popup focus-loss dismissal). |
| UI router | **TanStack Router** with memory history (popup re-mounts at `/` every open; a pop-out seeds the initial entry from the handoff). |
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
│           ├── entry-modes/           # Entry-type registry — the mode extension point
│           │   ├── types.ts           # EntryMode descriptor interface
│           │   ├── index.ts           # entryModes registry + modeList + getEntryMode
│           │   ├── login.tsx          # login mode: fields, detail, row, mappings
│           │   ├── card.tsx           # payment-card mode
│           │   ├── note.tsx           # secure-note mode
│           │   ├── ssh-key.tsx        # SSH-key mode (store/copy only)
│           │   ├── custom-fields.tsx  # shared custom-field editor/detail/helpers
│           │   └── DetailField.tsx    # shared copyable detail row
│           ├── routes/
│           │   ├── AuthRoute.tsx      # Auto-redirects to /vault when unlocked
│           │   ├── VaultHomeRoute.tsx
│           │   ├── CreateEntryRoute.tsx   # /vault/new/$type
│           │   ├── EntryDetailRoute.tsx
│           │   ├── EntryEditRoute.tsx
│           │   └── SettingsRoute.tsx
│           ├── screens/
│           │   ├── Auth/
│           │   ├── VaultHome/
│           │   ├── CreateEntry/       # EntryForm — generic create/edit host
│           │   ├── EntryDetail/       # generic detail host
│           │   ├── Settings/
│           │   └── VaultSetup/        # Used by options page
│           └── components/
│               ├── EntryRow.tsx       # type-agnostic vault-list row
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

The offscreen has since grown a second job (so the box above understates it): the
**WebRTC sync host**. `RTCPeerConnection` isn't available in a service worker, so
the offscreen (created with the `WEB_RTC` reason) runs the P2P sync transport
(enrollment and ongoing roster-sync) alongside the crypto. It still owns no
storage: it bridges reads/writes back to the background, and the SW now forwards
`SYNC_*` as well as `CRYPTO_*`. Both wire protocols are zod-validated at the
offscreen seam (`sync/messages.ts`, `crypto/messages.ts`). See docs/p2p-sync.md.

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
   - Any open UI reacts: `crypto.onExternalLock` (extension impl listens on
     `chrome.storage.session.onChanged` for the VEK key's removal) flips
     `useVault.isLocked`, and AppLayout's guard redirects to the unlock
     screen. So an open popup/detached window doesn't sit on stale unlocked
     content after a background lock.
7. **Explicit lock** (popup): same as alarm (also removes the VEK key, so the
   `onExternalLock` path fires too — harmlessly, since the popup already set
   `isLocked` itself).
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
  rotateVek(): Promise<string>;                    // full VEK rotation (reserved for an explicit vault rekey)
  lock(): Promise<void>;
  isLocked(): Promise<boolean>;
  onExternalLock(cb: () => void): () => void;       // background auto-lock → UI

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

// autofill.ts — logins (hostname-matched) + cards (offered on any payment form)
interface AutofillAdapter {
  setIndex(entries: IndexEntry[]): Promise<void>;
  clearIndex(): Promise<void>;
  query(hostname: string, opts: { hasLogin: boolean; hasCard: boolean }): Promise<QueryResult>;
  fetchFill(entryId: string): Promise<FillPayload>;
}
// IndexEntry   = LoginIndexEntry | CardIndexEntry  (discriminated on `type`)
//   LoginIndexEntry = { type:"login", id, hostnames: string[], name, username,
//                       password, customFields?, autofillEnabled?, autoSubmit?,
//                       subdomainMatch? }
//                     // `hostnames` is derived from `LoginEntryData.urls` at
//                     // index-build time; one login can cover many sites.
//                     // hostnameMatches returns true on the first hit under
//                     // the entry's `subdomainMatch` policy.
//   CardIndexEntry  = { type:"card", id, name, brand?, cardholderName,
//                       number, expMonth, expYear, cvv, customFields? }
// CustomFieldData = { key, value }   // key drives derived page-field matching
// MatchSummary = { id, name, secondary, autofillEnabled?, autoSubmit? }
// QueryResult  = { logins: MatchSummary[], cards: MatchSummary[],
//                  locked, hasPotentialMatch }
// FillPayload  = { kind:"login", username, password, customFields?, autoSubmit? }
//              | { kind:"card", cardholderName, number, expMonth, expYear, cvv, customFields? }
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
  popOut(handoff?: PopOutHandoff): Promise<void>;  // detach, carrying route + draft
  consumeHandoff(): Promise<PopOutHandoff | null>; // one-shot read on detached boot
  isDetached(): boolean;         // true when running in the popped-out window
  scanQrFromActiveTab(): Promise<string | null>;   // capture active tab, decode a QR
}

interface PopOutHandoff { path: string; draft?: unknown }

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
rotate_vek() -> Result<String, JsError>                  // full VEK rotation (reserved for an explicit vault rekey)
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

Built via `pnpm run wasm:build` → `wasm-pack build --target web --out-dir
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

The encoder emits password, webauthn, and recovery slots. Unknown slot kinds
(future authenticator types) are preserved verbatim across a decode → encode
round-trip so older builds don't drop slot data added by newer builds.

```ts
interface EncryptedEntry {
  id: string;          // uuid
  wrappedDek: string;  // base64 — DEK wrapped by VEK
  dekIv: string;       // base64
  ciphertext: string;  // base64 — JSON of a typed EntryData (see "Entry Types" below)
  iv: string;          // base64
}
```

Each entry's plaintext is a typed `EntryData` discriminated on `type`
(`login` | `card` | `note`). Entries persisted before the typed schema have no
`type` field and are normalised to `login` on decrypt, so old vaults read back
unchanged. Only `login` entries feed the autofill index and breach checks.

`useVault.loadEntries` decrypts the outer block, then each entry, and pushes
the decrypted index to the autofill adapter so the background SW can serve
queries while the popup is closed.

---

## Multi-Key Slots

LUKS-style multi-key slot layout. Same vault, unlockable by any of: a master
password, a hardware security key (FIDO2 `hmac-secret` via the WebAuthn PRF
extension), a printable recovery code, or future authenticator types — without
re-encrypting the entries each time a key is added or revoked.

Status: **password, WebAuthn, and recovery slots are all shipped** (format
v0x02) — register / unlock / revoke / reset wired end to end through the
offscreen crypto boundary and the Settings + Auth UI.

**Invariant B:** a vault must always keep at least one *primary* unlock method,
where primary = master password OR security key. A recovery code can unlock but
is a backup only — it never satisfies the always-one-primary guard. This lets a
user disable the master password entirely (security-key-only) or remove all
keys (password-only), but never strands them with just a recovery code. Enforced
in `core/vault/slot-policy.ts`.

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

**Changing a password is a re-wrap, not a VEK rotation**: we re-derive the KEK
from the new password and rewrap the *same* VEK under the password slot, leaving
every other slot (recovery, security keys) intact. The VEK is deliberately
stable because it's shared across slots — rotating it would invalidate the
recovery slot (the code is offline and can't be re-wrapped) and every WebAuthn
slot (each would need a tap). The tradeoff is no VEK forward-secrecy on password
change, but a leaked *password* is fully addressed: its KEK and verifier are
replaced. (A true "rekey the vault" operation — new VEK, re-encrypt everything,
reissue the recovery code, re-tap keys — could be added later as an explicit
action; it is not the everyday password-change path.)

### Header layout

See "Vault Blob Format" above for the live layout. The encoder enforces a
non-empty slot list and a hard cap of 16 slots.

### Slot payloads (password, webauthn, recovery — all shipped)

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

### WebAuthn PRF / `hmac-secret` (shipped)

The authenticator's `hmac-secret` gives a stable HMAC output from a FIDO2 key
(YubiKey 5, Solo, passkey-capable platform authenticators) without ever
extracting key material. We reach it through the **WebAuthn `prf` extension**,
not the raw `hmacCreateSecret` / `hmacGetSecret` inputs: Chromium forwards
`hmacCreateSecret` on `create()` but **silently drops `hmacGetSecret` on
`get()`** (returns an empty extension result), so the raw path never yields
unlock material. Both register and unlock therefore go through `prf`.

On registration (`navigator.credentials.create` with `extensions: { prf: { eval:
{ first: salt } } }`) we store `credentialId` + a 32-byte random `salt` and try
to read a create-time PRF result; most security keys can't evaluate PRF at
makeCredential (that needs CTAP 2.2 `hmac-secret-mc`), so registration falls
back to a second `get()` — i.e. two taps to register, one to unlock. On unlock
we call `get()` with `extensions: { prf: { eval: { first: ourSalt } } }` and
pass the returned 32-byte secret through HKDF to produce the KEK
(`derive_kek_hkdf` in WASM). Browser support: Chrome / Edge / Brave on desktop
today; not all authenticators implement `hmac-secret` (YubiKey 5+ and most Solo
keys do).

This is about *unlocking the vault* with a hardware key — distinct from the
vault *storing and serving* passkeys for websites (see the "Passkeys" section).

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
5. Last resort: the same heuristic against the field's associated `<label>`
   text (`<label for=id>`, a wrapping `<label>`, or `aria-labelledby`) — for
   forms whose only human-readable hint lives in the label.

This makes the email-only step of two-step logins (e.g. ikea.com) work — the
script doesn't require a password field to be present.

### Cards & custom fields

The content script also detects **payment fields** (`cc-number`, `cc-name`,
`cc-exp` / `cc-exp-month` + `cc-exp-year`, `cc-csc`) via their HTML
`autocomplete` tokens, then attribute-hint, then associated-`<label>`-text
fallbacks (the same ladder used everywhere — attributes first, label text last).
Cards aren't hostname-
scoped, so focusing a payment field opens a picker of *all* cards (they never
auto-fill — always an explicit pick); selecting one fills the card fields
(expiry formatted to the target field's width; CVV handled even when
`type=password`).

**Custom-field autofill** works for both logins and cards. Each custom field's
name is turned into matcher variants (`"Postal code"` → `postal-code` /
`postalcode`); the script fills the first *empty* page input whose `autocomplete`
token or normalized `name`/`id`/`aria-label`/`placeholder` — then, as a last
rung, associated `<label>` text — matches. Matching is
deliberately conservative: exact normalized match at any length, substring match
only for keys ≥ 5 chars, text-like inputs only (never password/email), and never
overwriting a non-empty or already-filled field. The query tells the background
which field kinds the page has (`hasLogin` / `hasCard`) so only relevant matches
come back.

Custom fields are **strictly lowest priority**: `fillCustomFields` excludes the
inputs the built-in login/card detectors own (the detected username/password and
all card fields), so a custom field named "username" / "email" / "cvv" / "card
number" can't hijack a primary slot — even when that primary value is empty.
Built-ins also fill first, then custom fields take whatever's left.

### One-time codes (TOTP)

`otpInputs()` finds the page's one-time-code entry: an `autocomplete~="one-time-code"`
input first (multiple such inputs are treated as a segmented widget), else an
OTP-hinted input (`one-time` / `otp` / `2fa` / `authenticator` / `verification
code` …, minus card/address/coupon negatives), with a single-character match
expanded into its run of sibling one-char boxes. `candidateKind` evaluates OTP
**last** (after card and login) so it only claims fields nothing else owns, and
CVV stays a card field. The query carries `hasOtp`; the background returns
`otps` (hostname-matched logins that have a key). A focused OTP field auto-fills
on a single match (or shows a picker), and the selection rides an `otpOnly` flag
so the fill — `fillOtp`, single field or char-per-box — touches only the code
field. The background computes the live code in `fetchFill`; the seed never
reaches the page.

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

## Corner Prompt (capture, save & use)

One in-page corner card is the surface for every "want to save this?" *and* "want
to use this?" moment — new login, changed password, passkey registration, and
passkey sign-in — so the experience is identical across them. It's pinned to the
**top-right of the viewport** (top frame only), sharing the autofill dropdown's
visual language (dark blurred popover, an injected `#titanpass-prompt` root with
inline styles) but **corner-anchored rather than field-anchored**, and it
dismisses on an explicit close or a timeout.

### Variants

One component, a `kind`-discriminated payload:

- **`save-login`** — a username+password was submitted that we don't have for
  this hostname. Editable username + masked password, primary **Save**,
  secondary **Not now**, overflow **Never for this site**.
- **`update-login`** — the submitted password differs from the stored entry's.
  Names the account whose password changed; primary **Update**, secondary
  **Not now**. When several entries match the hostname, the user picks which.
- **`save-passkey`** — the site is registering a passkey. If a login for this
  rpId exists, the default is **Add to ‹username›** with an alternative **Save as
  a new login**; if none exists, just **Save as a new login** with an editable
  username (prefilled from the WebAuthn `user.name` / `user.displayName`).
  Primary **Create**, secondary **Cancel**.
- **`use-passkey`** — the site asked to authenticate (`get()`) and we hold a
  matching passkey. Names the account (or lists them if several), primary **Use
  passkey**, secondary **Cancel**. Mechanics — conditional vs. modal triggers,
  matching, consent, signing — live in "Passkeys → Use".

### Capture & lifecycle

- **Logins** are captured by the content script: password fields are snapshotted
  on input; on form `submit` (and the Enter / synthetic-submit paths the
  autofiller already recognises) the candidate `{ username, password }` goes to
  the background. Submit usually navigates and destroys the page, so the
  background **stashes the pending capture** (in-memory / `chrome.storage.session`
  — never `local`, it holds a plaintext password) keyed by eTLD+1, and the
  content script shows the prompt on the next load for that site (or immediately
  for SPA logins with no navigation).
- **Passkeys** are captured at registration: the proxy's `onCreateRequest` (see
  "Passkeys") parks the request, the background tells the active tab's content
  script to show the `save-passkey` prompt, and the user's attach-vs-new choice
  flows back *before* we mint the credential and `completeCreateRequest`. The
  request waits on the user; `onRequestCanceled` tears the prompt down.

### Who writes the vault

The prompt only collects intent; the commit runs background → offscreen (crypto)
→ storage, reusing the same encrypt-and-write path as popup CRUD so there's a
single source of truth (and the in-memory autofill index is refreshed after).

**Write path — queue and flush.** The File System Access backend refuses
gesture-less writes from a non-popup context, so:

- `chrome.storage.local` vaults — write straight through from the background;
  the corner-prompt commit lands immediately.
- FSA-backed vaults — encrypt in the offscreen doc and **stash the new
  encrypted blob in `chrome.storage.session`** keyed against the vault. The
  in-memory entries (and autofill index) update right away so the rest of the
  unlocked session sees the new entry; the on-disk file flushes on the **next
  popup or options open** (any extension-context surface with a fresh user
  gesture, which can call the FSA write). A small "**1 change pending sync**"
  indicator in the popup header surfaces the lag honestly. On lock or browser
  close before flush the session-stashed blob persists in
  `chrome.storage.session` and flushes on the next unlock-with-popup-open.

### De-dupe & anti-nag (assumptions)

- Never prompt when the exact credential is already stored (no diff).
- A per-site **"Never for this site"** suppression list in `chrome.storage.local`.
- One prompt per captured credential per session; gated on a global Settings
  toggle **"Offer to save logins & passkeys"** (default on).
- A locked vault still captures and prompts, but the primary action first walks
  the user through unlock before committing.

---

## UI Routing

`app/router.tsx` defines a TanStack memory-history router with two top-level
trees:

```
/                            → AuthRoute     (unlock form)
_app (layout)
  /vault                     → VaultHomeRoute
  /vault/new/$type           → CreateEntryRoute  ($type ∈ login|card|note)
  /vault/$entryId            → EntryDetailRoute
  /vault/$entryId/edit       → EntryEditRoute
  /settings                  → SettingsRoute
```

Both `CreateEntryRoute` and `EntryEditRoute` render the generic `EntryForm`
host (create reads `$type` from the path; edit takes it from the entry). One
form serves both create and edit for every mode. `EntryRow` rows are clickable
(navigate to detail) and carry a three-dots menu with inline Edit / Delete
(delete swaps to a confirm step before destroying), plus a copy menu whose
actions are mode-specific.

### Entry types (modes)

Entries are typed (`login` | `card` | `note` | `ssh-key`), and each type is
described by a self-contained **mode descriptor** in `app/entry-modes/`. A
descriptor bundles
everything type-specific: add-menu metadata (label / description / icon), the
form-body component, the detail-body component, the form↔entry mappings
(`emptyForm` / `toForm` / `toEntry`), the vault-list row projection (`row`),
search text, and optional detail subtitle / warning banner. The registry
(`entryModes` / `modeList` / `getEntryMode`) is the single place every generic
consumer reads from — `EntryForm`, `EntryDetail`, `VaultHome`/`EntryRow`,
`AddDropdown`, and routing are all type-agnostic.

`EntryForm` owns the cross-cutting form concerns once (react-hook-form context
via `FormProvider`, card chrome, submit/footer, pop-out draft registration);
the descriptor's `Fields` component supplies only the inputs. `EntryDetail`
likewise owns the chrome (banner, header, delete/edit footer, clipboard) and
delegates the field rows to the descriptor's `Detail`.

**Custom fields** are shared by every type, not owned by any one mode. They live
in `BaseEntryData.customFields` (`{ key, value, hidden? }`) and are managed
entirely by the host: `EntryForm` injects the editor + persists them,
`EntryDetail` renders them after the mode body, and the vault list folds them
into copy actions + search text (`entry-modes/custom-fields.tsx`). A new mode
gets custom fields for free.

**Adding a mode** is three steps: extend the `EntryType` union
(`hooks/useVault`), write a descriptor file like `login`/`card`/`note`, and add
it to the registry. No host, route, list, or plumbing changes are needed.
Only `login` carries autofill overrides, the password generator/strength meter,
and breach checks; the login form's URL field is an editable list (`urls:
string[]`) so a single credential can be registered against many sites at
once. Cards autofill on payment forms; notes and SSH keys never
reach the autofill index. SSH keys (`ssh-key.tsx`) are store/copy only — a
browser extension can't act as an ssh-agent — and use a masked multi-line
`SecretArea` primitive for the private key; key type is derived from the public
key on save.

**Route guards run in the router, not in component bodies.** The root is a
`createRootRouteWithContext<{ vault }>()` whose `vault` slice (`isLocked`,
`ready`, `entries`) is injected from React via `<RouterProvider context>` in
`App.tsx` (`InnerApp`, inside `VaultProvider`). Because changing that prop only
affects *future* navigations, `InnerApp` also calls `router.invalidate()`
whenever the slice changes, which re-runs the active routes' `beforeLoad` guards
against the new state. Each guard `throw redirect(...)`:

- `authRoute` (`/`): unlocked → `/vault`. This runs inside the navigation
  pipeline, so it cleanly replaces the old unlock-callback `useEffect` whose
  eager navigate raced `VaultHomeRoute` mounting on stale `isLocked: true`.
- `_app` layout: `ready && isLocked` → `/`. Covers every authed route at once —
  a lock from anywhere (header button, Settings, background auto-lock) flips
  `isLocked`, the invalidate re-runs this, and we bounce to the unlock screen.
- `entryDetail` / `entryEdit`: `ready && !entries.find(id)` → `/vault` (stale or
  deleted id).

The `ready` gate on `_app`/entry guards keeps a popped-out window restoring a
deep route from bouncing during pre-hydration (where `isLocked` still holds its
default `true`). `authRoute` is **deliberately not** `ready`-gated: it keys off
`!isLocked` while `_app` keys off `ready && isLocked`, and that asymmetry stops
the two guards from looping in the brief `(isLocked=false, ready=false)` window
where hydration flips `isLocked` before `ready`. Parent-before-child guard
ordering means an auto-lock that also empties `entries` lands on `/` (the `_app`
guard) rather than `/vault` (an entry guard). Guards are covered headlessly in
`app/router.guards.test.ts`. The header's "Back" button is contextual: it calls
`router.history.back()` to return wherever the user actually came from (so
opening Edit from the vault list goes back to the list, not the detail view).
Routes still declare `staticData.back` (`{ to, paramKeys? }`), but it's only the
*fallback* target used when `router.history.canGoBack()` is false — a popped-out
window that booted straight onto a deep route has a single memory-history entry.
The button shows only on routes that declare a back target (the vault home has
none).

`OptionsApp.tsx` is a separate React tree mounted by the options page; it
renders the `VaultSetup` flow directly without the router because file
pickers misbehave inside the popup.

### Detached window (pop-out)

The popup auto-dismisses on focus loss, which is hostile to multi-step
flows (filling a long form, copying values into another tab). A header
button calls `shell.popOut(handoff)`, which uses `chrome.windows.create` to
open `popup.html?detached=1` as a standalone type=`popup` window — 500×600,
anchored to the top-right of the currently-focused browser window with an
80px y-offset to clear the title + tab bars. The unlocked session is
preserved because the background SW owns the VEK cache and autofill index,
so the new window picks up the session without re-prompting.

**Route + draft handoff.** Because the router uses *memory* history, the new
window would otherwise restart at `/`. To resume where the user left off,
the originating popup hands over `{ path, draft }`:

- `popOut()` snapshots the current router href and (if a form route is
  mounted) its live `react-hook-form` values via a getter the route
  registered through `PopOutProvider`. The handoff rides in the
  `POPOUT_OPEN` message; the background stashes it in
  `chrome.storage.session` (in-memory — a draft can hold a plaintext
  password, so it must never touch the URL or `chrome.storage.local`)
  *before* creating the window, then the originating popup closes.
- The detached `popup.tsx` boot is async: it calls `consumeHandoff()`
  (a read-and-delete one-shot, so a window reload starts clean) and passes
  `initialPath` / `initialDraft` into `<App>`. `App` builds the router once
  via `createAppRouter(initialPath)`, and the matching form route — which
  mounts first because the history is seeded with that path — claims the
  draft once via `takeInitialDraft()` and seeds the form with it.
- `useVault.ready` flips true only after mount-time hydration finishes.
  The `beforeLoad` guards that redirect on a missing entry (`entryDetail`,
  `entryEdit`) gate on it so a detached window booting straight onto
  `/vault/$id[/edit]` doesn't bounce to `/vault` before `entries` has loaded
  (and so the popped-out form's restored draft isn't discarded by an early
  redirect). The handoff is also dropped on lock, alongside the VEK.

The content script's "vault locked" hint pops out with no handoff, so it
lands on `/` (the unlock screen), unchanged.

`shell.isDetached()` reads the `?detached=1` URL flag and is used to hide
the pop-out button when already running detached. `popup.tsx` also
switches the html/body from the fixed 500×400 popup dimensions to `100%`
when detached, so the React app fills the chrome window instead of
leaving dead space.

---

## Passkeys (Vault as a WebAuthn credential provider) — planned

Goal: let the vault create, store, and use **passkeys** (WebAuthn discoverable
credentials) on the user's behalf, synced through the same encrypted vault blob
as every other entry. This is the inverse of the hmac-secret unlock plan above:
there a hardware key unlocks the vault; here the vault *is* the authenticator a
website talks to. (Don't conflate the two — see "WebAuthn `hmac-secret`".)

### Mechanism — `chrome.webAuthenticationProxy`

Chrome's `webAuthenticationProxy` API (permission `webAuthenticationProxy`) is
the only way an MV3 extension can answer `navigator.credentials.create()` /
`.get()`. After `attach()`, the background SW receives:

- `onCreateRequest` — registration. Carries a JSON-serialized
  `PublicKeyCredentialCreationOptions` (all ArrayBuffers base64url). We mint a
  credential and reply via `completeCreateRequest({ requestId, responseJson })`.
- `onGetRequest` — authentication. We find a matching stored credential, sign,
  and reply via `completeGetRequest(...)`.
- `onRequestCanceled` — tear down any in-flight unlock prompt.
- `onIsUvpaaRequest` — "is a user-verifying platform authenticator available":
  yes whenever passkey support is enabled.

**Interception is all-or-nothing.** While attached, the extension handles
*every* WebAuthn call in the browser — including ones meant for the user's
platform authenticator or security key. So the policy is:

- Attach only when the user has opted in **and** the vault is unlocked; detach
  on lock and on opt-out, so native authenticators work normally otherwise.
- For an RP / credential we don't manage, complete with a `NotAllowedError` so
  the site falls back cleanly (and investigate forwarding to the native stack
  where the API allows it).

### What we store — passkeys live on the login entry (no new mode, no blob bump)

**Final assumption: a passkey is not a standalone entry — it's attached to a
login.** This mirrors how the user thinks about it ("attach to my GitHub
account") and how every other manager models it, and it makes the capture UX
(below) a simple attach-or-create choice. So `LoginEntryData` gains an optional
`passkeys` array, exactly alongside `totp` / `customFields`:

```
interface PasskeyCredential {
  rpId: string;            // "github.com" — the relying party
  rpName?: string;
  userHandle: string;      // base64url user.id from the RP
  userName: string;        // account label shown in the chooser
  userDisplayName?: string;
  credentialId: string;    // base64url; random 16–32 bytes we generate
  alg: -7 | -8 | -257;     // COSE alg: ES256 (default) / EdDSA / RS256
  publicKeyCose: string;   // base64url COSE_Key (reference / debug)
  privateKey: string;      // the SECRET — PKCS8 / JWK
  createdAt: number;
  // signCount stays 0 for synced credentials (no clone-detection false alarms).
}

interface LoginEntryData extends BaseEntryData {
  // …urls, username, password, totp, overrides…
  passkeys?: PasskeyCredential[];
}
```

A login can therefore be **passkey-only** (no password — the "create new" path
makes a fresh login shell holding just the passkey). The whole login entry is
already encrypted under its per-entry DEK-under-VEK envelope, so the private key
inherits that protection; nothing else changes. **No vault-format version bump,
no new entry mode** — passkeys render inside the login form/detail like `totp`,
and the vault list shows a passkey badge on logins that have one. `onGetRequest`
lookups scan every login's `passkeys` by `rpId` (+ `credentialId` when the RP
sends `allowCredentials`).

### Crypto flow

- **Key generation**: WebCrypto `crypto.subtle.generateKey` (ECDSA P-256 for
  ES256 by default). Export the private key, encrypt through the vault's AES-GCM
  envelope, store. Public key encoded as a COSE_Key.
- **Registration (create)**: `authenticatorData` = `SHA-256(rpId)` ++ flags
  (`UP|UV|AT|BE|BS` — BE/BS set because the credential is backed up in the synced
  vault) ++ `signCount=0` ++ attestedCredentialData (`AAGUID` ++ credId ++ COSE
  pubkey). Wrap as an `attestationObject` with **`fmt:"none"`** (no attestation
  key material to manage). Build `clientDataJSON` (`{type:"webauthn.create",
  challenge, origin, crossOrigin:false}`) and return the serialized
  `PublicKeyCredential`.
- **Authentication (get)**: select by `rpId` + `allowCredentials` (or
  discoverable when empty). `authenticatorData` = `SHA-256(rpId)` ++ flags ++
  `signCount=0`; `signature = sign(privKey, authenticatorData ++
  SHA-256(clientDataJSON))`. Return `{clientDataJSON, authenticatorData,
  signature, userHandle}`.
- **User verification**: an unlocked vault *is* UV. A request demanding UV while
  locked triggers an unlock prompt before we complete it.
- CBOR (attestationObject + COSE key) is small enough to encode in TS; ECDSA
  signing uses WebCrypto. Signing only moves into WASM if profiling demands it.

### Use — the sign-in prompt

Passkey use is **RP-initiated**: the site must call `navigator.credentials.get()`
(we can't authenticate unilaterally — the assertion needs the RP's challenge). So
"you land on foo.com and we offer your passkey" really means *the foo.com login
page fired a `get()` and we hold a match*. The proxy's `onGetRequest` is the only
trigger; we surface the **same top-right corner card** as the save prompt — the
`use-passkey` variant (see "Corner Prompt").

- **The card is always a response to the site asking — never a navigation
  nudge.** It appears when `onGetRequest` fires, in two cases:
  - *Modal* (the canonical case) — the user clicks the site's "Sign in with a
    passkey" button, the site calls `get()`, and our card comes out ("Sign in to
    foo.com as ‹username›?").
  - *Conditional* (`mediation:"conditional"`) — the site arms passkey autofill on
    load; with a match we surface the same card. Still the site asking (it made
    the `get()` call), just on page load rather than on a button click.
- **Matching** (background): scan every login's `passkeys[]` for `rpId`, filtered
  by `allowCredentials` when the RP sends one (else discoverable = every passkey
  for that rpId). 0 matches → complete with `NotAllowedError` so the site falls
  back; 1 → the card names that account; >1 → the card lists them and the user
  picks.
- **Consent = the card tap; unlocked vault = UV.** Tapping **Use passkey** is the
  user-presence/consent gesture; if the vault is locked the card unlocks first.
  We then decrypt the private key, sign per "Crypto flow", and
  `completeGetRequest`. `onRequestCanceled` (navigation, or the site abandoning a
  conditional request) tears the card down.
- **Anti-nag:** a conditional prompt respects a per-site dismiss + the global
  passkey toggle, so it doesn't reappear on every load once waved off; a modal get
  always shows (the user explicitly asked to sign in).
- The password autofill dropdown (field-anchored) and this passkey card
  (corner-anchored) coexist on the same login page without fighting.

### UX

- Settings toggle **"Use Vault for passkeys"** → `attach()` / `detach()`.
- **Registration is the capture prompt.** When a site calls
  `navigator.credentials.create()`, the proxy parks the request and we surface
  the top-right **`save-passkey`** prompt (see "Corner Prompt") offering *attach to the matching login* or *save as a new login*.
  Only after the user chooses do we mint the credential and complete the request.
- **Use is the sign-in prompt** (see "Use" above) — a `use-passkey` corner card
  driven by `onGetRequest`, proactively on a conditional get and on demand for a
  modal one.
- Passkeys are viewed/managed **inside their login entry** (a passkeys section in
  the detail, a badge in the list); deleting one edits the login. They are
  **not** content-script-autofilled — the browser drives use through the proxy.

### Open questions / risks

- Coexistence with native authenticators given all-or-nothing interception
  (mitigated by attach-only-while-unlocked, but needs real-world testing).
- Whether conditional-mediation requests actually arrive via the proxy on the
  target Chrome version.
- Chrome Web Store review of the `webAuthenticationProxy` permission — powerful,
  expect scrutiny and a justification.
- Attestation: shipping `none` sidesteps key management, but some enterprise RPs
  demand real attestation — out of scope for the first cut.

---

## HTTP Basic Auth autofill — planned (later)

Goal: fill the browser's native **HTTP Basic / Digest auth dialog** (the
`WWW-Authenticate` 401 popup) from a stored login. Lower priority than passkeys —
basic auth is increasingly rare on the public web (mostly internal tools, NAS
boxes, staging gates), so this is a down-the-road convenience, not a release item.

### Why this is a separate path

The 401 dialog is **native browser chrome, not DOM** — the content-script autofill
pipeline (field detection, dropdown, corner prompt) can't see or touch it. The
only hook is the network layer: `chrome.webRequest.onAuthRequired`. It is the one
`webRequest` event that still supports *blocking* in MV3 (the rest gave way to
`declarativeNetRequest`); `webRequestAuthProvider` is the permission that unlocks
it. So this lives entirely in the **background SW**, alongside the
`webAuthenticationProxy` handlers — a third browser-driven entry point next to
content-script autofill and the passkey proxy.

### Mechanism

- Manifest gains `"webRequest"` + `"webRequestAuthProvider"` permissions.
- Register `onAuthRequired` with `["asyncBlocking"]` (async, because we decrypt a
  credential out of the vault before answering):

  ```
  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      // details.challenger {host, port}, details.realm, details.scheme, details.isProxy
      matchBasicAuth(details).then(cred =>
        callback(cred ? { authCredentials: { username: cred.user, password: cred.pass } }
                      : {}));   // {} → let the browser show its own dialog
    },
    { urls: ["<all_urls>"] },
    ["asyncBlocking"]);
  ```

### Matching is coarser than form autofill

`onAuthRequired` gives **host + port + realm + scheme + isProxy — no path**. So
matching keys off origin (host[:port]) and optionally `realm`, not the
URL-pattern matching the content script uses. A login matches if one of its `urls`
shares the challenger host. `details.isProxy` lets the same handler answer proxy
407s if we choose to.

### Locked-vault + multi-match are the hard parts (not the API)

The handler fires *before* any UI moment, with no user gesture:

- **Vault locked** → we can't silently decrypt, and there's no natural prompt
  surface here. First cut: bail with `callback({})` so the native dialog shows
  (i.e. autofill is best-effort, unlocked-vault only). A later pass could park the
  request and raise an unlock prompt, mirroring the passkey `onGetRequest` flow.
- **>1 match for the host** → no good chooser at this layer; pick the single match
  or fall through to native. (Reusing the corner card is possible but is the
  expensive part — defer.)
- **Bad-credential loop:** Chrome re-fires `onAuthRequired` for the *same request*
  if the credentials we supplied were rejected. Track attempts per `requestId` and
  fall back to `callback({})` after one try, or it spins.

### Scope notes

- **Capture** (offering to save basic-auth creds the user typed into the native
  dialog) is *not* covered — the dialog is opaque to us; the save path stays
  manual entry for now.
- Firefox exposes the same `onAuthRequired`; Safari has no equivalent — consistent
  with "Firefox/Safari out of scope for v1".

---

## Status

### Working

- Full CRUD loop: vault create + unlock, entry list (`VaultHome`), entry
  create (`EntryForm` via `/vault/new/$type`), entry detail with
  copy-to-clipboard (`EntryDetail`), edit (reuses `EntryForm` with the stored
  entry), and delete with confirm step. Row-level edit / delete + copy menu
  via the three-dots menu on every `EntryRow`.
- **Typed entries (modes)** — logins, payment cards, secure notes, and SSH keys,
  each a self-contained descriptor in `app/entry-modes/` consumed by a generic
  form host, detail host, list, and add-menu. Adding a new kind is one descriptor
  file + one registry line; see "Entry types (modes)" above. The data model
  is a discriminated union on `type`; pre-typed vaults normalise to `login`.
  SSH keys are store/copy only (no ssh-agent in an extension) and use a masked
  multi-line `SecretArea` for the private key. SSH-key entries also surface
  the OpenSSH **SHA-256 fingerprint** (`SHA256:<base64-no-padding>`, matching
  `ssh-keygen -lf`) derived from the stored public key via WebCrypto, so the
  user can eyeball-match against the fingerprint a remote (GitHub, a server's
  `authorized_keys` listing) displays.
  Every type also supports shared, persisted **custom fields** (visible or
  hidden), surfaced in the form, detail view, copy menu, search, and autofill
  (matched to page fields by name-derived tokens — see the autofill section).
- Pop-out to detached window via `shell.popOut(handoff)` — button in both
  `AppLayout` header (unlocked) and `Auth` screen (locked). Detached
  window persists the unlocked session because session state lives in the
  background SW, not the popup, **and resumes on the same route with any
  half-filled form intact** by handing `{ path, draft }` over through
  `chrome.storage.session` (see "Detached window" above).
- File System Access storage with `chrome.storage.local` fallback.
- WASM crypto with Argon2id + AES-256-GCM + envelope encryption.
- **Multi-key vault slot format** (VLT1 v0x02) — random VEK at vault
  creation, password slot wraps the VEK with `KEK = Argon2id(password, salt)`,
  per-slot verifier = `HMAC-SHA256(KEK, magic ++ version ++ slotId)` for
  constant-time wrong-password rejection. Password (0x01), webauthn (0x02), and
  recovery (0x03) slots are all wired (see below). Slot-mutation policy
  (`core/vault/slot-policy.ts`) enforces **invariant B** — a vault always keeps
  ≥1 primary unlock (password or security key); a recovery code never counts
  as primary.
- **Hardware-key unlock (WebAuthn PRF, slot kind 0x02)** — register a FIDO2
  authenticator (YubiKey, Touch ID, Windows Hello) and unlock the vault with it
  instead of (or alongside) the master password. Both `registerSecurityKey` and
  `unlockWithSecurityKey` use the `prf` extension (Chromium drops the raw
  `hmacGetSecret` on `get()` — see "WebAuthn PRF" above). Registration evals the
  PRF salt at `create()` and falls back to a second `get()` when the key can't
  (most can't → two taps to register, one to unlock); the KEK is HKDF over the
  returned 32-byte secret (`derive_kek_hkdf` in WASM). Add / list / revoke in
  Settings, security-key + recovery-code affordances on the Auth screen, and
  `wrap_vek_webauthn` / `unwrap_vek_webauthn` / `verify_webauthn_slot` across
  the offscreen crypto boundary. Slots coexist, so a vault can be opened by
  password or security key in any combination — including **password-less**
  (master password disabled, security key only).
- **Re-wrap password change + set / disable** — changing the master password
  re-derives the KEK and rewraps the *same* VEK under the password slot
  (`writeMasterPasswordSlot`), leaving recovery and webauthn slots intact; it
  verifies the written slot and rolls the file back if that fails.
  `setMasterPassword` re-enables a password on a key-only vault the same way;
  `disableMasterPassword` drops the password slot (refused by invariant B
  unless a security key remains). The VEK is intentionally stable rather than
  rotated — see "Changing a password is a re-wrap" above for the tradeoff.
- **Recovery codes (slot kind 0x03)** — every vault gets a 150-bit Crockford
  base32 recovery code at creation (`createVault` returns it; shown once via
  `RecoveryCodeDisplay`, never persisted in plaintext). It's a high-entropy
  passphrase that reuses the password KDF (`wrap_vek_password` /
  `unwrap_vek_password`) stored under the recovery kind — no Rust changes.
  `generateRecoveryCode` resets it (gated behind a master-password confirm, or
  a security-key tap on a password-less vault); `unlockWithRecoveryCode` opens
  the vault from the Auth screen. One recovery slot per vault; reset replaces it.
- Background-owned session state with sliding auto-lock alarm
  (user-configurable, 15 min default). An open popup / detached window
  reflects a background lock in real time via `crypto.onExternalLock`
  (a `chrome.storage.session` VEK-removal listener), so it never lingers on
  stale unlocked content.
- **OS-screen-lock auto-lock** — `chrome.idle.onStateChanged` routes the
  `locked` state through the same `clearSession()` + offscreen `CRYPTO_LOCK`
  path the alarm uses, closing the window where the user has walked away
  but the vault is still autofillable. The `idle` state is deliberately
  ignored (too aggressive for reading / calls / conferences — the sliding
  alarm covers genuine afk), and popup `visibilitychange` is deliberately
  not wired (the action popup auto-closes on blur, so it would fire on any
  outside click).
- VEK cache (`chrome.storage.session`) for seamless resume across offscreen /
  SW restarts.
- Autofill on top-frame login pages: username-only, password-only, and
  combined forms. eTLD+1 subdomain matching via `tldts` (overridable
  per entry to `exact` / `subdomain` strict modes). **A login can be
  registered against multiple sites** (`urls: string[]`); a page matches
  if any of the entry's hostnames satisfies the policy. SSO accounts
  reused across products, sibling brand domains, and http/https
  variants all collapse onto one entry instead of duplicates.
- **Card autofill** — payment fields (`cc-number` / `cc-name` / `cc-exp[-month
  /-year]` / `cc-csc`) are detected by autocomplete token + attribute hints;
  focusing one opens a picker of all cards (explicit pick only, never
  auto-filled). The card index ships in the same session-stored autofill index
  as logins.
- **Custom-field autofill** — a custom field's name is expanded into matcher
  variants (`postal-code` / `postalcode`) and filled into the first empty page
  input whose autocomplete token or attribute hint matches. Works after both
  login and card fills. Conservative matching (exact, or substring for keys ≥ 5
  chars; text-like empty inputs only) keeps it from clobbering unrelated fields.
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
- **Settings screen** — split into a **General** section (auto-lock timeout
  5 / 15 / 30 / 60 min / never, clipboard-clear TTL, breach-check toggle,
  offer-to-save toggle, muted-site list) and a **Security** section (master
  password change / set, a require-master-password toggle that disables it
  behind a confirm modal, security keys add / list / revoke, and recovery-code
  reset behind an auth gate → modal showing the new code). The standalone
  "Lock now" row was removed (lock still lives in the AppLayout header). Prefs
  persisted via `storage.setMeta` in `chrome.storage.local`; background reads
  them on demand and reschedules the auto-lock alarm when the timeout changes.
  Master-password change is a re-wrap — see "Re-wrap password change" above.
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
  Surfaced in a collapsible "Advanced" section on the login form.
  Background's `hostnameMatches` honours `subdomainMatch`. Content
  script honours `autofillEnabled === false` (still shows in dropdown
  for manual pick, no silent fill) and `autoSubmit === true` (calls
  `form.requestSubmit()` 50 ms after fill, with a synth-Enter fallback
  for forms without a submit button). All overrides ride inside the
  encrypted entry JSON and the in-memory autofill index, so old vaults
  without these fields keep working unchanged.
- **TOTP (two-factor) codes** — logins carry an encrypted `totp` authenticator
  key (an `otpauth://` URI or a bare base32 setup key). The login detail shows a
  live 6-digit code with a draining countdown ring, regenerated every second and
  copyable through the same clipboard auto-clear path as any other secret. Code
  generation + parsing live in `util/totp.ts` (`parseTotp` / `totpAt`, verified
  against the RFC 6238 vectors) and tolerate both URI and spaced/dashed-secret
  inputs; HOTP and Google's `otpauth-migration://` export blob are rejected.
  **Set-up by QR scan from the current page** — the "Authenticator key" field's
  camera button calls `shell.scanQrFromActiveTab()`, which has the background SW
  `captureVisibleTab` (PNG) the user's real browsing window and decode a QR via
  `jsQR` over an `OffscreenCanvas` (no DOM, runs in the worker). Only the decoded
  string crosses back to the popup — the screenshot never leaves the background —
  and it's accepted only if it parses as a usable TOTP. Needs no new permission
  (`<all_urls>` already covers capture). The setup key can also be pasted by hand.
  **TOTP autofill** — the content script detects a one-time-code field
  (`autocomplete="one-time-code"`, else an OTP-hinted input, with single-char
  boxes gathered into a segmented group) and, on the 2FA step, offers the
  hostname-matched logins that have a key; picking one (or a single auto-fill)
  drops in the live code. The code is computed in the background at fill time via
  `fetchFill` and only the digits cross to the page — the seed never leaves the
  background. The fill is threaded through with an `otpOnly` flag so it touches
  only the OTP field, never username/password. The key rides the session autofill
  index as `LoginIndexEntry.totp`; `QueryResult.otps` carries the matches.
- **Import from other managers** — Bitwarden (`.json`), 1Password (`.1pux`),
  Proton Pass (`.zip`), KeePass (2.x XML export), and **KeePass encrypted
  `.kdbx` (KDBX4)**. The first four are pure, unit-tested parsers in
  `core/import/` (`fflate` unzip, `fast-xml-parser`) mapping each provider onto
  our typed `EntryData`; unmappable kinds fold into a secure note, passkeys are
  dropped with a warning. Every URL the source format records is carried over
  (1Password `overview.urls[]`, Bitwarden `login.uris[]`, Proton
  `content.urls[]`), so an SSO account that already pointed at five sites comes
  across as one login with five URLs, not five duplicates. `.kdbx` is the
  exception to the pure-parser shape: it's encrypted, so it's opened **inside
  WASM** (`crypto-wasm/src/kdbx.rs`, `open_kdbx4` via `CRYPTO_OPEN_KDBX`) with
  the database's own master password + optional key file — the foreign password
  and decrypted secrets never touch the JS heap. WASM returns the raw String
  pairs and `import/kdbx.ts` maps them through the *same* `mapKeepassFields` the
  XML importer uses. Scope: KDBX4 only, AES-256-CBC/ChaCha20, Argon2d/Argon2id;
  KDBX3, AES-KDF, and Twofish are rejected with a specific message. The flow
  lives on the options page (`options.html?screen=import`, opened from Settings
  → Data → Import via `shell.openSetup("import")`) because a file dialog
  dismisses the popup; it parses on-device and bulk-writes via
  `useVault.importEntries` in a single encrypted `persistEntries` pass. Dedup,
  folders, and attachments remain out of v1 (see below).
- **Corner prompt — save & update logins.** Top-right in-page card the content
  script renders after the user submits a form with credentials we don't have
  (or that differ from what we have). Capture is gated on a real user-edit of
  the password field (autofilled values that the user didn't touch are
  skipped) and suppresses on captchas, OTP-only steps, and ambiguous
  password-change forms; a MutationObserver fallback catches SPA submits that
  fire no native `submit` event. Background owns the dedupe decision against
  the autofill index (exact / save / update with same-username candidates
  floated to the top), the plaintext capture stash in `chrome.storage.session`
  (wiped on lock), and the encrypt-and-commit path through the offscreen doc.
  Writes branch on backend kind: chrome.storage.local vaults commit
  immediately from the background; FSA-backed vaults stash the new outer
  blob in `chrome.storage.session` and the next popup/options open flushes it
  through `storage.flushPendingVaultBlob` — surfaced as a "1 pending sync"
  chip in the AppLayout header so the lag is honest. Locked-vault "Unlock &
  save" stashes a one-shot handoff and opens the action popup
  (`chrome.action.openPopup`, detached-window fallback for older Chrome); the
  popup commits the parked capture immediately after a successful unlock via
  `shell.flushPendingCornerCapture` → `CORNER_FLUSH_HANDOFF`. Per-site mute
  via the card's overflow → "Never for this site" (managed back in Settings),
  and a global Settings toggle (default on). Passkey variants
  (`save-passkey` / `use-passkey`) are deferred to the passkey work that
  rides this surface.
- **Lazy in-memory autofill index** — the background's decrypted index is
  in-memory only (never persisted, to keep plaintext out of
  `chrome.storage.session` under memory pressure). Previously it was null
  until the popup repopulated it after every SW idle-kill, which made the
  dropdown and the corner card both falsely report "locked" while the vault
  was actually unlocked (cached VEK still in session). `hydrateAutofillIndexFromDisk`
  now rebuilds the index by re-decrypting on demand the next time any path
  needs it (`AUTOFILL_QUERY`, `AUTOFILL_FIND`, `AUTOFILL_FETCH`, and every
  corner-prompt path). The autoritative "is the vault locked" signal is now
  `cachedVek === null`; an empty index is just "not hydrated yet."
- **Detection helpers extracted + tested under happy-dom.** The pure DOM
  detectors (`detectLoginFields`, `detectCardFields`, `otpInputs`,
  `findNewPasswordOnChangeForm`, `hasInteractiveCaptcha`, `candidateKind`,
  etc.) live in `platform-extension/src/detection.ts` — testable in
  isolation without the content-script's bootstrap side effects. Coverage
  is two-tier: ~60 synthetic snippet tests in `detection.dom.test.ts`
  exercising every code path, plus ~60 fixture tests in
  `fixtures/sites.dom.test.ts` against scrubbed HTML snapshots of 10 real
  sites (github, bmo, discord, twitch, amazon-add-payment, microsoft x2,
  github-2fa, biteasy, github-password-change). The fixtures surfaced one
  production-grade bug — BMO's login uses your debit card number as your
  user ID, so the field's label/aria-label read "Card number or Login ID"
  and `CC_NUMBER_RE` claimed it as card.number. `candidateKind` now
  prefers login when a field satisfies both detectors (the CVV-as-password
  exception is preserved). The corpus also documented two intended
  shallow weaknesses: `\bcvv\b` doesn't match underscore-fused names like
  `cvv_field` (no word boundary at `_`), and a standalone
  `verification-code` field is classified as card-CVV (via
  `card.?code`) — both locked in with explicit tests so a future regex
  tweak knows the tradeoff.
- **Device sync (P2P, behind Settings → Device sync).** Direct device-to-device
  vault sync with no server and no installed binary. A sync *group* is one logical
  vault sharing one VEK; a new device enrolls by pasting/scanning a one-time
  pairing code (Noise XXpsk3, PSK carried in the code), receives the VEK + roster +
  entries sealed Noise-only over a WebRTC data channel, and mints **its own**
  unlock slot (master password **or security key**) without the VEK ever reaching
  the popup. Reconnecting devices authenticate by their roster keys (Noise KK, no
  code) and sync continuously in the background while unlocked; reconciliation is an
  **entry-level last-writer-wins merge** over HLC stamps + tombstones, comparing
  only the sealed-envelope index (no per-entry DEK unwrap, so deletes don't
  resurrect and merge never sees plaintext). WebRTC runs in the offscreen document
  (`WEB_RTC` reason); signaling is a user-chosen Nostr-subset relay (a minimal
  ~100-line relay ships in `/signaling`). Transport-free core in `core/sync/`, hosts
  in `platform-extension/src/sync/`, Noise (KK + XXpsk3) + BIP340 in `crypto-wasm`.
  v1 scope: same-network, all-online; cross-internet sync and VEK rotation are
  deferred. Full design + build status in docs/p2p-sync.md.

#### Schema migrations

JSON-shape changes inside the encrypted entries blob don't bump the on-disk
vault format — they ride a runtime normalizer
(`@core/vault/entry-normalize.normalizeEntryData`, shared by the popup's
`useVault` and the background's lazy-rehydration path) that runs against every
decrypted entry before Zod validation. Currently:

- **Untyped → typed entries.** Vaults created before the `type` discriminator
  treat every entry as `login` (the original kind).
- **Single URL → multi-URL.** Logins persisted with `url: string` are collapsed
  into `urls: [url]` (or `urls: []` if blank). The legacy `url` field is
  dropped on the next save. Migration is forward-only — old code reading a new
  vault would see an unknown `urls` and a missing `url`, but the extension
  auto-updates and there's no realistic downgrade path.

### TODO (next phases)

1. **Optional full vault rekey** — the everyday password change is now a
   re-wrap that keeps the VEK stable (see "Changing a password is a re-wrap").
   A separate, explicit "rekey the vault" action could rotate the VEK,
   re-encrypt every entry, reissue the recovery code, and re-present each
   security key so the new VEK is rewrapped under every slot in one atomic
   operation — useful after a suspected compromise. Cross-vendor testing
   required (YubiKey 5+ / Solo / platform passkeys on Chrome / Edge / Brave;
   not all FIDO2 authenticators implement `hmac-secret`). Not a release gate.
2. **`useVault` integration tests** — the slot-policy, recovery-code, and
   vault-format logic are unit-tested, but the hook flows (set / disable /
   change password, generate / unlock recovery) have no harness (no
   `renderHook` / adapter mocks in the repo). Build mockable crypto + storage
   adapters and cover the new auth flows end to end.
3. **Passkey storage — Vault as a WebAuthn credential provider** — create / store
   / use synced passkeys via `chrome.webAuthenticationProxy`, stored **as a
   `passkeys` field on the login entry** (attach-or-create via the corner
   prompt — the `save-login` / `update-login` infrastructure already ships, so
   the new variants are `save-passkey` / `use-passkey` on the same card).
   Full design in the "Passkeys" section; key pieces are the proxy
   attach/detach lifecycle (attach only while unlocked), the `none`-attestation
   create/get crypto, and Web Store review of the powerful permission.
4. **Autofill heuristics — ongoing tuning.** The first pass landed (detection
   helpers extracted, ~120 detection tests across synthetic snippets + 10
   real-site fixtures, BMO bug fixed — see Working). Remaining work is
   incremental: add fixtures as users report site-specific misses, and grow
   coverage in known-thin areas — a visible captcha fixture (current
   coverage is invisible Turnstile only), more SPA / shadow-DOM patterns,
   and more bank / payment-processor checkout markup. No discrete blocker;
   this is now an open-ended quality-of-coverage axis rather than a release
   gate.
5. **E2E tests** — Playwright + extension support. Includes the corner-prompt
   capture flow (real submit on a public site, queue-and-flush across an FSA
   popup close/reopen, locked-vault unlock-and-save) which the unit tests in
   `dedupe.test.ts` only cover at the pure-logic layer. (Detection itself is
   covered by `*.dom.test.ts` under happy-dom — see Working — but those don't
   exercise the full content-script ↔ background ↔ offscreen pipeline.)
6. **Reproducible WASM build in CI** — `rust-toolchain.toml` + Docker.
7. **Chrome Web Store submission**.
8. **HTTP Basic Auth autofill** (later) — fill the native 401 dialog via
   `chrome.webRequest.onAuthRequired` (perms `webRequest` +
   `webRequestAuthProvider`), background-SW only since the dialog is native chrome,
   not DOM. Best-effort, unlocked-vault-only first cut; host/realm matching (no
   path), guard the bad-credential re-fire loop. Full design in the "HTTP Basic
   Auth autofill" section. Low priority — basic auth is rare on the public web.

---

## Out of Scope for v1

- Firefox / Safari / mobile browsers
- File attachments on entries
- Iframe and Shadow DOM autofill
- Native messaging host
- Biometric unlock
- Browser bookmark / history integration
- SSH key-pair generation (a password manager stores secrets; key minting
  belongs in `ssh-keygen` / a dedicated tool). The read-side fingerprint
  display for stored keys ships — see Working.
