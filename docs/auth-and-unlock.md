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

#### Passcode fallback (iOS)

The gate is a `SecAccessControl` on the cached-VEK Keychain item, and iOS gives us
two of them. Which one is used is the **Allow passcode fallback** toggle
(Settings > Security, under the biometric row, iOS only via the
`biometricPasscodeFallback` capability), **off by default**:

| Toggle | Access control | Opens with | On enrolment change |
| --- | --- | --- | --- |
| off (default) | `.biometryCurrentSet` | Face ID / Touch ID only | OS destroys the cached VEK |
| on | `.userPresence` | biometry **or** the device passcode | survives |

Off is the default because "Face ID" that a passcode also opens is not Face ID:
anyone holding the device passcode could otherwise open the vault without the
master password. `.biometryCurrentSet` rather than `.biometryAny` for the same
reason - otherwise that same person just enrols their own face in iOS Settings and
walks in. This matches Android, whose Keystore key has always been
`BIOMETRIC_STRONG` + `setInvalidatedByBiometricEnrollment(true)`; allowing
`DEVICE_CREDENTIAL` there needs the key authorized for it at generation (API 30+,
minSdk is 24), so Android has no such toggle and the flag is ignored.

Three consequences worth knowing:

- **The choice is baked in when the VEK is cached**, so changing it means
  re-caching. `reconcileBiometricGate` runs after every successful unlock (one
  Keychain write, no prompt), which is also how a device armed by a build that
  predates the setting converts: those items are all `.userPresence`.
- **The prompt policy must match the item.** `getSecret` evaluates
  `.deviceOwnerAuthentication` or `.deviceOwnerAuthenticationWithBiometrics`
  accordingly - a passcode-authenticated `LAContext` cannot open a
  `.biometryCurrentSet` item. In biometrics-only mode it also blanks
  `localizedFallbackTitle`, since that button can only ever return
  `LAError.userFallback`.
- **Re-enrolling Face ID retires the cache.** The read comes back
  `errSecAuthFailed`, which the plugin reports as `invalidated` after deleting the
  dead item; `biometricUnlockFlow` disables the gate and the unlock screen says so
  (the one other failure, besides a stale cache, worth showing unasked - the
  button it came from is gone with it). Repeated failures give `lockout`, which in
  biometrics-only mode has no way out inside the policy: unlock the device with its
  passcode first, or use the master password.

A device with **nothing enrolled** in Face ID / Touch ID can't open a
biometry-only gate, so `effectiveAllowPasscode` forces the passcode on there
whatever the preference says (`isAvailable` reports `biometryEnrolled: false`),
and the row reads "Device passcode" with the toggle on and disabled.

**None of this is testable on the simulator, and the reason is worth recording so
nobody re-derives it.** Probed by running the two `SecAccessControl`s inside the
real signed app (the only way to get a keychain-access-group entitlement there -
`simctl spawn` refuses an entitled bare binary, and an unentitled app gets
`errSecMissingEntitlement`):

- `SecAccessControlCreateWithFlags(.biometryCurrentSet)` and the matching
  `SecItemAdd` both **succeed with nothing enrolled**. The constraint is lazy -
  it is only evaluated on read - so the plugin's `no-biometry` rejection is a
  backstop, not the guard that matters. `effectiveAllowPasscode` is.
- Reading either item back with `kSecUseAuthenticationUISkip` returns
  `errSecSuccess` **and the data**, with no prompt, both before and after
  toggling Face ID enrolment. The simulator has no Secure Enclave and does not
  enforce these access controls at all.

So a passing simulator run says nothing about whether the passcode is refused, or
about enrolment invalidation. Both need a real device. (One incidental
consequence: `hasSecret` / `vekExists` see `errSecSuccess` there rather than the
`errSecInteractionNotAllowed` their comments describe - they already treat both
as "present", so the toggle still reads correctly.)

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
doing there. It has **no policy to pick**: `readVek` hands an unauthenticated
`LAContext` to the Keychain and lets the item's own access control raise the
prompt, so the passcode-fallback setting is enforced there by construction. It
reads the mirrored flag (`autofill.biometricPasscodeFallback` in the App Group,
written by `BiometricVault.setSecret` alongside the item it describes, so the two
can't drift) only to label the button - "Face ID" versus "Face ID or passcode".

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
