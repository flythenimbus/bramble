# Email aliases (planned)

Design note for the per-site email alias generation asked for in issue #74:
Bramble holds an API key for an alias provider the user already has, and creates
a fresh address at signup time so every site gets its own. It records the
provider surfaces, where the key lives, and which platform can reach which host,
so the shape is decided before any code.

Fast-moving facts (provider endpoints, CORS behaviour, quotas) are dated
**September 2026**. Those measured against live accounts by
`scripts/alias-spike.ts` are under [What the spike
measured](#what-the-spike-measured); what remains unproven is listed there too,
and is unproven because no account exists to prove it against, not because it
was not tried.

## What this is, and is not

Bramble is not an alias service. It holds a bearer token for the user's own
provider and makes one call on their behalf; the mail never touches us, and
neither does the forwarding configuration. The provider account is the user's
and stays the user's.

**v1 creates aliases and nothing else.** Not list, not disable, not delete, not
reconcile-with-the-vault. An alias that outlives its entry is the provider's to
turn off, in the provider's own UI, which is where the forwarding rules and
recipients already live. A password manager that half-mirrors an alias
inventory is worse than one that does not mirror it at all, because the half
that is stale is indistinguishable from the half that is not.

## The providers

Each is a single authenticated POST once discovery is done. What differs is the
auth header, whether anything must be fetched first, and how much configuration
the user has to supply before the first alias can exist. **v1 ships Addy and
SimpleLogin**, the two verified end to end against live accounts. Fastmail and
Forward Email are researched and deferred, each for the same reason and noted in
its own section: neither can be proven without a paid account.

### Addy.io

| | |
|---|---|
| Create | `POST {base}/api/v1/aliases` |
| Headers | `Authorization: Bearer {key}`, `Content-Type: application/json`, `Accept: application/json`, `X-Requested-With: XMLHttpRequest` |
| Body | `{ domain, description?, format?, local_part?, recipient_ids?, label_ids? }` |
| Address at | `data.email` |
| Verify token | `GET {base}/api/v1/api-token-details` |
| Domains | `GET {base}/api/v1/domain-options` |
| Default base | `https://app.addy.io` |

Two things here shape the UI rather than just the client.

Addy is a Laravel app, and Laravel decides between a JSON error and a redirect to
its web login by whether the request looks like an API call. Its docs specify
`X-Requested-With: XMLHttpRequest`; measured, an unauthenticated request returns
a JSON `401 {"message":"Unauthenticated."}` with either that header or
`Accept: application/json` alone. Send both, because the cost is nothing and the
failure mode is a 302 to an HTML login page whose redirect target has no CORS,
which surfaces in a browser as an opaque network error rather than "bad key".

**`domain` is required**, and the account's available domains are only knowable
from `domain-options`. So Addy cannot generate with zero configuration: the
settings screen has to fetch the domain list at connect time and have the user
pick a default. Only SimpleLogin is configuration-free; Forward Email is
domain-first in a stricter way still, needing a domain the user already owns. That is a real extra state (fetch, pick,
persist) and it is Addy-specific, which is an argument for the provider
descriptor owning its own settings fields rather than the settings screen
switching on provider id.

`format` is one of `random_characters`, `uuid`, `random_words`,
`random_male_name`, `random_female_name`, `random_noun`, or `custom`. Only
`custom` needs `local_part`. Offer it, default to the account's own default by
omitting the field.

Addy is self-hostable, so the base URL is configuration, never a constant.

### SimpleLogin

| | |
|---|---|
| Create | `POST {base}/api/alias/random/new?hostname={host}&mode={uuid\|word}` |
| Headers | `Authentication: {key}`, `Content-Type: application/json` |
| Body | `{ note? }` |
| Address at | `.email` |
| Verify token | `GET {base}/api/user_info` |
| Default base | `https://app.simplelogin.io` |

The auth header is **`Authentication`**, not `Authorization`, and the value is
the bare key with no `Bearer` prefix. It is the single easiest thing to get
wrong in this document and it fails as a 401 that looks exactly like a bad key.

`hostname` is a query parameter, not a body field, and it is what makes the
alias legible in the user's SimpleLogin dashboard later. Always send it.

Also self-hostable, so again: base URL is configuration.

**Custom domains need a different endpoint entirely.** `alias/random/new` always
uses the account's default domain, so a domain the user owns is unreachable
through it. Reaching one takes three calls:

1. `GET /api/v5/alias/options[?hostname=]` returns `can_create`, a
   `prefix_suggestion` derived from the hostname, and `suffixes[]`, each with a
   `suffix`, a `signed_suffix` and `is_custom`. The signature is the point: it is
   what stops a client naming an arbitrary domain.
2. `GET /api/v2/mailboxes` for the default mailbox id, which the create requires
   and which only the account knows.
3. `POST /api/v3/alias/custom/new[?hostname=]` with `alias_prefix`,
   `signed_suffix`, `mailbox_ids` and an optional `note`.

So the random path stays the default and the custom path is used only when a
domain is chosen. One call against three, for the case most people want.

The prefix needs care. A shared suffix already carries its own randomness
(`.angriness537@simplelogin.com`), so the site name alone is unique enough and
the address stays readable. A custom domain's suffix is bare (`@mail.example.com`),
so the prefix has to supply the uniqueness itself or the second alias for the
same site collides with the first. Random entropy is therefore appended only when
`is_custom` is set.

### Fastmail

**Status: postponed, not cancelled.** Masked Email needs a paid Fastmail account
and there is no account to verify against, so everything below is read from the
docs and none of it has been seen on the wire. It stays written down because the
research is done and the shape is unlikely to move, but a client is not written
from a doc alone: the whole point of the spike is that Addy's quota fields and
Forward Email's verification `401` were both things no documentation mentioned.
Ships when an account exists to prove it against.

Two steps, because JMAP discovers before it acts.

1. `GET https://api.fastmail.com/jmap/session` with `Authorization: Bearer {token}`.
   Read `apiUrl`, and the account id from
   `primaryAccounts["https://www.fastmail.com/dev/maskedemail"]`.
2. `POST {apiUrl}`:

```json
{
  "using": ["urn:ietf:params:jmap:core", "https://www.fastmail.com/dev/maskedemail"],
  "methodCalls": [
    ["MaskedEmail/set", {
      "accountId": "{accountId}",
      "create": {
        "bramble": {
          "state": "enabled",
          "forDomain": "example.com",
          "description": "Bramble"
        }
      }
    }, "0"]
  ]
}
```

The address comes back at `methodResponses[0][1].created.bramble.email`, under
whatever creation id was sent. `emailPrefix` is create-only and optional;
`createdBy`, `createdAt`, `id` and `email` are server-set.

`state` is set explicitly to `enabled`. The default is `pending`, which is for
integrators that mint an address speculatively and confirm it when the user
actually uses it. Bramble's generate is already an explicit click, so the
address should work the moment it is filled. (Confirm in the spike: a `pending`
address that is never confirmed is understood to expire, and shipping that by
accident would produce aliases that quietly stop working weeks later, which is
the worst failure this feature can have.)

**The `apiUrl` pin.** The session response names the URL that the next request
sends the bearer token to. That is a server-named destination for a credential,
which is exactly the hazard `adapters/backup-creds.ts` pins target origins
against. Accept `apiUrl` only when its origin matches the session URL's origin,
and reject otherwise. Three lines, and without them a compromised or spoofed
session response harvests the token.

**Token scope.** Fastmail's OAuth scopes include
`https://www.fastmail.com/dev/maskedemail` as a distinct scope alongside
`urn:ietf:params:jmap:core`. Whether a manually created API token can be
narrowed the same way in Settings > Privacy & Security > Manage API tokens is
not settled by the public docs and is unproven. It matters: if it can, Fastmail
is the only provider here whose stored key cannot read the user's mail, and that
is worth saying in the settings copy.

## Transport: plain `fetch`, on every platform

The expensive assumption here was that this would need a native HTTP path per
platform, the way cloud backups do. It does not. Measured September 2026, with
an `OPTIONS` preflight carrying `Access-Control-Request-Method: POST` and
`Access-Control-Request-Headers: authorization,content-type`:

| Origin | app.addy.io | app.simplelogin.io | api.fastmail.com |
|---|---|---|---|
| `chrome-extension://...` | `*` | reflected | reflected |
| `tauri://localhost` | `*` | reflected | reflected |
| `capacitor://localhost` | `*` | reflected | reflected |
| `https://localhost` | `*` | reflected | reflected |

All three answer a cross-origin preflight, and two of them reflect whatever
origin is asked. So the client is one implementation in `core`, calling `fetch`,
shared by the extension, the desktop and both mobile apps. No `net` adapter, no
Rust command, no Capacitor HTTP plugin.

This is the opposite of the backups situation and worth understanding rather
than just enjoying, because the difference is not luck: these are consumer APIs
whose vendors expect browser-extension callers, while no S3 endpoint or WebDAV
server has any reason to grant CORS to `tauri://localhost` (see
[cloud-storage-backups.md](cloud-storage-backups.md)). A self-hosted Addy or
SimpleLogin behind someone's own reverse proxy inherits none of this, so a
self-hosted base URL failing CORS is a supported failure and needs an error
message that says so rather than "network error".

A preflight is not a response, so this was measured again against the real
endpoints (an unauthenticated `GET` of each provider's token-details equivalent,
all four origins, twelve combinations). Every one returned its `401` carrying an
acceptable `Access-Control-Allow-Origin`: `*` from Addy, the reflected origin
from the other two. So the header is not a preflight-only courtesy, and an error
response reaches the client as a readable status rather than an opaque network
failure, which is what makes "wrong API key" reportable at all.

The remaining gap is narrow but real: only an authenticated `2xx` proves the
success path, since a server can route errors and successes through different
middleware. That is spike question 1.

Two caveats carried forward:

- Redirects are not followed (`redirect: "manual"`, and reject rather than
  chase). A redirect out of an API call means the session was rejected and the
  destination is an HTML login page with no CORS, so following it converts a
  clean "bad key" into an opaque failure. The desktop's backup transport already
  takes this position (`reqwest::redirect::Policy::none()`, `backup.rs`).
- Every request sends `credentials: "omit"`. `api.fastmail.com` returns
  `access-control-allow-credentials: true`, and ambient cookies have already
  cost this repo a day once (1255ab7b, WebDAV uploads authenticating as the
  wrong thing). The token goes in a header, deliberately and only.

## The rest of the field, and why CORS decides it

Bitwarden's generator names six services, and they are effectively the whole
market: Addy.io, SimpleLogin, Fastmail, Forward Email, Firefox Relay and
DuckDuckGo. The other three were measured the same way (September 2026,
preflight with `Access-Control-Request-Method: POST`), and the result splits them
cleanly:

| Provider | Create | CORS from our origins |
|---|---|---|
| Forward Email | `POST {base}/v1/domains/{domain}/aliases`, HTTP Basic with the token as username, `name` omitted for a random one, address at `name@domain` | reflected, all origins |
| Firefox Relay | `POST https://relay.firefox.com/api/v1/relayaddresses/`, `Authorization: Token {key}`, body `{enabled, generated_for, description}`, address at `full_address` | **none** |
| DuckDuckGo | `POST https://quack.duckduckgo.com/api/email/addresses`, `Authorization: Bearer {token}`, no body, address is `{address}@duck.com` | **none** |

**Forward Email is the natural fourth** and costs almost nothing beyond a
descriptor: same transport, same key handling, and its `name` field is optional
with a random one generated server-side, which is exactly this feature's call.
The catch is that it is domain-first like Addy, and more so: the user must
already have a domain set up on Forward Email, so it serves people who bring
their own domain rather than anyone with an account.

**Firefox Relay and DuckDuckGo return no CORS headers at all**, and that is not a
detail. It means they cannot be called from the desktop webview or from either
mobile app, and the only reason they work in a browser extension is that a
background service worker holding `<all_urls>` bypasses CORS entirely. Adding
either one re-opens the per-platform HTTP adapter that the four other providers
let us skip: a Rust command on the desktop, a native HTTP path on mobile.

So they are deliberately out of v1, and the reason is worth stating precisely
because it is not "we ran out of time". Shipping them extension-only would put a
"Generate alias" button in the shared entry form that works on one of the four
targets, which is a worse outcome than not offering the provider. If they are
wanted later, they arrive together with the adapter, as one piece of work whose
cost is the adapter and not the two clients.

DuckDuckGo is the tempting one, being free and widely used, so the temptation is
worth naming: it is the provider most likely to be asked for and the one that
cannot be served cheaply.

Outside those six there is little. iCloud Hide My Email and Proton Pass aliases
have no public creation API (Proton owns SimpleLogin, so a Proton user's route in
is the SimpleLogin client we already have). Self-hosted Addy and SimpleLogin need
no separate client, only the base URL that is already configuration.

## Where the key lives

The API key is a bearer secret against the user's account. For Addy and
SimpleLogin it is account-capable: it can list existing aliases, read
recipients, and delete. It is a vault secret and is treated as one.

- **VEK-wrapped, like `BackupSecrets` on every platform except desktop.** It is
  never written in plaintext to `storage.local` or to a keychain.
- **Vault-scoped** (`<key>:<vaultId>`, `syncKeyFor`), not device-scoped. It
  grants a capability, and CONTEXT.md's MUST rule settles the arguable cases in
  that direction. A second vault must not inherit the first one's ability to
  spend someone's alias quota.
- **Generation therefore requires an unlocked vault.** This costs nothing real:
  the in-page suggestion and the entry form both already require unlock, and
  the extension background reaches the VEK through offscreen exactly as autofill
  does.
- Unlike the desktop's backup credentials, there is **no OS-credential-store
  tier**. The reason that tier exists is unattended scheduled runs; alias
  creation is always a user gesture in a foreground window, so there is nothing
  to keep working while locked.
- **Device-local, for now.** Sync moves only `{ entries, tombstones }`, so the
  configuration does not travel: each device is set up separately. That is a gap
  rather than a decision, and closing it is designed in
  [synced-settings.md](synced-settings.md), which exists because the obvious fix
  (a new field on the synced payload) is silently stripped by every
  already-released client.

## Consent and egress

This is the app's second network egress after the HIBP breach check, and the
README and Settings both currently say the breach check is the only one.

It is a different kind of egress and gets a different treatment. HIBP is a
background check that would otherwise happen silently against every saved
password, so it is a global toggle, off by default. Alias creation is a user
action against a service the user configured with their own credentials.
**Configuring a provider is the opt-in**; a second master switch on top of it
would be ceremony, not consent. What is owed instead:

- The settings copy names the exact host that will be contacted, including the
  self-hosted case where the user named it themselves.
- The website privacy policy gains this egress alongside HIBP.
- Nothing is contacted before a provider is configured, and no request carries
  anything but the token, the site's domain and a description.

## Surfaces

Cross-platform, in `core`:

- **Settings > Email aliases.** Provider, base URL, API key, verify button,
  plus the provider's own fields (Addy's domain and format). Verify calls the
  provider's token-details endpoint, which is a read, so a wrong key fails
  before it ever tries to create anything.
- **The entry form.** A generate button on the username field, mirroring the
  password field's generate. Fills the created address, and the entry's own name
  or first URL becomes `forDomain` / `hostname` / `description`, which is what
  makes the alias identifiable in the provider's dashboard six months later.

Extension only:

- **The in-page suggestion** on a detected signup form, offering an alias for
  the email field the way one is already offered for the password field.

## The side effect that shapes the in-page surface

Generating a password is free and repeatable. Generating an alias creates a real
record on a real account and spends real quota, and on some plans that quota is
small. Every consequence follows from that.

The generated-password suggestion rides along on the autofill query and is drawn
the moment the response lands (1e7fe405), precisely because generating early
costs nothing. An alias cannot work that way. It must be:

- **click-only.** Never on paint, never on hover, never speculatively while a
  form is being scored.
- **a round trip with visible states.** A spinner while in flight and a real
  error row on failure, inside the in-page UI, which today has no concept of a
  suggestion that can fail.
- **not regenerated casually.** The password suggestion's regenerate button is
  free to press repeatedly. An alias regenerate abandons an address that already
  exists at the provider, so it needs either a confirmation or no button at all.

There is also a new trigger to build. `shouldSuggestPassword` gates on
`field.type !== "password"` (`content/signup-detect.ts:463`) and the whole
suggestion cache is keyed to password fields, so offering on an email field is a
new entry point into `scoreSignupForm`, not a new row in an existing menu. This
is why Phase 4 is the largest phase despite being the smallest amount of network
code.

## What the spike measured

`pnpm run spike:aliases` (`scripts/alias-spike.ts`) runs against real accounts.
Read-only unless `--create` is passed, because a create is a real record on a
real account. Run against live Addy, SimpleLogin and Forward Email accounts,
September 2026:

**Transport, settled for the two providers with working accounts.** Authenticated
`200`s carry `Access-Control-Allow-Origin` on all four origins, not just the
`401`s: `*` from Addy, reflected from SimpleLogin. Forward Email reflects it too,
on a `401`. So there is no remaining reason to expect a native HTTP path.

**Addy's `domain-options` says which domains are Addy's own.** The response is
not just `data`:

```json
{
  "data": ["anonaddy.com", "anonaddy.me", "you.anonaddy.com", "you.anonaddy.me"],
  "sharedDomains": ["anonaddy.com", "anonaddy.me"],
  "defaultAliasDomain": "anonaddy.me",
  "defaultAliasFormat": "random_characters"
}
```

`data` is everything the account may create under: Addy's shared domains, the
user's own subdomains from `/api/v1/usernames`, and any custom domain they have
added via `/api/v1/domains`. `sharedDomains` is the subset the allowance is
counted over, so anything in `data` and not in `sharedDomains` is the user's own
and unlimited. `defaultAliasDomain` is the account's existing preference, which
is what the settings screen preselects instead of asking someone to choose again.

A self-hosted or older Addy that omits `sharedDomains` is read as "all shared",
which is the cautious direction: claiming a domain is unlimited when it is not
would let someone hit a wall with no warning.

**Quota is readable, and small.** `account-details` exposes
`active_shared_domain_alias_count` and `active_shared_domain_alias_limit`; a free
account gets **10**. Two consequences. The settings screen should show remaining
quota, because it can, and a limit of 10 makes it worth showing. And the
"regenerate abandons a real address" concern in the section above is not
theoretical: on a free Addy account, four idle presses of a regenerate button
consume nearly half the allowance.

**Creates are verified on both.** With `format` omitted, Addy applied the
account default and returned `w40myp02@anonaddy.com`, eight lowercase
alphanumerics (`random_characters`). Omitting the field is therefore the right
default: the user's own choice at the provider wins, and the setting is an
override rather than something we must always supply. The create also moved
`active_shared_domain_alias_count` from 0 to 1, so the counter is live and a
"1 of 10 used" line in settings costs one field of an endpoint already called.

**SimpleLogin's `hostname` shapes the address, not just the dashboard.** Passing
`bramble-spike.example.com` produced `example.reentry351@simplelogin.com`. The
site name is lifted into the local part, which has two consequences the design
has to take a position on.

The hostname we send has to be the registrable domain, cleanly derived, because
it ends up in an address the user reads and gives out. `registrableDomain`
(`platform-extension/src/dedupe.ts`) already does this for the corner prompt; the
alias path uses the same derivation rather than passing a raw form URL through.

And the address discloses where it was used. Anyone shown
`example.reentry351@simplelogin.com` learns the holder has an account at
example.com, which is a real loss for a feature whose purpose is
compartmentalization. SimpleLogin's `mode=uuid` produces an address that reveals
nothing, so the settings screen offers the choice and names the tradeoff:
`word` is legible in your own inbox, `uuid` tells a reader nothing. Which should
be the default is a judgement to make in Phase 2, but leaving it implicit is not
an option, because sending `hostname` at all is what triggers this.

**A `401` does not mean "bad API key".** Forward Email answers a valid key on an
unverified account with
`401 {"message":"Please verify your email address to continue."}`. Any client
that maps status to message loses that, and the user is sent to re-check a key
that was never the problem. The provider's own `message` is surfaced verbatim,
and the status only chooses whether the message is treated as an auth failure.
The same rule catches Addy, whose errors are also `{"message": ...}`.

**Forward Email needs a domain the user owns AND a paid plan.** Two separate
walls, found one after the other. A verified account with no domains returns
`200` and an empty array, because Forward Email has no shared alias domains of
its own the way Addy has `anonaddy.me`; every alias lives under a domain the user
owns with MX records pointed there. With a domain added, the create then returns
`402 {"message":"Please upgrade to a paid plan [...] to unlock this feature."}`,
so the alias API is gated behind Enhanced Protection.

Its onboarding is therefore "already run your mail here, on a paid plan", not
"paste an API key". That is a different proposition from the other two despite
having the simplest API of the four, and it puts Forward Email in the same
position as Fastmail: researched, reachable, unverifiable without spending money.
Both are deferred rather than dropped.

**`402` is its own error class, and the provider's message can contain a URL.**
Payment-required is neither an auth failure nor quota exhaustion, and a client
that folds every non-2xx into "could not create an alias" tells a user on the
wrong plan to go check their API key. It joins the list of statuses that mean
something specific.

The message that came back carries an upgrade link, which sharpens the earlier
rule about surfacing provider text verbatim: surface it as **plain text, never
auto-linked**. A password manager that renders a clickable URL supplied by a
remote server, in a screen where the user has just been asked for a credential,
is building a phishing surface out of an error path. The message is shown; the
link is not made clickable.

### Still open

1. **Fastmail is unverified and postponed** (see the status note in its section).
2. **Forward Email is unverified past discovery**, and stays that way without a
   paid plan. Whether an omitted `name` really yields a random one is untested.
3. What each provider returns at **quota exhaustion**. Addy's limit of 10 makes
   this cheap to provoke deliberately and worth doing before Phase 2 designs the
   error surface.
4. Rate limits, undocumented on all four.

## Phases

| Phase | Work | State |
|---|---|---|
| 0 | This document, plus the spike script. | done |
| 1 | `core/aliases/`: provider descriptors, the Addy and SimpleLogin clients, zod-validated responses, VEK-wrapped key storage, tests. | done |
| 2 | Shared UI: the settings section and the entry-form button, in six locales. | done |
| 3 | Extension in-page suggestion: the email-field trigger, the picker row, the background round trip, save wiring, `_locales`, dom tests. | done, exercised in Chromium |
| 4 | Firefox, mobile, release. | outstanding |

### What running it in a browser found

Three things, none of which any test would have caught, which is the argument for
doing it before calling a phase finished.

**The spinner never appeared.** The row's state was in the shadow renderer's cache
key but not the iframe renderer's, which computed its own from the matches and the
suggestion alone. Idle and busy hashed the same, the re-post was dropped as
redundant, and the row sat in whichever state it was first drawn in. The iframe is
the primary renderer, so that was the whole in-flight state. Addy answers fast
enough to hide it; SimpleLogin, three calls deep on a custom domain, did not. The
same line also dropped both extra rows when falling back to the shadow renderer on
a COEP page, which had silently been true of the suggested-password row since
before this feature.

**A locked vault offered nothing on the email field.** An account-creation form
deliberately shows nothing on its non-password fields, which was right until there
was an alias behind the lock. Fixed by offering the ordinary locked row there.
Answering "is a provider configured" while locked needed the registry rather than
the active vault id, which lives in session storage and is cleared on lock.

**Neither renderer had ever been driven in a test.** Both bugs lived in the iframe
path, which the picker's tests did not exercise at all; they now complete the
readiness handshake and assert on what is posted.

Phase 1 responses are validated with zod, as the backup OAuth responses are
(031e84b0): these are third-party JSON shapes that change without warning, and
an alias address is about to be written into a vault entry.
