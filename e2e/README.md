# End-to-end tests (Playwright)

Four suites, each with its own config, because they need different things attached. Only the first
two are CI-safe.

| Suite | Command | Needs | What it reaches |
| --- | --- | --- | --- |
| `extension/` | `pnpm test:e2e` | a built extension | popup + background/offscreen + storage glue |
| `extension/transport-race/` | `pnpm test:transport-race` | `FIREFOX_BINARY` for the Firefox project | the browser's own request/reply primitive |
| `sync/` | `pnpm test:e2e:sync` | nothing (servers auto-start) | two peers pairing over real WebRTC |
| `android/` | `pnpm test:e2e:android` | a device attached | the **shipped** app: uniffi Rust core, native storage |

`perf/page-blocking.mjs` is not a suite: it is a plain script (`node
e2e/perf/page-blocking.mjs [url]`) that loads a real site twice, once with the built Chromium
extension and once without, and prints the difference in main-thread blocking time. It needs the
network, so it is manual. It is what quantified issue #59 and what should be re-run after any
change to the content script's detection or its mutation handling.

The transport-race gate lives under `extension/` but is `testIgnore`d from `playwright.config.ts`:
it loads its own tiny fixture rather than the built extension, so it needs no build and runs in
seconds.

## Prerequisites (once)

```sh
pnpm exec playwright install chromium   # the full build, not just the headless shell
```

Every suite launches a real extension profile, so build it after source changes:

```sh
pnpm --filter @vault/platform-extension build:chromium
```

## `extension/transport-race/` — the document-bound transport gate

The security gate for GHSA-xm22-vwcg-9jqg. Two Playwright projects run the same three races:

```sh
pnpm test:transport-race --project=chromium     # no Firefox needed
FIREFOX_BINARY=/path/to/firefox FIREFOX_HEADLESS=0 pnpm test:transport-race --project=firefox
pnpm test:transport-race                        # both; needs FIREFOX_BINARY
```

- `transport-race/harness.ts` owns the fixture server and **every** assertion, so both browsers are
  held to an identical contract. Each spec supplies only a way to open a URL.
- Chromium is driven by Playwright directly. **Firefox is driven by `web-ext`**, because Playwright
  cannot install a Firefox add-on (extensions are Chromium-only, persistent-context-only). For that
  project Playwright is just the runner.
- Firefox must run headed (`FIREFOX_HEADLESS=0`) under Xvfb for the BFCache case to be meaningful;
  CI does this with `xvfb-run -a`, across both current Firefox and the 128 compatibility floor.
- A missing `FIREFOX_BINARY` **fails** rather than skipping. A silently skipped security gate is a
  hole.
- `retries: 0` on purpose: a race that only passes on retry is a failure. The harness makes one
  narrow exception, and it is not that: a **declined bfcache** (`pagehide persisted=false`) means
  the browser refused to STAGE the scenario, so no assertion has run and nothing was proven either
  way. That is retried up to five times, in `runCase`; every contract violation still fails on the
  first attempt. The Firefox 128 floor declined roughly one attempt in four (7 of 25 CI runs, and
  once two minutes apart from a pass on an adjacent commit), which five attempts takes to about one
  run in 600. Pinning `browser.sessionhistory.max_total_viewers=3` fixed the *always* case; what is
  left is most likely inherent, since A navigates while deliberately holding an extension message
  channel open and that channel is the thing under test.
- When it does give up, it runs a **control**: `probe-a.js`, the same navigate-away-and-back shape
  with no extension messaging at all. Whether the browser caches THAT decides which answer the
  failure gives - "this machine declines bfcache outright" or "this case specifically is
  ineligible" - so the next person reads a verdict rather than a symptom. It runs only on the
  failure path, so a green run pays nothing for it.
- Those two verdicts get different outcomes, and the difference is the whole point. **Control also
  refused** = the experiment could not be run here, so the case is SKIPPED, loudly (the reason is
  printed to the log, not just filed as a report annotation) and the job stays green: the same
  contract is still enforced on every environment that can stage it. **Control cached** = this
  browser can bfcache but refuses to do it for our page, which is a fact about the case rather than
  the machine, and that FAILS. Do not soften the second one; it is the only remaining way this gate
  can tell you something new.

The fixture holds an async `sendResponse` while a hostile parent replaces the same iframe with
same-origin and cross-origin B documents. The BFCache case uses a top-level A → B → Back navigation
because subframe history entries are not independently BFCache-restorable; it proves frame ID 0, a
stable restored-A nonce, and inert replies. Before asserting nobody saw the sentinel, the harness
first asserts the frame **was** reused by two documents with **different** nonces: that positive
control is what makes a green run mean anything, since it proves a frame-addressed reply would have
landed in B.

A replacement document must never observe the sentinel. A failure means this request/reply design
must not ship, and must not fall back to frame targeting. The only approved fallback is explicit
exact-`documentId` targeting with the Firefox support floor raised to 153.

The fixture is deliberately a tiny test-only extension, never Bramble: it proves the *browser's*
primitive. That Bramble uses that primitive is proven by the extension unit tests.

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
- `autofill-rescan.spec.ts` is the cost suite for issue #59, and two of its cases assert on cost
  rather than behaviour: how many `AUTOFILL_QUERY` messages reach the background while a page
  churns (counted by an extra `chrome.runtime.onMessage` listener in the service worker, which
  answers nothing), and how much main-thread blocking a sentence typed into a textarea causes.
  **The churn in those fixtures is load-bearing.** A static page keeps the field model cached, so
  the regression does not reproduce and the test passes against the old code: verified by
  rebuilding at the parent commit, where the two cases report 8 stray queries and 4,467ms of
  blocking.

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

**Rebuild the extension first.** The mobile peer is served by vite and picks up `@core` changes
live; the extension peer loads `dist-chromium`, so a core change that is not rebuilt makes the two
peers run *different code*, and the spec fails somewhere unrelated to what you changed.
`roster-signature-backfill.spec.ts` covers the phase-1 roster migration: it pairs the peers, strips
the signatures out of both stored rosters to recreate the pre-2026-07-09 world, reopens the popup,
and asserts the extension re-signs itself through the real host and that the peer converges on that
signature. The unit tests mock the shell, so this is the only place a silently no-op backfill (a
mis-wired host declines, and the code returns rather than throwing) is caught.

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

## The sync suite runs in CI now

`test:e2e:sync` pairs two peers over a real relay and is the only automated coverage of an actual
join. It used to be excluded from CI as unsuitable for a shared runner. That was wrong on both
counts: `playwright.sync.config.ts` starts the relay and the mobile dev server itself, and the
whole suite finishes in under a minute.

The cost of leaving it out: it sat red from 2026-07-09 to 2026-09-01 on a one-word selector bug.
`getByRole("button", { name: /Continue/i })` began matching two buttons the day a master-password
gate was added next to DesktopLinkSection's "Allow and continue", and Playwright's strict mode
refused to click either. Nothing was wrong with sync itself, and nobody could see it, because no
job ran it.

If you add a suite that CI does not run, it is not covered - it is only untested more slowly.
