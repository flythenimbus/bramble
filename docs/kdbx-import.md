# KDBX4 import

Importing a KeePass KDBX4 database. Code: `packages/crypto-wasm/src/kdbx.rs`,
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
