# Two-peer sync e2e (extension + mobile app, real relay)

Pairs two **real peers** over WebRTC through a local signaling relay: the browser extension in its
own profile, and the mobile app — the same Vite SPA that Capacitor wraps — in a browser context.
Both run the shared `@core` sync transport, so the enrolment handshake, roster exchange and merge
are the production ones.

This is the gap `e2e/README.md` flagged: *"A full two-device sync test (two contexts pairing over
WebRTC + a local relay) is a further step."*

## Running

```sh
pnpm --filter @vault/platform-extension run build:chromium   # once, if the extension changed
pnpm run test:e2e:sync
```

The config starts both servers itself: the relay (`nostr-relay/node/relay.mjs`, port 7400) and the
mobile dev server (port 5199). Nothing external is contacted.

## Two things that will bite you

**Set the relay AFTER creating the vault.** Creating the *first* vault calls `resetSyncState()`,
which removes `sync.relay` along with the rest of the sync identity. Seeding it beforehand looks
like it works and then silently falls back to the hosted relay.

**Only the inviter needs the relay configured.** The pairing code carries it
(`PairingCodeSchema.relay`) and the joiner adopts it.

The spec asserts the decoded code names the local relay, precisely so a regression here fails
loudly instead of quietly exercising production infrastructure. To confirm the test really depends
on the relay rather than reaching the hosted one:

```sh
SYNC_RELAY_URL=ws://localhost:7999 pnpm run test:e2e:sync   # must FAIL
```

## What the entry assertion does and doesn't pin

The spec writes a login on the inviter and asserts the joiner can read it. That covers the
end-to-end outcome — the joiner decrypts the inviter's data with the key it was handed, which is
exactly what issue #27 destroys.

It does NOT pin the enrolment bundle specifically. Forcing `sendBundle` to ship zero entries still
passes, because the ongoing merge delivers the entry anyway. Measured, not assumed. Shipping a
*wrong* VEK does fail, but earlier: the join never completes, so the pairing assertions catch it.

## What this does not cover

Mobile's **native layer**. In a desktop browser Capacitor falls back to the WASM crypto core and
the web implementations of Filesystem/Preferences, not uniffi and the Android ones. For that, see
`e2e-android/` (CDP over adb).
