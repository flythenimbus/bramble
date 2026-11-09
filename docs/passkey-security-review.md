# Passkey provider and PRF: adversarial review and fixes

An external adversarial review of the passkey provider and the PRF work ([passkey-prf.md](passkey-prf.md))
ran on 2026-11-01 across Chrome, Firefox, Android, iOS, the core and the importers. It confirmed 21
findings, each with a trace and most with an executed proof of concept. All of them are fixed except
#18, which is by design (below). Findings that predate PRF were fixed in the same pass.

**Status:** fixed on main 2026-11-01 (9893acc9, fd6ed1c9, 85280a1e, 05d29b84, 41a4f394, 27b29c5f).
Verified: the core, extension and mobile unit suites; the Android JVM tests; Chrome end to end through
the real webAuthenticationProxy (`passkey-origin.spec.ts`, which fails on the pre-fix build, and
`passkey-prf.spec.ts` through the new confirm-it's-you window); Android and both iOS targets compiling.
Not yet run on a device: Android, iPhone, Firefox.

## Findings and fixes

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | Chrome took the origin from the focused tab, so a background page on a sibling subdomain got the focused page's assertion and PRF output | Critical | The origin is Chrome's own stamp on each proxied request (`remoteDesktopClientOverride`); a top-level request from a tab that isn't focused is refused (9893acc9) |
| 2 | Android never bound the rpId to the caller: any app could name a site and get its PRF output for its own salts | High | A caller needs a verified privileged browser origin on that site, or the rpId's `assetlinks.json` vouching for the app (41a4f394) |
| 3 | `userVerified: true` on every approved ceremony; a card click (extension) or a stale keep-unlocked session (Android) released UV=1 and PRF | High / Medium | UV is claimed only after a verification in this ceremony. UV "required" and PRF force one: a confirm-it's-you window in the extension, a fresh unlock on Android. Otherwise UV=0 (85280a1e, 41a4f394) |
| 4 | The Firefox bridge served requests from any frame | Medium | Only the top frame or a same-origin child, judged from the message sender (9893acc9) |
| 5 | Poisoned `fido2Extensions` / PRF halves survived import and sync, then sank a whole Apple credential exchange | Medium | Write-gate validation, and the exporter and importer drop just the bad member with a warning (05d29b84) |
| 6 | The passkey card had no anti-clickjacking guard | Low | Consent clicks are ignored while the card is hidden, faded, covered or in its first 500 ms (`legibility.ts`, shared with the picker) (fd6ed1c9) |
| 7 | Origin and card tab came from two separate tab queries | Low | One binding per request, from the stamp (9893acc9) |
| 8 | Internal error text reached the page | Low | Pages only ever see a generic `NotAllowedError` (fd6ed1c9) |
| 9 | Concurrent ceremonies replaced each other's card; a timed-out create fell back to native while a passkey still saved | Low | One ceremony at a time on one 150 s budget; a create that hits the page backstop fails instead (fd6ed1c9) |
| 10 | Android ignored `allowCredentials` | Low | Enforced when listing and again before signing (41a4f394) |
| 11 | Android decoded PRF salts leniently, the core strictly | Low | Salts must be canonical base64url everywhere (fd6ed1c9, 41a4f394) |
| 12 | `evalByCredential` keys matched by exact spelling | Low | Keys match by the id's canonical spelling everywhere (fd6ed1c9, 41a4f394) |
| 13 | Android signed a privileged browser's hash with no origin-to-rpId check | Low | The browser's origin must be the rpId or a subdomain (41a4f394) |
| 14 | Android backups could carry the plaintext pending-save handoff | Low | `dataExtractionRules` and `fullBackupContent` exclude every handoff file (41a4f394) |
| 15 | Android pending-passkey writes raced each other and the app's drain | Low | A cross-process `LockedFile` for every write, and a native drain under the same lock (41a4f394) |
| 16 | iOS pending handoffs raced between the extension and the app | Low | File queues in the App Group container under a cross-process `flock` (`AppGroupHandoff`) (27b29c5f) |
| 17 | iOS matched a chosen passkey by credential id alone; an import could plant a duplicate under another rpId | Low | Every lookup is keyed by rpId and credential id, on iOS and Android (27b29c5f, 41a4f394) |
| 18 | iOS registers passkey identities without the QuickType opt-in | Low | By design, see below |
| 19 | Import unzipped before applying the size cap | Low | The cap applies to the declared sizes before inflating (05d29b84) |
| 20 | CXF passkeys skipped the importer caps | Low | The same rpId and size checks as every file importer (05d29b84) |
| 21 | `.bramble` import stored PRF halves unvalidated | Low | The write gate requires 1 to 1024 bytes of standard base64 per half (05d29b84) |

## Decisions

- **#18 stays.** The OS can't route a passkey get() to a provider whose identities it doesn't know,
  so gating them on the keyboard-suggestions opt-in would switch passkeys off for everyone who leaves
  it off. iCloud Keychain and every third-party provider register them the same way. The identities
  carry no secret, and enabling Bramble as a provider is the consent that covers them.
- **Honest UV=0.** A plain sign-in on an already unlocked vault (extension) or inside a keep-unlocked
  session (Android) reports UV=0 rather than prompting. WebAuthn tells sites asking for "preferred"
  to accept that, and it keeps everyday sign-ins one click.
- **No gesture requirement on Firefox.** Requiring a user gesture for the bridge would break sites that
  call `get()` after an `await`. The card is the consent.
- **The clickjacking guard covers passkey consent only** (approve and pick), not save-login, whose
  worst case is an unwanted entry.
- **Confirming with a key on Chrome.** A key tap inside an in-flight request ends that request; it
  is the proxy pause window described in
  [passkey-provider.md](passkey-provider.md#the-pause-window-is-a-hole-in-the-provider-and-it-is-structural).
  The tap carries over to the site's next try.
- **Android's list hop filters by caller only when the begin request carries it.** The framework sends
  `callingAppInfo` there only when the caller asked (`alwaysSendAppInfoToProvider`). The sign hop
  always has it and enforces the check, so nothing is released without it.
- **Asset links for apps.** The check blocks on a miss and caches only grants (7 days, keyed by the
  signing certs). A failed fetch is not cached, so an app is never locked out by a bad network moment,
  but its first passkey use needs the network.
- **Duplicate credential ids.** Rather than de-duplicating ids across the vault on import, every
  lookup is keyed by rpId and id, so a duplicate can only ever answer for its own site.

## Found alongside

- **Attachment spool.** Sealing an attachment on mobile spooled its plaintext to `blobs/.spool-*` in
  the data dir, which Android Auto Backup and iCloud backup both include, and nothing swept a spool
  that a crash left behind. It now spools to the cache dir (in no backup) through the shared
  `spool.ts`, and a startup sweep clears leftovers in both places. Found while doing #14.

## Open

- **Device checks.** Android, iPhone and Firefox, on the Corbado PRF demo and AliasVault, plus an
  app sign-in on Android to exercise the asset-links check.
- **The iOS passkey bundle** append is now under the App Group lock, but it still lives in
  `UserDefaults`, whose per-process cache can serve a stale read. The bundle is rebuilt from the
  vault on the app's next index refresh, so a lost append heals itself there.
