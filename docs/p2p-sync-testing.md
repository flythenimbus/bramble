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
