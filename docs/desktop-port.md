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
  three feature configurations check clean and the crate's tests still pass: 58 under the
  default wasm features, 51 under `native`, the difference being the wasm-only modules.
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
- **Storage is tested; 21 tests, weighted at the paths that lose data.** `storage.rs` is split
  into an `ops` layer parameterised on the data dir and `#[tauri::command]` wrappers that only
  resolve it, because the commands took an `AppHandle` purely to find that directory and so
  none of the logic could run without a live Tauri app. The two that matter are both issue #27:
  reading the backup must not restore it, and restoring must *not* snapshot first, or it
  overwrites the only good copy with the bad bytes. Verified by mutation, not by the suite
  going green: making restore symmetrical with write fails exactly one test.
- **The spotlight panel exists, as a shell.** A second window in the same process (one VEK, no
  cross-process handoff), hidden and transparent, toggled by `CmdOrCtrl+Shift+Space`, with a
  native `NSVisualEffectView` behind the webview. It collapses to the search row until there
  is a query and grows anchored at its top-left. No results yet: that is the next slice.
- **The browser link works end to end.** Verified in Vivaldi through both UIs: the desktop
  app shows a code, the extension takes it, and `Test` then reconnects over KK with no code.
  The chain is the desktop's socket, a native-messaging proxy Chrome spawns, a host manifest
  the app installs for every Chromium browser present, and the extension's own client. The
  pairing key lives in the OS credential store; the allowlist is a file beside the vault.
- **The app outlives its main window.** Closing hides rather than destroys, a tray icon is the
  route back, and on macOS the Dock icon follows the window via the activation policy
  (`Regular` ↔ `Accessory`). Needed for the spotlight to be reachable at all, and the same
  scaffolding the sync hub will want.

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

**Two constraints this took on.** Transparency for the spotlight panel needs Tauri's
`macos-private-api` feature, which rules out the Mac App Store; Bramble ships direct downloads,
so no channel is given up, but it is now a real constraint. And `Accessory` policy means the
app leaves Cmd+Tab while its window is hidden, and that with no Dock icon there is nothing to
click, so the tray is the only route back.

**Trap: Tailwind only scans `packages/core`.** `@core/styles/tailwind.css` declares
`@import 'tailwindcss' source(none)` with a single `@source` scoped to core, so a utility used
in a *platform* package that core does not also happen to use is never generated. The class
lands in the DOM, matches no rule, and does nothing, which is the worst way for a style to
fail. The extension and mobile never noticed because their own `.tsx` files are thin mounts
whose classes all exist in core anyway; desktop is the first package with markup of its own.
Fixed with `packages/platform-desktop/src/styles/index.css`, which imports core's stylesheet
and adds its own `@source`. Anything styled directly in the other platform packages will need
the same. Check the built CSS rather than the screen: a missing utility looks identical to one
that is simply not doing what you expected.

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

### The pairing

Each side generates a long-lived static keypair on first run. On first connect they exchange
public keys, the user confirms, and each stores the other's public key in an allowlist. Every
connection after that is a mutual proof of possession against those allowlisted keys, with no
user interaction. Concretely, `Noise_XX` for the pairing handshake (neither side knows the
other's static key yet) and `Noise_KK` afterwards (both do). `snow` is already a dependency
and supports both, so this is roughly 100 lines rather than a bespoke scheme, and "we reused
the audited handshake" is a far easier line in a review.

The private key never crosses the socket, so a passive observer learns nothing replayable and
a swapped proxy binary cannot impersonate either end. **The proxy is deliberately an untrusted
relay**; it holds no key material at all.

Almost everything from the P2P design drops out. **The SAS compare goes**: it exists because
two sync devices are physically apart, whereas here both endpoints are on the same screen, so
"Chrome wants to connect" plus the extension ID is the whole ceremony. **The relay, Nostr
signaling, roster and admission logic go too**: they solve distance and multi-device state
that does not exist on one machine.

### What the pairing does not cover

One-time pairing authenticates the **channel**, not each **request**. Treating the first as if
it delivered the second is the mistake this section exists to prevent.

**The pairing key is a bearer credential at rest.** The extension's half lives in
`chrome.storage.local`, a file in the browser profile. Malware that can read that directory
can extract it and impersonate the extension indefinitely, silently, with no further clicks.

That is a **privilege escalation over what such malware already had**, which is the part worth
sitting with. It could already read the extension's vault blob, but that is encrypted and
needs the master password. A stolen pairing key against a running, unlocked desktop app turns
"I have an encrypted blob" into "I have a live oracle for plaintext credentials". Same file
access, materially larger blast radius. This is the same residual risk 1Password and KeePassXC
carry; it is not disqualifying, but "you approve once" is doing less work than it sounds like.

Five controls make it defensible. The first two carry most of the weight:

1. **Gate every credential answer on the vault being unlocked.** This is the single biggest
   bound: it turns "permanent silent access" into "access during windows you were already
   working in", and kills the exfiltration-at-3am case outright.
2. **Metadata only for queries; secrets only on an explicit fill.** "Do you have an entry for
   github.com?" returns a name and an id. The credential crosses the socket for one entry at
   the moment of use. Malware enumerating the vault learns which sites have accounts, which is
   bad, but not the passwords.
3. **Keep the desktop's private key in the macOS Keychain**, `WhenUnlockedThisDeviceOnly` with
   an ACL requiring the app's code signature, rather than a file beside the vault. Does not
   protect the extension's half, but stops the trivial symmetric theft `[unverified]`.
4. **Verify the connecting process** (`LOCAL_PEERPID` then a code-signature check). See below
   for why this is weaker than it looks.
5. **Make fills visible.** A tray flash or notification per fill means bulk exfiltration is not
   silent.

Deliberately *not* on that list: **origin binding**. The extension asserts the active tab's
origin, so an attacker holding the key simply lies about it. It is hygiene, not a boundary.

### Code-signature checks, and where they actually help

Worth being precise, because the obvious target is the wrong one.

**Verifying the proxy's signature is nearly worthless here**, and for a good reason: the proxy
is untrusted by design. It holds no key and can only relay, so an attacker gains nothing by
replacing it, and checking the signature of a component that could not have compromised
anything protects nothing. Malware can also just run the genuine signed proxy itself.

**Verifying the proxy's parent process does add something.** Chrome passes the calling
extension's origin to the native host as `argv[1]`, but a local process can run the proxy
directly with a forged argv. If the app requires that the proxy was spawned by a signed
browser binary, that attack needs code injection into a real browser rather than just running
a binary. This is roughly what 1Password does `[unverified]`.

Both are defence in depth on top of the keypair, never a substitute: without the extension's
private key, neither forged argv nor a replaced proxy gets an attacker anything. On Linux
there is no signature to check at all, and peer-PID checks carry a reuse race, so this layer
degrades to nothing there.

For reference, 1Password is not open either: it verifies the browser's code signature and
requires an explicit first-run opt-in. The seamlessness is that you approve once and never
think about it again, not that authentication is absent.

### Open decision: per-fill confirmation

Whether a request can *require* a confirmation (a click, or Touch ID once biometric unlock
lands) on top of the paired channel. Default off, because prompting on every fill destroys the
feature, but KeePassXC offers it and some users will want high-value entries gated even on a
paired channel.

Build the request protocol so a response can be "needs confirmation" from the start. It is
cheap now and awkward to retrofit, because it changes the shape of every request.

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

Unlocking twice for one action is the obvious wart in a paired setup, and 1Password's answer
(delegate the extension's unlock to the desktop app) is coherent here too. It stays additive:
the extension keeps working standalone exactly as today and only gains this when paired. Not
v1, and the reason is a dependency rather than a preference.

**Prerequisite: they have to be the same vault.** The extension's vault is sealed under its own
VEK, and the desktop can only unlock it if it holds that VEK, which happens only if the two are
sync peers, because sync is what shares a VEK across devices. Desktop sync is Phase 3. So this
feature sits behind it, which is easy to miss when it looks like a small piece of UX.

**Do not ship the VEK.** The obvious implementation hands the VEK over the paired channel at
unlock and lets the extension's existing crypto path take over unchanged. It is a small change
and it quietly undoes the whole point of the channel. Today a stolen pairing key yields one
credential at a time, only while the vault is unlocked. Put the VEK on that socket and the same
theft yields the entire vault, decryptable offline, forever, including after the user locks and
including entries they never opened. Same compromise, categorically different loss. It also
walks straight through the metadata-only rule above: "secrets for one entry at the moment of
use" is not a boundary if the master key goes over the wire at session start.

**Delegate the operations instead.** In delegated mode the extension's crypto adapter routes to
the desktop rather than to its own offscreen document, and no VEK ever crosses. The extension's
plaintext exposure is unchanged (it already holds decrypted entries in memory after a normal
unlock); what changes is custody of the key, which never leaves the Rust process.

That leaves one refinement worth taking. The vault list needs a name and username per entry,
and entries are encrypted whole, so a naive delegated list means "decrypt everything" at
session start. The desktop should instead return a **redacted projection** for listing, holding
back password and secret fields, and full plaintext only for the entry actually being used. It
can do that because it is the side holding the plaintext. A full dump of a delegated session
then yields no passwords at all, which is what makes this option genuinely better rather than
merely differently shaped.

Costs, stated honestly: this is a real refactor of the extension's crypto adapter rather than a
new message type, and the extension depends on the desktop staying alive for the whole
delegated session. Writes need a decision too, since encryption also routes to the desktop and
the two vaults then have to reconcile through sync.

Three invariants, whichever way the details land:

- **Lock propagates.** If the desktop locks and the extension stays open, the feature has
  extended an unlocked session past the point the user believes they ended it, which is worse
  than not having it.
- **The handover is gated on a user gesture** (Touch ID once biometric unlock lands). Not
  because it stops a key holder outright, but because it makes the attempt *visible*: a prompt
  appears that the user did not ask for.
- **Delegated mode is opt-in and reversible**, and standalone remains the default. The
  extension is publicly released; this cannot become a dependency for existing users.

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

## Sync transport: the webview's own WebRTC, on macOS

The plan here was to reuse the `webrtc` cargo feature (webrtc-rs), already device-proven on iOS,
on the assumption that desktop webviews have inconsistent WebRTC support. **That assumption was
wrong on macOS.** WKWebView in a Tauri window exposes `RTCPeerConnection`, `RTCDataChannel` and
`WebSocket`, so `@core`'s transport, relay client and merge engine run in the vault window
unchanged. iOS needed the native path because *its* WKWebView does not expose them; the desktop
one does. Nothing of webrtc-rs is needed here.

What could not move into the webview is the crypto, because the VEK lives in the Rust process
and never crosses the IPC boundary. `src/sync-crypto.ts` is the whole difference from mobile: the
same snake_case names `@core/sync` calls, each one an `invoke` of a Rust command wrapping
`handshake` / `nostr` / `roster_sig`. It is named against the wasm exports rather than the repo's
usual camelCase deliberately, because `@core/sync` was written against those names and renaming
would only add a layer whose job is to undo the rename.

Windows (WebView2, Chromium) is near-certain to work the same way; WebKitGTK is the open
question `[unverified]`, and it is where webrtc-rs would come back if it comes back at all.

**The release CSP has to allow the relay.** `connect-src` starts at `'self' ipc:
http://ipc.localhost`, which blocks the relay WebSocket and the ICE-servers fetch. WebKit reports
the blocked `new WebSocket` as `SecurityError: The operation is insecure.`, which reads like a
transport-security problem rather than a policy one, and the ICE fetch fails quietly into "direct
(host) only". Neither appears in `pnpm dev:desktop`, because `devCsp` permits localhost, so this
is a release-only failure. `https:` and `wss:` are now allowed.

That is broader than pinning the relay host, and deliberately: the relay is user-configurable
under Advanced, and a CSP is fixed at build time, so a pinned host would break any custom relay
with the same illegible error. `script-src` stays `'self'` with no `unsafe-inline`, which is what
keeps the widened `connect-src` from being reachable. The tighter fix is to move the relay socket
into Rust so the webview needs no network access at all; that is worth doing when the sync hub
lands, not as a CSP tweak.

**Browsers on this machine skip the relay entirely.** The app and a paired extension already have
an authenticated pipe between them, so routing their sync traffic out to a relay and back through
WebRTC is a trip through the internet to reach the next process along. `PeerSource` in
`@core/sync/transport/peer-session` makes where peers come from injectable; a supplied source
short-circuits before ICE and before joining a room, so a local session never touches the network.
The local path also works with no network at all.

Nothing above that seam changes, deliberately. A local peer proves membership of the CURRENT
roster and completes Noise KK keyed by its device identity like any other, so being on the same
machine is not an authorization and a revocation bites a pipe as it bites a relay connection.

Both ends run TWO sessions, relay and link, rather than one combined source: a phone is only
reachable through the relay, a browser here is reachable without it, and a relay outage should not
take the local pipe down with it. They need no coordination because the merge they both feed is
already serialised.

This nests Noise inside Noise. The outer session authenticates a browser INSTALL to this app; the
inner one, which the link layer cannot read, authenticates a roster DEVICE to the group. They are
different identities on purpose, and only the inner one is what the roster knows, so it has to be
the one that survives to where revocation is enforced.

Three things that are easy to get wrong here, all now pinned by tests:

- **The link is request/response no longer.** The extension used to treat the next inbound frame
  as the answer to the request in flight. A pushed sync frame arriving mid-request would resolve
  it, leaving the session one frame out of step for the rest of its life: every later fill
  returning the previous fill's credential.
- **One connection per extension.** The app keys its outbound queue by the browser's static key,
  so a second connection displaces the first as the target for pushes, and closing that
  short-lived one takes the queue with it. Sync goes quiet with nothing reporting a fault. While
  the held link is up, delegation rides it rather than spawning its own.
- **A reconnect can be seen before the disconnect it replaced.** A browser can register a new
  connection before the old one notices it is dead, so events carry a link generation and each
  side ignores anything about a connection it has already replaced.

Peers are keyed by Noise static key, never the extension id: two browser profiles share an id but
not a key.

**Ongoing sync** (`src/sync/roster.ts`) mirrors mobile's `sync-manager.ts`, including all of its
issue-#27 pinning: the session binds to one vault id for its lifetime, merges are serialised, a
merge that outlives its session is dropped rather than written, and the blob store is pinned
rather than re-resolving the active vault per call. Desktop needs that more than mobile does,
not less: the process outlives the window, so a session can be running with no UI on screen.
`src/sync/roster.test.ts` pins the routing half, ported from mobile's.

**Host-side admission signing** is done, unlike on mobile. `ShellAdapter` lets the host
admission-sign a joiner's roster entry and write the roster itself; the extension does that
because Firefox's event page outlives the popup, and a lost write leaves the joiner rejected as
"not in roster" when it reconnects, which reads as a pairing that worked and then silently
didn't. Desktop has that hazard in worse form, since closing the vault window does not end the
process, so an invite can outlive the UI entirely. `admitJoiner` in `src/sync/transport.ts` does
the write before announcing the enrollment, which also orders it ahead of the UI's identical
write instead of racing it. The vault is pinned at invite time, like the VEK, so a vault switch
while the code is on screen cannot enrol the joiner into a group whose vault it was never given.

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

**Bundling.** The host manifest names an absolute path to the proxy, resolved as a sibling of
the running binary, so a bundle needs the proxy in `Contents/MacOS`. Tauri's `externalBin` puts
it there and signs it as a nested binary, which notarization requires. `scripts/stage-proxy.mjs`
builds and stages it, writing a placeholder first to break a circularity: the proxy is a binary
in the same crate as the app, so building it runs `tauri-build`, which validates that every
`externalBin` already exists.

A signed build is verified working: `codesign --verify --deep --strict` clean, and the app
rewrites every browser's manifest to a proxy path inside the bundle. Notarization is not done,
which only matters for machines other than the one that built it.

**Signing is not optional for this feature.** macOS ties a keychain item's ACL to the reading
binary's code signature, so an unsigned build looks like a different application on every build
and prompts for the login password. See risk 5.

## Filling from the panel

Enter in the quick-access panel fills the form in the browser. The app hands over the ONE
credential the user just chose; the browser puts it in the field.

This is the delegation model the browser link was chosen for, and the reason is the second
unlock. An earlier attempt routed the fill through the extension's own `AUTOFILL_SELECT`, which
reads the extension's index and therefore needs the EXTENSION unlocked — demanding exactly the
double unlock the link exists to avoid. Nothing on the path now reads the browser's vault: the
background forwards the credential and the content script calls `fillForm` directly, so a locked
browser can fill.

**Where authorization lives.** The user picking an entry in the panel, with the app unlocked, is
the grant. On top of that the app checks the entry's hostnames against the page the browser last
reported, so a wrong tab in front of the user is refused rather than filled, and the panel names
that page ("Fill on example.com") before the user commits.

That report comes from the browser, and a compromised extension could lie about it to obtain a
credential for a page it is not on. It is a second line, not the only one, which is why the panel
shows the target: the user sees where it is going. Hardening it properly means the app learning
the frontmost window itself rather than trusting a report `[unverified: needs NSWorkspace work]`.

**Limits, deliberate.** The fill goes to the top frame only, so a form inside an iframe is not
filled. Enter also copies the password, because the browser may refuse the page or not be running,
and an action that sometimes silently does nothing is worse than one that always does something.

**The link's lifetime is its own.** It opens when the browser starts if a pairing exists, whatever
the lock state, and closes only on unlink. Three separate bugs came from tying it to something
else: to sync starting (so a vault in no group had an unreachable app), to being unlocked (so
filling while locked, the entire point, could not work), and to an unlock TRANSITION (so a service
worker restarting with an already-unlocked session never opened it). An open pipe grants nothing on
its own: the app answers only while its own vault is unlocked, and the handshake still has to pass.

## Releasing and updating

Distribution is a signed GitHub release, nothing else. That makes updating part of the product
rather than a nicety: there is no store to push a fix through, so without an in-app updater a
security fix reaches only the people who happen to check the repository.

`plugins.updater` in `tauri.conf.json` points at `latest.json` on the latest release, and
`createUpdaterArtifacts` makes the bundler emit `Bramble.app.tar.gz` plus a `.sig`. The plugin
verifies that signature against the public key compiled into the INSTALLED build before applying
anything, which is what makes downloading a binary and running it acceptable: a substituted or
tampered asset fails verification and is discarded.

**The signing key is permanent from the first public release.** Verification uses the key baked
into the app someone already has, so changing the keypair later strands every existing install on a
manual re-download. It rides the same age + YubiKey scheme as every other release key (see release-signing.md):
encrypted at rest, unlocked with a PIN and a touch by `scripts/build-desktop.ts`, and never written
to disk in plaintext. The key cannot live ON the token, because Tauri's CLI signs with minisign and
takes a path or a string rather than driving a hardware token; what the YubiKey gates is access to
it. Note the env var is `TAURI_SIGNING_PRIVATE_KEY` — the `_PATH` variant its own generator
advertises is NOT what the bundler reads, and a build without a key fails at the bundling step
rather than silently producing an unsigned archive.

`pnpm release desktop <version|patch|minor|major>` cuts the release, the same shape as the other
targets: bump, gate, build, tag, push, publish. `--universal` builds both architectures. Tags are
`<version>-desktop`, and notarization is a hard requirement here rather than a warning — an
un-notarized build is one Gatekeeper blocks on every machine that did not produce it.

It publishes the GitHub release BEFORE committing the manifest, in a second commit. The manifest is
the live update channel, so the other order leaves a window where every app that checks reads a
manifest whose download 404s, and a failed update looks identical to a broken updater.

**Release from `main`.** The manifest reaches apps only through the website, and deploy-website.yml
runs on pushes to main, so a release cut from any other branch produces a real GitHub release that
no installed app ever hears about. The script checks the branch up front rather than letting that
happen. `/desktop/*` is served with a five minute cache (the site default is four hours), so an
update becomes visible shortly after the Pages deploy lands rather than the next morning.

`pnpm package:desktop` is the packaging half on its own: it builds and then writes `latest.json` from what the build actually produced,
rather than reconstructing filenames: the signature has to belong to the exact bytes published. It
builds rather than assuming a build, like the other targets, because assembling from whatever
happened to be in the bundle directory is how a release ends up carrying an artifact from an older
commit — and the signature would still verify against it, so the manifest would be internally
consistent and simply describe the wrong software. `--universal` builds both architectures;
`--resume` assembles what is already there. It refuses to write a manifest for an archive with no
`.sig`, because publishing one would leave a release that looks complete while updating silently
fails for everyone.

**`latest.json` is served from `https://bramble.sh/desktop/latest.json`, not the GitHub release.**
GitHub's `/releases/latest` means the newest release of ANY target, and this repo ships chromium,
firefox and android out of the same tag namespace — the endpoint resolved to `1.11.3-firefox` and
404'd. Even once a desktop release carried the manifest, the next extension release would take the
pointer back and silently break update checks for every install. The website is a stable https URL
under our control, so the release writes `website/public/desktop/latest.json` and the Pages deploy
publishes it. The endpoint is compiled into every shipped binary, so this had to be settled before
the first release rather than after.

The archive URLs inside the manifest still point at the GitHub release assets for the
`<version>-desktop` tag; only the manifest itself moved.

**A placeholder manifest is committed, and that is not tidiness.** The updater calls `res.json()`
on any 2xx that is not 204, and Cloudflare Pages answers unknown paths with 200 and an HTML page,
so a missing manifest does not read as "no update" — it reads as a parse error. A 404 would not
help either: the plugin treats any non-success status as an error too. The only clean answers are
204 or a valid manifest, so one is served from the start, with version `0.0.0` so it is never newer
than an installed build. Its platform entries have to be well-formed even though they are never
used, because `get_urls` resolves the URL for the running target BEFORE comparing versions; an
empty `platforms` map fails with `TargetNotFound` instead of reporting no update. A Rust test
parses the committed file so a malformed one fails the build rather than the update channel.

**The menu.** `menu.rs` builds the bar by hand rather than taking `Menu::default`, for two items:
an About panel that says who wrote this and under what licence, and a "Check for Updates…" that
does not require knowing Settings has an Updates section. Customising one submenu means owning the
whole bar, so Edit is rebuilt too — without it Cmd-C and Cmd-V stop working in the webview, in a
password manager.

macOS renders only part of `AboutMetadata`: name, version, short_version, copyright, icon and
credits. `authors`, `license` and `website` are accepted and silently dropped, so the author,
licence and source URL all go through `credits`, where they render as plain text. The URL is
therefore selectable, not clickable.

The menu item emits an event and the webview does the work, because the webview already owns the
updater adapter, the dialog copy and the progress UI; a second implementation in Rust would be a
second answer to "is there an update" that could disagree. A check from the menu differs from the
launch prompt in two ways: it ignores the dismissed version, since asking again is the point, and
it always answers — "Bramble is up to date" when there is nothing, and the error when the check
fails. On launch those are silent, because nobody asked.

**Being told an update exists.** Settings has a Check button, but a manual check is only found by
someone who already suspects there is something to find, which is the wrong assumption for a
security fix. So `updates-prompt.ts` asks once, five seconds after launch, in a native dialog: long
enough to stay out of the way of unlocking, still plainly part of opening the app. Declining
records the version, so the same one is never offered twice and the prompt does not train people to
dismiss it unread.

Accepting routes to Settings before starting the download, because a system dialog cannot show
progress and a password manager that goes quiet and then restarts by itself is alarming. That is
why download progress is a subscription on the updates adapter rather than local state in the
section: the install starts outside the component, and a section tracking only its own clicks would
show "Check for updates" while the app downloaded itself.

The dialog's copy lives in `packages/core/src/app/update-prompt-copy.tsx`, not beside the dialog.
The extractor only reads `packages/core/src`, so the same sentence written in the desktop package
would ship untranslated to every locale. It falls back to English if no catalog is active yet:
Lingui throws rather than falling back, and a thrown error there means no dialog at all.

**Notarization** reuses the App Store Connect API key the iOS release already has. Apple takes
either that or an Apple ID with an app-specific password; the key is the better credential, since
it is scoped, separately revocable, and not one that also opens the account. `build-desktop.ts`
reads `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_PATH` from `fastlane/.env` and maps them to the
`APPLE_API_*` names Tauri expects, rather than having the issuer ID written down twice; explicit
`APPLE_*` in the environment still wins, for CI. Without them the build succeeds and produces
something Gatekeeper blocks everywhere but the machine that built it, so the script says so.

### Testing an update without publishing one

`pnpm build:desktop:local-update` builds against `tauri.local-update.conf.json`, which points the
updater at `http://127.0.0.1:8787` and turns off the https requirement, and `pnpm updater:smoke`
serves that build back to itself as a newer version. It skips notarization: the build never leaves
the machine, so it would buy nothing and cost an upload, a wait, and a submission record.
(`BRAMBLE_SKIP_NOTARIZE=1` does the same for any other local build.) Run the app out of
`target/release/bundle/macos/` rather than `/Applications`, so replacing the bundle needs no
privileges, and watch the server log: a request for `latest.json` then one for the archive is the
whole handshake.

`--slow[=seconds]` spreads the download out (default 10s). Six megabytes off localhost arrives in
milliseconds, so without it the percentage in Settings is gone before it can be read, which makes
the one part of the UI worth watching the one part you cannot see. The manifest is never throttled.

It advertises the SAME archive under a bumped version. The signature covers the archive's bytes and
the version comes from the manifest, so every check the plugin makes passes; it installs what is
already installed. One build instead of two, and it still exercises the part worth exercising —
manifest, download, signature verification against the key compiled into the running app, bundle
replacement, relaunch. Afterwards the app reports the old version and offers the same update again.
That is expected. To confirm the version really changes, bump `tauri.conf.json`, build again, and
serve the new archive to the old install.

**A local-update build must never be released.** It would check a machine that is not there and
could never be updated again, since the fix would arrive over the channel that is broken.
`pnpm release:desktop` refuses to write a manifest when it finds the local endpoint in the built
binary, which catches it whatever produced the build.

**Architecture.** Every desktop build is universal, not just a release: `pnpm build:desktop`,
the local-update test build, and `pnpm release desktop` all produce both slices. A host-arch build
is not something to hand anyone, and it fails in the least useful way, by looking identical and
simply not opening on an Intel Mac. `--aarch64` (or `pnpm build:desktop:aarch64`) opts out for
iterating, where the second slice doubles the build for a machine that cannot run it.

Bundles land under `target/universal-apple-darwin/release/bundle`, not `target/release/bundle`,
because cargo puts a `--target` build under its triple. It needs
`rustup target add x86_64-apple-darwin`, checked before the gate rather than several minutes into a
build that ran the whole test suite first.

The sidecar is the awkward part, and none of it fails early. Tauri lipos the app's MAIN binary and
nothing else, while `externalBin` entries are copied rather than built, so a universal build wants
the proxy in two places at once: `binaries/bramble-proxy-universal-apple-darwin` for the sidecar
copy, and `target/universal-apple-darwin/release/bramble-proxy` for the binary copy it does for
this crate's own bins. stage-proxy writes both. Staging only the host arch would have produced a
universal app with an Apple-Silicon-only proxy, where the app launches on Intel and the browser
link simply never works. `build.rs` also names its placeholder after the triple being compiled
rather than the host's, or cross-compiling the proxy fails looking for the sidecar that compiling
it is supposed to produce. Local builds (`pnpm build:desktop`) stay host-arch, since
nothing about iterating wants the second slice. Two things about that path are easy to get wrong and were, at first. cargo puts a
`--target` build under `target/<triple>/`, so a universal build does NOT land in `target/release`,
and reading the wrong directory is not an empty-directory error: it is the previous aarch64 build,
published as though it were the universal one. And a universal archive is named exactly like an
aarch64 one, so keying it by filename hides it from Intel entirely, where the updater reports
TargetNotFound rather than no update. It is keyed under both arches instead.

`minimumSystemVersion` is unset, which means Tauri's default of 10.13.

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
   precedent but desktop notarization is new ground. **Browser pairing now depends on this**,
   which is the part that is easy to miss: macOS ties a keychain item's ACL to the reading
   binary's code signature, so an unsigned or ad-hoc-signed build looks like a different
   application on every build and prompts for the login password each time. Ship it unsigned
   and every user gets a password prompt on every launch, which for a password manager reads
   as something being wrong. A Developer ID signature is stable across builds and updates, so
   it should prompt zero times. `[unverified: no signed desktop build exists yet, so the
   zero-prompt claim and ACL survival across updates are both inference from how macOS ACLs
   work rather than something observed]`
6. ~~**webrtc-rs interop with the extension's browser WebRTC on desktop.**~~ Retired by not
   happening: macOS WKWebView has its own WebRTC, so desktop talks to peers with the same browser
   APIs the extension does. Returns only if WebKitGTK turns out to lack them.

## Proposed plan

Each phase retires a risk.

- **Phase 0, walking skeleton. DONE**, on macOS only: `packages/platform-desktop` (Vite + React,
  mirroring platform-mobile) plus `src-tauri` as its own crate. The `native` feature split. Linux
  and Windows are still unbuilt, so risk 1 is not actually retired.
- **Phase 1, vault MVP. MOSTLY DONE.** `storage`, `crypto`, `clipboard`, `shell` adapters, VEK
  held in Rust, create/unlock/CRUD. `Target` and `CAPABILITIES` widened. Outstanding: KDBX import
  and the passkey provider (both need core-rust re-exports), and biometric unlock.
- **Phase 2, spotlight. IN PROGRESS.** Shell done (window, hotkey, vibrancy, collapse-to-search,
  tray and app lifetime). Next: a metadata-only search index held in Rust and pushed from the
  main window, `spotlightActions` on `EntryMode`, and the combobox with Cmd+O / Cmd+E. Actions
  stay clipboard-only until Phase 4, so it is useful before any IPC exists. The non-activating
  panel (risk 2) is deliberately deferred to when auto-type makes it matter.
- **Phase 3, sync hub. IN PROGRESS.** Enrollment (invite and join), host-side admission signing,
  and ongoing roster sync all run in the vault window on the webview's own WebRTC, with the
  crypto routed to Rust. Browsers on this machine sync over the native link instead of the relay,
  on both ends. Device identity lives in the OS credential store. Outstanding: the tray residency
  and scheduled backups that are the actual "hub" part, and a two-device test.
- **Phase 4, browser integration. DONE for fill.** Proxy binary, host manifests, Noise pairing,
  and Enter in the panel fills the page in the browser. See "Filling from the panel" below.
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
