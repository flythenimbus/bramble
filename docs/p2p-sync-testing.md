# Testing P2P sync

How to exercise device-to-device sync locally. The design is in
[p2p-sync.md](p2p-sync.md). Two browser profiles (or two Chromium browsers) on one
machine act as two devices: each has its own storage, device keypair, and offscreen
document, and WebRTC connects them over loopback.

## The rig

1. **Run the relay** (separate terminal, leave it running):

   ```sh
   node nostr-relay/node/relay.mjs  # ws://localhost:7400
   ```

   See [../nostr-relay/README.md](../nostr-relay/README.md). Any Nostr relay works;
   this local one keeps testing self-contained.

2. **Build and load the extension as two devices:**

   ```sh
   pnpm run build                  # outputs dist-chromium/
   ```

   Use two separate Chromium profiles, or two Chromium browsers (e.g. Chrome +
   Vivaldi). In each: `chrome://extensions` -> Developer mode -> **Load unpacked**
   -> select `dist-chromium/`. Each install is a device with its own vault.

   The dev UI is **Settings -> Device sync (dev)**.

## Enroll a second device

1. **A** (the seed vault, with some entries): **Add a device** -> a
   `bramble-pair-1.…` pairing code appears and A starts listening. **Copy pairing
   code** (use the button; the field scrolls).
2. **B** (a throwaway vault — joining replaces its contents): paste the code, choose
   how to unlock this device — **Master password** (type one) or **Security key**
   (tap your key when you press Join; desktop only, shown when WebAuthn is available)
   — then **Join**.
3. The log shows `authenticated ✅ -> transferring vault…`, then B's vault becomes
   A's. B unlocks with the method it just set.

The pairing code carries `{groupKey, inviterPub, psk, relay, exp}` and no vault secrets
directly — but its `psk` is what authenticates the joiner, so while the invite is live
the code is worth the vault. Treat it as a password when testing (don't paste one into
an issue or a shared log). The invite expires, is single-use, and the transfer is gated
on the SAS both sides show; see docs/p2p-sync.md "Pairing code".
The VEK is sealed Noise-only over the authenticated channel and the joiner
rebuilds its vault inside the offscreen, so the raw VEK never reaches the popup. The
joiner mints its own unlock slot there: for the security-key choice the PRF ceremony
runs in the popup (where WebAuthn works) and only the hmac-secret crosses to the
offscreen, exactly like a password would, so the VEK still never reaches the popup.

## Verify ongoing sync (the headless path)

Once both are enrolled, sync runs **automatically in the background while unlocked**
— no button, no window:

1. Both vaults unlocked (open each popup once to unlock; then you can close them).
2. Edit / add / delete an entry in **A** — its popup can be **closed**.
3. Within a few seconds, **B** reflects the change. Deletes propagate as tombstones
   and don't resurrect from a stale peer.

Reconnecting devices authenticate by their roster keys (Noise KK) with **no pairing
code** — enrollment is one-time.

## Storage backend and headless writes

The vault lives in `chrome.storage.local` (see [storage.md](storage.md)), which the
background reads and writes with no gesture and no permission, so enrollment, join, and
ongoing merge all persist fully headless — nothing to grant, nothing queued. (The old
file-backed/FSA path, which needed a per-file permission gesture, has been retired; a
pre-existing file vault migrates to local storage on its first unlock.)

## Engine-only check (no relay, no transport)

The merge engine is exercised in isolation by unit tests, no browser needed:
`core/src/sync/{merge,vault-merge,apply-remote,hlc,roster}.test.ts` cover the
last-writer-wins merge, tombstones, and the apply seam against hand-built payloads.
Run them with `pnpm run test`. (The old copy-paste "sneakernet" bridge that did this
in-app was removed once the real WebRTC transport landed.)

## Dev loop

After code changes: `pnpm run build`, then click the reload icon on the extension on
`chrome://extensions` in **both** installs. After any `core-rust` (Rust) change
also run `pnpm run wasm:build` — `pnpm run build` does **not** rebuild the wasm, and a
stale wasm shows up as `x.foo is not a function` in the browser.

## Testing the roster-signature migration (phase 1 -> phase 2)

A device signs its own roster entry at create / join / invite, and since 2026-08-22 also on
unlock, which is the backfill that lets the phase-1 migration finish
([p2p-sync-revocation-hardening.md](p2p-sync-revocation-hardening.md)). Settings -> Sync marks
every unsigned device with an `UNSIGNED` chip.

Unless you kept a vault paired before 2026-07-09, the only way to reach the pre-signing state is
to strip the signatures out of stored rosters by hand. In the extension's background console
(`chrome://extensions` -> service worker, or `about:debugging#/runtime/this-firefox` -> Inspect;
use `browser.` on Firefox):

```js
const all = await chrome.storage.local.get(null);
const k = Object.keys(all).find(k => k.startsWith("sync.group"));
const g = all[k]; g.roster.devices.forEach(d => { delete d.sigKey; delete d.sig; });
await chrome.storage.local.set({ [k]: g });
```

**Watch the PEER, never the device that is signing.** Two things hide the state otherwise, and
both of them are the system working:

- **A device cannot show its own `UNSIGNED` chip.** Opening the popup is what mounts the provider
  and runs the backfill, so the entry is signed before the panel paints, and the panel refreshes
  on that write.
- **A one-sided strip heals itself.** The peer still holds a signed copy and rebroadcasts every
  ~4s; if it has re-signed since (a newer stamp), it overwrites the stripped row immediately.
  Strip **both** sides back to back, with neither popup open in between.

So: strip both, open peer A's popup and **"Open in window"** to pop it out (the popup dismisses on
focus loss, a detached window does not), leave Settings -> Sync visible there, then open peer B's
popup. A's chip for B clears within a few seconds. That is the signature crossing the relay, and
it is the same assertion `e2e/sync/roster-signature-backfill.spec.ts` makes.

Read storage rather than trusting the chips when something looks wrong. Note the `.find()` above
takes the FIRST `sync.group:*` key, which on a multi-vault profile may not be the active vault:

```js
const all = await chrome.storage.local.get(null);
for (const k of Object.keys(all).filter(k => k.startsWith("sync.group"))) {
  console.log(k, all[k].roster.devices.map(d => ({ id: d.id.slice(0, 8), signed: !!d.sigKey })));
}
```

**Firefox is the case worth spending the time on.** Its signing goes through the background EVENT
PAGE rather than an offscreen document, which no automated suite covers (Playwright cannot install
a Firefox add-on), and the event page suspends after ~30s idle - so also run it once with the vault
locked first, to prove the backfill survives a cold wake. A host that refuses to sign says so:

```
[vault] roster signature backfill failed; will retry on next unlock:
```

Silence there with an unsigned entry still in storage is a different bug: the host declined rather
than errored.

## Caveats

- **Brave WebRTC privacy:** Brave Shields / "WebRTC IP handling" can suppress
  loopback ICE candidates. If devices won't connect, relax that setting or use plain
  Chrome / Vivaldi.
- **Loopback is not a real LAN:** same-machine connections mask real mDNS / LAN
  host-candidate and relay-reachability issues. Before trusting sync, do one pass
  across **two machines** on the same Wi-Fi.
- **Propagation is ~4s** (periodic gossip), not instant — an on-change nudge is a
  follow-up.
- **Unit tests** cover the engine + protocol (merge, format, roster, handshake,
  nostr codec, signaling); the rig is for the transport + enrollment, which need a
  real browser.
