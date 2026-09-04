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

Each unlock path (`unlock` with a password, `unlockWithWebauthnKey`,
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

### Platform-authenticator unlock (extension)

Touch ID / Windows Hello in the browser extension is the **opposite** design to the
mobile cache above, despite the similar name: it **is** a slot. The OS passkey
provider derives a PRF secret, that becomes the KEK, and it wraps the VEK in a
normal webauthn slot, identical in the vault file to a security key's. So it obeys
slot-policy, counts as a primary method, and revokes like any other slot.

The practical differences to keep straight when writing copy:

| | Mobile biometric | Extension platform authenticator |
| --- | --- | --- |
| Mechanism | OS-gated VEK cache, not a slot | Webauthn slot |
| Vault file | Untouched | Gains a slot |
| Scope | That device only | macOS: every Mac on the Apple account. Windows: that machine |

The macOS case is the surprising one: Apple Passwords credentials sync, so a slot
registered on one Mac unlocks on another. `authData`'s BE/BS bits report this at
registration, so the UI can state which the user got. See
[security-keys.md](security-keys.md) for the ceremony, the measured support matrix,
and the provider-choice failure mode.

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
and the row reads "Device passcode" with no fallback row at all.

### The invariants this rests on

Eight rules. The first shipped version broke four of them and read as two settings
contradicting each other; multi-vault testing then found two more, and rules 5 and
6 are the pair that let one vault's passcode open another's.

1. **One gate, one switch.** With fast unlock off, no sub-row renders. Shown but
   disabled is not the same thing: "Device passcode: off" above "Allow passcode
   fallback: on" is a screen nobody can act on.
2. **The fallback switch exists only where a choice does**, i.e. only when a
   biometric is enrolled. With nothing enrolled the passcode is not a fallback,
   it is the gate, and the row above already says so.
3. **The armed gate and the flags describing it move together.** `setSecret`
   writes the access control, the passcode flag and the vault id; `purge` clears
   all three. A flag outliving its item tells the extension a gate is armed that
   is not.
4. **The extension only offers a gate it can actually use.** Keychain items
   **survive app deletion**, so presence is evidence only once it is presence of
   *this vault's* item. Everything the extension caches is keyed by the vault it
   holds a bundle for (`autofill.bundleVaultId`): the VEK (`vek:<id>`), the
   keep-unlocked session, and the passcode-fallback flag. That replaced comparing
   a separately-stamped mirror id against the bundle's - keying by vault makes the
   comparison unnecessary, because finding the item *is* the match. The one shared
   item it replaced meant arming a second vault overwrote the first's cache and
   disabling either deleted both.
5. **Nothing about the gate is device-wide.** The gate is per vault, so the
   settings describing it are stored per vault too (`<key>:<vaultId>`, the same
   convention as the sync keys). `pref.biometricAutoPrompt` and
   `pref.biometricPasscodeFallback` were flat, so a second vault opened already
   showing both switched on, having never been given either - and the re-arm then
   wrote the second vault's gate to match the first one's setting.
6. **Re-arming only happens where it is free.** It exists to change an access control that
   iOS fixes at write time, and a Keychain write raises no prompt. Android's Keystore key is
   created `setUserAuthenticationRequired`, so `enable` must authenticate before it can
   encrypt: running the reconcile there asked for a second touch after a biometric unlock, and
   an unexplained "Enable biometric unlock" prompt after a password one. Cancelling that prompt
   was the real damage - `setSecret` deletes and regenerates the key BEFORE prompting, so a
   cancel left the stored ciphertext encrypted under a key that no longer existed while
   `hasSecret` still reported the gate armed. `BiometricUnlock.enableIsSilent` marks the
   difference, and there is nothing to reconcile on that gate anyway. It is stated as "is this
   provably silent?" rather than "does this need auth?" so that an unknown answer skips the
   reconcile: the platform read behind it falls back to `"web"` until the Capacitor bridge is
   injected, and under the opposite phrasing that unknown meant "go ahead and re-arm".
7. **Re-arming asks the OS about THIS vault; it never trusts a passed-in flag.**
   That flag is React state describing whichever vault the last probe finished
   for, so mid-switch it still names the one you came from. Re-arming on a stale
   `true` does not refresh a gate, it *creates* one: unlocking vault B with a
   password gave B a passcode-openable cache it was never enabled for. The guard
   is now `biometric.isEnabled(vaultId)`, a keychain attribute read.
8. **A VEK that doesn't open the bundle is a stale cache, not an error to
   read.** The failure is a Rust `aead::Error`, which meant the extension used to
   put "aes decrypt: aead::Error" on screen after a correct passcode. Discard the
   mirror and the session, then ask for the master password in English.

Labels follow **enrolment, not hardware**: `LAContext.biometryType` answers
`.faceID` on a Face ID phone with Face ID switched off, so both `isAvailable` and
the extension's `biometryInfo()` call `canEvaluatePolicy` first (treating
`biometryLockout` as enrolled) and fall back to "passcode" wording.

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
reads the mirrored flag (`autofill.biometricPasscodeFallback:<vaultId>` in the App
Group, written by `BiometricVault.setSecret` alongside the item it describes, so
the two can't drift) only to label the button - "Face ID" versus "Face ID or
passcode". Keyed by vault like the item: with two vaults armed at once a single
flag would name only the one armed last.

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
- `verifyWithWebauthnKey`: a single tap that proves possession of a registered
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
