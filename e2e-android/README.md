# On-device Android e2e (CDP over adb)

Drives the **installed app on a real device** with Playwright, by attaching to the WebView's
devtools socket. Unlike the browser-hosted mobile app, this exercises the shipped native layer:
the uniffi Rust core, Capacitor's native Filesystem/Preferences, real `.bak` rotation.

## Running

```sh
pnpm test:e2e:android
```

Needs:

- exactly one device in `adb devices` (set `ANDROID_SERIAL` if you have several)
- a **debuggable** build installed — Capacitor only opens the devtools socket for those. A
  release build will fail with "did not start (is it installed and debuggable?)".

Overrides: `ADB`, `ANDROID_HOME`, `ANDROID_CDP_PORT` (default 9222), `ANDROID_APP_ID`.

These are **not** part of `pnpm test:e2e`; `playwright.config.ts` only covers `./e2e`.

## What it can and can't see

CDP attaches to the WebView, so it sees the app's DOM and nothing else. Native UI — the Android
autofill sheet, biometric prompts, the system file picker — is invisible here. Those need
Espresso (already declared in `android/app/build.gradle`) or a tool like Maestro.

## The extension <-> device sync test

`pair-with-extension.spec.ts` pairs the browser extension with the **shipped app on the device**
over a relay running on this machine. It is the only test where the joiner rebuilds its vault with
the uniffi Rust core and the Android storage adapter — the layer issue #27 shipped on.

Two things make it work, and both fail as ordinary test failures rather than obvious ones:

- `adb reverse tcp:7400 tcp:7400` routes the DEVICE's localhost to this machine's relay. That also
  means the pairing code's `ws://localhost:7400` is valid verbatim on both peers, so the code the
  inviter really produced is the one the joiner consumes.
- The WebRTC data channel needs a real IP route between phone and host. Same LAN is enough; a
  guest network with client isolation is not.

It **mutates the device**: the joiner ends up with a real vault, which the test then deletes.
Verified self-cleaning — the device had 3 vaults before and after two consecutive runs. A mid-test
failure will leave a stray `e2e-*` vault behind for you to clear.

## Writing tests here: the device holds real data

`smoke.spec.ts` is deliberately read-only. It navigates but never creates, edits or deletes a
vault, so it is safe against a device with real vaults on it.

Anything that mutates vault state must create and delete **its own** vaults and never touch
existing ones. A test that deletes "the first vault" will delete somebody's passwords. There is
no sandbox here and no undo.
