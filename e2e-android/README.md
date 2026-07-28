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

## Writing tests here: the device holds real data

`smoke.spec.ts` is deliberately read-only. It navigates but never creates, edits or deletes a
vault, so it is safe against a device with real vaults on it.

Anything that mutates vault state must create and delete **its own** vaults and never touch
existing ones. A test that deletes "the first vault" will delete somebody's passwords. There is
no sandbox here and no undo.
