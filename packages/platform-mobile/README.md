# @vault/platform-mobile

Capacitor (iOS + Android) shell for Bramble. A Vite SPA that mounts `@core`'s `App`
with mobile adapters (`src/adapters/`). Phase 0 walking skeleton: in-app vault UI,
WASM crypto, filesystem storage. System autofill, biometric unlock, and sync are
later phases (see `docs/mobile-port.md`).

## Prerequisites

- iOS: macOS + Xcode. Android: Android Studio + SDK + NDK.
- A simulator/emulator or a physical device.

## Build the web bundle (run after any web change)

```bash
pnpm core:build          # from repo root: builds WASM into public/wasm + Vite dist
```

Run this once before the first native launch, and again whenever the Rust WASM
changes. Plain JS/TS/CSS changes are picked up by the live-reload flow below.

## Run

From `packages/platform-mobile`:

```bash
pnpm dev              # browser only (plugins no-op) — quickest boot check
pnpm dev:ios          # iOS sim/emulator + Vite HMR (localhost)
pnpm dev:android      # Android emulator/device + Vite HMR (adb reverse)
pnpm dev:ios:lan      # physical iOS device + HMR (loads from your Mac's LAN IP)
pnpm dev:android:lan  # physical Android device + HMR
pnpm run:ios          # build bundled assets, deploy, launch on iOS (no dev server)
pnpm run:android      # same for Android
```

Open the native projects in their IDEs with `pnpm exec cap open ios` / `... android`.

## Live-reload gotcha (important)

The `dev:*` scripts bake a `server.url` (`http://localhost:5173`) into the native app
so it loads from the Vite dev server. If you then run the app with Vite **not** running,
you get a blank screen (`-1004 cannot connect to host`). After a `dev:*` session, run a
plain bundled launch once before testing offline:

```bash
pnpm core:build && pnpm run:ios     # resets to bundled assets, no dev-server URL
```

So: `dev:ios`/`dev:android` (Vite up, HMR) and `run:ios`/`run:android` (bundled) are two
distinct modes; don't relaunch a `dev:*` build with Vite down.

## Simulators on an external drive

CoreSimulator cannot create devices on a non-internal volume (the runtime data-template
copy fails with "Operation not permitted" / stuck in creation state). Keep the device
set (`~/Library/Developer/CoreSimulator/Devices`) on the internal disk.
