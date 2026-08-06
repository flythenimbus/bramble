# Desktop app (Tauri 2) plan: feasibility findings

Research notes on shipping Bramble as a native macOS + Windows + Linux app built with Tauri 2,
reusing the existing codebase. Captures what is already portable, what needs a new platform
implementation, the genuine blockers, and a phased plan.

Two classes of claim live here and they are not equally solid. **Codebase findings are verified**
and carry file paths; anything about OS behaviour, webview capability, or crate maturity is from
general knowledge as of **August 2026**, has *not* been checked against live sources in this pass,
and is marked `[unverified]`. Do a research pass before committing to any of those.

## Bottom line

- **Feasible, and the cheapest of the three platform ports so far.** `packages/core` talks to its
  host through eight adapter interfaces injected by `PlatformContext`. A desktop port is a new
  `packages/platform-desktop` implementing those, plus a Rust binary. The hard parts are not the
  port; they are three net-new native subsystems (browser IPC, auto-type, SSH agent).
- **Tauri is the right pick, and the reason is `core-rust`, not the framework's merits.** The
  extension reaches the crypto core through wasm-bindgen and mobile reaches it through uniffi. A
  Tauri app is a Rust binary, so it depends on `vault-crypto` as an ordinary cargo dependency and
  calls it directly. `packages/core-rust/Cargo.toml` already ships `rlib` in `crate-type` and
  `cargo test` builds natively today. No binding layer at all.
- **The VEK lives in the Rust process and never enters the webview.** This is the same
  privileged-crypto-context pattern as the extension's offscreen document and mobile's native
  plugins, and it is the strongest argument against Electron, whose main process is V8: a GC'd heap
  copies key material around and cannot be zeroized. `zeroize` is already a dependency here.
- **One process, two windows.** A closable main vault window and a frameless always-on-top
  spotlight window, not two apps. One process means one VEK and no cross-process key handoff (see
  issue #27 for what the shared-VEK hazard costs). The always-on sync hub is what justifies a
  resident process; the spotlight bar is what makes the user glad it is resident.
- **Everything browser-facing is additive and optional.** The Chromium extension is publicly
  released to real users and stays fully standalone. Desktop integration only adds capability when
  both are installed; it never becomes a dependency.
- **Three things are hard:** the extension IPC channel (and its install surface), auto-type
  (per-OS input synthesis plus permissions), and Linux, which is the weak column in every table
  below.
- **The SSH agent is nearly free on the data side.** The `ssh-key` entry type already exists and
  already syncs. Desktop becomes the only client that can *use* those keys, with no vault-format,
  sync, or importer change.

## Implementation status (built so far, branch `feat/desktop`)

**Phase 0 is done and the vertical slice is proven.** The app builds and boots on macOS, the
React UI renders in WKWebView, and a frontend call reaches a Rust command and hits the
filesystem. The sections below this one are the original forward-looking analysis (still
accurate for the unbuilt parts); this section is the ground truth.

- **`core-rust` as a plain cargo dependency: CONFIRMED.** The decisive bet works. A new
  `native` feature (`native = ["dep:snow", "dep:k256"]`, with `ffi = ["native", "dep:uniffi"]`
  layered on it) builds the crate with neither binding layer. The existing `ffi_exports`
  module was widened to `any(ffi, native)` with `#[cfg_attr(feature = "ffi", uniffi::export)]`
  rather than copied into a third block, so the struct-returning calls have one body. All
  three feature configurations check clean and the 1296 existing tests still pass.
- **`packages/platform-desktop`**: Vite + React SPA mirroring platform-mobile, plus `src-tauri`
  scaffolded by the 2.11.4 CLI (tauri 2.11.3, tauri-build 2.6.3) so the config matches the
  shipped schema rather than being hand-written.
- **The VEK lives in the Rust process.** `src-tauri/src/crypto.rs` exposes 19 commands wrapping
  `vault_crypto` directly. The core's structs already serialize camelCase, so results land in
  the shapes `@core/adapters/crypto` declares with no mapping layer. `decryptEntries` batches
  in Rust, so opening a vault is one IPC round trip rather than one per entry.
- **Storage is native files** (`src-tauri/src/storage.rs`): temp-plus-rename atomic writes and
  a `.bak` snapshot before every overwrite, which is stronger than the extension's backend.
- **`flags.ts` widened.** `Target` gained `desktop`. `Surface` was renamed to `pointer`/`touch`,
  because desktop is pointer-driven but needed its own capability axis regardless: `popOut` has
  to be `false` on desktop despite being `true` for the other pointer target. So capabilities
  now resolve through a separate `Family` (`extension` / `mobile` / `desktop`) and `Surface`
  means input model only, which is what its doc comment always claimed.

Not yet wired, and deliberately loud about it rather than silently broken: passkey provider and
KDBX import (both sit behind private modules in core-rust that need a re-export), autofill of any
kind, sync, and biometric unlock. The security-key slot commands *are* wired since they cost
nothing, but `securityKeys` stays `false` for desktop because the webview cannot produce an
hmac-secret.

Run it with `pnpm dev:desktop`. `build:desktop` bundles it, `test:desktop` runs the shell's
cargo tests.

The window is a fixed, non-resizable 600x580, in the same spirit as the extension's
500x550 popup. An earlier attempt sized it to each screen's content and was dropped: the
measurement is genuinely awkward (@core's screens are fixed-height boxes that scroll
internally, so neither `documentElement.scrollHeight` nor the scroller's own `scrollHeight`
reports the content height), and even working it made the window move about under the user.
A fixed window is the better fit for a UI that is popup-dimensioned anyway.

**Debugging note.** `console.log` from the webview does not reach the `tauri dev` terminal,
and both `osascript` and Quartz window queries need Accessibility permission the terminal will
not have. The way to get diagnostics out is `@tauri-apps/plugin-log` (the Rust half is already
registered for debug builds) plus `"log:default"` in `capabilities/default.json`; `info()` then
prints to the dev terminal. Worth re-adding for the duration of a debugging session and
removing afterwards.

## Why Tauri, and why the mobile Tauri rejection does not transfer

Commit `ca82927d` switched the mobile plan from Tauri to Capacitor. That decision was specifically
about mobile native extension targets: Capacitor hands you real, editable Xcode and Android Studio
projects, which matters enormously when the largest workstream (the autofill credential provider) is
a native target you have to own. Tauri 2's mobile support was the tooling gamble.

None of that applies to desktop. Desktop is Tauri's mature primary target, there is no generated
native project to fight, and there is no equivalent extension-target problem. Mobile stays on
Capacitor. The two coexist because `core-rust` is the shared substrate, not the shell.

Electron's only real advantages are one consistent Chromium renderer everywhere and a Playwright
story that transfers directly. Both are worth less here than they look, because the native-Rust
strategy below *replaces* the webview features you would otherwise depend on (WebRTC, WebAuthn,
crypto), and because the highest-value desktop features (sync hub, auto-type, SSH agent) are native
work under either framework. The remaining Electron cost is a ~150MB bundle that is much harder to
reproducibly build, against a project that already maintains reproducible-build docs for AMO and
F-Droid.

## The reuse seam: what a desktop platform package costs

`Platform` is `{ target, storage, crypto, autofill, shell, clipboard, biometric, exchange }`. Core
has near-zero direct browser-API use outside the adapters.

| Adapter | Desktop implementation | Effort |
|---|---|---|
| `storage` | Rust-side files. Gets *better* than the extension: real atomic writes (temp + rename), and `readVaultBackup` snapshot semantics become natural rather than emulated | Low |
| `crypto` | Direct `vault-crypto` rlib calls behind Tauri commands. The offscreen indirection collapses entirely | Low |
| `clipboard` | `tauri-plugin-clipboard-manager` plus the existing timed-clear behaviour | Low |
| `shell` | Most of the interface is extension-shaped (`popOut`, `consumeHandoff`, `matchCurrentTab`, `getCurrentTabOrigin`, `scanQrFromActiveTab`). There is no current tab, so those go absent as they do on mobile; many are already optional | Low |
| `biometric` | Touch ID via LocalAuthentication, Windows Hello via WinRT, nothing on Linux. Same OS-gated VEK-cache shape as mobile's BiometricVault | Medium |
| `autofill` | Net-new: auto-type plus extension routing. See below | High |
| `exchange` | Absent (iOS only) | None |

### `flags.ts` changes

Add `"desktop"` to `Target`. Every `{ extension, mobile }` capability then needs a desktop answer,
and because `CAPABILITIES` is declared `satisfies Record<string, Capability>`, tsc enumerates the
full list for you.

`Surface` is documented as "`extension` is pointer-driven, `mobile` is touch". Desktop is
pointer-driven, so it maps onto the `extension` surface cleanly but the name becomes a lie. Renaming
the two values to `pointer` / `touch` is the honest fix and is mechanical.

First-pass desktop capability values:

| Capability | Desktop | Why |
|---|---|---|
| `popOut` | `false` | It is already a window |
| `cameraScan` | `false` (v1) | Webcam QR for pairing is plausible but webview camera access is inconsistent `[unverified]`; manual pairing-code paste covers it |
| `cloudBackup` | `true` | `cloud-storage-backups.md:56` already assumes an always-on desktop as the backup host |
| `securityKeys` | `false` (v1) | Webview WebAuthn is unavailable/unreliable. Native CTAP is the follow-on, below |
| `saveCapture` | `false` | The desktop app has no page to capture from; the extension keeps doing this |
| `passkeyProviderToggle` | `false` (v1) | |
| `credentialExchange` | `false` | iOS only |
| `filePickerAcceptFilter` | `true` | Native desktop pickers filter by extension properly |
| `lockOnScreenLock` | `true` | Desktop OSes emit real screen-lock signals `[unverified: exact APIs]` |
| `perVaultSync` | `false` | Settled: spotlight and the app search the single unlocked vault, matching mobile's single-active model |

**X11 vs Wayland cannot be a capability flag.** It is a runtime property of the user's session, not
a build target. That is the argument for one `desktop` target rather than three per-OS targets:
per-OS flags would triple the matrix and still fail to express the case that actually varies.

## Product scope

Three things, in value order:

1. **Always-on sync hub.** The differentiated one, and only possible on desktop. A tray-resident
   peer fixes P2P sync's structural problem, which is that two phones are rarely online
   simultaneously. Also the natural host for scheduled encrypted backups.
2. **Spotlight mini app.** The reason a user notices the app is running. Detailed below.
3. **Vault manager.** Big-screen CRUD, import/export, multi-vault management. Comes nearly free
   with the adapter seam, and largely mirrors the options page.

## The spotlight mini app

A frameless, always-on-top, transparent window in the same process, opened by a global hotkey.

**The UI is ordinary HTML/CSS/JS**, a second Tauri window rendering React and reusing `@vault/core`
components and `@vault/theme` tokens. Search matching should come from `VaultSearchBar`.

**The blur is the one native piece.** `backdrop-filter: blur()` blurs content behind an element
*within the same page*; the desktop wallpaper and other apps are not in the page's compositing tree,
so on a transparent window it blurs nothing. The 1Password/Spotlight effect requires a native view
behind the webview: `NSVisualEffectView` on macOS, Mica or Acrylic on Windows, applied through the
`window-vibrancy` crate in Tauri's setup hook. The HTML then needs a genuinely transparent
background so it shows through. Linux has no standard compositor blur; fall back to an opaque
surface `[unverified]`.

### Interaction model

A search input with results below it, combobox-style:

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `Enter` | Fill |
| `Cmd/Ctrl+O` | Open the Bramble main window focused on that entry |
| `Cmd/Ctrl+E` | Edit that entry |

Show `⌘` on macOS and `Ctrl` elsewhere rather than hardcoding either.

**Actions belong on `EntryMode`, not in the spotlight window.** `app/entry-modes/types.ts` states
that registering a descriptor is the only step to add a mode, and `EntryRowView.copyItems` is
already this exact idea. Add a `spotlightActions` field. This matters immediately, because Enter is
not universal: "fill" is meaningless for an `ssh-key`, means the card number for a `card`, and
probably means copy for a `note`. Without the descriptor the spotlight grows a
`switch (entry.type)` that must be edited every time a mode is added.

**Enter is also context-dependent.** Browser frontmost routes through the extension; a native app
frontmost auto-types; nothing focused has no target at all. Fall the third case back to a clipboard
copy with a visible hint rather than failing silently, because the user cannot otherwise tell why
nothing happened.

**Keep secrets out of this window.** Results carry id, name, username, and type only; the credential
is resolved from Rust at action time. This is a floating always-on-top window that people will
screenshot and screen-share, and it costs nothing to keep plaintext out of its heap. Same reasoning
as keeping the VEK out of the webview.

**Accessibility:** `role="combobox"` with `aria-activedescendant` moving over a `role="listbox"`,
and DOM focus stays in the input. The naive implementation moves focus onto the result row, at which
point typing stops filtering.

### Locked state

The hotkey on a locked vault turns the bar into the unlock prompt (Touch ID or master password
inline). This makes spotlight the *primary* unlock surface, ahead of the main window.

One wrinkle where this meets single-vault search: with several vaults and none unlocked, the prompt
must pick one. Default to the last-unlocked vault, with a small switcher.

### The macOS activation trap

If the spotlight window activates the app, Bramble becomes the frontmost application and the
information auto-type needs (which app to type into) is destroyed. Two fixes, and both are wanted:
capture the frontmost app *before* showing the window, and convert the window to a non-activating
`NSPanel` so it takes keyboard focus without stealing activation. Tauri v2 has no first-class API
for the latter; the usual routes are `objc2` directly or the `tauri-nspanel` community plugin
`[unverified]`.

## Browser integration

### Native messaging needs a proxy, and the proxy is what creates the security problem

Native messaging inverts the lifecycle: the browser spawns the host process, but Bramble is
resident. The standard shape, used by 1Password, KeePassXC, and Bitwarden, is a thin spawned relay:

```
extension  --native messaging (stdio)-->  bramble-proxy (small spawned binary)
                                              |
                                              +-- unix socket / named pipe --> bramble (resident)
```

The proxy is a small Rust binary shipped with the app. It needs a native-messaging host manifest per
browser (file paths on macOS and Linux, registry keys on Windows) listing the allowed extension IDs.
Firefox supports the same mechanism with `allowed_extensions` keyed on the addon ID rather than
Chrome's `chrome-extension://` origins, so both existing targets are covered `[unverified: exact
paths and key names]`.

If the browser-spawned host did the work itself, **no handshake would be needed at all**: the
browser only spawns hosts whose manifest allowlists the extension ID, and stdio is a private
parent-child pair. The gap is created entirely by the proxy hop, which the resident-process
architecture forces. The rendezvous socket is where "same host" stops being a security boundary:
`0600` permissions keep other *users* out, but every process running as *you* can connect. A
malicious dependency in an unrelated project must not be able to open that socket and ask for the
GitHub password, which would bypass the master password entirely. That is the same class of problem
as the GHSA pairing-code issue: a bearer secret worth the vault.

### The minimum viable pairing

The irreducible requirement is **one user-confirmed pairing**, because a human click is the only
thing a same-user process cannot produce. Almost everything from the P2P design drops out:

- **Drop the SAS compare.** It exists because two sync devices are physically apart. Here both
  endpoints are on the same screen: show "Chrome wants to connect" with the extension ID and let the
  user approve.
- **Drop the relay, Nostr signaling, roster, and admission logic.** All of that solves distance and
  multi-device state that does not exist here.
- **Keep static keys and one handshake.** Not for confidentiality (anyone who can sniff a local unix
  socket already has the access needed to read process memory) but so the **proxy is an untrusted
  relay rather than a trusted component**. With a bearer token, replacing the proxy binary captures
  the token; with static-key authentication a swapped proxy can only relay.

Use `snow`, already a dependency, for a `Noise_KK` exchange rather than designing a bespoke token
scheme. It is roughly 100 lines, and reusing the audited handshake is a far easier line in a
security review. The heavy parts of the P2P stack (roster, signaling, admission) do not come along.

Add peer-credential checks (`SO_PEERCRED`, `GetNamedPipeClientProcessId`, macOS code-signature
validation by PID) as defence in depth. They are decent on macOS and Windows, weak on Linux where
there is no signature to check, and they have PID-reuse races, so they are a second lock, never the
only one `[unverified]`.

For reference, 1Password is not open either: it verifies the browser's code signature against known
signed builds and requires an explicit first-run opt-in. The seamlessness is that you approve once
and never think about it again, not that authentication is absent.

### Routing

On hotkey, check the frontmost application:

- **Native app** → auto-type path.
- **Browser** → do not auto-type. Route to that browser's extension connection, ask for the active
  tab URL, filter, and on selection send a fill command back. The extension performs the fill using
  its existing `content/` field detection, which is already tested against the recorded login shapes.

The desktop app therefore never implements field detection. Each installed extension registers its
own connection with the proxy on startup, so a user with Chrome and Firefox both open works.

Native messaging has a per-message size cap (believed 1MB host to extension on Chrome
`[unverified]`), so this channel carries queries and single credentials, never bulk vault data.

### Deferred: extension unlock delegation

1Password lets the extension delegate unlock to the desktop app, which is what makes its biometric
unlock feel seamless. That is coherent here too, but it must stay additive: the extension keeps
working standalone exactly as today and only gains "unlock via desktop app" when paired. Not v1.

## Auto-type and native-app matching

Input synthesis is per-OS: `CGEventPost` on macOS (requires the Accessibility TCC permission),
`SendInput` on Windows, `XTEST` on X11. **Wayland effectively blocks it**, which is why KeePassXC's
auto-type does not work there; degrade to clipboard copy `[unverified]`.

Matching needs a different key than the web. **Reuse the existing app-URI scheme rather than adding
a field.** `packages/core/src/vault/autofill-index.ts` already defines `APP_URI_SCHEMES`,
`isAppUri`, and `appIdFromUri`, added in `10dcc339` for imported Android and iOS app URIs.
`appIdFromUri` currently has no caller; desktop native-app matching would be its first, keyed on
bundle id (macOS), executable path or AUMID (Windows), or window class (Linux).

Note the deliberate constraint recorded in that commit and in `autofill.md`: Bramble does **not**
infer a domain from a package name, because the inference works for
`se.skanetrafiken.washington` and fails for `com.google.android.youtube`, and nothing stops an app
claiming someone else's namespace. Desktop must not reintroduce that inference for bundle ids.

## SSH agent

Storage is done. `app/entry-modes/ssh-key.tsx` holds name, publicKey, privateKey, passphrase, and
notes, and the type already syncs. The gap is that nothing *uses* the private key: `util/ssh.ts` is
41 lines and both `deriveKeyType` and `sshFingerprint` are public-key-side only. The private key is
an opaque string.

The work is entirely Rust:

- Parse the `openssh-key-v1` container, including the encrypted case, which defaults to bcrypt-pbkdf
  plus aes256-ctr keyed on the stored `passphrase`
- Extract the ed25519 or ecdsa scalar and sign. `ed25519-dalek` and `p256` are already dependencies
  and cover `ssh-ed25519` and `ecdsa-sha2-nistp256`; RSA would need the `rsa` crate
- Speak the agent protocol on a socket, plus the OpenSSH named pipe on Windows, with
  `SSH_AUTH_SOCK` pointed at it

RustCrypto's `ssh-key` covers the first two including passphrase decryption; `ssh-agent-lib` covers
the third `[unverified: crate maturity]`. Gate both behind an `ssh-agent` cargo feature so the wasm
and mobile builds never pay for them, exactly as `webrtc` is gated for iOS.

Require per-signature approval (biometric where available). The pitch: private keys never touch disk
unencrypted and every use is explicitly approved.

## Sync transport: reuse the native WebRTC path

Desktop webviews have inconsistent WebRTC support and WebKitGTK is the weak link `[unverified]`.
Rather than gamble on three implementations, reuse the `webrtc` cargo feature (webrtc-rs), already
device-proven on iOS, across all three desktop OSes. That is *more* consistent than Electron, since
it is one Rust implementation rather than whatever each Chromium build ships.

`packages/platform-mobile/src/native-webrtc.ts` is the template. The shim's interface is unchanged;
it needs Tauri `invoke`/`listen` in place of Capacitor `registerPlugin`/`addListener`.

## Required `core-rust` change

`snow` and `k256` are currently reachable only through the `wasm` or `ffi` features, and desktop
wants them without uniffi. Split them out:

```toml
native = ["dep:snow", "dep:k256"]
ffi = ["native", "dep:uniffi"]
```

Desktop then depends on `vault-crypto` with `default-features = false, features = ["native"]`, plus
`webrtc` and `ssh-agent` as those land.

## Platform reality

| | macOS | Windows | Linux |
|---|---|---|---|
| Webview | WKWebView | WebView2 (Chromium) | WebKitGTK |
| Backdrop blur | `NSVisualEffectView` | Mica/Acrylic (11 good, 10 laggy) | **none standard** |
| Global hotkey | yes | yes | X11 yes; **Wayland needs the GlobalShortcuts portal** |
| Auto-type | `CGEventPost` + Accessibility TCC | `SendInput` | X11 `XTEST`; **Wayland blocked** |
| Biometric | Touch ID | Windows Hello | none |

All `[unverified]`. Linux is the weak column in every row, and WebKitGTK is the same stricter
renderer already noted at `mobile-port.md:697`. The native-Rust strategy contains the damage: the
webview only has to render React, not do crypto, transport, or WebAuthn.

## Risks to retire early

1. **WebKitGTK rendering and window transparency on Linux.** The UI is Tailwind-heavy and WebKit is
   the stricter engine. Retire in Phase 0 by rendering the existing UI on all three OSes.
2. **The macOS non-activating panel plus frontmost-app capture.** The entire auto-type premise
   depends on it, and it is the highest-uncertainty native piece. Retire in Phase 2.
3. **Native-messaging manifest install across three OSes and two browsers**, and whether it survives
   app updates and the app being moved. This is the messiest install-time work in the project.
4. **The macOS Accessibility TCC prompt.** Users bounce off it. Needs a real onboarding flow, not a
   raw system dialog.
5. **Code signing and notarization on macOS, SmartScreen on Windows.** `release-signing.md` is
   precedent but desktop notarization is new ground.
6. **webrtc-rs interop with the extension's browser WebRTC on desktop.** Already proven iOS to
   extension, so low risk, but unproven on this path.

## Proposed plan

Each phase retires a risk.

- **Phase 0, walking skeleton.** `packages/platform-desktop` (Vite + React, mirroring
  platform-mobile) plus `src-tauri` as a cargo workspace member. The `native` feature split. UI boots
  on all three OSes.
- **Phase 1, vault MVP.** `storage`, `crypto`, `clipboard`, `shell` adapters, VEK held in Rust,
  create/unlock/CRUD/import. `Target` and `CAPABILITIES` widened.
- **Phase 2, spotlight.** Global hotkey, vibrancy, non-activating panel, combobox UI,
  `spotlightActions` on `EntryMode`, inline unlock. Actions limited to clipboard and Cmd+O/Cmd+E, so
  it is useful before any IPC exists.
- **Phase 3, sync hub.** Native WebRTC shim port, tray residency, scheduled backups.
- **Phase 4, browser integration.** Proxy binary, host manifests, Noise pairing plus the approval
  dialog, fill routing. Enter becomes a real fill in the browser.
- **Phase 5, auto-type.** Per-OS input synthesis, `appIdFromUri` matching, permissions onboarding.
  Enter becomes a real fill in native apps.
- **Phase 6, SSH agent.**
- **Deferred:** native CTAP security keys, extension unlock delegation, Wayland auto-type.

Phase 2 lands before Phase 4 deliberately: the spotlight is useful with clipboard actions alone, and
it proves the hardest native UI problem before the largest install-surface problem.

## Open questions

- **Distribution.** Direct download plus Homebrew cask on macOS; MSI or winget on Windows; Linux is
  the question. Flatpak is actively hostile to both native messaging (the manifest must reach the
  browser's sandbox) and global input capture, so AppImage or native packages may be forced
  `[unverified]`.
- **Auto-update.** Tauri's updater needs its own signing keys, which interacts with
  `release-signing.md`.
- **Versioning.** Per-target versioning is already the norm here, so desktop gets its own line.
- **Native CTAP for security keys.** `authenticator-rs` or `ctap-hid-fido2` would make desktop
  security-key unlock *more* capable than the browser path, since hmac-secret is a CTAP2-level
  protocol feature and a native implementation sidesteps origin restrictions entirely. The slot
  format does not change. Worth its own spike after v1 `[unverified]`.
