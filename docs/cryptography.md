# Cryptography: the VEK / slot / KEK wrapping model

This is the core of how Bramble protects vault data. All of it lives in
`packages/core-rust/src/lib.rs` (the Rust/WASM crypto) and is driven from
`packages/core/src/hooks/useVault.tsx` (the orchestration).

## The key hierarchy

Everything encrypts under one key, the **VEK** (Vault Encryption Key):

```
                password ──Argon2id──┐
                                     ├──> KEK ──wraps──> VEK ──> entry DEKs ──> entry plaintext
            security key ──HKDF──────┤                      └──> outer entries blob, settings
           recovery code ──Argon2id──┘
```

- The **VEK** is a random 32-byte key generated once at vault creation
  (`generate_vek`) and never derived from a password. It is the only thing that
  decrypts vault contents.
- Each **slot** (password, security key, recovery code) derives its own **KEK**
  and stores a copy of the VEK wrapped under that KEK. Unlocking means: derive
  the KEK, unwrap the VEK, hold it in memory.
- Each **entry** has its own random **DEK**; the entry plaintext is encrypted
  under the DEK, and the DEK is wrapped under the VEK. The outer entries blob and
  settings are encrypted directly under the VEK.

The in-memory VEK lives in a single global slot in WASM
(`vek_slot()`), wrapped in `Zeroizing` so it is wiped on drop. The master
password and all decrypted secrets stay in WASM memory and never cross to the JS
heap; only the resulting plaintext entries do.

Why this shape: adding, revoking, or rotating a slot only rewraps the VEK. It
never re-encrypts per-entry ciphertext, so changing unlock methods is cheap and
does not touch the bulk of the vault.

## KEK derivation (the difference between slot kinds)

Password and security-key slots are byte-identical on disk (verifier, wrap IV,
wrapped VEK). The only thing that differs is how the KEK is produced:

- **Password / recovery code**: Argon2id over `password + salt`, with parameters
  `time=3, memory=64 MiB, parallelism=1`, producing a 32-byte KEK
  (`derive_kek`). A recovery code is just a high-entropy passphrase, so it reuses
  the password KDF.
- **Security key**: HKDF-SHA256 over the 32-byte hmac-secret returned by the
  authenticator, domain-separated by the info string `titanpass/webauthn/v1`
  (`derive_kek_hkdf`). The authenticator owns the entropy; HKDF just shapes it
  into a KEK that cannot collide with other HKDF callers. That info string names
  the product Bramble was called before it was renamed, and is frozen: it is a
  domain separator rather than a label, and changing it would change every
  derived KEK and strand every enrolled security key. See
  [security-keys.md](security-keys.md).

Reusing the same on-disk slot layout for both keeps slot serialization uniform on
the JS side.

## Verifier-based unlock (reject wrong credentials cheaply)

Each slot stores a **verifier**: `HMAC-SHA256(KEK, magic_version || slot_id)`.
On every unlock attempt the KEK is re-derived, the verifier is recomputed, and
the two are compared in **constant time** (`ct_eq`) before any AES-GCM unwrap
runs.

This lets a wrong password be rejected without paying for a failing AEAD tag
check, and without leaking timing. The `magic_version` prefix
(`"VLT1" || 0x02`) binds a verifier to a specific format version so a verifier
from one format revision cannot be replayed against another.

`verify_*_slot` does the verifier check only (no unwrap). It is used to confirm
the current password while the vault is already unlocked, for example in the
Settings change-password flow, without touching the live in-memory VEK.

## Password change does NOT rotate the VEK

This is a deliberate tradeoff (see `writeMasterPasswordSlot` in `useVault.tsx`).

A password change re-wraps the VEK under a new KEK and replaces the password
slot's verifier. It does **not** generate a new VEK. The reasons:

- The recovery slot's code is offline and cannot be re-wrapped on demand.
- Every security key would each need a physical tap to re-wrap.

Keeping the VEK stable lets those other slots survive a password change
untouched. The cost is no VEK forward-secrecy on password change. That is
acceptable because a leaked *password* is still fully addressed: its KEK and
verifier are replaced, so the old password no longer unlocks. Entries are never
re-encrypted (same VEK), so a bad write can only damage the password-unlock path,
not the data. The write is verified after the fact and rolled back from backup if
the post-write verifier check fails.

`rotate_vek` (a real VEK rotation, used on key revocation rather than password
change) generates a fresh VEK and requires the caller to re-wrap every slot under
it before persisting. It refuses to run on a locked vault, since rotating from a
zero state would silently drop the old key.

## Entry and outer encryption

- **Per entry** (`encrypt_entry` / `decrypt_entry`): a fresh random DEK and IV
  per entry. The plaintext is AES-256-GCM under the DEK; the DEK is wrapped under
  the VEK with its own IV. Re-randomized on every save (sub-millisecond per
  entry), so slot rotations never need to re-encrypt entries.
- **Outer blobs** (`encrypt_with_vek` / `decrypt_with_vek`): the entries blob,
  settings, and similar single-use payloads are encrypted directly under the VEK
  with a random IV, skipping the per-entry DEK indirection.

## Exported files use a key of their own

`seal_portable_vault` / `open_portable_vault` are the one pair of calls that
encrypt vault data under a key that is **not** the VEK. Exporting a selection as a
`.bramble` generates a fresh 32-byte key for that file, seals the entries under it,
and wraps it in a password slot keyed by the password the user chose for the export.

This is a deliberate departure from everything above, and the reason is the threat
model rather than convenience. An exported file leaves the device, and the password
someone picks for a file is typically far weaker than their master password. Sealing
it under the VEK would mean the file is a second door to the *whole* vault: crack
that weaker password and you hold the key that decrypts every entry in the vault
blob, including the ones that were never exported. A per-file key bounds the loss to
exactly what was in the file.

Both calls are session-free. They never read or write the VEK slot, so an export
works on a locked vault and an import cannot disturb an unlocked one. Minting the
key locally also avoids `generate_vek`, which *replaces* the session key: doing that
mid-session is the multi-vault VEK hazard behind issue #27.

See [encrypted-import.md](encrypted-import.md) for the file format and the import
side.

## Session resume

After Chrome kills the service worker, the offscreen document caches the VEK in
`chrome.storage.session` and re-injects it via `unlock_with_vek`, so the user
does not retype their password. See [auth-and-unlock.md](auth-and-unlock.md) and
[storage.md](storage.md).

### Where the VEK lives while unlocked (and the threat reality)

The VEK's home is the Rust WASM module (generated there, `Zeroizing`-wrapped so it
can be wiped). While the vault is unlocked it also exists as a base64 JS value in a
few places: the session cache above (`chrome.storage.session` + the SW's in-memory
copy) for resume, and transiently during device enrollment (it is exported, sealed
Noise-only over the channel, and re-loaded; see [p2p-sync.md](p2p-sync.md)).

This is the floor for every pure browser-extension password manager, not a gap
specific to this project: the platform gives an extension no secure enclave for its
own symmetric vault key, and JS can read WASM linear memory anyway, so while
unlocked the key is reachable by code running in the extension's process. Managers
that do better (e.g. biometric unlock) delegate the secure store to a native app
behind an OS keychain, which this project intentionally does not require.

What actually bounds exposure is therefore **lock policy**, not where the key sits
during the unlocked window: auto-lock on idle (sliding alarm), lock on OS screen
lock (`chrome.idle`), and lock on browser close (the session cache clears, so the
vault is locked on next launch and needs the password again).

### Deferred hardening: "VEK never in JS"

Keeping the VEK exclusively inside WASM (encrypt or drop the session cache; seal the
enrollment bundle inside WASM so it never becomes a JS string) is a possible
defense-in-depth step. It is deferred because the gain is modest (WASM memory is
still JS-readable, so it raises the bar against casual heap inspection and lingering
GC'd strings, but is not a hard boundary) and the session-cache half trades against
headless resume (dropping the cache means re-unlocking whenever the offscreen
restarts). The enrollment-seal half is cheap and self-contained if pursued alone.
The crossing-by-crossing inventory, the update order and the effort for each live in
[vek-residency-hardening.md](vek-residency-hardening.md).

## Tests

`lib.rs` drives the primitives directly (HKDF, AES-GCM, verifier compute,
`ct_eq`) with fixed inputs rather than going through the global VEK slot, which
would make parallel tests racy. The round-trip and rejection tests
(wrong secret, tampered verifier, tampered ciphertext, webauthn-vs-password KEK
separation) lock in that a security key set up today keeps unlocking against any
future build.

`portable_vault_tests` covers the export format: the round trip, wrong-password and
wrong-magic rejection, per-file randomness, and that nested passkey material
survives verbatim. Two of them pin the property the design rests on — that sealing
neither reads nor disturbs the session VEK, and works on a locked vault — so a
refactor that quietly reached for `with_vek` would fail rather than silently turn
every export into a copy of the vault key. Those two share the `VEK_SLOT_LOCK` used
by the round-trip tests above, since they touch the global slot.
