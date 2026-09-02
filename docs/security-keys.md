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

## Platform authenticators (Touch ID / Windows Hello)

The same PRF machinery works with a **platform** authenticator, which is what
github issue #67 asks for. Measured 2026-08-31 with a throwaway probe page loaded
into both dist builds; every cell is a real ceremony, not an inference:

| Host | rpID | Authenticator | Result |
| --- | --- | --- | --- |
| macOS, Chromium | implicit (extension id) | Apple Passwords | PRF ok, one tap, **synced** |
| macOS, Firefox 154 | explicit `bramble.app` | Apple Passwords | PRF ok, one tap, **synced** |
| Windows 11 25H2, Chromium | implicit (extension id) | Windows Hello | PRF ok, one tap, **device-bound** |
| Windows 11 25H2, Firefox | explicit `bramble.app` | Windows Hello | PRF ok, one tap, **device-bound** |

Unlike a security key, PRF is evaluated at create, so **registration is one tap**,
not the two above. The secret is deterministic across create and get, as required.

Four things the measurement settled:

- **The extension origin is a valid rpID for a platform authenticator on Chromium.**
  That was the open architectural question. Firefox still rejects its implicit
  `moz-extension://` rpID and needs an explicit `rp.id`, see
  [firefox-port.md](firefox-port.md).
- **Only the OS provider returns PRF.** The browsers' own passkey stores do not:
  Chromium's internal authenticator (aaguid `b5397666-4885-aa6b-cebf-e52262a439a2`)
  creates a user-verified credential and then reports `prf.enabled: false` with no
  secret from either ceremony. The user picks the provider in the OS dialog, so
  registration MUST detect a missing PRF secret and say "choose iCloud Keychain /
  Windows Hello". The two-taps message above is wrong for this path.
- **Options differ from a security key.** Platform needs
  `authenticatorAttachment: "platform"`, `residentKey: "required"` (Apple Passwords
  will not answer otherwise) and `userVerification: "required"` (without it the
  secret can come back ungated, defeating the point). `residentKey: "required"` was
  deliberately rejected for security keys and stays rejected there, so these are two
  separate entry points, not a flag on one.
- **Portability differs by OS and is measurable.** The BE/BS bits in `authData` say
  whether the credential syncs: macOS gives `backedUp: true` (every Mac on the Apple
  account), Windows gives `false` (that machine only). Read the bits at registration
  rather than inferring from the OS.

Requirements: Windows needs 11 25H2 with KB5077181 (build 26200.7840+, which adds
`hmac-secret` to Hello) plus Chrome/Edge 147+ or Firefox 148+; older Windows has no
PRF in Hello at all, so registration has to fail gracefully. Linux has no platform
authenticator in any browser and is out; a security key remains its answer.

**Trap:** the passkey provider (`chrome.webAuthenticationProxy`) intercepts all
browser WebAuthn while attached and fails an extension-originated request with
`NotAllowedError: no resolvable tab origin`
(`background/webauthn-proxy-init.ts`, because such a request has no active tab).
Anything doing WebAuthn must go through `createPrfCredential` / `getPrfSecret`,
which carry the `PASSKEY_PROXY_PAUSE` / `RESUME` envelope from
`platform-extension/src/shell.ts`. Calling `navigator.credentials` directly looks
exactly like an authenticator that does not support PRF.

### One rpID for platform keys, the implicit one for security keys

Platform keys register under a **shared explicit rpID** (`bramble.app`) on BOTH browsers, so a
key registered in Chrome unlocks in Firefox: Apple Passwords syncs the credential and Windows
Hello is an OS store both browsers reach, so a matching rpID was the only thing missing.
Measured accepted on Chromium from a `chrome-extension://` origin, with PRF, 2026-08-31. This
is supported behaviour on both engines, not a trick: Chrome M122+ and Firefox 150+ both let an
extension claim an rpID that a domain in its `host_permissions` could claim.

**Security keys deliberately did not move.** They keep Chromium's implicit extension-id rpID,
because changing it would invalidate every already-registered key and wins nothing: Firefox has
no PRF for external keys, so there is no roaming to gain. `rpIdFor()` holds that rule.

The cost is that a vault can hold slots under two rpIDs, and the vault file does not record
which is which. Unlock therefore tries both, ordered by what this device knows it registered
(`unlockRpIdOrder`), so a single-kind vault still costs one prompt and only a mixed vault pays
for a second. `minimum_chrome_version` stays at 116 so existing security-key users on older
Chrome keep working; a platform registration there fails with a version message instead.

### When neither rpID matches, unlock says so

After both rpIDs have been tried, a slot may still not match: a security key registered in
Chrome cannot be used from Firefox at all. Nothing in the vault file records which slot belongs
to which rpID, and local labels do not help - they live in per-browser extension storage, so a
foreign slot is simply absent rather than marked. A filter would never fire.

WebAuthn also refuses to distinguish "user dismissed the prompt" from "nothing matched" -
both are a bare `NotAllowedError`, deliberately, so a site cannot probe which credentials
you hold. So unlock cannot detect this case, only describe it: `getPrfSecret`'s `forUnlock`
option turns that error into a message naming both possibilities. Registration's fallback
`get()` deliberately does not use it, because there the credential was just created and a
refusal means something else.

### How it is surfaced

One Settings section, **Tap to unlock** (`TapToUnlockSection`), holds platform
authenticators and security keys together, because they are one mechanism: same slot,
same list, same revoke path. Add asks which one, and that is forced rather than a UX
preference, since the two need incompatible `residentKey` values and the ceremony is
chosen before the OS dialog opens.

Gating is two capabilities, deliberately:

- `webauthnUnlock` (chromium + firefox) gates the section and the unlock-screen button.
- `securityKeys` (chromium only) decides whether Add offers **Security key**. Firefox
  shows the section with only the device option.

Rows report where a key works, from the `synced` flag the ceremony measured, not from the
OS: "all your devices" for an Apple Passwords credential, "this device only" for Windows
Hello. Labels live in the `pref.securityKeyLabels` local pref and never travel with the
vault file, so a slot registered on another device reads as an unnamed security key;
`describeWebauthnKeys` in `slot-policy.ts` holds those fallbacks and their tests.

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

The join screen offers **Master password**, **This device** (Touch ID / Windows Hello)
and, where `securityKeys` allows, **Security key**, gated on `webauthnUnlock` so it is
hidden where PRF can't work (mobile webviews; see [mobile-port.md](mobile-port.md)).

The key options are not a convenience. A vault whose master password is off has no
password slot, so the inviter ships no `passwordCheck` and nothing verifies what the
joiner types (`enroll-host.ts` falls back to a local confirm-password guard, which only
catches typos). Joining such a vault with a password therefore invents one, wraps the VEK
under it, and puts a password slot back into a vault that deliberately had none. Joining
with a key mints a slot against the joining device's OWN authenticator instead, so the
vault stays password-less and each device keeps its own key. Nothing is transferred from
the inviter either way: the hmac-secret goes popup to offscreen on one machine, exactly as
a typed password does.

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
