# platform-mobile development guide

How to develop the Bramble mobile app (Capacitor 8, iOS + Android), the quirks we
hit standing it up, and how to get past each one. For the high-level port plan see
`../../../docs/mobile-port.md`; for a terse quickstart see `../README.md`.

## Architecture in one paragraph

`packages/platform-mobile` is a Vite single-page app that mounts `@core`'s `App`
(`src/main.tsx`) with five mobile adapters (`src/adapters/`) implementing the
`PlatformContext` interface: `storage` (`@capacitor/filesystem` + `@capacitor/preferences`),
`crypto` (in-webview Rust WASM, no offscreen hop), `clipboard` (`@capacitor/clipboard`
+ a JS auto-clear timer), plus stubbed `shell` and `autofill` (later phases). The built
SPA is wrapped by the native iOS/Android projects under `ios/` and `android/`, which are
committed and owned (edit them directly in Xcode / Android Studio).

## The build pipeline

```
crypto-wasm (Rust)  --wasm-pack-->  public/wasm/      (WASM crypto module)
@core + src         --vite------->  dist/             (the SPA)
dist/               --cap sync-->   ios/, android/     (native web assets)
```

- `pnpm core:build` (repo root) = `wasm:build:mobile` + the Vite build. It produces
  `public/wasm/` and `dist/`. Run it once before the first native launch, and again
  whenever the **Rust** changes.
- Plain JS/TS/CSS changes do **not** need `core:build` during a live-reload session
  (see below) — Vite HMR handles them.

## Day-to-day commands (run from `packages/platform-mobile`)

| Command | Mode | Notes |
|---|---|---|
| `pnpm dev` | Browser | Plugins no-op; fastest "does it boot" check. |
| `pnpm dev:ios` / `dev:android` | Device/sim + **HMR** | Vite + `cap run -l` together. Edit web code, it hot-reloads on device. |
| `pnpm dev:ios:lan` / `dev:android:lan` | Physical device + HMR | App loads from your Mac's LAN IP instead of localhost. |
| `pnpm run:ios` / `run:android` | Bundled | Build + deploy bundled assets, no dev server. Use for offline testing. |
| `pnpm test` | Node (vitest) | Unit tests for the adapters. Native plugins are mocked (`registerPlugin`), so this checks JS-side logic only, never the OS biometric/keychain path. |
| `pnpm sim:reset` | — | Fix an off-screen iOS Simulator window (see quirks). |

`dev:*` (HMR) and `run:*` (bundled) are two distinct modes. The iOS scripts auto-target
the newest iPhone simulator via `scripts/pick-ios-target.mjs`, so `cap run`'s device
picker is skipped.

## Quirks we hit (and the fix)

### 1. Live-reload bakes a dev-server URL into the app
`dev:*` runs `cap run -l`, which writes `server.url = http://localhost:5173` into the
native app so it loads from Vite. If you later launch that build with **Vite not
running**, you get a blank screen and `WebKit ... didFailProvisionalLoad ... code=-1004`
("cannot connect to host") in the logs.

Fix: after a `dev:*` session, do one bundled launch before testing offline:
```bash
pnpm core:build && pnpm run:ios
```
Also note `cap copy` updates the *source* project only — an already-installed app keeps
its baked-in config until you rebuild+redeploy (`cap run` / `run:ios`).

### 2. Capacitor 8 iOS uses Swift Package Manager, not CocoaPods
There is no `Podfile` / `.xcworkspace`; the project is `ios/App/App.xcodeproj` plus a
`CapApp-SPM` local Swift package. Build with `-project App.xcodeproj` (not
`-workspace`). When we add the autofill extension target later, it links the shared Rust
`.xcframework` and the Capacitor SPM products via SPM/framework references, not a Podfile.

### 3. Simulators cannot live on an external drive
Symptom: `simctl create` fails with "Device was allocated but was stuck in creation
state", and the log shows `Error copying sample content ... Operation not permitted` even
with an APFS, owners-enabled, Full-Disk-Access-granted setup. CoreSimulator clones the
runtime's data template into the device dir, and that cross-volume copy onto an external
volume is rejected.

Fix: keep the device set on the internal disk. If `~/Library/Developer/CoreSimulator/Devices`
is a symlink to an external volume, replace it with a real folder:
```bash
rm ~/Library/Developer/CoreSimulator/Devices
mkdir -p ~/Library/Developer/CoreSimulator/Devices
```
The 16 GB of iOS runtimes can stay where they are; only the device set must be internal.
(TCC / Full Disk Access is a red herring here — the daemon already has it.)

### 4. "Cannot allocate memory" from simctl
If the device set symlink points at an **unmounted** external volume, CoreSimulator
fails to initialize with a misleading `SimError 400 ... Cannot allocate memory`. It is
not a RAM problem — the device set is just unreachable. Mount the volume, or (better)
move the device set to internal per quirk #3.

### 5. External volume mounted with `noowners`
Before fixing #3 we also saw EPERM because the external volume was mounted "Ignore
ownership on this volume" (`noowners`). If you must use an external volume for anything
CoreSimulator/Xcode touches: `sudo diskutil enableOwnership /Volumes/<name>` (or uncheck
"Ignore ownership" in Finder → Get Info). Note `noowners` can return after a remount.

### 6. DerivedData on an external drive breaks builds when unmounted
If Xcode's DerivedData is redirected to an external drive (Settings → Locations) and the
drive isn't mounted, builds fail with permission/`mktemp` errors. Either mount it, set
DerivedData back to Default, or pass `-derivedDataPath /tmp/<x>` for one-off CLI builds.

### 7. `cap run` device picker can't receive arrow keys
Under `concurrently` the interactive "choose a target device" prompt can't read arrow
keys. Fixed by passing `--target $(node scripts/pick-ios-target.mjs)` so there's no
prompt. To target a specific device: `pnpm exec cap run ios --target <udid>`.

### 8. Simulator window opens off-screen / not visible
After disconnecting an external display, Simulator may place the device window on the
phantom display (its saved geometry references it), and even the Dock's Device menu is
empty. Fix:
```bash
pnpm sim:reset
```
This quits Simulator, backs up and clears the per-device window geometry
(`DevicePreferences`), points it at the newest iPhone, and reopens it. Then re-run
`pnpm dev:ios`. Backup is written to `/tmp/sim-deviceprefs-backup.txt`.

### 9. Content rendered wider than the screen (WKWebView phantom zoom)
Symptom: the right edge of every screen is clipped (buttons/cards cut off). Measuring in
the webview showed `window.innerWidth` (visual viewport, 385) smaller than
`document.documentElement.clientWidth` (layout viewport, 440) — WKWebView was applying a
zoom so content laid out at 440 but only 385 was visible. `initial-scale=1` alone did not
prevent it. Fix in `index.html`: lock the scale.
```html
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
```
With the scale locked, visual == layout viewport and content fits. (Disabling pinch-zoom
is expected for a native-app-like shell.) To diagnose a recurrence, temporarily log
`window.innerWidth` vs `document.documentElement.clientWidth`; if they differ, it's this.

### 10. Adding an in-house native (local) Capacitor plugin
The biometric unlock ships as a **local plugin** living inside the owned native projects
(no separate npm package). The pattern, both platforms:

- **iOS** (`ios/App/App/BiometricVault.swift`): a `CAPPlugin, CAPBridgedPlugin` class plus a
  `CAPBridgeViewController` subclass that registers it in `capacitorDidLoad()` via
  `bridge?.registerPluginInstance(...)`. The subclass is wired by changing the bridge VC's
  `customClass`/`customModule` in `Base.lproj/Main.storyboard` (module is `App`, the target
  name). A new `.swift` file must be added to `project.pbxproj` in four places (PBXBuildFile,
  PBXFileReference, the `App` PBXGroup children, and the Sources build phase). JS side:
  `registerPlugin<T>("BiometricVault")`.
- **Android** (`android/app/src/main/java/app/bramble/mobile/BiometricVaultPlugin.java`): a
  `@CapacitorPlugin(name = "BiometricVault")` class extending `Plugin`, registered with
  `registerPlugin(BiometricVaultPlugin.class)` in `MainActivity.onCreate` (before
  `super.onCreate`).
- **Both survive `cap sync`.** Verified: `cap sync` rewrites only `public/`, the generated
  `capacitor.config.json`, and the plugin list (`Package.swift` / `capacitor.*.gradle`); it does
  **not** touch the storyboard, `pbxproj`, `MainActivity`, or hand-added native source. Re-check
  with `grep customClass ios/.../Main.storyboard` and `grep -c BiometricVault.swift
  ios/App/App.xcodeproj/project.pbxproj` after a sync.

### 11. Android build needs JDK 21 (Android Studio's JBR)
The Capacitor plugin Gradle modules declare a Java 21 toolchain, so a system JDK 17 build fails
with "Cannot find a Java installation ... matching {languageVersion=21}". Point Gradle at the
JDK 21 that Android Studio bundles:
```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
(cd android && ./gradlew :app:compileDebugJavaWithJavac)   # fast Java-only compile check
```
The Android SDK path is already in `android/local.properties` (`sdk.dir`).

### 12. Testing biometric unlock on the simulator
The sim has no real biometrics; enroll a virtual one: Simulator menu **Features -> Face ID ->
Enrolled**. Flow: unlock with the master password, open **Settings -> Biometric unlock** and
toggle it on (on iOS this stores the VEK with no prompt; the prompt is on *read*), then lock
(or relaunch) and tap **Unlock with biometrics** on the unlock screen. Trigger the match with
**Features -> Face ID -> Matching Face**; **Non-matching Face** exercises the failure path. The
Settings toggle re-probes availability on open, so enrolling Face ID after launch is picked up
without a relaunch. Enable is iOS-silent; on Android enabling itself shows a `BiometricPrompt`
(the Keystore key needs auth to encrypt).

## Reclaiming disk space

The iOS runtimes are the big consumers (~8 GB each). List and delete unused ones rather
than moving them to an external drive (which reintroduces quirks #3–#6):
```bash
xcrun simctl runtime list
xcrun simctl runtime delete <runtime-id>
xcrun simctl delete unavailable   # remove orphaned devices
```
