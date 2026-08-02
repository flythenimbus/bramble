# Encrypted vault imports

How Bramble handles *encrypted* imports. Three formats are in play, at different
levels of support:

- **Bramble `.bramble`** — our own portable vault, sealed at export under a password
  chosen for the file. The only import that keeps passkeys and password history,
  since the entries arrive already normalized. See [below](#bramble-portable-vault).
- **KeePass KDBX4** — fully decrypted inside WASM and imported. See below.
- **Bitwarden encrypted JSON** — *not* decrypted. Bramble detects it and tells the
  user what to do, because one of the two Bitwarden encrypted formats can't be
  decrypted by anyone but Bitwarden. See [below](#bitwarden-encrypted-json).

Plain (unencrypted) exports — Bitwarden JSON, 1Password 1PUX, Proton Pass — go
through their own parsers with no decryption step and are not covered here.

Every one of them, encrypted or not, lands in the same place: `ImportShell` runs
`splitAlreadyImported` (`core/vault/entry-identity.ts`) over the parsed entries
before the preview, so re-importing a file adds nothing and says how many it
skipped. Import always merges into the current vault. Replacing a vault wholesale
is a different operation, restore-from-backup, described in
[cloud-storage-backups.md](cloud-storage-backups.md).

---

# Bramble portable vault

A `.bramble` written by **Actions → Export selection** in the vault list. It is a
VLT1 blob like any other, so the existing restore path reads it too, but its
contents are a plain `{ entries }` payload rather than a vault's own
`EntriesPayload` of DEK-sealed records.

Code: `seal_portable_vault` / `open_portable_vault` in
`packages/core-rust/src/lib.rs`, framed by
`packages/core/src/export/portable-vault.ts`.

- **Its key is not the vault's key.** Sealing generates a fresh 32-byte key used
  for that file alone, wrapped in a password slot under the password the user chose
  at export. Sealing under the session VEK would mean that cracking one exported
  file's password yields the key to every entry in the vault it came from, exported
  or not. That is the entire reason these calls exist rather than reusing
  `encrypt_with_vek` + `wrap_vek_password`.
- **Session-free.** Neither call reads or writes the VEK slot, so an export works on
  a locked vault and an import cannot disturb an unlocked one. Note that generating
  the file key via `generate_vek` would *replace* the session key: that is the
  multi-vault VEK hazard from issue #27, and it is why the core mints the key
  locally instead.
- **Framing lives in TypeScript.** The core returns the sealed pieces (slot fields,
  entries IV and ciphertext) and `encodeVaultBlob` assembles them, so VLT1 keeps a
  single implementation instead of gaining a second one in Rust.
- **A full vault backup is refused, by name.** Its payload decrypts fine but holds
  entries still sealed under per-entry DEKs; importing them would write entries whose
  every field is ciphertext, so `openPortableVaultFile` detects that shape and points
  the user at restore instead.
- **Wrong password is not an error.** The core answers `None`/`null`, kept distinct
  from a corrupt or non-Bramble file so the UI can say which happened.

The password prompt is the shared credential step (`KdbxUnlock`), with the key-file
field off: only KeePass has those.

---

# KeePass KDBX4

Importing a KeePass KDBX4 database. Code: `packages/core-rust/src/kdbx.rs`,
driven from `keepass.ts` on the JS side. This is the spike for reading external
vaults; export reuses the same VariantDictionary codec and `derive_keys` chain.

## Scope and boundary

The database is opened entirely inside WASM. The foreign master password and
every decrypted secret stay in this module (`Zeroizing`), never the JS heap,
matching the rest of the vault's crypto boundary (see
[cryptography.md](cryptography.md)). Only normalized entry key/value pairs cross
back to JS, which then maps them to `EntryData` along the same path the other
importers use.

Supported, by deliberate choice:

- **KDBX4 only.** KDBX3 is rejected.
- Outer cipher **AES-256-CBC** or **ChaCha20**. Twofish rejected.
- KDF **Argon2d** (KeePass default) or **Argon2id**. AES-KDF rejected.
- Inner stream **ChaCha20**.
- Attachments/binaries are ignored.

Each rejection has a stable machine code (`KdbxError::code()`, for example
`KDBX_UNSUPPORTED_CIPHER`, `KDBX_WRONG_CREDENTIAL`) so the JS layer can show the
right UI: keep the user on the unlock step for a wrong credential, or surface
"unsupported" for an out-of-scope database. Out-of-scope cipher and KDF are
rejected up front, before spending Argon2 on a file that cannot open and so the
error stays credential-independent.

## Key derivation

Following KeePass rules exactly:

- **Composite key** = `SHA256( [SHA256(password)] [|| keyfile_key] )`. A component
  that is not set contributes nothing. An empty password (a key-file-only
  database) is omitted entirely, because hashing `SHA256("")` would derive the
  wrong key.
- **Key file** resolution: an XML key file (v2.0 hex, v1.0 base64), else raw 32
  bytes, else 64 hex characters, else `SHA-256` of the file contents.
- **Transform**: Argon2 (d or id, per the KDF `$UUID`) over the composite key with
  the parameters from the header's VariantDictionary.
- **Final keys**: `cipher_key = SHA256(master_seed || transformed)`;
  `hmac_base = SHA512(master_seed || transformed || 0x01)`.

## Authentication and the wrong-password signal

Before any payload is decrypted, the outer header is authenticated:

- `SHA256(header)` must match the stored header hash (integrity).
- An HMAC-SHA256 over the header (keyed from `hmac_base`) must verify. A wrong
  password produces the wrong key and so a failed HMAC, which surfaces as
  `WrongCredential`. This is how a wrong password is detected, without leaking
  timing.

The body is then read as HMAC-verified blocks, decrypted (AES-CBC/Pkcs7 or
ChaCha20), and gunzipped if compressed.

## Inner XML and what gets emitted

The inner XML is walked with a streaming reader. Protected (`Protected="True"`)
values are decrypted with the inner ChaCha20 stream. The keystream is consumed by
**every** protected value in document order, including History revisions and
Recycle Bin entries that are ultimately discarded, so decryption always applies
the keystream and emission is decided separately.

Only top-level current entries are emitted. Excluded: History revisions, entries
under the Recycle Bin group, and attachments/binaries.

## Test coverage

Real fixtures cover AES-256-CBC + Argon2d, with and without a key file (the only
variants `pykeepass` / `keepassxc-cli` can emit), plus a rich database exercising
Recycle Bin, History, and a protected TOTP Seed field. Byte-mutation negative
tests cover the rejections (KDBX3, bad magic, unsupported cipher, AES-KDF) without
needing exotic real files. Two paths are covered by reasoning rather than a
fixture and the comment in `kdbx.rs` says so: Argon2id (a one-line algorithm
branch over the same machinery Argon2d exhausts) and ChaCha20 as the *outer*
cipher (it shares all framing with the AES path and the ChaCha20 primitive runs on
every test via the inner stream; only the 12-byte-IV outer application is
unexercised).

---

# Bitwarden encrypted JSON

Code: `packages/core/src/import/bitwarden.ts`. **Bramble does not decrypt Bitwarden
encrypted exports** — it detects them and routes the user to a fixable path. This
section records why, and what a future decrypt would take.

## Two encrypted formats, only one is ever decryptable

Bitwarden's "Encrypted export" has two variants, both with `encrypted: true`:

- **Account-restricted** (no `passwordProtected`, no `salt`). Encrypted with the
  user's Bitwarden *account key*. It can **only** be re-imported into that same
  account, and rotating the account key makes it undecryptable even for Bitwarden.
  **No password unlocks it**, so Bramble (or any third party) fundamentally cannot
  read it. Nothing we can do here but tell the user to re-export.
- **Password-protected** (`passwordProtected: true`, plus `salt`, `kdfType`,
  `kdfIterations`, `encKeyValidation_DO_NOT_EDIT`, `data`). Encrypted with a
  password the user chose at export time. **Anyone with that password can decrypt
  it** — this is the only variant a decrypt feature could ever support.

## Current handling

`parseBitwarden` checks for `encrypted === true` / `passwordProtected === true`
right after `JSON.parse`, before the generic format check, and throws a specific,
actionable error: re-export from Bitwarden as a plain `.json` with "Password
protected" turned off. Without this, an encrypted file has no `items` array and
would trip the generic "This doesn't look like a Bitwarden JSON export" — telling
the user their valid Bitwarden file isn't Bitwarden. (The two variants are not yet
distinguished in the message; both get the "re-export unencrypted" advice, which
is correct for both.)

## What decrypting the password-protected variant would take (deferred)

Deliberately not built. If added, it needs **no Rust/WASM** — every primitive is in
WebCrypto — because Bitwarden's password-protected exports use a fixed scheme:

1. `masterKey = PBKDF2-SHA256(password, base64(salt), kdfIterations)` (32 bytes).
   Password-protected exports are always `kdfType: 0` = PBKDF2.
2. Stretch with **HKDF-Expand** (not full HKDF; the key is already strong):
   `encKey = HMAC-SHA256(masterKey, "enc" || 0x01)`,
   `macKey = HMAC-SHA256(masterKey, "mac" || 0x01)`.
3. `encKeyValidation_DO_NOT_EDIT` and `data` are `AesCbc256_HmacSha256_B64`
   EncStrings of the form `2.<iv>|<ct>|<mac>`. Decrypt each by verifying
   `HMAC-SHA256(macKey, iv || ct) == mac`, then `AES-256-CBC(encKey, iv, ct)`.
4. Decrypt `encKeyValidation…` first to confirm the password (wrong password ->
   MAC fails -> keep the user on the password step, as KDBX does), then decrypt
   `data` -> the plaintext `{ folders, items }` JSON -> hand to `parseBitwarden`.

Wiring note: unlike KDBX, "needs a credential" here is **per file, not per
provider** — a Bitwarden file is usually plain, so the password step would fire
only when the password-protected shape is detected, then reuse the KDBX unlock UI.
A real Bitwarden-generated fixture (known password) would be needed for the test;
round-tripping against our own encrypt only proves internal consistency.

Sources: [Bitwarden — Encrypted Exports](https://bitwarden.com/help/encrypted-export/),
[BitwardenDecrypt](https://github.com/GurpreetKang/BitwardenDecrypt).
