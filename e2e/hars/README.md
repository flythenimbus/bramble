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

`skanetrafiken-login` was recorded with:

```sh
node scripts/capture-har.mjs https://www.skanetrafiken.se/mitt-konto/ skanetrafiken-login \
     --consent "Tillåt alla" --locale sv-SE --origins azurestaticapps.net
```

The `--origins` flag is load-bearing there: the login UI is a module-federation
remote served from `*.azurestaticapps.net`, so a first-party-only recording
replays the page shell with the panel missing and the app reporting
"Denna tjänsten är för tillfället tyvärr inte tillgänglig".

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

## Staleness

These are snapshots and they go stale, exactly like the DOM fixtures. They are
deliberately chosen edge cases rather than a health check on the live web, so
re-record only when a specific behaviour is in question. Re-recording is one
command; the invocation used for each HAR is documented above.
