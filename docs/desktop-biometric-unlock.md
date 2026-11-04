# Desktop biometric unlock: Touch ID and Windows Hello

Plan for unlocking the desktop app with Touch ID on macOS and Windows Hello on Windows instead of
the master password. Asked for repeatedly, most recently in #180, which also covered the browser
extension; that half shipped separately (the extension's passkey unlock gained "Unlock on open").

Status: **built 2026-11-03; Windows Hello and Touch ID both work in the app.** Core flag and
labels, the desktop adapter, the Rust module, the macOS gate and the Windows Hello gate. On a
Windows 11 VM (unsigned cross-built installer, local account, PIN), the app armed the gate,
unlocked with it, prompted on open, did not prompt after the Lock button, and brought the Hello
dialog to the front. On a Mac, a build made by `scripts/build-macos.ts` (Developer ID, the
entitlement and the embedded profile; see docs/release-signing.md) armed the gate, unlocked with
one Touch ID sheet, and prompted once on open. An unsigned build reports the gate unavailable,
which a test pins. CI needs the `APPLE_PROVISIONING_PROFILE` secret before the next desktop
release. Nothing is released.

## What already exists

Almost everything above the OS. Mobile's biometric unlock is built against one interface,
`BiometricUnlock` in `packages/core/src/adapters/biometric.ts`, and everything around it is shared
and platform-blind: the unlock button and its labels (`Auth.tsx`), the Settings section
(`BiometricSection.tsx`), "Unlock on open" (`auto-biometric.ts`), the passcode-fallback choice,
re-arming after an unlock, and tearing down a gate whose cached key no longer opens the vault
(`vault/biometric-unlock.ts`). `useVault` turns all of it on when `platform.biometric` is defined.

The desktop app does not define it (`clients/desktop/src/main.tsx`: "Touch ID / Windows Hello is
phase 1"). That is the whole gap: one native implementation per OS, and a few labels.

## The model

The same as mobile. Per vault, the VEK is cached on the device in a place the OS releases only
after Touch ID or Windows Hello. It is a convenience in front of the vault, not a slot in it:
nothing is added to the vault file, other devices know nothing about it, and the master password
keeps working. Losing the gate (new fingerprints, Windows Hello reset) costs a password unlock,
never the vault.

## The key stays in Rust

On desktop the VEK already lives in the Rust process (`src-tauri/src/crypto.rs`), so the gate can
read the key from the crypto session to arm itself and install it there on unlock, without the
key ever entering the webview. That is item 4 of
[vek-residency-hardening.md](vek-residency-hardening.md) ("native-only biometric gate"), and
desktop is where it is worth most: that doc ranks macOS and Linux first because they have real
swap and real core dumps.

Mobile keeps today's shape until that item lands for it. The interface gains one flag:

```ts
/** The gate reads the VEK from, and installs it into, the native crypto session itself. */
holdsKeyNatively?: boolean;
```

`enableBiometricUnlock` skips `crypto.exportVek()` and `unlockVekWithBiometric` skips
`crypto.unlockWithVek()` when it is set. When item 4 moves mobile over, the flag becomes the only
behaviour and goes away.

## Native commands

A `biometric` module in `src-tauri`, one implementation per OS behind the same commands:

| Command | Does |
|---|---|
| `biometric_status` | Available, the modality (`touchId`, `windowsHello`), and whether a biometric is enrolled |
| `biometric_is_enabled(vault_id)` | Whether this vault has a cached key, without prompting |
| `biometric_enable(vault_id, allow_passcode)` | Reads the VEK from the session and caches it behind the gate |
| `biometric_unlock(vault_id, allow_passcode)` | Prompts, then installs the cached VEK into the session |
| `biometric_disable(vault_id)` | Deletes the cached key |

Errors reach JS as `{ code, message }` objects, so the codes the core already reads
(`cancelled`, `interrupted`, `invalidated`, `lockout`) work unchanged. A gate that cannot work on
this build (see signing below) reports itself unavailable, so the UI hides the feature rather
than offering a toggle that fails.

## macOS

The iOS design (`clients/mobile/ios/App/App/BiometricVault.swift`), in Rust:

- A generic-password item in the **data protection keychain**, one per vault, access group
  `BHGR3PP64J.app.bramble.desktop`, accessible only when the Mac is unlocked and only on this
  device.
- Access control fixed when the item is written: `.biometryCurrentSet` (Touch ID only; macOS
  deletes the item if the enrolled fingers change, which surfaces as `invalidated`) or, with
  passcode fallback on, `.userPresence` (Touch ID or the Mac's login password).
- Unlock evaluates an `LAContext` first, so cancel and lockout are told apart, then reads the item
  with that authenticated context, as iOS does.
- Every other read must not prompt, and on macOS even an attribute read can (its generic "needs
  to authenticate to continue" sheet). The existence check passes a context with
  `interactionNotAllowed`, and "would have needed you" counts as present, as iOS's check does.
- Re-arming deletes the old item, and macOS guards that with Touch ID, so desktop declares
  arming not silent and the core never re-arms after an unlock. A passcode-fallback change
  re-arms from Settings, where a prompt is expected.
- Availability from `LAContext.canEvaluatePolicy`. **Decision:** offered only when Touch ID is
  enrolled. On a Mac without it, the only gate would be the login password, which is mostly a
  weaker master password; iOS offers its passcode-only gate because a phone's passcode is the
  everyday unlock, which a Mac password typed at login is not.

Crates: `security-framework` (already in the tree through `keyring`) for the keychain and access
control, `objc2-local-authentication` for `LAContext`.

**Signing is a hard requirement.** The data protection keychain needs the app signed with a
`keychain-access-groups` entitlement and its provisioning profile embedded in the bundle.
`scripts/build-macos.ts` does both for a Developer ID signed build, and moves the browser-link
helper to `Contents/Helpers` so Tauri cannot sign the entitlement onto it; the details are in
[release-signing.md](release-signing.md). The same profile serves the macOS credential provider
([macos-credential-provider.md](macos-credential-provider.md)). An unsigned or dev build gets
`errSecMissingEntitlement` (-34018), which the module reads as "unavailable".

## Windows

Windows Hello's own key API, `Windows.Security.Credentials.KeyCredentialManager`, so the unlock is
bound to the Hello check cryptographically rather than trusting a yes/no answer:

- On enable, open (or create) a Hello key credential named per vault, and sign a fresh random
  challenge with it (this is the Hello prompt). The signature is handed to the core's
  `wrap_vek_webauthn` as if it were a security key's hmac-secret: the same HKDF, verifier and
  AES-GCM wrap, so this adds no crypto of its own. The challenge, slot id and wrapped VEK go in
  Credential Manager under the app's service, where the uninstaller's sweep finds them.
- On unlock, sign the same challenge again (prompt) and hand the signature to
  `unwrap_vek_webauthn`, which checks the verifier before loading the VEK. A verifier mismatch
  means the Hello key changed, reported as `invalidated`.
- **It relies on the signature being identical every time, and it is.** Checked 2026-11-03 on
  Windows 11 for Arm (VMware Fusion, virtual TPM) with a local account and a PIN: one 32-byte
  challenge signed twice, then again through a reopened key, gave the same 256-byte RSA
  signature all three times. The check was a PowerShell script against `KeyCredentialManager`,
  not the app. Hello also works for a local account, not only a Microsoft one.
- Every signature prompts, except one made right after the key is created, which rides on the
  creation prompt. So arming costs one prompt (new key or existing), and so does each unlock.
- Hello always accepts its PIN, so there is no passcode-fallback choice to offer: the capability
  is off on Windows and the Settings row hides. The label is "Windows Hello".
- A reset or removed Hello key fails to open, which surfaces as `invalidated`.
- Windows opens the Hello dialog without the foreground, so even from the app it sat minimised
  and flashing in the taskbar, and `KeyCredentialManager` takes no owner window. The fix, as in
  KeePassXC: once a request starts, find the dialog by its window class
  (`Credential Dialog Xaml Host`) and raise it, which Bramble may do because it is the foreground
  app when it asks. Confirmed in the app on the Windows VM: the dialog now comes forward.

Crate: `windows` (already in the tree at 0.62) with the `Foundation`, `Security_Credentials`,
`Security_Cryptography` and `Storage_Streams` features.

## Linux

Not offered. There is no hardware-backed equivalent: fprintd behind polkit is a yes/no answer the
app would have to trust, not something that protects the key.

## Core and UI changes

- `BiometricUnlock.holdsKeyNatively`, honoured in `vault/biometric-unlock.ts`.
- `BiometryType` gains `"windowsHello"`, with its own label where Touch ID has one.
- The desktop flags enable `biometricPasscodeFallback` on macOS only.
- `clients/desktop/src/adapters/biometric.ts` maps the commands to the interface and is wired
  into `main.tsx`.
- Later: the spotlight panel's locked-vault prompt (desktop-port.md) offers Touch ID too.

## Order

1. Core flag and labels, the desktop adapter, and the Rust module's command surface with the
   macOS implementation. Testable end to end only on a signed build.
2. Windows Hello, tested on a real Windows machine: first that two signatures over one challenge
   match, then the prompt's placement over the app window.
3. The spotlight prompt.

Paired extension unlock through the desktop ("Deferred: extension unlock delegation" in
desktop-port.md) builds on this, but also needs desktop sync first.
