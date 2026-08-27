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

### Device-local biometric (mobile)

Face ID / Touch ID / Android BiometricPrompt is deliberately **not** a slot. The
VEK is cached on one device behind an OS-enforced gate (Secure Enclave /
Keystore), keyed by vault id, so the vault file stays portable and slot-policy is
untouched: a device holding the cache skips the Argon2 KDF, and everything above
remains the way in from anywhere else. `adapters/biometric.ts` is the contract,
`vault/biometric-unlock.ts` the flow (including stale-cache teardown, which
disables the gate and sends the user back to their password).

By default the unlock screen offers it as a button. Turning on **Unlock on open**
(Settings > Security, under the biometric row, off by default) makes the screen
present the gate itself, so a Face ID user opens the app to no tap at all
(issue #43). The rules live in `app/screens/Auth/auto-biometric.ts`:

- **One attempt per lock episode.** The route guard bounces to the unlock screen
  on every lock, so a fresh screen means a fresh attempt; a cancel leaves the
  user on the password form rather than re-raising the prompt they just
  dismissed.
- **Not until the OS calls the app active.** Painting is not the same as being
  able to present system UI: on the iOS simulator, `evaluatePolicy` answers
  `-1004 "Caller is not running foreground."` for over a second after this screen
  starts rendering. `ShellAdapter.onAppStateChange` (mobile only) reports the
  platform's own answer, and the prompt waits for it. It must be Capacitor's
  `appStateChange` and **not** `resume`: `resume` fires on
  `willEnterForeground`, which is just as early, while `appStateChange` fires on
  `didBecomeActive`, which is the moment LocalAuthentication starts cooperating.
- **A gate that never opened is not an answer.** Transients remain (`systemCancel`
  when another sheet is in the way), so a failed unasked prompt is retried a few
  times, a few hundred ms apart, before giving up silently. This is why the native
  plugins distinguish a user cancel (`cancelled`, final) from a prompt the OS
  pulled (`interrupted`, retry) from a real failure (`auth-failed`) — collapsing
  the first two hid the retry entirely.
- **An unasked prompt never leaves an error on screen** — the user still has the
  button, which reports properly when they tap it. The one exception is
  `StaleBiometricCacheError`, because there the button is gone with the cache,
  and silence would leave nothing to explain it.
- **An explicit Lock is honoured** (`lockedByUser`, set only by `lock()`), or
  locking would be impossible while looking at the phone. Auto-lock does not set
  it, which is what lets a backgrounded vault re-open on return.
- **Never while off screen.** Auto-lock fires as the app leaves the foreground, so
  the unlock screen routinely mounts backgrounded. Document visibility is the cheap
  check; the screen also waits for a frame, which a hidden document cannot produce,
  so a webview that never reports hidden still cannot prompt into the void.

The iOS AutoFill extension does the same thing natively from `viewDidAppear`,
ungated: it exists only to answer a fill request, so there is nothing else to be
doing there.

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
