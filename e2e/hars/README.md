# HAR recordings

Recorded network traffic for real sites, replayed offline by the specs in
`e2e/extension/`. A HAR replay boots the site's **actual application**, so its
own click handlers, router and re-renders run. That is the difference that
matters for save-capture testing, where the entire question is what the app does
to the DOM when a login lands.

This complements, and does not replace, `packages/platform-extension/src/fixtures/sites/`:

| | what it is | drives |
|---|---|---|
| `fixtures/sites/*.html` | stripped DOM snapshot, scripts removed | fast jsdom detector/capture unit tests |
| `e2e/hars/*.har.zip` | full network recording, real JS runs | Chromium e2e against the live app |

## Recording

```sh
node scripts/capture-har.mjs <url> <name> [--consent "<button text>"] \
     [--origins other.cdn.example] [--locale sv-SE] [--wait 5000]
```

Recording is **first-party only** by default. Analytics, consent and captcha
vendors add weight and non-determinism, and replay aborts them anyway. Sites that
serve their app from another origin need it listed in `--origins`, or the replay
boots an empty shell. Watch the "visible inputs" count the script prints: zero
means the app never mounted and something it needs is missing.

## The corpus

Chosen for structural shapes that break detection, not for popularity. Every one
is smoke-tested by `e2e/extension/har-corpus.spec.ts`, which fails if a recording
stops booting its app.

| HAR | size | why it's here |
|---|---|---|
| `hackernews-login` | 2 KB | no `autocomplete` anywhere (`acct`/`pw`), and two identical forms on one page |
| `yahoo-login` | 940 KB | identifier-first with no token, shadow DOM, 7 iframes |
| `ebay-login` | 232 KB | identifier-first behind several iframes |
| `bol-login` | 287 KB | Dutch, Spring Security `j_username`/`j_password` |
| `skanetrafiken-login` | 1.1 MB | formless SPA, `type="button"` submit, federated remote |

```sh
node scripts/capture-har.mjs https://www.skanetrafiken.se/mitt-konto/ skanetrafiken-login \
     --consent "Tillåt alla" --locale sv-SE --origins azurestaticapps.net
node scripts/capture-har.mjs https://news.ycombinator.com/login hackernews-login --wait 4000
node scripts/capture-har.mjs https://login.yahoo.com/ yahoo-login --origins s.yimg.com --wait 7000
node scripts/capture-har.mjs https://signin.ebay.com/signin ebay-login --wait 6000
node scripts/capture-har.mjs https://www.bol.com/nl/rnwy/account/inloggen bol-login \
     --locale nl-NL --origins login.bol.com --wait 7000
```

Three lessons are baked into those invocations:

- **`--origins` is load-bearing.** skanetrafiken serves its login UI as a
  module-federation remote from `*.azurestaticapps.net`; Yahoo serves everything
  from `s.yimg.com`. Without them the replay boots a shell (skanetrafiken reports
  "Denna tjänsten är för tillfället tyvärr inte tillgänglig", Yahoo renders no
  form) and the recording is 16 KB of nothing.
- **Start from the URL a user would.** bol.com only assembles its login at
  `login.bol.com` after redirecting from `/rnwy/account/inloggen`; recording the
  final URL directly captures zero inputs.
- **Some sites cannot be recorded unattended at all.** gitlab.com, allegro.pl and
  leboncoin.fr record 0 inputs whatever you do: headless, headed, real user
  agent, `--disable-blink-features=AutomationControlled`. Their bot walls read
  more than the browser announces. `--manual` is the only route, because a human
  clears the interstitial.

## Manual recording

The script runs **headed by default** — recording is a human operation, not a CI
step. `--headless` is there for an unattended re-record of a site already known
to work.

`--manual` holds the browser open until you press Enter in the terminal:

```sh
node scripts/capture-har.mjs https://example.com/login example-2fa --manual
```

Everything you do in that window lands in the HAR. This is the only way to reach
what the automated path cannot: **segmented one-time-code widgets**, password
change forms, a genuinely successful login, and the bot-walled sites above.

### What gets scrubbed, and what doesn't

Every recording is stripped of `Cookie`, `Set-Cookie`, `Authorization`,
`Proxy-Authorization` and `WWW-Authenticate` headers before it is written, and
the script prints the count. This is unconditional rather than a flag: the one
recording somebody forgets to scrub is the one that matters.

`recordHar`'s `mode: "minimal"` does **not** do this. It drops the HAR's
`cookies` arrays but leaves the headers, so an authenticated capture carries a
live session. The first Microsoft recording had 17 such headers; the five
unauthenticated ones already committed had 100 between them.

**Bodies are not scrubbed and cannot safely be** — they're the thing being
replayed. A recording still holds whatever the responses contained: usernames,
tokens embedded in HTML, and on a 2FA setup page the TOTP secret itself. Use a
throwaway account, and read the recording before committing it:

```sh
unzip -o e2e/hars/<name>.har.zip -d /tmp/har && grep -ril "otpauth\|secret=" /tmp/har
```

Once recorded, the replay is inert: `notFound: "abort"` means no request leaves
the machine, so a spec can drive a "successful login" against the recording
without touching the real site or holding any credential.

## Replaying

Register the HAR **first**. Playwright runs the most recently added route handler
first, so per-call stubs must be added *after* it to take precedence:

```ts
await context.routeFromHAR(HAR, { notFound: "abort" });
await context.route("**/some/api", stub);   // wins over the HAR
```

`notFound: "abort"` keeps the run hermetic: anything not recorded fails rather
than reaching the network. Expect a pile of aborted third-party requests in the
console; that is the design, not a fault.

Calls the recording cannot carry (authenticated endpoints, captcha) get stubbed
per spec. **No credential is ever sent anywhere**: every request is served or
stubbed locally, so driving a "successful login" costs the real site nothing and
needs no account.

## Size

`--skip css,png,woff2,...` drops assets from the recording. Measure before
reaching for it: on skanetrafiken it saved only 128KB of 1.1MB, because the bulk
is JS and the zip already compresses text hard. That is a poor trade against
losing real layout, which is most of why a HAR beats a DOM snapshot, so this
recording keeps everything. Image-heavy sites are where the flag pays.

Only skip stylesheets once a spec confirms layout isn't load-bearing for what it
asserts. Ours read `getBoundingClientRect`, and they pass with CSS blanked
because skanetrafiken hides the panel inline rather than via a class; a site that
hid it with a stylesheet rule would need its CSS kept.

The cost that actually matters is **churn, not size**. A `.zip` is already
compressed, so git cannot delta it: every re-record stores another full copy in
history forever. Re-record deliberately, not routinely.

## Staleness

These are snapshots and they go stale, exactly like the DOM fixtures. They are
deliberately chosen edge cases rather than a health check on the live web, so
re-record only when a specific behaviour is in question. Re-recording is one
command; the invocation used for each HAR is documented above.
