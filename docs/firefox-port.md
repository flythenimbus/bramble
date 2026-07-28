# Firefox port: feasibility findings

> **Superseded on storage:** this doc frames Firefox's lack of File System Access as *the*
> sync gap, because Chrome then stored the vault in a real FSA file. Chrome has since moved
> to `chrome.storage.local` too (see [storage.md](storage.md)), so **both browsers now use
> the sandbox backend and neither has a synced file** — the FSA discussion below is
> historical. The conclusion is unchanged and stronger: WebRTC P2P is the sync path
> everywhere.

Research notes on shipping `packages/platform-extension` (MV3, currently Chrome-only) as a
Firefox add-on from one codebase. Captures what was verified about Firefox's platform, what in
the codebase is already portable, and the sync constraint (no FSA on Firefox, so the WebRTC P2P
channel is the mandatory v1 sync path).

Fast-moving platform facts are dated **mid-2026**; re-verify before acting on them later.

## Summary

- Porting the runtime is **small**: most Chrome-isms are already feature-detected and degrade
  without crashing. There are two real code changes for the core runtime (the offscreen document,
  and the `chrome.*` namespace), plus a per-target manifest and build wiring.
- **The passkey provider now works on Firefox** via a MAIN-world content-script transport (built,
  unit-tested, and device-verified on webauthn.io). `chrome.webAuthenticationProxy` is Chrome-only, so Firefox
  overrides `navigator.credentials.create/get` in the page's own world and drives the same
  transport-free ceremony handlers Chrome uses. **Security-key unlock stays gated off** (the
  `moz-extension://` origin can't be a WebAuthn RP, and Firefox lacks PRF over external keys
  regardless). See "Passkey provider", "Security-key … unlock", and "Status".
- **P2P sync is mandatory for Firefox v1, and works via a relay-forward fallback.** With no FSA,
  file-anywhere sync is impossible on Firefox, so P2P is the only cross-device sync it can offer. But
  Firefox has no `RTCPeerConnection` in any reachable context (WebRTC off by default in hardened
  builds; the background lacks it regardless), so the Noise-encrypted frames ride the signaling
  relay's `WebSocket` instead of a data channel — headless in the FF background, negotiated per pair.
  Chrome↔Chrome stays direct-WebRTC; the relay only ever sees ciphertext. See "Firefox P2P
  transport".
- **Filesystem sync cannot port.** Firefox cannot replicate the File System Access (FSA) "store
  `vault.db` anywhere, autosave silently" model that is the Chrome build's serverless sync
  mechanism; a pure extension can at best auto-push to a Downloads-relative file with manual pull,
  and true file parity needs a native-messaging companion. This is why P2P (above) is the Firefox
  sync path instead. See "Filesystem sync".

## Status (2026-07)

Branch `feat/firefox` is a clean fast-forward onto `main` (34 commits ahead, 0 behind), so it merges
without conflicts. Full gate green: 581 JS tests (core / mobile / extension), 35 Rust/WASM `cargo`
tests, `biome` clean across 310 files, both targets build, `web-ext lint` 0 errors. Core flows are
device-tested on Firefox (unlock, sync, passkey provider); the one feature still to build and the
on-device checks not yet crossed live are under "Remaining" below.

**Built:**

- Runtime port — the `api` shim (`chrome.*` → `globalThis.browser ?? chrome`), the offscreen →
  event-page crypto host seam, the Firefox manifest, `TARGET` build wiring, `_locales` /
  `default_locale` i18n parity.
- **P2P sync via relay-forward** — the one mandatory-for-v1 piece. Negotiated per pair (a `hello`
  `caps.rtc` flag picks WebRTC vs relay), runs headless in the FF background; Chrome↔Chrome stays
  direct WebRTC. Hardening: FF keep-alive alarm (event-page suspension), handshake timeout,
  stale-peer reaper, epoch-rotating sync room, payload padding. Initial + ongoing sync device-tested
  Chrome↔Firefox. See "Firefox P2P transport".
- UI/behaviour — popup closes after opening setup, the FSA "vault file location" step is hidden (no
  picker), dark-mode toolbar icon via manifest `theme_icons`, storage durability (`unlimitedStorage`
  + `navigator.storage.persist()`).

- **On-page UI localization.** The corner-prompt cards (save / update / passkey), the autofill
  dropdown, and the WAR iframe now translate via the native `_locales` catalog +
  `browser.i18n.getMessage` (de / es / fr / it / pt-BR), closing the gap where only the React
  popup/options were localized (those use Lingui). Content scripts must stay one flat file, so
  `getMessage` is the fit: synchronous, no chunk, keyed off the same browser locale `LocaleGate`
  resolves for the app. Shared with Chromium (same source + `_locales`), so both targets localize;
  English text is byte-identical to before. Adding a string: put it in `_locales/en/messages.json`,
  then run `scripts/i18n/chrome-manifest.mjs` (incremental, merges missing keys per locale).

- **Passkey provider (MAIN-world content-script transport)** — a `world: "MAIN"` in-page override of
  `navigator.credentials.create/get` + an isolated-world relay + background `WEBAUTHN_CREATE/GET`
  handlers, all driving the same `handleCreate`/`handleGet` ceremony handlers Chrome's proxy uses.
  The origin comes from the browser-set message `sender` (authoritative, per-frame), so it's cleaner
  than Chrome's active-tab guess. Codec round-trip + existing ceremony unit tests pass; both targets
  build clean; **device-verified on webauthn.io** (register + authenticate, locked and unlocked). The
  corner card was polished alongside: Bramble glyph, per-account rows that authenticate on click, a
  locked-state explainer line, and the unlock window auto-closes after a locked unlock so it doesn't
  cover the picker.

**Gated off on Firefox (no broken UI; deferred fast-follow):** security-key unlock — see its section
below for what it needs.

**Remaining before a Firefox ship:**

- **Export / import backup (the one feature still to build; Phase 5b).** `storage.local` is the only
  copy on Firefox and is wiped on uninstall or profile reset, so a user-driven backup path is
  non-optional. Build a user-facing **export** (serialize the vault and save the `.db` blob via the
  `downloads` API) and **import** (a file input that re-loads it), reusing the serialize/parse that
  already wraps `readVaultBlob`/`writeVaultBlob` in `storage.ts`. Chrome's `.db` save flow is
  FSA-only (`showSaveFilePicker`), so this is net-new UI, shared by both targets once built. P2P sync
  gives partial redundancy (the vault also lives on peers), but is not a substitute for a local
  backup file. See "Storage durability".
- **On-device checks not yet crossed live.** Idle sync catch-up (~30-60s), the epoch rollover (fires
  only at an hour boundary; logic is unit-tested), and autofill on a real page. Passkey provider and
  initial + ongoing sync are already device-verified.
- **Clipboard auto-clear from the FF background** (flagged, unverified). `navigator.clipboard.
  writeText("")` may be rejected from an unfocused background page, and the usual `<textarea>` +
  `execCommand` fallback also needs a focused document the background lacks. May need a rethink
  (clear from the popup, or on next popup open). See "Risks / open items".
- AMO listed submission: the release pipeline + source-code submission + reproducible-build docs
  are wired (`docs/amo-source-build.md`); what remains is dashboard-only and one-time (screenshots,
  category, `data_collection_permissions`, privacy-policy URL) plus AMO's manual review.

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
| `webAuthenticationProxy.*` | webauthn-proxy-init.ts | **Absent on Firefox** (passkey provider); Firefox uses a MAIN-world content-script transport instead, see "Passkey provider" |
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

## Firefox P2P transport: relay-forward fallback (decided)

**Finding (device-verified).** `RTCPeerConnection` is `undefined` in *every* Firefox context the
extension can reach — the background/event page, the popup, the content-script isolated world, the
page's MAIN world, and a `web_accessible_resource` iframe. In the tested profile that's because
WebRTC is disabled browser-wide (`media.peerconnection.enabled = false` — the default in LibreWolf /
Mullvad Browser / arkenfox and most privacy-hardened Firefoxes), which an extension cannot override.
And even where WebRTC is *enabled*, the extension **background** has no `RTCPeerConnection` (Firefox
bug 1278100); the only contexts that would (a real tab / a frame inside a web tab) can't host
headless background sync and die on navigation. So there is no viable WebRTC path on Firefox — the
earlier "content-script iframe" idea (former option a) is a dead end too.

**Decision: relay-forward as a negotiated WebRTC fallback.** Carry the same Noise-encrypted frames
that ride the WebRTC data channel over the existing signaling relay (`WebSocket`) instead. This is
clean because the transport is already abstracted behind a two-method `Channel`
(`sync/transport/channel.ts`: `send(string)` / `recv(): Promise<string>`) — the Noise handshake,
enrollment, roster+entries merge, and CRDT all talk to `Channel`, never to `RTCPeerConnection`. A
relay-backed `Channel` is a drop-in second implementation; everything above it is unchanged.

Crucially, relay-forward needs only `WebSocket` + WASM, both of which **work in the Firefox
background event page** (verified: signaling already reaches "relay connected" there, and crypto is
device-verified there). So the Firefox sync path runs **headless in the background** — no offscreen
document, no content-script iframe, no page context. The whole "which Firefox context has WebRTC"
problem disappears.

**Architecture (per-pair, negotiated):**

- **Chrome ↔ Chrome:** WebRTC direct (offscreen document), unchanged. The vault never touches the
  relay — the relay only carries signaling.
- **Any pair where a peer can't do WebRTC** (Firefox, WebRTC disabled, or NAT/firewall blocks the
  data channel): **relay-forward** — the relay carries Noise ciphertext.
- **Negotiation:** peers advertise a capability flag in the `hello` discovery event (`caps.rtc`).
  Both advertise `rtc:true` → WebRTC data channel; otherwise → relay channel. So a Chrome device and
  a Firefox device sync via relay-forward automatically.

This is cross-browser, not just a Firefox patch: it also rescues Chrome↔Chrome pairs that can't
establish a WebRTC data channel (symmetric NAT, no TURN, corporate firewall).

**Work (contained, in `@core/sync/transport`):**

1. `RelayChannel` implementing `Channel` over relay events, with **transparent chunking** — the
   relay caps messages at 64 KiB (`MAX_MSG_BYTES`), so `send` splits large frames into
   `{msgId, idx, total, chunk}` events and the receiver reassembles before delivering. The only
   genuinely new logic; unit-test it.
2. `caps.rtc` in the `hello` payload + per-pair transport selection in `mesh` / `peer-session`.
3. Wire `RelayChannel` in at the point that currently builds the WebRTC peer; remove the throwaway
   `sync-frame` iframe + `diag.rtc*` probes (they explored the now-dead WebRTC-context path).

**Caveats:**

- **Reliability / ordering.** A WebRTC data channel is reliable + ordered; the relay is best-effort
  live fan-out of *ephemeral* events (stores nothing — see "Filesystem sync"), so both peers must be
  online and a dropped frame isn't retransmitted. Order holds on the happy path (`WebSocket` is
  ordered, both connected). **Implemented:** a **handshake timeout** (roster-sync) so a frame dropped
  mid-handshake abandons cleanly instead of hanging, and a **stale-peer reaper** (the connectionless
  relay transport has no close signal, so a departed peer is dropped after several silent gossip
  ticks). **Residual:** no per-frame retransmit on the post-handshake data path — a lost gossip frame
  is recovered by the next 4s re-broadcast rather than resent.
- **Both-online only** — same as the current WebRTC model. Async catch-up would need a
  store-and-forward mailbox (ciphertext at rest on the relay), which we deliberately avoid.

### Privacy / metadata (relay-forward)

Relay-forward moves the vault ciphertext through the relay on every sync (vs direct WebRTC, where
it's peer-to-peer and often never touches the relay). Content stays sealed — the relay only ever
sees Noise ciphertext and cannot decrypt (session keys come from the device roster, never the relay)
— but it's a **metadata step-down**, so it's worth hardening.

What the relay can observe, and the mitigations:

- **Already good (current signaling):** the event author is a **fresh ephemeral key per session**
  (`nostr-signer.ts`), content is group-key-encrypted, and events use **ephemeral kinds
  (20000-29999)** so the relay stores nothing (`nostr-relay/cf-worker`). No cross-session author
  linkage, nothing at rest.
- **Room-id linkage → rotate per epoch (implemented).** The sync room is derived per hourly epoch
  (`deriveRoomId(groupKey, label, epoch)`); the mesh publishes to the current epoch and subscribes to
  current+previous (one multi-value tag filter, with a minute-granularity rollover), so the relay
  can't link a group's sync activity across epochs. Gated to the sync room via the `epochRooms` flag;
  enrollment stays on a stable, clock-skew-independent room.
- **Message size → vault size → pad payloads (implemented).** Relay-forward frames are padded into
  NIP-44-style size buckets (`relay-channel.ts` `padMessage`/`unpadMessage`) before chunking and
  stripped after reassembly, so chunk counts / sizes reveal only a coarse range, not the entry count.
- **IP address — not fixable in Nostr.** The relay terminates the socket, so it sees the client IP
  regardless of code. Two answers, both outside the protocol: **self-host** the relay (operator =
  you), or point at a **Tor `.onion` relay**. Tor only helps the `WebSocket`/relay-forward path (it's
  TCP-only; WebRTC's UDP can't traverse it) — which lines up, since relay-forward is exactly the
  fallback and the Tor-running crowd is the WebRTC-off crowd. Caveat: a browser extension can't
  provide Tor; it needs Tor Browser, an OS SOCKS proxy, or (Firefox-only) the `proxy` API routing
  just the relay socket through a local `tor`. And a Cloudflare Worker can't be an onion service, so
  onion ⇒ self-host the node relay (`nostr-relay/node`).
- **NIP-42 (relay AUTH) — access control, not privacy.** It binds identity to the relay (the wrong
  tool for anonymity) but is the right tool to lock a self-hosted relay to your own devices.

The honest floor: a relay you connect to *directly* always learns IP + timing + a routing token. The
mitigations above shrink correlation; they don't zero it. **Self-hosting stays the strongest posture,
and the relay URL is already user-configurable** (Settings → Advanced), so "use your own / a `.onion`
relay" is a real lever, not a promise.

## Passkey provider (Chrome proxy; Firefox MAIN-world transport, device-verified)

Bramble is a software WebAuthn authenticator: it creates and stores passkeys in the vault and signs
assertions with its own P-256 keys (see `docs/passkey-provider.md`). On Chrome this is delivered via
**`chrome.webAuthenticationProxy`**: the browser routes a page's `navigator.credentials.create/get`
calls to the extension, which runs the ceremony. Firefox has **no equivalent** to that proxy API, so
the delivery is a **MAIN-world content-script transport** instead. Both deliveries drive the same
transport-free ceremony handlers; only the wiring differs. **Built, unit-tested, and device-verified
on Firefox against webauthn.io.**

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

This is how third-party managers (Bitwarden, Proton Pass, ...) provide passkeys in Firefox today.
Because Bramble signs with its own vault keys, it needs no platform authenticator; only the transport
differs from Chrome.

**Architecture (built).** The pieces split cleanly by trust and world:

1. **MAIN-world override** (`content/webauthn-inpage.ts`, `world: "MAIN"`, `run_at: document_start`,
   Firefox-only). Patches `navigator.credentials.create/get` in the page's own realm before page
   scripts run. Serializes the live options to the base64url JSON the handlers already read
   (`content/webauthn-inpage-codec.ts`), forwards via `window.postMessage`, and rebuilds a synthetic
   `PublicKeyCredential` from the reply.
2. **Isolated-world relay** (`content/webauthn-bridge.ts`, `document_start`). The MAIN world can't
   reach extension APIs, so this bridges `window.postMessage` ↔ `runtime.sendMessage`. A separate
   `document_start` script (not the `document_idle` autofill content script) so it's listening before
   a page that calls WebAuthn early.
3. **Background handlers** (`background/webauthn-content-transport.ts`, registered only when
   `api.webAuthenticationProxy` is undefined) call the **same** `handleCreate`/`handleGet`
   (`background/webauthn-proxy.ts`) Chrome's proxy uses.
4. **Shared wiring** (`background/webauthn-provider.ts`) holds the corner-card ceremony, vault IO,
   crypto deps, and the enabled flag; `webauthn-proxy-init.ts` is now Chrome-proxy-only.

**Resolved gotchas** (the doc's earlier open items):

- **`ArrayBuffer`s across the world boundary.** Neutralized by transporting base64url **strings**
  over `postMessage`, never buffers; the codec materializes fresh `ArrayBuffer`s in the page realm,
  so there are no typed-array copies. The synthetic credential also `setPrototypeOf`s to the real
  `PublicKeyCredential` / response prototypes so RP-library `instanceof` checks pass.
- **Origin (the phishing-resistance line).** Comes from the browser-set message `sender`
  (`sender.origin ?? sender.url`), per-frame and unforgeable by the page. This is **cleaner than
  Chrome**, which has to guess the requester from the active tab. The MAIN-world script is not a
  trust boundary; a page can at most craft a request for its own origin.
- **Timing.** Both content scripts run at `document_start`; a wedged bridge falls back to the native
  authenticator so a page's WebAuthn never hangs or breaks.
- **Disabled / passthrough.** The override is always injected, so when the provider is off (or the
  origin is one we won't serve, e.g. a cross-origin child frame) the background replies `passthrough`
  and the shim calls the captured native method. Firefox therefore has **no all-or-nothing
  interception** and **no pause-around-own-unlock** dance that the Chrome proxy needs.

**Scoped out of v1:** `mediation: "conditional"` (passkey autofill in the field dropdown) passes
through to native.

**Verified on device:** a webauthn.io pass on real Firefox (register + authenticate, locked and
unlocked). **Still unverified:** a cross-device check that a passkey created on Firefox signs in on
Chrome/iOS via sync and vice-versa (the core bytes are identical, so it should just work).

## Security-key / platform-authenticator unlock (Firefox: disabled)

Distinct from the passkey *provider* above: this is Bramble's **own vault unlock** via a WebAuthn
credential (the PRF / hmac-secret extension derives a key that wraps the VEK). On Firefox it is
**disabled** — `shell.supportsSecurityKeys` is false on `moz-extension://`, so the Settings section
hides — because registering throws **"The operation is insecure"**: the default rpID is the
`moz-extension://` origin, which Firefox rejects as a WebAuthn RP.

What it would take, and why it stays deferred (verified 2026-07):

- **The rpID error is fixable (Firefox 150+).** An extension can specify an explicit `rp.id` for any
  domain in its `host_permissions` (`<all_urls>` covers any), so `rp.id: "bramble.app"` on Firefox is
  accepted. Keep Chrome's *implicit* rpID (the extension origin) unchanged — changing it invalidates
  every already-registered Chrome user's key.
- **The real blocker is PRF over external keys.** Firefox supports the PRF extension for **platform**
  authenticators (Touch ID / Windows Hello, ~FF 135/139) but **not for external hardware keys
  (YubiKeys)** — that's still Chrome-only. So even with the rpID fixed, only platform-authenticator
  unlock would work on Firefox; YubiKey unlock can't until Firefox ships external-key PRF.
- **No need to unify keys across browsers.** The VEK is already unified across devices via P2P sync,
  and the multi-slot design lets each device/browser register its own unlock (YubiKey slot on Chrome,
  Touch-ID slot on Firefox, master password everywhere) — all wrapping the same synced VEK. A shared
  rpID would need a breaking re-registration migration for existing Chrome users *and* still wouldn't
  give YubiKey roaming (Firefox PRF gap), so it isn't worth it.
- **Dead ends:** WebHID / WebUSB (raw CTAP2 would bypass the rpID) — Firefox implements neither.

Plan if revisited: enable on FF 150+ as **platform-authenticator** PRF unlock (explicit `bramble.app`
rpID, version-gated, Chrome untouched), leaving YubiKey unlock Chrome-only pending Firefox.

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
| `content_scripts` | one entry (`content-script.js`) | plus two Firefox-only entries at `document_start` for the passkey transport: `webauthn-inpage.js` (`world: "MAIN"`) and `webauthn-bridge.js` (isolated). See "Passkey provider" |
| `content_security_policy`, `web_accessible_resources`, `commands`, `host_permissions`, `action`, `icons`, `options_page` | same | same |

Verified Firefox facts behind these choices:

- **Background**: `"background": { "scripts": [...], "type": "module" }` is supported; Firefox
  starts the event page even when `service_worker` is present (FF 121+). The event page provides
  the DOM document used for WASM and clipboard.
- **Host permissions**: from FF 127, entries in `host_permissions` and `content_scripts` are shown
  in the install prompt and granted on install, so `<all_urls>` autofill works out of the box.
  Users can still revoke them in `about:addons`. `strict_min_version: "128.0"` is the safe floor.
- **`web_accessible_resources` `use_dynamic_url: true`**: Firefox may ignore it (the manifest omits
  it there). The autofill-ui iframe still loads via a static `moz-extension` URL; only per-session
  URL rotation is lost. Confirm with `web-ext lint`. Note the Chromium subtlety it caused: with the
  flag on, `runtime.getURL()` returns a GUID origin the loaded document does not share, so the
  picker's bridge pins the origin from the iframe's READY handshake instead (see docs/autofill.md).

## Build tooling

- Parametrize `vite.config.ts` by `process.env.TARGET` (`chrome` default | `firefox`): the
  `copy-manifest` plugin copies the matching manifest, and `outDir` switches to `dist` vs
  `dist-firefox` so the two builds do not clobber each other.
- Add scripts (`build:firefox`, `bundle:firefox`) and the `web-ext` dev dependency for
  `web-ext lint` / `run` / `build` / `sign`. Add `dist-firefox/` and `web-ext-artifacts/` to
  `.gitignore`.

## AMO submission notes (listed on addons.mozilla.org)

Firefox ships **listed** (public store), not self-distributed. `pnpm run release firefox <ver>`
submits the listed version and attaches the source archive; AMO reviews, signs, and hosts the
`.xpi`. See `docs/release-signing.md` and `docs/amo-source-build.md`.

- `gecko.id` (`firefox@bramble.app`) and `strict_min_version` are set in the manifest.
- **Source submission is wired:** `sign-firefox.ts` attaches a `git archive` of the source for
  review; `docs/amo-source-build.md` is the reviewer build recipe (`rust-toolchain.toml` pins Rust).
- Listing copy is localized under `packages/platform-extension/store/firefox/` and pushed via
  `pnpm run metadata:firefox`; the name + short description come from the package `_locales`.
- Still dashboard-only (one-time): screenshots, a category, a privacy-policy URL (required for a
  password manager; reuse the Chrome listing's HIBP disclosure), and `data_collection_permissions`.
- A first listed version gets **manual review** (WASM + a password manager get a careful look).

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
  storage is disk-bounded. Both manifests now declare `unlimitedStorage`.
- **Uninstall clears it.** Unlike an FSA file (which survives), `storage.local` is wiped on
  extension uninstall, and a profile reset loses it too. So on Firefox the vault can vanish with
  no file to fall back on. This makes **export/import backup (Option 2) non-optional**, and is a
  second reason to want **P2P sync (Option 5)**: with sync the vault also lives on peer devices,
  giving redundancy against this failure mode. The backup itself is the one Firefox feature still
  unbuilt (Phase 5b; see "Status").
- **Eviction under disk pressure.** Firefox's Quota Manager can evict an origin's storage when
  the global limit is hit; only **persistent** buckets are exempt. `unlimitedStorage` lifts the
  quota cap but does not clearly mark the bucket persistent. Bramble now calls
  `navigator.storage.persist()` on init/unlock to request a persistent bucket; confirming Firefox
  honors it is part of the remaining on-device pass. Silent eviction of the only copy is the failure
  most worth ruling out for a password manager.

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
