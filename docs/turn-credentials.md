# TURN credentials: who gets them, and how much they may use

Status: built on both relays (2026-10-12), not yet deployed. Tickets are accepted but not yet
required: flip `ICE_REQUIRE_TICKET` once ticket-sending releases have spread.

`POST /ice-servers` used to hand a 24-hour Cloudflare TURN credential to anyone who asked: CORS
`*`, no check. Anyone could relay their own traffic on the project's account.

The clients are open source and there are no accounts, so no secret can tell a Bramble device from
a script, and app attestation is out (no Google Play services, and the extension has none). The
goal is therefore bounded cost rather than identity: credentials that are hard to get in bulk, each
limited in what it can use, and a total that stays inside the free tier.

## Stage A: the hosted Worker (built)

One global Durable Object, `IceGuard` (`services/nostr-relay/cf-worker/src/ice-guard.ts`), is asked before
every mint, and a cron trigger asks it to check usage every 10 minutes. The limits are wrangler
vars; the rules are pure functions in `ice-policy.ts`, tested with `node --test`.

| Measure | Value | How |
|---|---|---|
| Per requester | 20 requests a minute | Counted in the guard, exact and global. Workers' rate-limit binding counts per location and is approximate by design |
| Credential lifetime | 2 hours (was 24) | A relayed connection drops at expiry and the mesh redials within 30 s; a file transfer resumes |
| Monthly ceiling | 900 GB of TURN egress | The free tier is 1,000 GB per account. The 100 GB margin covers credentials already out and the check interval |
| Per credential | 10 GB in a clock hour | Over it, the cron revokes the credential (up to 20 a run) and blocks its requester for a day |

A requester is the HMAC of its address under a random salt that changes monthly; IPv6 is cut to
its /64 first, so stepping through one subscriber's block doesn't buy a fresh allowance. Raw
addresses are never stored. Records last as long as their purpose: rate windows two minutes,
credentials two hours, blocks a day.

Each cron run logs one line: how requests were answered since the last run (TURN with and without
a ticket, STUN by reason) and the month's egress against the ceiling, for example
`[ice-guard] last 10 min: 41 TURN (38 ticketed), 3 STUN (rate 2, no ticket 1); month 8.1 of 900 GB`.
That is what shows whether the limits turn away real users and when to require tickets.

Whenever TURN is withheld (ceiling, rate limit, block, or any failure in the guard or the mint),
the answer is still a 200 carrying Cloudflare's free STUN servers. Clients read anything else as no
servers at all, which would cost them NAT traversal too; with STUN, devices that can connect
directly still do.

The month total comes from `callsTurnUsageAdaptiveGroups` (sum of `egressBytes`, account-wide,
since the free tier is shared by every key), the per-credential cap from the same dataset grouped
by `username` and `datetimeHour`. A total unconfirmed for an hour withholds TURN, so a broken
check can't run up a bill. Without the analytics secrets, the rate limit and lifetime still apply,
and every cron run logs that the ceiling and cap don't.

### Deploying

```sh
cd services/nostr-relay/cf-worker
pnpm exec wrangler secret put TURN_ANALYTICS_TOKEN   # API token: Account > Account Analytics > Read
pnpm exec wrangler secret put CF_ACCOUNT_ID
pnpm run deploy
```

The two GraphQL queries follow Cloudflare's documented examples but have not yet run against the
live API. Before deploying, run the cron once locally with the real secrets in `.dev.vars`
(`TURN_KEY_TOKEN_ID`, `TURN_KEY_API_TOKEN`, `TURN_ANALYTICS_TOKEN`, `CF_ACCOUNT_ID`):

```sh
pnpm exec wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"
```

No `check failed` line in the output means both queries were answered and parsed.

## Stage B: a credential needs a live sync connection (built)

Decided 2026-10-12: the hosted TURN serves people on Bramble's relay, not anyone who can reach the
endpoint. A device that signals on another Nostr relay gets STUN only from it, unless it brings its
own TURN.

Each socket gets a random ticket when it connects. The app asks for it on open
(`["BRAMBLE_TICKET"]`, answered `["BRAMBLE_TICKET", ticket]`; additive, so an old or stock relay
ignores it, and the app stops waiting after 2 s) and sends it with every ICE request in a
`text/plain` body, which needs no CORS preflight an older relay would fail. The relay mints at the
full rate only for a ticket held by an open socket that has published in the last five minutes
(apps say hello every 30 s); the Worker keeps the ticket as the socket's hibernation tag, so the
lookup is direct. The app sends a ticket only to an ICE endpoint on the relay's own host, since an
endpoint elsewhere has no use for it.

A script can still do all this, but every credential is then tied to visible relay activity, and
the endpoint is no use as free TURN for someone else's app without speaking Bramble's relay
protocol. Until `ICE_REQUIRE_TICKET` is on, a request without a live ticket gets a much lower
allowance (`ICE_TICKETLESS_PER_MINUTE`, 4) instead of none, so released apps keep TURN in the
meantime. Signed requests were the first idea; they would need a secp256k1 Schnorr library in both
relays, since neither Workers' WebCrypto nor Node's crypto verifies Nostr signatures.

## Self-hosted Node relay (built)

The same tickets, an in-process rate limit (`ICE_REQUESTS_PER_MINUTE` with a live ticket,
`ICE_TICKETLESS_PER_MINUTE` without, per IPv4 address or IPv6 /64) answering STUN only past it,
`ICE_REQUIRE_TICKET`, and a 2-hour default lifetime. Behind a proxy every request comes from the proxy, so
`TRUST_PROXY` names the proxy whose `X-Forwarded-For` is believed, and only it. Covered by
`services/nostr-relay/node/relay.test.mjs`, which starts the relay and asks it as a client would.

No ceiling and no revocation: those rest on Cloudflare's billing data and revoke API, and a
shared-secret credential can't be revoked by itself (coturn checks only the HMAC and the expiry).
coturn enforces limits in the data path instead; the relay README carries a recommended
`turnserver.conf` (`denied-peer-ip` for private ranges, `no-tcp-relay`, quotas, bandwidth caps).
Usernames are `<expiry>:<tag>`, the tag an HMAC of the requester under a per-process salt, so the
TURN server's logs tell requesters apart without naming them. coturn's `user-quota` keys on the
whole username, so with the expiry in it that limit is per credential, not per requester. Changing
`TURN_SECRET` on both sides invalidates every credential at once.

**Private mode, on both relays.** `RELAY_TOKEN` makes a relay refuse sockets and ICE requests
without `?token=`; the health probe and CORS preflights stay open. The token rides in the relay
URL, which pairing codes already carry, so a joining device needs no new setting, and
`deriveIceUrl` now keeps the query. Anyone who sees a pairing code learns the token, so rotate it if
one leaks, and keep query strings out of proxy logs.

## Files

Attachments use TURN too since 2026-10-12 (see [file-attachments.md](file-attachments.md),
"Transfer"), so one monthly budget covers entries and files, and a month that reaches the ceiling
leaves both without TURN. The ceiling counts all of it; nothing yet keeps a share back for entries.
