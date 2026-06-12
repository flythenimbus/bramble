# Firefox port: feasibility findings

Research notes on shipping `packages/platform-extension` (MV3, currently Chrome-only) as a
Firefox add-on from one codebase. Captures what was verified about Firefox's platform, what in
the codebase is already portable, and the one hard blocker (filesystem sync).

Fast-moving platform facts are dated **mid-2026**; re-verify before acting on them later.

## Summary

- Porting the runtime is **small**: most Chrome-isms are already feature-detected and degrade
  without crashing. There are two real code changes (the offscreen document, and the `chrome.*`
  namespace), plus a per-target manifest and build wiring.
- The one genuine blocker is **filesystem sync**. Firefox cannot replicate the File System
  Access (FSA) "store `vault.db` anywhere, autosave silently" model that is the app's serverless
  sync mechanism. A pure extension can at best auto-push to a Downloads-relative file with manual
  pull. True parity needs a native-messaging companion. See "Filesystem sync".

## Chrome API surface in use

Swept from `packages/platform-extension/src` (excluding tests/fixtures). All of the following
work on Firefox MV3 as-is **except** `chrome.offscreen`:

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
| `offscreen.*` | offscreen-client.ts | **Absent on Firefox** (the core change) |
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
SW idle-kill, and (c) clear the clipboard. Firefox has no `chrome.offscreen`.

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

Blast radius: six importers (`session.ts`, `clipboard.ts`, `background.ts`, `vault-io.ts`,
`autofill-index.ts`, `corner-prompt.ts`) and two test/harness references. The test harness mocks
`chrome.offscreen`, so under vitest the feature-detect always picks the Chrome branch and existing
assertions stay valid.

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

## Manifest deltas (Chrome vs Firefox)

The build already copies `packages/manifests/chrome/manifest.json`. A Firefox manifest is identical
except:

| Field | Chrome | Firefox |
| --- | --- | --- |
| `background` | `{ "service_worker": "background.js", "type": "module" }` | `{ "scripts": ["background.js"], "type": "module" }` (event page) |
| `browser_specific_settings.gecko` | n/a | `{ "id": "...", "strict_min_version": "128.0" }` required |
| `minimum_chrome_version` | `"116"` | drop (Chrome-only key) |
| `permissions` | includes `"offscreen"` | drop `"offscreen"` (FF rejects unknown perms; also keeps `api.offscreen` undefined) |
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
- AMO requires source for bundled JS and WASM. Document the reproducible build (`bun install`,
  `bun run wasm:build`, `TARGET=firefox bun run build:firefox`); `rust-toolchain.toml` already pins
  the Rust toolchain for `packages/crypto-wasm`.
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
   `crypto-wasm` stack) reads/writes the user's chosen path; the extension talks to it via
   `runtime.connectNative`. Restores Chrome-equivalent sync. Cost: a separate native app, a per-OS
   installer, macOS signing/notarization, a native-messaging manifest the user registers, and a new
   security surface. AMO ships only the extension; the host is installed separately. Large, separate
   workstream. This is the mechanism KeePassXC and 1Password use.
2. **Ship Firefox without file-sync (recommended for v1).** Live vault in `storage.local`; add
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
5. **P2P device-to-device sync (no filesystem, no binary).** Move sync off the filesystem
   entirely: a WebRTC data channel carries the encrypted vault directly between the user's own
   devices, with a merge engine reconciling edits. Same-network/all-online for v1; signaling via
   a user-chosen Nostr-subset relay; trust anchored on a per-device roster so the relay is an
   untrusted pipe. Cross-browser (works on Chrome too) and independent of the FSA gap. Full
   design in [p2p-sync.md](p2p-sync.md).

Recommendation: Option 2 for v1 (ships honestly, unblocks the rest of the port), with Option 1
tracked as a follow-up for users who need Firefox + sync. Avoid Option 3 unless its push-only nature
is messaged very clearly. Option 5 is the cross-browser sync path being designed and supersedes 1
and 3 if it lands. The rest of the port is independent of this choice.

### Storage durability (Firefox, no FSA)

Without FSA the vault lives in `storage.local` as the **primary** store, not a fallback, so its
durability properties become load-bearing. Three facts to design around (verified mid-2026):

- **Size cap.** `storage.local` is capped (Chrome: 10 MB, 5 MB on Chrome 113 and earlier;
  Firefox: bounded by the IndexedDB quota, a slice of ~50% free disk). A typical vault is well
  under 1 MB, but ~10k entries can reach ~5-9 MB and bump the Chrome cap. Fix: declare the
  **`unlimitedStorage`** permission (manifest-only, no API) in **both** manifests, after which
  storage is disk-bounded. The manifest table above lists `storage.local` but not this
  permission; add it.
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
