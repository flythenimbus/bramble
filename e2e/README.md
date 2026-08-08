# End-to-end tests (Playwright)

Three suites, each with its own config, because they need different things attached. Only the
first is CI-safe.

| Suite | Command | Needs | What it reaches |
| --- | --- | --- | --- |
| `extension/` | `pnpm test:e2e` | nothing | popup + background/offscreen + storage glue |
| `sync/` | `pnpm test:e2e:sync` | nothing (servers auto-start) | two peers pairing over real WebRTC |
| `android/` | `pnpm test:e2e:android` | a device attached | the **shipped** app: uniffi Rust core, native storage |

## Prerequisites (once)

```sh
pnpm exec playwright install chromium   # the full build, not just the headless shell
```

Every suite launches a real extension profile, so build it after source changes:

```sh
pnpm --filter @vault/platform-extension build:chromium
```

## Document-bound transport contract

`pnpm run test:transport-race` runs a small test-only extension against real Chromium and Firefox. It requires Playwright Chromium plus `FIREFOX_BINARY` pointing at official Mozilla Firefox current or Firefox 128+. CI exercises both current Firefox and the 128 compatibility floor. Firefox must run headed (`FIREFOX_HEADLESS=0`) under Xvfb so the BFCache case is meaningful; CI does this with `xvfb-run -a`. Locally, install Chromium with `pnpm exec playwright install chromium` and run `TRANSPORT_BROWSERS=chromium pnpm run test:transport-race` when Firefox is unavailable; use the default `all` in CI or when `FIREFOX_BINARY` is set. The fixture holds an async `sendResponse` while a hostile parent replaces the same iframe with same-origin and cross-origin B documents. Its separate BFCache case uses a top-level A → B → Back navigation because subframe history entries are not independently BFCache-restorable; it proves frame ID 0, a stable restored-A nonce, and inert replies. A replacement document must never observe the sentinel; a failure means this request/reply design must not ship or fall back to frame targeting. The only approved fallback is explicit exact-`documentId` targeting with the Firefox support floor raised to 153.

---

## `extension/` — the default suite

```sh
pnpm test:e2e:build      # build the extension, then run
pnpm test:e2e            # if dist-chromium is already current
HEADED=1 pnpm test:e2e   # watch it in a real window
```

- `fixtures.ts` launches a persistent Chromium with the extension loaded (`channel: "chromium"`,
  the new headless that runs MV3 service workers). `launchExtensionContext()` gives one throwaway
  profile = one independent "device".
- `helpers.ts` has the UI helpers (create/lock/unlock, the vault picker, the sync panel) and
  background-storage inspection. The other two suites import from here rather than duplicating.
- Serial (one worker): the persistent profile and fixed ports are shared resources.

---

## `sync/` — two peers over a real relay

Pairs the extension with the mobile app — the same Vite SPA Capacitor wraps, loaded in a browser
context. Both run the shared `@core` transport, so the handshake, roster exchange and merge are the
production ones.

```sh
pnpm test:e2e:sync
```

The config starts the relay (`nostr-relay/node/relay.mjs`, port 7400) and the mobile dev server
(port 5199) itself. Nothing external is contacted.

**Two traps, both of which fail silently rather than loudly:**

- **Set the relay AFTER creating the vault.** Creating the *first* vault calls `resetSyncState()`,
  which removes `sync.relay` along with the rest of the sync identity. Seeding it beforehand looks
  like it works and then quietly falls back to the **hosted** relay.
- **Only the inviter needs it configured.** The joiner takes the relay from the pairing code
  (`PairingCodeSchema.relay`).

Because that failure is silent, the spec decodes the pairing code and asserts it names the local
relay. To confirm the suite really depends on it:

```sh
SYNC_RELAY_URL=ws://localhost:7999 pnpm test:e2e:sync   # must FAIL
```

The entry assertion pins the **end-to-end outcome** (the joiner can read the inviter's data), not
the enrolment bundle: forcing the bundle to ship zero entries still passes, because the ongoing
merge delivers it. Measured, not assumed.

**Not covered:** mobile's native layer. In a desktop browser Capacitor falls back to the WASM
crypto core and the web Filesystem/Preferences — that's what `android/` is for.

---

## `android/` — the shipped app on a real device

Attaches to the app's WebView over its devtools socket, so the code under test is the one that
ships: the uniffi Rust core, Capacitor's native Filesystem/Preferences, real `.bak` rotation.

```sh
adb devices                    # exactly one, state "device"
pnpm test:e2e:android
```

Requires a **debuggable** build installed — Capacitor only opens the devtools socket for those. A
release build fails with `did not start (is it installed and debuggable?)`.

Overrides: `ADB`, `ANDROID_HOME`, `ANDROID_CDP_PORT` (default 9222), `ANDROID_APP_ID`,
`ANDROID_SERIAL` (the fixture refuses to guess between several devices).

Running part of it:

```sh
pnpm test:e2e:android -- --grep "pairs with"          # only the sync test
pnpm test:e2e:android -- e2e/android/smoke.spec.ts    # only the read-only ones
```

### What CDP can and can't see

It attaches to the WebView, so it sees the app's DOM and nothing else. Native UI — the Android
autofill sheet, biometric prompts, the system file picker — is invisible. Those need Espresso
(already declared in `android/app/build.gradle`) or a tool like Maestro.

### The extension ↔ device pairing test

`pair-with-extension.spec.ts` pairs the extension with the app on the device, over a relay on this
machine. It's the only test where the joiner rebuilds its vault natively.

Two environmental dependencies, both of which surface as ordinary test failures:

- `adb reverse tcp:7400 tcp:7400` (set up by the fixture) routes the **device's** localhost to this
  machine's relay. That also makes the pairing code's `ws://localhost:7400` valid verbatim on both
  peers, so the code the inviter produced is the one the joiner consumes.
- The WebRTC data channel needs a real IP route between phone and host. Same LAN is enough; a guest
  network with client isolation is not.

### The device holds real data

`smoke.spec.ts` is deliberately read-only — it navigates but never creates, edits or deletes a
vault, so it's safe against a device with real vaults.

`pair-with-extension.spec.ts` **mutates the device**: the joiner ends up with a real vault, which
the test then deletes. Verified self-cleaning — the device had 3 vaults before and after two
consecutive runs. A mid-test failure leaves a stray `e2e-*` vault for you to clear.

Anything else added here must create and delete **its own** vaults. A test that deletes "the first
vault" deletes somebody's passwords. There is no sandbox and no undo.
