# platform-mobile development guide

How to develop the Bramble mobile app (Capacitor 8, iOS + Android), the quirks we
hit standing it up, and how to get past each one. For the high-level port plan see
`../../../docs/mobile-port.md`; for a terse quickstart see `../README.md`.

## Architecture in one paragraph

`clients/mobile` is a Vite single-page app that mounts `@core`'s `App`
(`src/main.tsx`) with five mobile adapters (`src/adapters/`) implementing the
`PlatformContext` interface: `storage` (`@capacitor/filesystem` + `@capacitor/preferences`),
`crypto` (in-webview Rust WASM, no offscreen hop), `clipboard` (`@capacitor/clipboard`
+ a JS auto-clear timer), plus stubbed `shell` and `autofill` (later phases). The built
SPA is wrapped by the native iOS/Android projects under `ios/` and `android/`, which are
committed and owned (edit them directly in Xcode / Android Studio).

## The build pipeline

```
core-rust (Rust)  --wasm-pack-->  public/wasm/      (WASM crypto module)
@core + src         --vite------->  dist/             (the SPA)
dist/               --cap sync-->   ios/, android/     (native web assets)
```

- `pnpm core:build` (repo root) = `wasm:build:mobile` + the Vite build. It produces
  `public/wasm/` and `dist/`. Run it once before the first native launch, and again
  whenever the **Rust** changes.
- Plain JS/TS/CSS changes do **not** need `core:build` during a live-reload session
  (see below) — Vite HMR handles them.

## Day-to-day commands (run from `clients/mobile`)

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
- **The `registerPluginInstance` line is the step that actually matters, and forgetting it fails
  silently.** Capacitor 8 does **not** discover plugins through the Objective-C runtime: it registers
  `packageClassList` from the generated `capacitor.config.json` (npm-packaged plugins only), plus
  whatever `capacitorDidLoad()` adds. A local plugin that compiles, links, and appears in the binary
  is still invisible to JS until it is added to that list in `BiometricVault.swift`; calls to it
  reject with "not implemented", which an adapter that swallows errors will report as "feature
  unavailable". Adding the file to `project.pbxproj` is necessary but not sufficient.
  ```bash
  # every local plugin class should appear in the registration list
  grep -c registerPluginInstance ios/App/App/BiometricVault.swift
  ```
- **Both survive `cap sync`.** Verified: `cap sync` rewrites only `public/`, the generated
  `capacitor.config.json`, and the plugin list (`Package.swift` / `capacitor.*.gradle`); it does
  **not** touch the storyboard, `pbxproj`, `MainActivity`, or hand-added native source. Re-check
  with `grep customClass ios/.../Main.storyboard` and `grep -c BiometricVault.swift
  ios/App/App.xcodeproj/project.pbxproj` after a sync.

### 11. Android build needs JDK 21 (Android Studio's JBR)
The Capacitor plugin Gradle modules declare a Java 21 toolchain, so a system JDK 17 build fails
with "Cannot find a Java installation ... matching {languageVersion=21}".

`pnpm run:android` / `dev:android` / `dev:android:lan` **handle this automatically** — they go
through `scripts/run-android.mjs`, which points `JAVA_HOME` at a JDK 21 (an already-21 `JAVA_HOME`,
else `java_home -v 21` *verified to actually be 21*, else Android Studio's bundled JBR) before
running `cap`. Android Studio's own Run button is also fine (it uses its embedded JDK).

You only need to set it by hand for **direct Gradle** invocations:
```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
(cd android && ./gradlew :app:compileDebugJavaWithJavac)   # fast Java-only compile check
```
The Android SDK path is already in `android/local.properties` (`sdk.dir`). Note `java_home -v 21`
falls back to the newest JDK when 21 is absent, so don't trust it blindly (the wrapper verifies).

### 12. Testing biometric unlock on the simulator
The sim has no real biometrics; enroll a virtual one: Simulator menu **Features -> Face ID ->
Enrolled**. Flow: unlock with the master password, open **Settings -> Biometric unlock** and
toggle it on (on iOS this stores the VEK with no prompt; the prompt is on *read*), then lock
(or relaunch) and tap **Unlock with biometrics** on the unlock screen. Trigger the match with
**Features -> Face ID -> Matching Face**; **Non-matching Face** exercises the failure path. The
Settings toggle re-probes availability on open, so enrolling Face ID after launch is picked up
without a relaunch. Enable is iOS-silent; on Android enabling itself shows a `BiometricPrompt`
(the Keystore key needs auth to encrypt).

### 13. AutoFill credential-provider probe (the Phase 3 seed)
`ios/App/AutoFillProbe/` is a minimal AutoFill Credential Provider Extension, added by
`scripts/add-autofill-probe.rb` (uses the `xcodeproj` gem — `gem install --user-install
xcodeproj` — to add the target surgically without disturbing the Capacitor/SPM project).
It's the **seed for the real provider**, kept committed; its VC only shows a debug label
and `AppDelegate` writes a dummy value to the App Group, so **replace/remove it before any
shipping build**. Hard-won setup notes:

- **App Group is the app<->extension channel.** Both `App/App.entitlements` and
  `AutoFillProbe/AutoFillProbe.entitlements` declare `group.app.bramble.mobile`; the app
  writes with native `UserDefaults(suiteName:)` (Capacitor Preferences can't write to a
  group). The extension reads the same container.
- **The AutoFill capability is restricted** — it needs real provisioning, not ad-hoc.
  `DEVELOPMENT_TEAM` is set on both targets; build with `-allowProvisioningUpdates` so Xcode
  registers both App IDs + the `autofill-credential-provider` and App Group capabilities
  under the account. Ad-hoc / `CODE_SIGNING_ALLOWED=NO` silently drops the entitlement.
- **iOS 18+ requires a capability declaration** or the provider never appears: the Info.plist
  needs `NSExtension > NSExtensionAttributes > ASCredentialProviderExtensionCapabilities >
  ProvidesPasswords = true`.
- **The simulator does NOT list third-party AutoFill providers in Settings.** Registration is
  fine (`xcrun simctl spawn <udid> pluginkit -m -p com.apple.authentication-services-credential-provider-ui`
  shows the extension bound to the AutoFill point), but the Settings UI and the live fill flow
  are **device-only**. Don't chase the sim here — verify the toggle + fill on real hardware.
- Verify it built into the app: `find <DerivedData>/Build/Products -name '*.appex'` and
  `ls App.app/PlugIns`. Confirm entitlements via the `*-Simulated.xcent` (the sim variant; the
  plain `.xcent` is the device one and reads empty on a sim build).
- **The autofill entitlement must be on BOTH the app and the extension targets.** Putting it only
  on the extension installs fine for dev but fails App Store validation with a 409 "Missing
  Entitlement" for `App.app`, AND keeps the provider out of the Settings list. It's now in both
  `App/App.entitlements` and `AutoFillProbe/AutoFillProbe.entitlements`. This was the main reason it
  didn't list.
- **Build the extension in Release, not Debug.** Xcode 16's debug-dylib stub
  (`AutoFillProbe.debug.dylib`) can stop an app extension from registering as a provider;
  `ENABLE_DEBUG_DYLIB_SUPPORT=NO` did not drop it here, but a Release build has no stub.
- **CONFIRMED end-to-end on a real device (2026-06-22)** via a TestFlight (distribution) build:
  Bramble appears in Settings → AutoFill & Passwords, enables, launches in a live Safari fill, and
  reads the App Group value the app wrote. The whole chain works. (A dev build never cleanly
  isolated dev-signing vs the entitlement because device-trust install walls kept blocking it; the
  TestFlight build, with the entitlement on both targets, just worked. Earlier notes blaming an
  "MDM device" were wrong — the phone is personal/unenrolled; `ManagedConfiguration`/`profiled`
  logs appear on every iOS device and are not MDM evidence.)
- To make the IPA: archive Release with `-derivedDataPath` on the **internal** disk (the Transcend
  external drive EPERMs the SPM `SourcePackages` cache), export with the `app-store-connect` method,
  and ensure a valid **Apple Distribution** cert exists (recreate via Xcode → Manage Certificates if
  the team's is revoked). `ITSAppUsesNonExemptEncryption=false` in Info.plist skips the upload's
  export-compliance prompt. Diagnose discovery with `idevicesyslog -u $(idevice_id -l) | grep -iE
  "credential|EXConcreteExtension|AuthenticationServicesAgent"`.

### 14. "Can't find variable: WebAssembly" on a real iOS device (JIT disabled)
All of Bramble's crypto is WASM (Argon2/AES/KDBX), and WASM needs JIT. iOS disables JIT in two
states, and in both the app throws `ReferenceError: Can't find variable: WebAssembly` and the
vault can't be created/unlocked:

- **Lockdown Mode (Settings → Privacy & Security → Lockdown Mode).** Disables JIT system-wide.
  This is a **product limitation**, not just a dev issue: the app does not work under Lockdown
  Mode until crypto moves to the native Rust core (Phase 3 uniffi, no JIT needed). If a test
  device shows the error and isn't under the debugger, check Lockdown Mode first.
- **Running attached to the Xcode debugger (lldb).** Launching via Xcode's Run attaches lldb,
  which disables JIT for the webview. Fix: fully quit the app (swipe away) and **launch from the
  home-screen icon**, or Edit Scheme → Run → Info → uncheck "Debug executable", or build Release.

The simulator does not enforce either restriction, so WASM always works there — this only bites on
real hardware.

### 15. Native crypto (uniffi) shares one Rust crate with WASM
`packages/core-rust` (`vault-crypto`) builds **two binding layers from one pure core**, chosen by
Cargo feature, so the same audited crypto serves the webview and native code:

- **`wasm` (default):** the `#[wasm_bindgen]` surface wasm-pack already builds. Unchanged; the JS
  exports are byte-identical (`pnpm wasm:build` / `wasm:build:mobile`).
- **`ffi`:** `uniffi` exports that generate Swift + Kotlin. Build the bindings + native libs with
  `pnpm ffi:bindings` (host-only, just the `.swift`/`.kt`), `ffi:build:ios` (XCFramework; needs
  Xcode + `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`), or
  `ffi:build:android` (jniLibs; needs `cargo install cargo-ndk` + `ANDROID_NDK_HOME`). Outputs land
  in `native-build/` (gitignored). Driver: [`scripts/build-crypto-ffi.sh`](../../../scripts/build-crypto-ffi.sh).

Gotchas: the two layers are **mutually exclusive** (each owns the bare export names; a
`compile_error!` fires if both features are on); the FFI build is `--no-default-features --features ffi`.
The bindgen step uses uniffi **library mode** (reads the compiled cdylib), and the `uniffi-bindgen`
bin needs `uniffi/cli` (so its invocation adds `--features ffi,uniffi/cli`, not just `ffi`). The crate
keeps a `staticlib` crate-type for the iOS `.a`; it's inert on the wasm32 build.

`ffi:build:ios` / `ffi:build:android` install the artifacts into the committed projects:
`ios/App/VaultCryptoFFI/` (xcframework + `vault_crypto.swift` glue) and `app/src/main/jniLibs/` +
`.../java/uniffi/vault_crypto/` (all gitignored, regenerated by the script). The Xcode/Gradle projects
reference those paths, so **run the build before opening the project** (like the WASM artifacts).

### 16. Native crypto plugin + the iOS autofill provider (Lockdown-Mode fix)
On **iOS** the mobile `crypto` adapter runs native (the uniffi core via the `NativeCrypto` Capacitor
plugin) instead of WASM, so the vault works under Lockdown Mode (quirk 14); Android + a dev browser stay
on WASM (`adapters/crypto.ts` gates on `getPlatform()==="ios"`). Wiring is via `scripts/add-native-crypto.rb`
(idempotent; links `VaultCrypto.xcframework` + glue into both the App and the `AutoFillProbe` extension,
and adds `NativeCrypto.swift` + `AutofillBridge.swift` to the App). Re-run it after a fresh
`ffi:build:ios` if the project references are missing.

- **uniffi calls are module-qualified `App.<fn>`** in `NativeCrypto.swift`: the plugin's `@objc` methods
  share names with the uniffi free functions and shadow them, so a bare `generateVek()` binds to the member
  and fails to compile. The extension has no such shadowing, so it calls `unlockWithVek`/`decryptWithVek`
  bare. Bridge args that are byte arrays (magicVersion, KDBX files) cross as base64.
- **Autofill:** the main app's `setIndex` encrypts each password under the VEK and pushes
  (service, username, recordId, encrypted secret) to the shared App Group + `ASCredentialIdentityStore`
  (`AutofillBridge`). The extension reads the biometric-gated VEK from a **shared Keychain access group**
  (`BHGR3PP64J.app.bramble.mobile.shared`, in both entitlements + BiometricVault's queries) and decrypts on
  selection. Passwords are never written to the App Group in cleartext.
- **On-device firsts:** because the VEK Keychain item moved to the shared access group, **re-enable
  biometric once** (the old item won't be found), and **enable Bramble under Settings > Passwords >
  AutoFill**. Archive distribution with `-allowProvisioningUpdates` so Xcode registers the keychain-sharing
  capability + app group.
- **App Group payload is JSON**, not a plist array-of-dicts: `array(forKey:) as? [[String: Any]]` can
  silently fail to bridge in the extension process, so AutofillBridge writes `JSONSerialization` Data and
  the provider reads it back. The provider also triggers Face ID **on the row tap** (user-foregrounded),
  not on `prepareInterface*` (which hits LAContext's "not running foreground"), and renders an on-screen
  diagnostic (App Group reachable? blob bytes?) + `NSLog`s when the list is empty.

### 17. Releasing to TestFlight (fastlane)
`pnpm ios:beta` builds + uploads to TestFlight (auto-bumping the build number); `pnpm ios:ipa` exports a
distribution IPA to `~/Desktop` with no credentials. Both run the Capacitor pre-chain first
(`core:build` + `ffi:build:ios` + `cap sync`). The lanes live in the **repo-root** `fastlane/` (shared
with the Android store metadata, which fastlane's supply layout puts there), so run them from the repo
root. The App Store Connect key is age-encrypted at
`~/.config/bramble/asc-api-key.age` and unwrapped per run with a YubiKey PIN + touch (see
`docs/release-signing.md`); `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_CONTENT` in the environment
override it, which is the seam CI would use. **Gotcha:** the Fastfile pins `derived_data_path` to internal disk
(`clients/mobile/ios/DerivedData`, gitignored) because Xcode's default DerivedData here is the
external Transcend volume, which EPERMs the SPM checkout cache and fails `build_app` with "Could not
resolve package dependencies" (quirks 3-6). That pin used to be `/tmp`, but macOS prunes `/tmp` after
~3 days and left the SPM checkout corrupt, so it's repo-local now. Both lanes also pass
`manageAppVersionAndBuildNumber: false`, or Xcode's export step re-stamps the build number and ships
archive+1. Signing stays automatic + `-allowProvisioningUpdates`.

### 18. The App scheme builds Release, so `Debug-iphonesimulator` products are stale

`xcodebuild ... -scheme App build` writes to
`ios/DerivedData/Build/Products/**Release**-iphonesimulator/`, because the scheme's build action is
pinned to Release (the AutoFill provider only registers properly in a Release build, quirk 13).
`Debug-iphonesimulator/` still holds whatever an older run left there, so inspecting it after a build
shows old bytes and reads as "my change didn't compile". Always check the Release directory, or pass
an explicit `-configuration`.

Handy verification after touching native code or an Info.plist, since it reads the built product
rather than the source:
```bash
strings App.app/App | grep -c CredentialExchangePlugin
plutil -extract NSExtension.NSExtensionAttributes.ASCredentialProviderExtensionCapabilities json -o - \
  App.app/PlugIns/AutoFillProbe.appex/Info.plist
```

### 19. Enabling the credential provider on a simulator without the Settings UI

Quirk 13 says the Settings AutoFill toggle is device-only. The registration half is reachable from
the CLI:
```bash
xcrun simctl spawn <udid> pluginkit -e use -i app.bramble.mobile.AutoFillProbe   # blank -> "+"
xcrun simctl spawn <udid> pluginkit -m -vvv -i app.bramble.mobile.AutoFillProbe  # inspect the record
```
Only the flag flip is verified, not that AuthenticationServices honours it for live fill or for the
credential-exchange picker; `pluginkit` does not surface the extension's declared capabilities either.
Treat end-to-end behaviour as device-only until proven otherwise.

### 20. Debug builds hide the app code in `App.debug.dylib`

Quirk 18's verification (`strings App.app/App | grep -c SomePlugin`) is Release-only. Xcode 16
Debug builds ship the code in a separate **`App.debug.dylib`** (~20 MB) and leave `App` as a ~92 KB
stub, so the grep answers `0` for *every* plugin, including ones that have shipped for months. That
reads as "my new plugin did not compile in" when nothing is wrong. Grep the dylib instead:

```bash
D=ios/DerivedData/Build/Products/Debug-iphoneos/App.app/App.debug.dylib
strings "$D" | grep -c NativeHttpPlugin
```

Calibrate against a plugin you know is there before believing a `0` from either path.

### 21. Driving the WKWebView from the CLI (the iOS answer to `adb forward` + CDP)

Android exposes CDP over `adb forward`, so a probe can `Runtime.evaluate` in the app's WebView.
iOS needs `ios-webkit-debug-proxy` (`brew install`), and three things differ:

**The build must be Debug.** Capacitor only sets `webView.isInspectable = true` under `#if DEBUG`
(`CAPInstanceDescriptor.swift`), and the App scheme's LaunchAction is pinned to Release (quirk 18).
A Release build reports zero pages, which looks exactly like "the plugin is not registered". Build
`-configuration Debug` explicitly. Do **not** reach for `ios.webContentsDebuggingEnabled` in
`capacitor.config.ts` or `CAPACITOR_DEBUG` in the Info.plist: both are committed changes that would
ship web inspection in a password manager.

**WebKit is Target-based and has no `awaitPromise`.** Every command must be wrapped in
`Target.sendMessageToTarget` with the `targetId` from the `Target.targetCreated` event whose type is
`page`, and every reply arrives inside `Target.dispatchMessageFromTarget`. Unwrapped commands fail
with `'Runtime' domain was not found`, which reads like a broken proxy. Since `awaitPromise` is a
CDP addition, an async snippet has to park its result on a global (`window.__probe = ...`) and the
driver polls for it.

```bash
ios_webkit_debug_proxy -c <hardware-udid>:9222 --no-frontend &
curl -s http://localhost:9222/json     # -> ws://localhost:9222/devtools/page/1
```

**The simulator works the same way, with three differences.** Its inspector socket has moved:
find it with `lsof -aU -c launchd_sim | grep webinspectord_sim` (it was under
`/private/var/tmp/com.apple.launchd.*/` on macOS 26, not `/private/tmp/`) and pass it as
`ios_webkit_debug_proxy -s unix:<socket>`. The proxy defaults to port 9222, which is also the
conventional `adb forward` port for Android's CDP, so a leftover forward silently wins and your
driver ends up evaluating in the Android WebView; check `Capacitor.getPlatform()` before trusting
anything. And loopback is exempt from ATS, so `http://localhost` reaches services on the Mac.

**In wrapped mode, ignore everything that is not `Target.dispatchMessageFromTarget`.** The proxy
first acknowledges the outer `Target.sendMessageToTarget` with an empty result, and if outer and
inner ids share a counter that ack resolves the inner request with nothing. A poll built on it
never sees a value and just hangs.

**ATS blocks a local probe server.** There are no `NSAppTransportSecurity` exceptions, so cleartext
HTTP to a LAN address is refused before it reaches the network, and there is no iOS equivalent of
`adb reverse` to a loopback server. Test against HTTPS endpoints instead. A failure here surfaces as a
generic transport error and is easily misread as a bug in the code under test.

### 22. Installing a Debug build over a TestFlight app keeps the data

Replacing a TestFlight-installed build with a locally signed Debug one (same team, same bundle id)
installs **in place**: no delete prompt, and the container - including the vault - survives. It is
worth checking the entitlements against the embedded profile first, because a mismatch is the case
where iOS's only remedy is deleting the app:

```bash
codesign -d --entitlements :- App.app | plutil -p -
security cms -D -i App.app/embedded.mobileprovision | plutil -p - | sed -n '/"Entitlements"/,/^  }/p'
```

The profile's `keychain-access-groups` is `BHGR3PP64J.*`, which covers the hardcoded
`BHGR3PP64J.app.bramble.mobile.shared` the app requests.

Two things still surprise: `devicectl device process launch` fails with "invalid code signature,
inadequate entitlements or its profile has not been explicitly trusted", and no *Developer App*
entry appears under Settings > General > VPN & Device Management. Neither is a signing fault - the
trust prompt is only raised by launching from the home screen. **Tap the icon once on the device**,
and it opens. Also note a Debug build leaves the AutoFill provider unregistered (quirk 13), so
reinstall Release afterwards if autofill matters.

### 23. `URLSession`'s request timeout ignores bytes you are sending

`timeoutIntervalForRequest` (and `URLRequest.timeoutInterval`) is an idle timer that only
data *received* resets. While a body uploads nothing arrives, so a slow upload that is moving the
whole time still dies at the limit: measured through a proxy throttling the upload direction, a
2 MiB PUT failed at exactly 61 seconds having sent 627 KB, about 10 KiB/s and still moving.
`timeoutIntervalForResource` (the total) never came into play. Progress callbacks cannot rescue it either, because
`didSendBodyData` counts bytes handed to the OS, not bytes that have left it.

`NativeHttp.swift` therefore sets each request's timeout to 60 seconds plus the body's size at an
8 KiB/s floor, and Android's plugin mirrors it. See "Timeouts sized to the body" in
[docs/cloud-storage-backups.md](../../../docs/cloud-storage-backups.md).

To reproduce a slow uplink on the simulator, put a small TCP proxy in front of the local
containers that throttles client-to-server only, and send the app to the background with
`xcrun simctl launch booted com.apple.Preferences`. Keep the proxy's chunk size proportional to the
rate (`max(16, rate / 50)` bytes worked). A fixed small chunk plus a sleep per chunk under-delivers
badly at higher rates (one configured for 20 KiB/s delivered 9.5), so time a known file through it
before trusting any rate.

Background-time measurements are native-side only. An attached Web Inspector (quirk 21) may keep the
WebContent process alive, so what JavaScript does while backgrounded cannot be trusted from a
debugging session.

### 24. Android: one plugin thread, a page that freezes, and debug logging that ANRs

**Capacitor runs every Android plugin method on one thread** (`HandlerThread("CapacitorPlugins")`
in `Bridge.java`). "Off the main thread" is true and misleading: a method that blocks holds up every
other plugin in the app until it returns. `NativeHttpPlugin` did exactly that for whole uploads, so
crypto and storage calls waited behind a backup. Enqueue and resolve from the callback instead;
`PluginCall.resolve` is safe from any thread.

**Debug builds log every plugin call's full arguments on the main thread** (`Bridge.callPluginMethod`
calls `call.getData().toString()` for its verbose log). A ~1.9 MB upload body took ~14 seconds of
CPU there and the app was killed for an ANR the moment "Back up now" was tapped; it also writes
Basic-auth headers into logcat. Release builds are unaffected, since `loggingBehavior` defaults to
debug-only. For large-body tests, build once with `loggingBehavior: "none"` in `capacitor.config.ts`
and revert it, then `npx cap sync android` again so the gitignored generated config follows.

**Measuring what leaving the app does.** `adb shell dumpsys activity p app.bramble.mobile` shows each
process's `oom adj` and `isFrozen`, the WebView's sandboxed renderer included, and `dumpsys
activity` has a "Freezer settings" block (`freeze_debounce_timeout=10000` on a Pixel 8, Android 17).
The page has a freeze of its own: listen for `document`'s `freeze` and `resume` events over CDP,
which still evaluates in a frozen page. Leaving is `adb shell input keyevent KEYCODE_HOME`.

**`adb reverse` hides a stalled sender.** With the throttling proxy on the Mac, the bytes an app has
written are already buffered outside it, so an upload kept arriving at the server for 78 seconds
after the app was frozen. Such a test shows whether the bytes arrived, not whether the app kept
sending; watch `isFrozen` and the JS result for that.

## Reclaiming disk space

The iOS runtimes are the big consumers (~8 GB each). List and delete unused ones rather
than moving them to an external drive (which reintroduces quirks #3–#6):
```bash
xcrun simctl runtime list
xcrun simctl runtime delete <runtime-id>
xcrun simctl delete unavailable   # remove orphaned devices
```
