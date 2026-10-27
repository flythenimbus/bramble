# Entry sync: send the vault when it changes, not every 4 seconds

Status: built 2026-10-13. Measured end to end (`e2e/sync/idle-traffic.spec.ts`): with one
150 KB note in the vault, an idle minute between a browser and a phone without WebRTC cost the
relay 26 KB, against 12.2 MB with the whole envelope sent every tick.

## Why

`core/sync/transport/roster-sync.ts` sends every connected peer the whole envelope (the sealed
entries payload plus the roster) every 4 seconds (`REBROADCAST_MS`), whether or not anything
changed. On a LAN that costs nothing anyone sees. Over TURN it is metered: a vault of a few hundred
KB comes to roughly 100 to 300 MB an hour in each direction for every pair of devices relayed that
way. The hosted TURN's last 30 days (to 2026-10-13: 8.11 GB egress, 7.84 GB ingress, bursts up to
about 450 MB) fit that, and no build sends files over TURN yet.

At that rate one user whose phone and desktop stay relayed for 8 hours a day uses on the order of
100 GB a month, so fewer than ten would use up the 900 GB ceiling
([turn-credentials.md](turn-credentials.md)), after which nobody gets TURN until the month resets.
Files are small beside it: each crosses once per device. The same waste reaches the Worker on
relay-forwarded pairs (Firefox), which carries the vault in 64 KB chunks every 4 seconds.

## What the 4-second resend does today

All of it has to keep working:

1. **Delivery.** A local edit reaches peers at the next tick. Only the extension pushes one at once
   (`broadcastNow`, via `SYNC_BROADCAST_NOW`); desktop and mobile rely on the tick.
2. **Gossip.** With three or more devices, a change B merged from A reaches C in B's next
   broadcast.
3. **Self-healing.** A merge that failed on the receiver gets another chance 4 seconds later.
   On Chrome that is the only recovery there is: the offscreen document's `pushRemotePayload`
   ignores the background's answer, so a merge that fails there is silent.
4. **Liveness.** A peer silent for five ticks (`STALE_MS`, 20 s) is dropped; relay-forward has no
   other sign that a peer has gone.

## The change (built)

Each tick, for each peer, the sender still builds its envelope (no change in CPU from before) and
compares it with the last one it sent that peer:

- **Unchanged:** it sends a heartbeat, `{}`.
- **Changed:** it sends the envelope whole and remembers it.

It also sends the whole envelope on connect (as now), when the peer asks for it, and every 10
minutes regardless, as a backstop.

**Asking again.** A receiver whose merge fails answers `{ "resend": true }`, and the sender forgets
what it last sent that peer, so the next tick carries the whole envelope. It waits for the tick
rather than sending from the receive loop, and every send to a peer now waits for the one before
it, because two at once on one Noise session interleave their frames (the timer's broadcast and
`broadcastNow` could already overlap). On the receiving side, `applyEnvelope` is caught instead of ending the peer's
loop, and the Chrome bridge rejects when the background answers `ok: false` (Firefox, desktop and
mobile already throw).

How that covers the four:

1. Delivery: an edit changes the envelope, so the next tick sends it. Desktop and mobile keep their
   4-second latency.
2. Gossip: a merge writes the local payload, which changes the envelope for every other peer.
3. Self-healing: the resend request, with the 10-minute backstop for anything a receiver can't
   detect.
4. Liveness: heartbeats arrive every tick, as envelopes did.

**Details.** The comparison is on the envelope string. `encodeEntriesPayload` and `encodeRoster`
are deterministic, which a test pins (two reads of an unchanged vault give the same string); if
something ever made them not, the result is a full send every tick, today's behaviour, never a
missed change. Memory: one envelope string per peer. A heartbeat is around 100 bytes on the wire,
so about 90 KB an hour per peer.

## Mixed versions

No negotiation is needed.

- **New sender, older receiver.** An older receiver marks a peer alive on any envelope and applies
  only an `entries` field, so `{}` keeps it alive and applies nothing. It gets the whole envelope
  whenever something changes. What it loses is the 4-second retry after a failed merge, since it
  can't ask for a resend: it waits for the next change or the 10-minute backstop.
- **Older sender, new receiver.** The older side keeps sending everything every 4 seconds, and
  nothing else changes. The saving comes once both ends have updated.

## Expected saving

An idle relayed pair with a 300 KB vault: about 270 MB an hour each way today; afterwards
heartbeats (about 0.1 MB an hour) plus a backstop envelope every 10 minutes (about 1.8 MB an hour),
roughly 99% less. An edit costs one envelope per peer.

## Measuring it: logging in the hosted Worker (built)

The ICE guard records nothing when it withholds TURN, so today there is no way to tell whether the
limits are turning away real users, how many requests carry tickets yet, or whether the analytics
query's month total is right.

- The guard counts every answer by outcome in its storage: TURN with a ticket, TURN without, and
  STUN for each reason (rate limit, block, ceiling, ticket required, a stale month total, a guard,
  mint or record failure). `admit` returns its reason rather than only `"stun"`.
- Each cron run logs one line and resets the counts, for example
  `[ice-guard] 10 min: 41 TURN (38 ticketed), 3 STUN (rate 2, no ticket 1); month 8.1 of 900 GB`.
  One line per run rather than per request, because a flood of withheld requests is exactly when
  per-request logging would cost most.
- The month total is logged on every run, so the first deploy can be checked against the
  dashboard, and the ticketed share says when to turn on `ICE_REQUIRE_TICKET`.

## Tests

- `roster-sync.test.ts`, over the in-memory pipes in `test/transport-fakes.ts`:
  - unchanged ticks send heartbeats;
  - a local change goes out whole on the next tick;
  - a change merged on B reaches C (three peers);
  - a failed merge gets a resend;
  - the backstop sends after 10 minutes (fake timers);
  - a heartbeat keeps a peer from being reaped;
  - a peer that still sends everything every tick converges and stays alive;
  - two reads of an unchanged vault give the same envelope.
- The Chrome bridge rejects on `ok: false`.
- End to end (sync suite, `idle-traffic.spec.ts`): pair the extension with the mobile app without
  WebRTC, so entries are relay-forwarded and the relay's `/stats` counts them, leave it idle for a
  minute, and assert the relay carried less than one envelope's worth. With the whole envelope
  forced on every tick the same test fails, at 12.2 MB.
- Worker: the summary line from a set of counts (pure, `node:test`); one cron run under
  `wrangler dev`.
- Over real TURN (`e2e/android/turn-idle-traffic.spec.ts`, opt-in, production relay and TURN):
  the extension paired with the app on a Pixel 8, the phone's WebRTC forced to relay-only, the
  same 290 KB vault idle for 10 minutes, measured 2026-10-14 against a build from just before the
  change:

  | | Before | After |
  |---|---|---|
  | Phone's TURN link, sent / received | 43.0 MB / 44.0 MB | 308 KB / 307 KB |
  | Cloudflare TURN egress (5-minute buckets) | 22.5 MB + 22.2 MB | 76 KB + 444 KB |

  About 265 MB an hour of TURN egress before, about 3 MB after, of which the 10-minute backstop
  is most. The after run's one whole envelope is that backstop. Runs stop short of the app's
  15-minute auto-lock, which ends sync.

  The same run then times an edit each way over that TURN link: browser to phone 6.4 s (the
  browser sends at once; most of it is the phone merging and redrawing), phone to browser 4.4 s
  twice (its next tick plus the merge). An edit never waits for the backstop.
- Mixed versions on the Pixel over TURN (the app from just before the change, the current
  extension): the older phone still sent its whole vault every tick (4.3 MB a minute) while the
  extension sent heartbeats (95 KB); edits 6.3 s browser to phone, 2.9 s and 3.9 s back.
- The iOS app on a simulator (`e2e/ios/sync-on-simulator.mjs`, native WebRTC): edits 255 ms
  browser to iPhone and within one tick back, before and after a quiet minute with no peer drops.
  The desktop app is still to do (2026-10-14): under the dev harness it reached "Join vault" but
  the browser never saw the join.
- Edits end to end (`e2e/sync/edit-latency.spec.ts`), browser and the mobile app on one machine,
  over WebRTC and over relay-forward: browser to phone under 20 ms, phone to browser 0.8 s, and
  3.9 s after a quiet stretch.

## Not in scope

- Reading the local payload less often. Each tick still decrypts it to compare, as each tick does
  today. A version number from the host would avoid that, and is a separate change.
- Sending only the entries that changed. One whole envelope per change is fine at these sizes.
