# Firefox port: feasibility findings

Research notes on shipping `packages/platform-extension` (MV3, currently Chrome-only) as a
Firefox add-on from one codebase. Captures what was verified about Firefox's platform, what in
the codebase is already portable, and the sync constraint (no FSA on Firefox, so the WebRTC P2P
channel is the mandatory v1 sync path).

Fast-moving platform facts are dated **mid-2026**; re-verify before acting on them later.

## Summary

- Porting the runtime is **small**: most Chrome-isms are already feature-detected and degrade
  without crashing. There are two real code changes for the core runtime (the offscreen document,
  and the `chrome.*` namespace), plus a per-target manifest and build wiring.
- The **passkey provider** uses `chrome.webAuthenticationProxy`, a Chrome-only API with no Firefox
  equivalent. It is feasible on Firefox via a content-script transport but is **optional for a first
  ship**; see "Passkey provider".
- **P2P sync is mandatory for Firefox v1.** With no FSA, file-anywhere sync is impossible on Firefox
  (below), so the WebRTC P2P channel (Option 5) is the only cross-device sync Firefox can offer,
  which makes it a hard v1 dependency rather than an enhancement. The P2P workstream has **landed**
  on Chrome (roster-auth, merge, enrollment, UI), so the remaining Firefox work is porting its
  transport from the offscreen document to the event page, not building sync itself.
- **Filesystem sync cannot port.** Firefox cannot replicate the File System Access (FSA) "store
  `vault.db` anywhere, autosave silently" model that is the Chrome build's serverless sync
  mechanism; a pure extension can at best auto-push to a Downloads-relative file with manual pull,
  and true file parity needs a native-messaging companion. This is why P2P (above) is the Firefox
  sync path instead. See "Filesystem sync".

## Chrome API surface in use

Swept from `packages/platform-extension/src` (excluding tests/fixtures). All of the following
work on Firefox MV3 as-is **except** `chrome.offscreen` and `chrome.webAuthenticationProxy`:

| API | Where | Firefox status |
| --- | --- | --- |
| `storage.local` / `storage.session` / `storage.onChanged` | storage.ts, session.ts, popout.ts, corner-prompt.ts, vault-io.ts, crypto.ts | OK (`storage.session` since FF 115) |
| `runtime.*` (sendMessage, onMessage, getURL, getManifest, onInstalled/onStartup, openOptionsPage) | pervasive | OK |
| `alarms.*` | clipboard.ts, session.ts, background.ts | OK |
| `tabs.*` (query, create, sendMessage, captureVisibleTab) | shell.ts, qr.ts, corner-prompt.ts, autofill-index.ts | OK (`captureVisibleTab` needs the host permission) |
| `windows.*` (create, update, get, getCurrent, getLastFocused) | popout.ts, qr.ts, corner-prompt.ts | OK |
| `commands.onCommand` | background.ts | OK |
| `idle.onStateChanged` | background.ts | Partial: no `"locked"` state on FF (see below) |
| `action.openPopup` | corner-prompt.ts | Already has a `windows.create` fallback |
| `offscreen.*` | offscreen-client.ts | **Absent on Firefox** (the core change); also now hosts the WebRTC sync transport |
| `webAuthenticationProxy.*` | webauthn-proxy.ts, webauthn-proxy-init.ts | **Absent on Firefox** (passkey provider; needs a content-script transport, see "Passkey provider") |
| `OffscreenCanvas` + `createImageBitmap` | qr.ts | OK (available in the FF event page) |
| `navigator.clipboard.writeText` | clipboard.ts (popup), offscreen.ts (clear) | OK with `clipboardWrite`; clear-from-background has a caveat (see Risks) |

Note: the code references the `browser`-incompatible `chrome.*` namespace throughout. See
"Namespace".

## Already portable (graceful degradations, no work)

- **FSA file picker**: feature-detected in `shell.ts:hasFilePicker()` and
  `storage.ts:pickerSupported()`. When `showSaveFilePicker`/`showOpenFilePicker` are absent the
  vault falls back to `chrome.storage.local`, so nothing throws on Firefox. This keeps the app
  running but breaks file-based sync (see "Filesystem sync").
- **`chrome.action.openPopup`** (Chrome 127+): wrapped in try/catch with a `chrome.windows.create`
  fallback at `corner-prompt.ts:350`.
- **`chrome.idle` / `chrome.commands`**: optional-chained in `background.ts`. The idle `"locked"`
  state used to lock on OS screen-lock is Chrome-only; on Firefox that listener just never fires
  and the sliding auto-lock alarm remains the safety net.
- **CSP** `script-src 'self' 'wasm-unsafe-eval'`: supported by Firefox MV3.

## The offscreen document (core change)

Chrome's MV3 background is a service worker with no DOM, so the code uses an **offscreen
document** to (a) host the Rust WASM crypto module, (b) hold the live VEK across popup close and
SW idle-kill, (c) clear the clipboard, and (d) host the WebRTC sync transport (added after this
doc's first draft; `offscreen.Reason.WEB_RTC`). Firefox has no `chrome.offscreen`.

Firefox does not need one: its MV3 background is an **event page with a DOM document**, so it can
host WASM and call `navigator.clipboard` directly (Mozilla docs state this explicitly). So the
Firefox "crypto host" is just the background event page itself, with in-process function calls
instead of `chrome.runtime.sendMessage` round-trips.

Design that works for both from one bundle:

- Extract the crypto switch (`dispatchCrypto`), the lazy `getWasm()` singleton, `clearClipboard()`
  and `b64ToBytes()` out of `offscreen.ts` into a transport-free module that touches no DOM/WASM at
  import time (so a Chrome SW can import it safely).
- `offscreen.ts` becomes a thin Chrome-only entry that keeps the `runtime.onMessage` listener.
- The client (`offscreen-client.ts`) generalizes into a crypto host that selects its transport at
  runtime via `typeof api.offscreen !== "undefined"`: Chrome uses the offscreen-document messaging;
  Firefox calls the extracted dispatch in-process.
- The existing VEK re-injection guard stays and is needed on both: Chrome's offscreen can be killed
  and Firefox's event page can be suspended; in both cases the WASM instance resets to locked while
  the VEK rehydrates from `storage.session`.
- The crypto path (WASM) works in the Firefox event page in-process, verified on-device.
- **The WebRTC sync transport does NOT** (corrected mid-2026, device-tested). `RTCPeerConnection`
  is **undefined in the Firefox extension background** (event page or persistent page) — a
  documented Firefox limitation: WebRTC works only in a real tab or a frame inside a tab, not the
  background (bug 1278100). `WebSocket` (relay signaling) *does* work in the background, so
  enrollment gets as far as "relay connected / peer found" and then throws
  `RTCPeerConnection is not defined` at `new RTCPeerConnection` (webrtc-peer.ts). This invalidates
  the earlier "event page hosts RTCPeerConnection directly" assumption. Firefox P2P therefore needs
  a different transport home; see "Firefox P2P transport" below.

Blast radius: six importers (`session.ts`, `clipboard.ts`, `background.ts`, `vault-io.ts`,
`autofill-index.ts`, `corner-prompt.ts`) and two test/harness references. The test harness mocks
`chrome.offscreen`, so under vitest the feature-detect always picks the Chrome branch and existing
assertions stay valid.

## Firefox P2P transport (open — blocks headless FF sync)

`RTCPeerConnection` is unavailable in the Firefox background (above), so the WebRTC data channel
cannot run there. Options, most to least headless:

1. **Relay-forward channel (recommended).** Carry the Noise-encrypted payload over the existing
   signaling relay (`WebSocket`, which *does* work in the background) instead of a WebRTC data
   channel. The relay already sees only ciphertext, so the trust model is unchanged; the Noise
   handshake, enrollment, and roster+entries merge all stay. Needs a relay-backed `channel.ts`
   selected on Firefox. **Only option that preserves headless background sync.** Slower; bounded by
   relay message size/rate.
2. **WebRTC in a tab-context page.** Run the transport in an extension page loaded in a real tab
   (the options/Settings page, or a `web_accessible_resource` iframe injected into a page by a
   content script), where `RTCPeerConnection` exists. Direct P2P like Chrome, but sync runs only
   while that page/tab is open (not headless), and an injected iframe dies on navigation.
3. **Native WebRTC (webrtc-rs) via native messaging.** Heavy: a separate native host + installer,
   like the iOS approach. Overkill for a browser extension.

Recommendation: option 1 (relay-forward) — the only headless-preserving path, reusing the whole
transport-free engine, at the cost of a new channel backing + relay-bandwidth limits.

## Passkey provider (Chrome-only proxy; Firefox needs a content-script transport)

Bramble is a software WebAuthn authenticator: it creates and stores passkeys in the vault and signs
assertions with its own P-256 keys (see `docs/passkey-provider.md`). On Chrome this is delivered via
**`chrome.webAuthenticationProxy`**: the browser routes a page's `navigator.credentials.create/get`
calls to the extension, which runs the ceremony. Firefox has **no equivalent** to that proxy API, so
this delivery path does not port. It is **not** a hard blocker, and the feature is **optional for a
first Firefox ship**.

Three Firefox/WebAuthn facts, to keep the mechanisms straight (verified mid-2026):

1. **WebAuthn client** (`navigator.credentials.create/get`, conditional UI): fully supported on
   Firefox. This is a user signing into sites with passkeys, not Bramble acting as a provider.
2. **`webAuthenticationProxy`**: Chrome-only; absent from Firefox's WebExtension API surface. This
   is the path Bramble currently uses.
3. **Extension WebAuthn with a custom RP ID** (Firefox 150 / Chrome 122): an extension may call
   `navigator.credentials.*` and specify an RP ID for any domain in its host permissions. Per MDN
   this lets the extension *make WebAuthn calls itself*; it does **not** intercept page requests,
   and it would use the *platform* authenticator rather than Bramble's vault keys. Related, but not
   the provider path.

How third-party managers (Bitwarden, Proton Pass, ...) provide passkeys in Firefox today, and the
recommended path here: **content-script interception**. A `world: "MAIN"` content script (FF 128+)
overrides the page's `navigator.credentials.create/get`, forwards the request to the background,
runs the ceremony, and returns a synthetic `PublicKeyCredential`. Because Bramble signs with its own
vault keys, it needs no platform authenticator; only the transport differs from Chrome.

The architecture already supports this split. The **pure ceremony handlers**
(`background/webauthn-proxy.ts`: `handleCreate`, `handleGet`, the corner-card ceremony) are
transport-free and reusable; only the **wiring** (`background/webauthn-proxy-init.ts`, which
attaches the Chrome proxy) is Chrome-specific. The Firefox port keeps the proxy on Chrome (and drops
the `webAuthenticationProxy` permission from the Firefox manifest) and adds a MAIN-world
content-script transport that drives the same handlers.

Open items to verify before building this:

- Structured-clone of the returned `PublicKeyCredential` / `ArrayBuffer`s across the MAIN-world
  boundary (the page expects real `ArrayBuffer`s, not typed-array copies).
- `world: "MAIN"` content-script timing vs a page that calls `navigator.credentials` early.
- Conditional UI / `mediation: "conditional"` (passkey autofill) is a larger surface; scope it out
  of the first pass.

## Namespace: `chrome.*` vs `browser.*`

The code is promise-style (`await chrome.storage.local.get(...)`). Chrome MV3 returns promises
from `chrome.*`. Firefox documents `browser.*` as the promise namespace and does not guarantee
promise semantics on the `chrome.*` compatibility alias, so relying on `await chrome.*` on Firefox
is undocumented behavior.

Cheapest robust fix (no runtime dependency): a one-line shim
`const api = globalThis.browser ?? chrome` (typed as `typeof chrome`), then reference `api.*`
everywhere. Use `globalThis.browser ?? chrome` (not a bare `browser`) so vitest under Node does not
`ReferenceError`. `webextension-polyfill` is the heavier alternative; the shim fits better because
the codebase is already promise-native.

The `chrome.*` sweep now spans ~32 source files (the passkey-provider and sync modules added since
this doc's first draft), so the shim is the single mechanical change that touches the most files.

## Manifest deltas (Chrome vs Firefox)

The build already copies `packages/manifests/chromium/manifest.json`. A Firefox manifest is identical
except:

| Field | Chrome | Firefox |
| --- | --- | --- |
| `background` | `{ "service_worker": "background.js", "type": "module" }` | `{ "scripts": ["background.js"], "type": "module" }` (event page) |
| `browser_specific_settings.gecko` | n/a | `{ "id": "...", "strict_min_version": "128.0" }` required |
| `minimum_chrome_version` | `"116"` | drop (Chrome-only key) |
| `permissions` | includes `"offscreen"`, `"webAuthenticationProxy"` | drop both `"offscreen"` and `"webAuthenticationProxy"` (FF rejects unknown perms; also keeps `api.offscreen` / `api.webAuthenticationProxy` undefined) |
| `content_security_policy`, `web_accessible_resources`, `commands`, `host_permissions`, `action`, `icons`, `options_page` | same | same |

Verified Firefox facts behind these choices:

- **Background**: `"background": { "scripts": [...], "type": "module" }` is supported; Firefox
  starts the event page even when `service_worker` is present (FF 121+). The event page provides
  the DOM document used for WASM and clipboard.
- **Host permissions**: from FF 127, entries in `host_permissions` and `content_scripts` are shown
  in the install prompt and granted on install, so `<all_urls>` autofill works out of the box.
  Users can still revoke them in `about:addons`. `strict_min_version: "128.0"` is the safe floor.
- **`web_accessible_resources` `use_dynamic_url: true`**: Firefox may ignore it. The autofill-ui
  iframe still loads via a static `moz-extension` URL; only per-session URL rotation is lost.
  Confirm with `web-ext lint`.

## Build tooling

- Parametrize `vite.config.ts` by `process.env.TARGET` (`chrome` default | `firefox`): the
  `copy-manifest` plugin copies the matching manifest, and `outDir` switches to `dist` vs
  `dist-firefox` so the two builds do not clobber each other.
- Add scripts (`build:firefox`, `bundle:firefox`) and the `web-ext` dev dependency for
  `web-ext lint` / `run` / `build` / `sign`. Add `dist-firefox/` and `web-ext-artifacts/` to
  `.gitignore`.

## AMO submission notes (if distributing on addons.mozilla.org)

- Set `gecko.id` and `strict_min_version`.
- Privacy policy URL is required for a password manager; reuse `website/` and include the HIBP
  breach-check disclosure already written for the Chrome listing.
- AMO requires source for bundled JS and WASM. Document the reproducible build (`pnpm install`,
  `pnpm run wasm:build`, `TARGET=firefox pnpm run build:firefox`); `rust-toolchain.toml` already pins
  the Rust toolchain for `packages/core-rust`.
- Sign via `web-ext sign` or AMO web upload to produce the `.xpi`.

## Filesystem sync (the hard constraint)

The Chrome build uses FSA so a user can put `vault.db` in a Dropbox/Syncthing/iCloud folder and get
serverless cross-device sync: silent autosave on write, and a re-read of the file on unlock that
picks up another device's changes.

Verified Firefox facts (mid-2026):

- Firefox implements **no local file pickers** (`showSaveFilePicker`, `showOpenFilePicker`,
  `showDirectoryPicker`) on any platform, and Mozilla has a standards position that local-disk
  pickers are harmful, so this is not arriving soon. Only OPFS (`navigator.storage.getDirectory`,
  sandboxed and not user-visible) ships.
- The extension `downloads` API is confined to the Downloads directory (relative paths, no `..`).
  It can overwrite silently (`conflictAction: "overwrite"`, `saveAs: false`) but **cannot read a
  file back**.
- No WebExtension API reads or writes an arbitrary path. Mozilla states **native messaging is the
  only route** to arbitrary files.

Consequence: a pure Firefox extension cannot do bidirectional file sync. The most it can do is
auto-push (mirror writes to a Downloads-relative file) with manual pull (the user re-imports to
pick up another device's edits). The user's Dropbox path cannot be targeted programmatically.

### Options

1. **Native messaging companion (true parity).** A small native host (Rust, reusing the
   `core-rust` stack) reads/writes the user's chosen path; the extension talks to it via
   `runtime.connectNative`. Restores Chrome-equivalent sync. Cost: a separate native app, a per-OS
   installer, macOS signing/notarization, a native-messaging manifest the user registers, and a new
   security surface. AMO ships only the extension; the host is installed separately. Large, separate
   workstream. This is the mechanism KeePassXC and 1Password use.
2. **Ship Firefox without file-sync (backup layer; pairs with Option 5).** Live vault in `storage.local`; add
   explicit Export (download `.db`) and Import (file input) for backup and device migration.
   Document that file-anywhere sync is a Chrome/Edge capability Firefox cannot support (a Mozilla
   platform limitation). Smallest effort, honest; Firefox is a single-device tier with manual
   backup.
3. **Auto-push mirror (partial).** `storage.local` live, plus a debounced auto-overwrite of
   `Downloads/Bramble/vault.db` (with `downloads.erase()` to keep the panel clean); the user points
   a sync tool at that folder or symlinks it into Dropbox. Convenient backup to a synced folder, but
   pull is still manual, so multi-device editing silently diverges. Risk: users mistake it for real
   sync. Medium effort.
4. **Defer or re-scope Firefox.** If matching Chrome's sync is a hard requirement and native
   messaging is unacceptable, Firefox may not be worth shipping yet.
5. **P2P device-to-device sync (no filesystem, no binary) — mandatory for Firefox v1.** Move sync off the filesystem
   entirely: a WebRTC data channel carries the encrypted vault directly between the user's own
   devices, with a merge engine reconciling edits. Same-network/all-online for v1; signaling via
   a user-chosen Nostr-subset relay; trust anchored on a per-device roster so the relay is an
   untrusted pipe. Cross-browser (works on Chrome too) and independent of the FSA gap. Designed in
   [p2p-sync.md](p2p-sync.md); landed on Chrome.

Recommendation (updated): for Firefox, **Option 5 (P2P sync) is the mandatory v1 sync mechanism** —
with FSA absent it is the only cross-device sync Firefox can offer. The P2P workstream has **landed**
on Chrome, so the remaining Firefox work is porting its WebRTC transport to the event page rather
than building sync. Pair it with the **export/import backup from Option 2**, which is non-optional
regardless because `storage.local` is wiped on uninstall (see "Storage durability").
Option 1 (native messaging) stays a later follow-up only for users who want file-anywhere parity;
avoid Option 3. This supersedes the earlier "Option 2 single-device tier" plan: via P2P, Firefox is
a full multi-device tier. The rest of the port is independent of the sync choice.

### Storage durability (Firefox, no FSA)

Without FSA the vault lives in `storage.local` as the **primary** store, not a fallback, so its
durability properties become load-bearing. Three facts to design around (verified mid-2026):

- **Size cap.** `storage.local` is capped (Chrome: 10 MB, 5 MB on Chrome 113 and earlier;
  Firefox: bounded by the IndexedDB quota, a slice of ~50% free disk). A typical vault is well
  under 1 MB, but ~10k entries can reach ~5-9 MB and bump the Chrome cap. Fix: declare the
  **`unlimitedStorage`** permission (manifest-only, no API) in **both** manifests, after which
  storage is disk-bounded. The chromium manifest already declares `unlimitedStorage`; the Firefox
  manifest must carry it too.
- **Uninstall clears it.** Unlike an FSA file (which survives), `storage.local` is wiped on
  extension uninstall, and a profile reset loses it too. So on Firefox the vault can vanish with
  no file to fall back on. This makes **export/import backup (Option 2) non-optional**, and is a
  second reason to want **P2P sync (Option 5)**: with sync the vault also lives on peer devices,
  giving redundancy against this failure mode.
- **Eviction under disk pressure.** Firefox's Quota Manager can evict an origin's storage when
  the global limit is hit; only **persistent** buckets are exempt. `unlimitedStorage` lifts the
  quota cap but does not clearly mark the bucket persistent. Smoke-test whether extension storage
  is treated as persistent, and if not, call `navigator.storage.persist()` to request it. Silent
  eviction of the only copy is the failure most worth ruling out for a password manager.

Sources: [`storage.local` (MDN)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/local),
[`chrome.storage`](https://developer.chrome.com/docs/extensions/reference/api/storage),
[Storage quotas and eviction (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

## Risks / open items

- **Clipboard clear from the Firefox background**: `navigator.clipboard.writeText("")` from an
  unfocused background page may be rejected. Fallback: a hidden `<textarea>` + `document.execCommand("copy")`
  (enabled by `clipboardWrite`). Verify during smoke testing.
- **`use_dynamic_url`** may be ignored on Firefox (see Manifest deltas). Low impact.
- **Revocable host permissions**: Firefox users can revoke `<all_urls>` in `about:addons`. v1 relies
  on the FF 127+ install-time grant; an optional fast-follow is a `permissions.contains` check with
  re-request.
- **AMO WASM review** needs the reproducible Rust build steps documented.

## Sources

- File System API / Firefox support: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API
- `downloads.download()`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/download
- WebExtensions filesystem position: https://wiki.mozilla.org/WebExtensions/Filesystem
- Native messaging: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging
- Background scripts (event page, `type: module`): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts
- `host_permissions` install-time grant: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions
- Build a cross-browser extension (`chrome.*` vs `browser.*`): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Build_a_cross_browser_extension
- webextension-polyfill: https://github.com/mozilla/webextension-polyfill
- WebAuthn in web extensions (extension RP ID, FF 150 / Chrome 122): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Use_the_web_authn_api
- Web Authentication API (Firefox client support): https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API
- `chrome.webAuthenticationProxy` (Chrome-only): https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy
