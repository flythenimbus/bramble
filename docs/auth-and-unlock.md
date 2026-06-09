# Auth and unlock

How the vault is unlocked, which methods are allowed to exist, and how lock state
propagates through the UI. The crypto underneath is in
[cryptography.md](cryptography.md); the security-key specifics are in
[security-keys.md](security-keys.md).

## Unlock methods

A vault has one or more **slots**, each a way to unlock:

- **Master password**: Argon2id KEK. A primary method.
- **Security key**: WebAuthn PRF / hmac-secret KEK. A primary method.
- **Recovery code**: a high-entropy offline passphrase, cryptographically a
  password slot but flagged as a backup. Never a primary method.

Each unlock path (`unlock` with a password, `unlockWithSecurityKey`,
`unlockWithRecoveryCode` in `useVault.tsx`) reads the vault blob, derives the
KEK for the chosen slot, unwraps the VEK, loads entries, and flips `isLocked`.
On a successful unlock it also flushes any corner-prompt capture that was parked
while the vault was locked (the background does the encrypt-and-write; the UI
just triggers it now that the VEK is live).

## Invariant B: always one primary method

The slot-mutation rules live in `packages/core/src/vault/slot-policy.ts`,
extracted as pure functions so the invariants can be unit-tested without React or
adapter mocks.

> A vault must always keep at least one **primary** unlock method (master
> password OR security key). A recovery code can unlock, but it never satisfies
> this guard.

`isPrimaryUnlock` counts only password and webauthn slots. The mutation helpers
enforce the invariant on removal:

- `removeWebauthnSlot` and `removePasswordSlot` refuse if the removal would leave
  no primary method, with a user-facing message telling them what to add first.
- They also refuse on a stale id (slot not found), so a removal request that
  raced with another change fails loudly rather than silently no-ops.

`upsertPasswordSlot` replaces any existing password slot, so it covers both
first-time enable and password change (re-wrap). `upsertRecoverySlot` replaces
the single recovery slot, so "reset recovery code" is atomic. All helpers are
immutable (return a new blob) and enforce the `MAX_SLOTS` ceiling.

## Verify without unlocking

Two operations prove the user's identity to authorize a sensitive action (like
resetting the recovery code) without changing lock state:

- `verifyMasterPassword`: a verifier-only check against the password slot. Works
  while the vault is already unlocked because it never touches the in-memory VEK.
- `verifyWithSecurityKey`: a single tap that proves possession of a registered
  key. Used on a password-less vault, where there is no master password to
  confirm with.

## Error sanitization

Anything that fails before the credential check (missing file, corrupt blob,
unsupported version, missing slot) is surfaced as a generic, friendly message.
Raw decoder errors like `unsupported vault version: 1 (expected 2)` leak format
internals and are alarming without being actionable, so the unlock paths wrap
read failures in a plain "Couldn't open this vault" message and log the real
error to the console.

## Lock-state propagation

Lock state is shared between the background service worker and the open UI:

- **Background-initiated lock** (the auto-lock alarm fires while the popup is
  open): the background locks the offscreen WASM and clears the autofill index,
  then signals the UI. The UI flips `isLocked` and tears down only its local
  state (the entries array). The router re-runs its guards and redirects.
- **External vault change** (a corner-prompt save committed in the background):
  the UI re-runs `loadEntries` so its in-memory entries and autofill index stay
  in sync with disk.

The router guards that act on this (including the deliberate hydration asymmetry
that avoids redirect loops during mount) are documented in
[routing.md](routing.md).
