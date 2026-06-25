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
pnpm sim:reset        # fix an off-screen iOS Simulator window
```

For the full dev flow, the build pipeline, and fixes for the environment quirks we hit
(external-drive simulators, off-screen windows, live-reload blank screens, etc.), see
[docs/development.md](docs/development.md).

Open the native projects in their IDEs with `pnpm exec cap open ios` / `... android`.

The iOS scripts auto-pick the newest available iPhone simulator (via
`scripts/pick-ios-target.mjs`) and pass it as `--target`, so `cap run`'s interactive
device picker is skipped (it can't receive arrow keys when wrapped in `concurrently`).
To target a specific device, run `pnpm exec cap run ios --target <udid>` directly.

## Build & install an Android APK

From the repo root, build the native inputs (web bundle + Rust crypto libs). Run these on a
fresh checkout and again after any **Rust** change (the `jniLibs` are gitignored, not committed):

```bash
pnpm core:build            # WASM + Vite web bundle (public/wasm, dist/)
pnpm ffi:build:android     # Rust jniLibs + uniffi Kotlin glue (needs the NDK + cargo-ndk)
```

Then from `packages/platform-mobile`, either build + deploy + launch in one step (JDK handled):

```bash
pnpm run:android           # cap run; JDK 21 auto-resolved via scripts/run-android.mjs
```

…or produce a standalone debug APK and install it on a connected device:

```bash
pnpm exec cap sync android                                  # copy web assets + plugins into android/
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # JDK 21 (see below)
(cd android && ./gradlew assembleDebug)                     # -> android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`adb` lives in `~/Library/Android/sdk/platform-tools`; add it to your PATH or use the full path.

**JDK 21 is required for Gradle.** The Capacitor plugin modules declare a Java 21 toolchain, so a
direct `gradlew` build on the system-default JDK 17 fails with
`Cannot find a Java installation ... {languageVersion=21}`. `pnpm run:android` and the
`dev:android*` scripts set `JAVA_HOME` for you; only direct Gradle needs it by hand. More in
[docs/development.md](docs/development.md) (quirk 11).

## Verifying a release APK

Release builds are published on the project's GitHub Releases (tag `<version>-android`) as
`bramble_android_<version>.apk` next to a `SHA256SUMS`. The app is signed with Bramble's release
key, which Android pins: every update must be signed by the same key, so the signing
**certificate fingerprint is the trust anchor**. Bramble's release certificate SHA-256 is:

```
46:4F:5E:91:3C:22:D5:80:F5:8A:46:67:A3:AD:B2:B7:20:E6:FC:CE:05:F7:C0:60:5C:B4:56:02:FB:97:EC:E1
```

To verify a download:

```bash
# Authenticity: confirm the APK is signed by the key above (use either tool).
apksigner verify --print-certs bramble_android_<version>.apk   # Android SDK; compare "SHA-256 digest"
keytool -printcert -jarfile bramble_android_<version>.apk      # any JDK; compare "SHA256"

# Integrity: confirm the download wasn't corrupted.
shasum -a 256 -c SHA256SUMS    # macOS  (sha256sum -c on Linux)
```

`apksigner` prints the fingerprint lowercase without colons and `keytool` uppercase with colons;
they are the same bytes. If it does not match the fingerprint above, do not install. The signing
setup is in [docs/release-signing.md](../../docs/release-signing.md).

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
