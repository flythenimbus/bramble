# Security keys (WebAuthn)

How a FIDO2 security key unlocks the vault. The crypto (HKDF KEK derivation, the
uniform slot layout) is in [cryptography.md](cryptography.md); this doc covers the
WebAuthn ceremonies and their quirks. The create()/get() PRF dance lives in
`vault/webauthn-ceremony.ts` (`createPrfCredential`, `getPrfSecret`,
`isWebauthnAvailable`), shared by `registerSecurityKey`, `unlockWithSecurityKey`,
and device enrollment; the slot bookkeeping stays in `useVault.tsx` +
`slot-policy.ts`.

## The unlock material is the PRF / hmac-secret

The KEK does not come from the credential itself. It comes from the
**hmac-secret** the authenticator returns: a stable 32-byte HMAC the key derives
from a per-slot salt it stores alongside the credential. The client never sees
the authenticator's underlying key, only this derived secret, which is then run
through HKDF to produce the KEK.

The secret is requested through the WebAuthn **`prf`** extension, not the raw
`hmacGetSecret` / `hmacCreateSecret` inputs. Chromium silently drops the raw
hmac extension on `get()` (it returns an empty extension result) and only honors
`prf` for assertions. Because `prf` is not in `lib.dom.d.ts`'s extension types,
the options object is cast so TypeScript accepts the field.

Per-slot salt sizing: the hmac-secret salt is 32 bytes (CTAP2 requirement),
which is why webauthn slots store a 32-byte salt versus the 16-byte Argon2 salt
on password slots.

## Registration is two ceremonies (two taps)

Most security keys lack `hmac-secret-mc` (the "evaluate during create"
capability), so registration is two WebAuthn ceremonies:

1. `navigator.credentials.create()` mints the credential. The PRF salt for this
   slot is picked up front and passed in `extensions.prf.eval.first`, so a
   capable key (CTAP 2.1 + Chromium) can return the secret in the create()
   response and spare the user a second tap.
2. If the create() response did not carry the PRF result (older keys ignore
   eval-at-create), a one-off `get()` with the **same salt** reads it. PRF is
   deterministic, so the value matches and the slot persisted from it unlocks
   identically.

The credential is registered non-discoverable (`residentKey: "discouraged"`):
the unlock handle lives in the vault file, not the key's limited
resident-credential storage. Registration requires the vault to be unlocked,
because it wraps the live in-memory VEK under the new KEK.

A cancel or timeout on either ceremony surfaces as `NotAllowedError`, which is
translated into a clear "this takes two taps, please complete both prompts"
message instead of the raw WebAuthn error.

The non-secret label for the key is stored separately, keyed by slot id.

## Enrolling a device with a security key

Joining a P2P sync group (see [p2p-sync.md](p2p-sync.md)) can unlock the new
device with a security key instead of a master password. It reuses the same
`createPrfCredential` ceremony, with two wrinkles from the enrollment flow:

- The ceremony runs **first**, on the Join click's user activation, before the
  (async, multi-second) handshake; otherwise the gesture is spent and `create()`
  fails. The resulting `{ credentialId, salt, hmacSecret }` is held while the group
  VEK arrives over the channel.
- The VEK never reaches the popup: only the hmac-secret crosses to the offscreen
  (exactly as a password would), which mints the webauthn slot against the
  transferred VEK via `wrapWebauthnSlot`. The popup then finishes the unlock with
  the in-hand secret (`finishWebauthnUnlock`), no second tap.

The option is gated on `isWebauthnAvailable()`, so it's hidden where WebAuthn / PRF
can't work (mobile webviews; see [mobile-port.md](mobile-port.md)). Desktop only
for now.

## Unlock and the salt-mismatch retry

When several keys are registered, the first `get()` offers all credentials in
`allowCredentials` but can only pass one salt: slot[0]'s. PRF output depends on
the salt passed to `navigator.credentials.get()`, so if the user taps a
*different* key whose stored salt differs, the first attempt produced the wrong
secret.

`needsSaltMismatchRetry` (in `slot-policy.ts`) detects this by comparing the
tapped slot's salt against the salt used in the first call. When they differ, a
second `get()` is issued, narrowed to that one credential with its own salt. The
tapped slot is identified by matching the authenticator's response `rawId`
against the stored `credentialId` (`matchSlotByCredentialId`).

## Revocation

`removeWebauthnSlot` drops the slot by id and refuses if it would leave the vault
with no primary unlock method (invariant B, see
[auth-and-unlock.md](auth-and-unlock.md)). The stored label is dropped alongside
the slot.
