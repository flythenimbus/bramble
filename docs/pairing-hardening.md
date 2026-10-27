# Pairing hardening (design note)

Status: **planned, nothing built** (scoped 2026-10-23). Follow-up to GHSA-x4f5-4wq4-c6c8 and
[sec-audit-ghsa-x4f5.md](sec-audit-ghsa-x4f5.md). Assumes the reader knows "Pairing code" in
[p2p-sync.md](p2p-sync.md) and "The pairing" in [desktop-port.md](desktop-port.md).

A recheck of `main` (`ba181915`; no pairing code has changed since `eb0fec64`) found three things.
The advisory's fix is intact on every platform. Two statements in the published advisory are not
backed by the code. And the browser-link pairing, which shipped after the advisory and was never
part of it, has two gaps of its own. This note lists what to change, in order, and what is
deliberately left alone.

Facts are dated **October 2026**; re-verify line numbers before acting on them later. Unqualified
`enroll-host.ts` means `packages/core/src/sync/transport/enroll-host.ts`, and `SyncConnectSection.tsx`
means `packages/core/src/app/screens/Settings/components/SyncConnectSection.tsx`.

## What the recheck confirmed

No action needed. Listed so the next recheck has a baseline.

| Guarantee | Where |
| --- | --- |
| The invite is claimed before anything is sent, and a claim is never released | `enroll-host.ts:319-325` |
| Claimable for 3 minutes on a local timer. Once claimed, the approval gets its own deadline (`f93da34c`), which is safe because nobody else can claim it by then | `enroll-host.ts:177-185`, `:207-215` |
| Every wait a peer can stall is bounded | `enroll-host.ts:38-49` |
| The joiner's introduction is bound to the key it proved before anything is sent | `enroll-host.ts:423` |
| The vault leaves only after the user approves the SAS. No fallback to the old send-first order | `enroll-host.ts:348-358`, `:391-413` |
| Extension, mobile and desktop all go through the shared `startEnroll`, and treat expiry or a dismissed dialog as a rejection | `clients/extension/src/offscreen-core.ts:831`, `clients/mobile/src/sync/sync-manager.ts:248`, `clients/desktop/src/sync/transport.ts` (`onInviteExpired`) |
| A web page cannot answer the approval: the background router and the offscreen both reject non-extension senders | `clients/extension/src/background/router.ts:43`, `clients/extension/src/offscreen.ts:60-74` |
| Admission signing runs only after approval | `clients/desktop/src/sync/transport.ts` (`onEnrolled`) |
| The advisory's version ranges match the tags: `e32330c8` is in 1.11.0-chromium, 1.8.0-firefox and 0.9.8-android, and in none of the releases before them | `git merge-base --is-ancestor` |

## Update order

| # | Item | Scope | Effort | Closes |
| --- | --- | --- | --- | --- |
| 1 | Correct the in-app pairing copy | Two strings in `SyncConnectSection.tsx`, then the i18n pipeline | ~1 hour + a translation run | The advisory's claim that the copy was fixed |
| 2 | Browser link: confirm the desktop's key before pinning it | `pairWithDesktop` in the extension, maybe one op in `socket.rs` | ~half a day | Impersonating the desktop at first pairing without the code |
| 3 | Sync enrollment: check the inviter's key before message 3 | `core-rust` handshake and every binding of it | ~1 day, including regenerated uniffi bindings and a device check | Advisory item 5 (joiner key disclosure) |
| 4 | Browser link: make the code impossible to guess offline | Code format, or a PAKE | ~half a day (long code) to ~2 days (PAKE) | Recovering the link code from one transcript |
| 5 | Approval prompt polish | Copy, and display truncation of the label | ~1 hour | Nothing structural. Makes the SAS gate harder to talk past |
| 6 | Correct the published advisory | GitHub, not this repo | ~30 minutes, after 1 and 3 ship | Advisory text that contradicts the code |

1 and 2 go first. Both are small, and 1 is a public statement that is currently untrue. 3 and 4
change the handshake or the code format and touch the native builds, so they ride a normal release.

## 1. Correct the in-app pairing copy

The "Add a device" row in Settings → Sync still says **"No vault secrets in the code."**
(`SyncConnectSection.tsx:481`). It is in all six locales and in every release from 1.11.0 to today.
[p2p-sync.md](p2p-sync.md) (lines 85-86) names exactly this phrase as the one not to use: true about
the bytes, false about the consequence. The row renders only for a vault that is not in a group yet,
so it is on screen right before someone makes their first code. Row 3 of
[sec-audit-ghsa-x4f5.md](sec-audit-ghsa-x4f5.md), the list of places making the claim, did not
include this file, which is how it survived the fix.

With the SAS gate in place, a shared code no longer leads to silent theft, so this is a correctness
fix rather than a live hole. But the advisory says the copy was corrected, and it was not.

Changes:

- `SyncConnectSection.tsx:481`: something like "Generate a one-time pairing code for a new device.
  Keep it private while it's on screen."
- `SyncConnectSection.tsx:629-631`: "You'll confirm a matching number" becomes "matching symbols".
  The prompt has shown emoji since `30472101`.
- Regenerate the catalogs per [i18n.md](i18n.md) (`pnpm i18n`, then `pnpm i18n:check`).

Optional: a test that fails if the English catalog contains "no vault secrets". A hand-kept list of
locations is what missed it last time.

## 2. Browser link: confirm the desktop's key before pinning it

`pairWithDesktop` stores the desktop's static key as `appPublicKey` as soon as the socket replies
`done: true` (`clients/extension/src/background/desktop-link.ts:289-301`). That reply is a
plain JSON frame (`Reply::step` in `clients/desktop/src-tauri/src/socket.rs:672-673`), not
a message sealed under the new session. In XXpsk3 the initiator finishes by *writing* message 3, so
at that point it has no proof the responder held the PSK. That proof only arrives with the first
message the responder seals under the session.

So whatever answers the extension's first pairing in the desktop's place gets its own key pinned
without knowing the code, and passes the extension's KK check on every connection after that.
[desktop-port.md](desktop-port.md) treats exactly that position as in scope ("a swapped proxy binary
cannot impersonate either end", line 356). From there it can answer the extension's `query`,
`syncInvite` and `syncIdentity` requests with whatever it likes, and it sees every hostname the
extension asks about.

Change: before writing `STORAGE_KEY`, require one message from the desktop sealed under the session
that just finished, and fail the pairing if it does not decrypt. `serve_session` already carries
sealed application traffic on the same connection, so the cheapest form is a sealed request the
extension already makes. If none of those works on a fresh session, add a `confirm` op that returns a
fixed string. Keep its timeout short (seconds): it is also how long an attacker holding the
extension's connection would have to crack the code in item 4.

Test: in `desktop-link.test.ts`, a fake desktop that replies `done: true` and never seals anything.
`pairWithDesktop` must reject, and storage must hold no link state.

Compatibility: none if an existing op is used. A new op needs the desktop updated first. The pair
frame already carries `PROTOCOL_VERSION` (`desktop-link.ts:277`) for the "update the app" message.

## 3. Sync enrollment: check the inviter's key before message 3

This is advisory item 5, which the advisory lists as fixed and is not. `read()` in
`packages/core-rust/src/handshake.rs:107-131` reads message 2 and immediately writes message 3.
Message 3 carries the joiner's static key encrypted under keys any responder can derive (from `ee`
and `es`); the PSK is only mixed in after it. The pin is checked once the whole handshake is done
(`enroll-host.ts:289`). So an impostor responder learns the joining device's long-lived sync public
key before the joiner drops it.

The impostor only has to be in the enrollment room, which takes the group key. That key is in every
code ever minted for the group, and it never rotates (`useSyncEnrollment.ts:112`; rotation is Item B
in [p2p-sync-revocation-hardening.md](p2p-sync-revocation-hardening.md), deferred). On its own, the
leak is a public key and a tracking handle. It is also the one input the SAS-grinding attack under
"Deferred" needs and cannot otherwise get cheaply.

Change:

- Add `handshake_enroll_initiator_pinned(local_priv, psk, expected_remote)`, which stores the
  expected key on the session. In `read()`, after `read_message` succeeds and before
  `write_message`, compare `hs.get_remote_static()` with it and drop the session on a mismatch.
  snow 0.9 exposes the remote static as soon as message 2's `s` has been read. It is authenticated
  at that point, because message 2's payload is sealed under `es`.
- Keep the unpinned `handshake_enroll_initiator`. The browser link uses it (`LINK_ENROLL_INITIATOR`
  in `clients/extension/src/offscreen-core.ts:726-732`, the `socket.rs` tests,
  `examples/fake-extension.rs`) and has no key to pin.
- Thread the new export through every binding:
  - the wasm and ffi exports in `handshake.rs`, next to the existing pair at ~405-420;
  - the regenerated uniffi bindings;
  - `NativeCrypto.swift` (~356) and `NativeCryptoPlugin.kt` (~396);
  - `clients/mobile/src/native-crypto.ts:119` and `:300`;
  - `sync_crypto.rs:54`, its registration at `lib.rs:306`, and `clients/desktop/src/sync-crypto.ts:84`;
  - `EnrollHandshakeWasm` (`enroll-host.ts:59-67`) and the joiner call at `:266`, passing
    `opts.inviterPub`.
- Keep the TypeScript check at `enroll-host.ts:289` as a second line.

The wire format does not change, so an updated joiner still pairs with an older inviter.

Tests: a Rust unit test where the responder uses a different static key. The initiator's read of
message 2 errors and returns no message 3. In `enroll-host.test.ts`, an impostor peer never receives
a third frame.

## 4. Browser link: make the code impossible to guess offline

The link code is 8 characters from a 30-symbol alphabet, about 39 bits
(`clients/desktop/src-tauri/src/pairing.rs:36-40`), and the PSK is a plain SHA-256 of it
(`pairing.rs:361`). XXpsk3 mixes the PSK into message 3, so whoever plays the desktop receives a
message whose tag checks a guessed code offline. `MAX_ATTEMPTS` and the 3-minute TTL only limit
online guessing.

Rough numbers: 30^8 is about 6.6 × 10^11 codes, at roughly a dozen SHA-256 compressions each, so
about 8 × 10^12 in total. One current high-end GPU does around 2 × 10^10 a second. The whole space
takes about seven minutes on one card, and a few cards finish inside the 3-minute window.

While item 2 is open, a swapped native-messaging host can sit in the middle of a first pairing:

1. It pins itself on the extension side for free (item 2).
2. It cracks the code from the extension's message 3.
3. It pairs itself with the real desktop before the code expires.

It then holds a valid link key on both sides. That is the "live oracle for plaintext credentials"
[desktop-port.md](desktop-port.md) already describes for a stolen key. The attacker class is the one
that doc already accepts (code running as the user), so the class is not new. What is new is that
this works on a machine that has never paired, and that the doc says it cannot.

Options:

- **Long pasted code (recommended).** At least 128 bits (about 26 base32 characters), shown with a
  copy button and pasted into the extension. Both ends are on the same screen, so pasting is the
  natural gesture. No new dependencies, about half a day. The clipboard is readable by the same
  attacker class, but the code is single-use and expires.
- **PAKE.** CPace or SPAKE2 in `core-rust`, with its output used as the XXpsk3 PSK. Keeps the short
  typed code and leaves exactly one online guess per attempt. Needs a new crate. Both sides already
  run `core-rust` (native on the desktop, WASM in the extension). About one to two days.
- **Not enough:** a shorter TTL or fewer attempts. Both only limit online guessing.

Either option changes the code format, so a mismatched desktop and extension cannot pair. Bump
`PROTOCOL_VERSION` and have the desktop say which side to update.

Correct line 356 of [desktop-port.md](desktop-port.md) now, whenever 2 and 4 land. The claim holds
for KK sessions after pairing, not for the first pairing.

## 5. Approval prompt polish

The prompt is already framed well: it asks "Is this your device?" and calls the label context rather
than proof. Two small additions:

- `SyncConnectSection.tsx:683-686`: add "If your other device isn't showing symbols, reject." The
  case the SAS cannot catch is a user approving while nothing is on the other screen.
- The label is chosen by the joiner, is an unbounded `z.string()`
  (`packages/core/src/sync/roster.ts:19`), and is rendered straight into the prompt. Truncate it for
  display (around 40 characters, with an ellipsis) in the prompt and the device list. Do not cap it in
  the schema: roster entries are signed and merged across versions, and a new cap could reject
  entries older clients already wrote.

## 6. Correct the published advisory

Edits on GHSA-x4f5-4wq4-c6c8 itself:

- **Title.** It starts with a tab character and names the component rather than the bug. Suggested:
  "P2P sync pairing code gives anyone who holds it the whole vault while an invite is open".
- **"Fixed in" column.** 1.11.0 / 1.8.0 / 0.9.8 / 1.4.3 instead of `_TBD_`.
- **"Workarounds for users, pending a fix".** Rename it to something like "If you shared a code
  before updating". The advice inside still applies.
- **Fix item 6.** Item 5 was not fixed. List it as a known residual, or name the release once item 3
  here ships.
- **Fix item 1.** The "user-facing copy" claim is only true once item 1 here ships. Name that release.
- **CWEs.** CWE-322 is in the metadata but not in the text.
- **References.** Link the fix commit `e32330c8`, and say the line numbers refer to `e32330c8^`.
- **CVE.** Request one (`cve_id` is null).
- **Severity (optional).** The vector uses Scope Changed. The vulnerable and impacted components are
  the same client and vault, and using stolen passwords elsewhere is a follow-on attack. So
  `S:U` (8.1, High) is easier to defend than 9.3. It is a judgment call either way.

## Deferred, with reasons

**SAS from the handshake hash.** `packages/core/src/sync/pairing-sas.ts` derives the SAS from the
invite PSK and both static keys. To force a match, an attacker needs all of:

- the live code;
- the joiner's static key in advance (item 3 removes the cheap way to get it);
- the ability to hold the real joiner back on the network (the relay operator, or someone on the
  path);
- about 2^42 work (the emoji) inside the window.

Deriving the SAS from the Noise handshake hash instead (snow's `get_handshake_hash()`, read in
`read()` before `into_transport_mode()`) would make grinding impossible. But every released client
computes the current derivation, and any negotiation would let an attacker pick the old one, so it
only helps once the old derivation is dropped. Do it with the next pairing change that breaks
compatibility anyway.

**VEK rotation.** Still deferred ([p2p-sync.md](p2p-sync.md) line 472). It is the only thing that
makes a code leaked before the fix recoverable. Until then, the advisory's advice to change the
credentials stored in the vault, rather than the master password, stands.

**Group-key rotation.** Item B in [p2p-sync-revocation-hardening.md](p2p-sync-revocation-hardening.md).
It decides who can be in the enrollment room, which is item 3's audience. Once item 3 ships, that
audience matters much less.
