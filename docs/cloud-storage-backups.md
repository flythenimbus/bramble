# Cloud storage backups (planned)

Design note for the "scheduled cloud backups" feature flagged in the README:
Bramble periodically writes an encrypted backup to a storage provider the user
chooses, on a schedule the user sets. It records the mechanism (how and when a
backup runs, and why it needs no multi-device coordination) and which providers
to target, so the surface is decided before any code.

Fast-moving facts (provider API availability, SDK maturity) are dated **July
2026** and flagged where they may shift. Re-verify before building.

## The insight that shapes everything

A Bramble backup is already client-side-encrypted ciphertext: the backed-up
`.bramble` blob is the vault's own bytes, so it only opens with the master password
(see `vault-format.md`). The storage provider never sees plaintext, whatever
provider it is.

Note that `.bramble` now covers two things. A **backup** is the whole vault blob,
copied byte for byte, and opens with the master password. A **portable vault** is a
selection exported from the vault list, sealed under a password chosen for that file
and holding no other key. Both are VLT1, so a reader takes either apart the same
way; what differs is which key opens it and whether the entries inside are
DEK-sealed. See [encrypted-import.md](encrypted-import.md). Only the backup is what
this document is about.

So the provider does **not** need to be zero-knowledge or end-to-end encrypted.
"Private provider" is a nice-to-have, not a requirement. What actually matters:

- A good, stable API (ideally no fragile reverse-engineering).
- Reliability and price.
- Whether the user already has an account there.

This flips the strategy. Instead of chasing one bespoke SDK per privacy provider
(many have weak or no APIs), target a few **universal protocols** and reach
dozens of backends, self-hosted included, with one lightweight client each. No
per-provider OAuth dance and no heavy SDK, which matters for a browser extension
and a mobile app.

## How backups run

The mechanism, decided before any code. Everything here follows from the
ciphertext insight above plus one platform fact: the browser extension has a
scheduler (`chrome.alarms`) and can reach any host, while the mobile apps have
no background scheduler at all and run only while open.

### Device-local, no syncing

Backup configuration is **device-local and per vault**: each vault has its own
list of targets, each with its own provider, credentials, and schedule. A vault
can back up to several destinations at once (say Drive daily, R2 weekly,
Nextcloud monthly). It is stored the way device preferences and sync endpoints
already are, per-device under `backup.*` keys, and is **never** placed in a sync
payload. The P2P sync code is untouched: no new wire field, no roster change, no
synced settings record.

Per vault, not per device, because a shared list made every vault back up to one
place: configuring Nextcloud in a personal vault silently configured a work vault
with the same server, credentials and folder, with no way to separate them
([issue #49](https://github.com/flythenimbus/bramble/issues/49)). See
[Config and state](#config-and-state-device-local-per-vault) for the keys and the
one-time migration off the old shared list.

The user configures backups on one device, typically an always-on desktop with
the extension. Only that device holds credentials and runs the schedules.

This makes the multi-device story trivially conflict-free, because conflicts
need shared state and device-local config has none. A user who deliberately
configures two devices gets two independent, intentional backup streams. Even
aimed at the same bucket that stays benign: objects are named by content hash,
so an identical vault yields an identical object (idempotent write), and
retention is computed deterministically from the object listing, so concurrent
prunes converge. The recommended setup, documented but not enforced, is "back up
from your one always-on device".

This deliberately drops an earlier idea of a synced, coordinated backup leader
(a deterministic leader elected from the roster CRDT, a shared last-backup
watermark, staggered failover). Not syncing is simpler and removes the entire
coordination surface.

### Best-effort: a frequency, not a clock time

Each target has its own **frequency** (Off / Daily / Weekly / Monthly), not a
time of day. A wall-clock moment cannot be promised: mobile has no background scheduler,
and because backups are unlock-gated (below) the vault is usually locked at any
given instant. The promise is a ceiling: at most once per frequency, the next
time the device is unlocked after one is due.

### Unlock-gated

Backups run while the vault is unlocked. Credentials are wrapped under the vault
key (VEK), so decrypting them to upload needs an unlocked vault or a cached
session VEK. This keeps cloud credentials encrypted under the master password at
rest, and matches how P2P sync already behaves (unlocked and foregrounded only).

The vault blob itself needs no unlock: the at-rest `.bramble` bytes are readable
while locked (`readVaultBlob` requires no VEK). Only the credentials gate on
unlock.

The consequence, stated plainly in the UI: effective frequency is capped by how
often the user opens Bramble on the backup device. Headless-while-locked
backups, where credentials sit under a device key instead of the VEK so the
extension's background worker can upload while locked, are a possible later
upgrade if best-effort proves too loose. Deferred for now.

### Config and state (device-local, per vault)

Each vault holds its own list of targets under `backup.targets:<vaultId>`; each
target carries its own non-secret provider config, VEK-wrapped credentials,
schedule, and run state:

```
backup.targets:<vaultId>: BackupTargetConfig[]   // each:
  { id, providerId, provider: s3|webdav,
    endpoint, region, bucket, prefix | serverUrl, path,   // non-secret
    frequency: off|daily|weekly|monthly, keep,
    creds: { iv, ciphertext },          // VEK-wrapped secret credentials
    sharedFolder?,                      // carried over from the old shared list
    lastBackupAt, lastVaultHash, lastError? }             // per-target run state
```

Stored via the same per-device meta storage as `sync.relay` and the `pref.*`
values, namespaced by vault id exactly like the `sync.*` keys
(`backupTargetsKeyFor`, mirroring `syncKeyFor`). "Back up now" fans out to every
target of the vault you are in; scheduling walks every vault and evaluates each
of its targets independently, against **that vault's own** change fingerprint.

Deleting a vault removes its list along with its blob and sync keys: the list
holds cloud credentials wrapped under a VEK that no longer exists.

**Migration off the shared list.** Installs configured before this existed have
one device-global `backup.targets` array. On first load with a resolved registry,
`migrateBackupTargetsToVaults` copies it to **every** registered vault and then
deletes the global keys (per-vault writes first, so an interrupted run just
repeats; a vault that already has its own list is never overwritten). Every vault
adopts it so that no vault silently stops being backed up by the upgrade. From
then on the lists are independent.

Each copy is marked `sharedFolder`, which keeps it writing where it already
writes: the default (first) vault at `<prefix>/`, every other vault at the
sibling `<prefix>-<vaultId>/` (`vaultBackupPrefix`). A target created in a vault
after the migration has no such flag and uses **exactly the folder the user
typed** - the point of the whole change. Editing a migrated target's folder drops
the flag too, since the user has now chosen a folder for that vault; editing
anything else keeps it, or the snapshots would move on top of another vault's.
`targetPrefixFor` is the single place that decides this, and both "Back up now"
and the scheduled run go through it.

### The decision rule

On each trigger a pure, testable function decides whether to upload:

```
shouldBackup(now, target, currentVaultHash, isUnlocked):   // evaluated per target
  if target.frequency == off -> skip (off)
  if not isUnlocked       -> skip (locked)
  due     = lastBackupAt is null or now - lastBackupAt >= interval(frequency)
  if not due              -> skip (not due)
  changed = currentVaultHash != lastVaultHash
  if not changed          -> skip (unchanged)
  -> run
```

A due-but-unchanged vault is skipped: the previous backup already captures the
current state. On upload failure `lastBackupAt` is not advanced, so it stays due
and retries at the next trigger, surfacing the error in the UI.

### Trigger points

Opportunistic, per platform:

- **Extension:** on unlock (primary), plus a lightweight `chrome.alarms` poke
  roughly every 30 minutes that no-ops while locked, re-armed when config
  changes. This reuses the alarm machinery already driving auto-lock, clipboard
  clear, and the sync keepalive.
- **Mobile:** on app resume and on unlock. There is no background scheduler on
  iOS or Android, so this is the only path. Native background (iOS
  `BGTaskScheduler`, Android `WorkManager`, the latter pure AndroidX and
  compatible with the no-Google-Play constraint) is a later stretch, OS-throttled
  and never guaranteed.
- **Desktop:** a timer in the Rust shell, every 5 minutes, and it is not
  unlock-gated. See [Desktop: the one platform that can keep a
  schedule](#desktop-the-one-platform-that-can-keep-a-schedule).

### Back up now

A Settings button, always available while unlocked. It bypasses the due and
changed checks and uploads a fresh dated snapshot to every target at once, with
per-target feedback (uploading, then backed up at a time, or failed with a
reason). It is the escape hatch for a change the user does not want to hold until
the next window.

### Object naming and retention

Any vault edit re-randomizes the whole ciphertext, so a backup is a whole opaque
blob with no byte-level delta to sync. Objects are named
`<prefix>/bramble-<ISO-timestamp>-<shorthash>.bramble`. Retention is keep-last-N,
computed deterministically from the sorted listing; deletes are idempotent.

`<prefix>` is the user's own folder field (`prefix` on S3, `path` on WebDAV),
defaulting to `bramble`. WebDAV's folder is deliberately *not* baked into the base
URL: doing so nested snapshots one level deeper than asked (a `path` of `bramble`
produced `bramble/bramble/`). Dropbox is the exception, since its `path` is a
container folder inside the app folder and keeps the `bramble` subfolder.
Grandfather-father-son retention (hourly / daily / weekly / monthly) is a
possible later refinement.

### Restore

Restore already exists: creating a new vault lets the user select a `.bramble`
file, and a backup `.bramble` is the raw vault blob, so opening one is a full
restore. No new restore flow is needed for this feature.

Restore replaces the vault on the device; it is not the same path as importing a
portable vault, which merges. That split is deliberate: at setup time there is no
vault to replace, and a user recovering from a backup wants exactly the state in
the file.

### Helper text

Shown under the frequency selector (Lingui `<Trans>` in the shared Settings UI,
so run `pnpm i18n:extract` after wiring it):

> Backups are best-effort, not a fixed time. Bramble backs up at most once per
> {frequency}, the next time you unlock the extension after one is due, so how
> often backups actually happen depends on how often you open Bramble on this
> device. Unchanged vaults are skipped. Need one right now? Use Back up now.

Mobile swaps "unlock the extension" and "open Bramble on this device" for "open
the app".

## Desktop: the one platform that can keep a schedule

Everything above describes best-effort, unlock-gated backups, because on a
browser extension that is the only honest promise. The desktop app is different
in three ways that compound, and together they make a *schedule* mean what it
says. It is the only target where "daily" is actually daily.

**1. The process outlives the window.** Closing the vault window hides it and a
tray icon stays (`lifetime.rs`), so the app is resident for as long as the
machine is on and the user has launched it.

**2. Nothing a backup needs requires the vault key.** The sealed blob is readable
while locked (as everywhere), and on desktop the *credentials* are not
VEK-wrapped either: they live in the OS credential store. So a run needs no
unlock at all, and each vault's timer is evaluated on its own whether or not
anything is unlocked.

**3. The requests have to leave from Rust anyway.** The webview's origin is
`tauri://localhost`, and no S3 endpoint or WebDAV server grants it CORS, so a
`fetch` there fails before reaching the network. Since the request is made in
the shell regardless, the credential has no reason to travel back to JavaScript.

### How it is built

- **Credentials:** one credential-store item per target, at
  `backup.creds:<vaultId>:<targetId>` (`backup.rs`), holding the same JSON the
  other platforms VEK-wrap, alongside the one origin it may be sent to (see
  [Origin pinning](#origin-pinning-the-part-that-does-the-work)). `secure_store`
  refuses that prefix through its generic `secure_get`/`secure_set`/
  `secure_delete` commands, so a compromised webview cannot read one back: it can
  ask for a request to be *sent*, never for the secret that authenticates it. The
  target's `creds` field is then just `{ wrap: "os" }`; `{ wrap: "vek" }` (or an
  absent `wrap`, which every existing target has) keeps the old meaning.
- **Transport:** `backup_send` performs the request with the auth injected in
  Rust: SigV4 via the shared core (`vault-crypto::sigv4`, pinned to the same
  vectors as the TS signer) or an `Authorization: Basic` header for WebDAV. The
  provider clients in `@core/backup` are unchanged apart from taking a
  `BackupTransport`, so object naming and keep-N retention stay single-sourced
  across every platform.
- **Schedule:** a thread in the shell emits `backup://tick` every 5 minutes, and
  the main window runs the same `runScheduledBackups` the extension does. The
  tick is in Rust because this window is usually hidden and a hidden webview's
  timers are throttled.
- **Fallback:** where no credential store answers, credentials are VEK-wrapped as
  everywhere else and backups go back to running only while that vault is
  unlocked. Same code path, one fewer capability. Which store answers is a
  ladder, not a yes/no: see [Where credentials go](#where-credentials-go-a-ladder-the-app-climbs-for-you).

### Origin pinning: the part that does the work

Keeping the credential out of the webview is worthless on its own, and an
adversarial review of the first implementation is what made that obvious (that
review, its findings and what was accepted rather than fixed:
[sec-audit-backups.md](sec-audit-backups.md)). The
webview names the URL of every request. Point `backup_send` at
`https://attacker.example` and this process would attach
`Authorization: Basic <user:password>` and mail the credential out. Refusing to
hand the secret back accomplishes nothing when the secret can be *spent*
anywhere.

So the stored record is `{ origin, secrets }`, where the origin is
`scheme://host[:port]` taken from the endpoint or server URL the user configured,
and `backup_send` refuses any request whose origin differs. The pin lives inside
an item the webview can neither read nor rewrite, which is what makes it a
boundary rather than a suggestion. `backup_send` is also main-window only:
crate commands are not gated by `capabilities/*.json` (those cover plugin
permissions), so without that check the always-on-top spotlight panel could drive
it too.

What remains, and is accepted: a compromised webview can still make authenticated
requests to the user's *own* provider, including deletes. Bounding that would
mean moving the whole orchestration into Rust, which forks object naming and
retention into two implementations. Destruction of backups by an attacker who
already owns the renderer is the lesser evil.

### Where credentials go: a ladder the app climbs for you

Three tiers, tried in order, per target, at save time:

1. **The OS credential store** (macOS Keychain, Windows Credential Manager, and
   on Linux Secret Service: gnome-keyring, KWallet, or KeePassXC's integration).
2. **The kernel keyring** (`keyutils`, the `keyring` crate's `linux-native`
   backend). Linux only, and the answer for the sessions that have no Secret
   Service on the bus: minimal window managers, headless machines. Better than
   holding the secret in our own process: it lives in kernel memory, is never
   swapped, survives an app restart within the login session, and is cleared at
   logout. It is not at-rest storage, so a reboot means the target waits for the
   next unlock to be re-armed.
3. **The vault key**, unlock-gated, exactly like the extension.

**The app chooses, and never asks.** Picking between these requires knowing what
Secret Service guarantees on a particular distribution versus what a kernel
keyring does versus what the vault key does. That is not a judgement a user can
make well, and asking them to make it is offloading our job. There is no toggle
and no per-target setting; `wrap: "os" | "vek"` records what happened, it is not
a preference anyone chose.

It follows that the app must **upgrade itself**. A target saved on a machine with
no keyring is vault-wrapped; the next time that vault is unlocked the plaintext
is in hand anyway, so if a store has appeared since, the credential moves up the
ladder silently. No migration screen, no prompt.

A store that is temporarily unreachable (a locked login keyring, a session
without a bus) is a **skip, not a failure**, matching what a locked vault already
does: no error painted on the card, still due, runs when the store comes back.

### What the user sees

Behaviour, never mechanism. The card says "Backs up on schedule" or "Backs up
when you unlock this vault". No keychain, no Secret Service, no VEK anywhere in
the main surface: those words cannot help someone decide anything, because there
is nothing for them to decide.

The degraded case gets a remedy rather than a warning, because it is usually one
package away: an unobtrusive explanation that this session has no keyring, and
that starting gnome-keyring or KWallet, or enabling KeePassXC's Secret Service
integration, gets scheduled backups working. That is a statement about behaviour
and how to change it, not a security decision handed to the user.

### The trade, stated plainly

Backup credentials on desktop are protected by the OS account rather than by the
master password. Code already running as the user, past the credential store's
ACL, can use them, and what they reach is the bucket: read, overwrite, delete.
It cannot read a vault, because the backups are ciphertext sealed by the master
password, and it does not get the VEK.

That is proportionate here and not on the extension, for one concrete reason: an
extension has no OS-mediated secret store, so its "device key" would be a plain
file in the browser profile. The desktop has a real one, and this app already
trusts it with strictly more powerful secrets, the sync device identity (the
Noise static key and the roster-signing seed). The alternative is worse than the
risk: an unlock-gated schedule on an always-on machine means a vault the user
rarely opens is effectively never backed up, and a backup that does not run
protects nobody.

Calibrate the Linux tier honestly, though. gnome-keyring and KWallet expose
`org.freedesktop.secrets` on the session bus and **any process running as the
user can read a secret from them unprompted**; there is no per-application ACL
like the one macOS binds to a signed binary. What the Linux tier buys is
encryption at rest while the session is locked or logged out, and on a
full-disk-encrypted machine even that is largely already covered. It is still
worth climbing to, but it is not the macOS guarantee wearing a different name.

**There is no opt-out.** On a desktop with a working store, unattended is what
you get. Someone who would rather their cloud credentials be reachable only with
the master password has no switch for it, which is a deliberate consequence of
the app choosing: an opt-out is the same unanswerable question as an opt-in,
asked the other way round. Recorded here rather than left to be discovered.

The recommendation for anyone who wants the credential to be weak by
construction is provider-side scope: an S3 key restricted to the backup prefix,
or Dropbox's app-folder token.

### Handling the secret in memory

Once a credential can be fetched unattended, "the vault is locked" stops implying
"no cloud credential is in this process's memory", and that was true the moment
scheduled-while-locked shipped, not when any cache was added: `secure_store`
memoises reads (it has to, or macOS turns every read into a password prompt), so
the first scheduled run leaves the plaintext in a process-global map for the life
of the process. What that costs and what follows:

- Evict `backup.creds:*` from that cache after a run, rather than holding it for
  the process lifetime. The prompt-storm argument justifies caching the accounts
  that are read constantly, not these.
- Hold the secret types in `Zeroizing` (the crate is already a core-rust
  dependency) so freed memory does not keep a copy, and keep `Debug` off them.
- Editing a target's credentials must evict any cached copy, or backups keep
  failing against a stale secret and the error will read like a server fault.
- Swap and core dumps remain part of the surface; `zeroize` does not address
  either. `MADV_DONTDUMP` is the cheap half if it ever matters.

### Considered and rejected

- **A key file next to the vault.** Any key readable unattended is readable by
  anything running as the user, so it protects against offline disk access and
  nothing else, which is what full-disk encryption already does better. Worth
  noting the company it would keep: `~/.aws/credentials`, `rclone.conf`, and
  restic and borg password files are all exactly this, so a user's realistic
  alternative to Bramble is weaker. Still not something to ship as a default.
- **Presigned URLs instead of a stored credential.** SigV4 can presign a PUT
  valid for up to seven days, so an unlocked session could mint capabilities a
  locked scheduler spends, and nothing reusable would sit at rest. It dies on our
  own object naming: keys embed the snapshot's content hash and timestamp, so
  they cannot be known in advance, and retention still needs LIST and DELETE.
  Recorded so it does not get re-proposed.
- **A per-target choice of mechanism.** See above: the app chooses.

### Carried over

Everything the per-vault and desktop-scheduling work left behind, with enough context to pick
each one up cold. Ordered by what would bite a user first.

**Failing targets retry forever, with no backoff.** The desktop tick is every five minutes and a
failed target stays due, so a wrong password means twelve authentication failures an hour,
indefinitely and unattended. Nextcloud throttles an account after repeated failed sign-ins — the
WebDAV client already explains this in `reason()` — so the retry loop manufactures a lockout that
outlives the correction. The fix wants a `failedAt` / `failures` pair on `BackupTargetConfig` and
a backoff capped at the target's own frequency, which is a persisted-format change and therefore
additive-and-tolerant like the rest. Until then, a broken target is noisy rather than harmful.

**Autostart, and on Linux the same work as TPM sealing.** "Runs as long as the computer is on"
holds only once the app has been launched. On macOS and Windows that is a login item
(`tauri-plugin-autostart`). On Linux it is a **systemd user unit**, and a user unit is also how
`LoadCredentialEncrypted=` delivers a TPM-sealed secret with no keyring daemon in the picture, so
on that platform autostart and a fourth, stronger credential tier are one piece of work.

**Two assumptions the UI already relies on, neither verified on hardware.**

- *keyutils persistence.* `secure_store`'s tier 2 links keys into the session AND the per-UID
  persistent keyring, which the crate documents as surviving a logout subject to an expiry timer
  (`/proc/sys/kernel/keys/persistent_keyring_expiry`, typically three days, refreshed on access).
  The card says "Backs up on schedule" on the strength of that. Check it on a real session:
  generate a target, log out, log back in, confirm the scheduler still runs before a reboot.
- *The `.deb`'s sidecar layout.* `manifest.rs` resolves the browser proxy as a sibling of the
  running executable. That holds in a bundle and in `target/debug`; nobody has confirmed where
  `externalBin` lands in a Debian package. If it is wrong, the browser link silently does not work
  for anyone who installed from apt.

**Not yet run.** All of it is written and skipped rather than missing:

- `docker compose up -d` then `BRAMBLE_IT=1 pnpm --filter @vault/core exec vitest run providers.integration` — the provider round trip, keep-N against a server's own listing, and the two-vault retention scoping, against real Nextcloud and MinIO.
- `cargo test -- --ignored` in `platform-desktop/src-tauri` — the SigV4 signer against MinIO, which validates signatures strictly. Our vectors only prove the two signers agree with each other.
- A desktop run against the compose Nextcloud: configure a target, lock the vault, wait for a tick, confirm a snapshot lands while locked.
- `apt install bramble` from `apt.bramble.sh` on a clean machine.

**Mobile is untouched** (`cloudBackup: false`). Enabling it needs an answer to the same question
the desktop had: whether a Capacitor webview can reach an arbitrary provider, or whether it needs
a native transport the way the desktop does. Do not assume the extension's answer transfers.

**Dropbox on desktop.** The OAuth connect is extension-only (`shell.connectBackupOAuth`), so the
desktop shows the S3 and WebDAV tiles and hides one-click sign-in.

**The extension's cross-vault credential fallback is temporary by design.** `decryptSecrets` tries
every resident vek because targets migrated off the device-global list were wrapped under whichever
vault happened to be active then. Once those have aged out (every migrated target re-saved, or
gone), it should be narrowed to the owning vault, which is what a per-vault model should mean.

**arm64 packages.** amd64 only, like Signal. The build container takes `--platform`, so this is a
runner or an emulated build rather than new code.

## Target these two adapters first

### S3-compatible

One S3 client reaches many backends. Backups are opaque objects, so a plain
PUT/GET/list/delete is all we need.

| Provider | Notes |
|---|---|
| Backblaze B2 | cheap, the de-facto backup target, clean S3 API |
| Storj | decentralized, client-side encrypted by default, ~$0.004/GB |
| Wasabi, Cloudflare R2, iDrive e2 | standard S3 |
| MinIO, Ceph, Garage | self-hosted, the "trust nobody" option |

### WebDAV

One WebDAV client reaches the self-hosted and privacy ecosystem.

| Provider | Notes |
|---|---|
| **Nextcloud / ownCloud** | self-hosted, the privacy crowd's default. Must-have. |
| Fastmail, mailbox.org, Koofr | hosted WebDAV |
| pCloud, Filen, Internxt | also expose WebDAV, so this adapter catches them too |

## OAuth one-click providers (Dropbox only)

For mainstream users who don't have S3 keys or a WebDAV server, the "Easiest" tile
offers sign-in-with-your-account. It uses OAuth 2.0 with PKCE as a **public client**
(no client secret ever ships), and each provider's own REST upload API rather than
S3/WebDAV. We store only the long-lived **refresh token** (VEK-wrapped, like every
other credential) and mint a short-lived access token on demand, so a scheduled
backup in the background service worker can refresh + upload with no user present.

**The seam.** The connect is run entirely in the extension **background service
worker** (`background/backup-connect`), not the popup. This matters:
`launchWebAuthFlow` opens a provider window that steals focus, which closes the popup
and destroys any context awaiting the auth code. The background survives that (with a
keepalive across the possibly-minutes-long 2FA sign-in), does the whole flow
(interactive authorize via `chrome.identity`, code exchange, VEK-wrap via the offscreen
host, persist the target), and the popup just triggers it via `shell.connectBackupOAuth`
and reloads. So even if the popup is torn down mid-flow, the target is saved and shows
on reopen. Absent on mobile, so the tiles stay "coming soon" there. The pure pieces are
plain `fetch`: `@core/backup/oauth` (PKCE, code exchange, refresh) and
`@core/backup/dropbox` (the storage client). The target factory (`createTarget`) gains a
`dropbox` kind; `toProviderConfig` stays pure and sync because the access token is minted
lazily inside the client (and re-minted once on a 401), not during config assembly.

**Flow.** Connect: generate a PKCE verifier/challenge + random `state` → `runOAuthFlow`
opens the provider's consent page and returns the auth `code` (state verified) → core
exchanges `code` + verifier for a refresh token → stored as the target's creds. Backup:
unwrap the refresh token → mint an access token → upload to the app folder, prune to
keep-last-N. Object naming/retention are identical to S3/WebDAV; keys live under the
connected app folder (an app-folder-scoped app only ever sees its own files).

**Registering the app (one-time, by the app owner).** OAuth needs a public app key
registered with the provider; drop it into `OAUTH_PROVIDERS` in `@core/backup/oauth`
(replacing the `REPLACE_WITH_...` placeholder, which keeps the tile in "coming soon"
until set). Dropbox: create an app at the App Console, **App folder** access,
scopes `files.content.write` + `files.content.read` + `files.metadata.read` (the last
is needed for `list_folder`, i.e. the keep-last-N prune), and add the extension's redirect
URI. The redirect is the extension's own `chrome.identity.getRedirectURL()`, i.e.
`https://<extension-id>.chromiumapp.org/`. The **published** Chrome id is stable
(`https://kmokhdhoggbdcgoepifeckhgbfakaknm.chromiumapp.org/`); an **unpacked** dev
build gets a random id unless a `key` is pinned in the manifest, so for local testing
either pin the CWS public `key` or also register whatever `chrome.identity.getRedirectURL()`
prints in the dev build's console. Firefox uses a different scheme
(`browser.identity.getRedirectURL()` returns an `*.allizom.org` URL, stable because the
`gecko.id` is pinned); that second redirect URI is registered on the same Dropbox app.
The connect is verified working on both Chromium and Firefox: the whole flow runs in the
background (service worker on Chrome, event page on Firefox), so it's browser-agnostic.

Dropbox needs `token_access_type=offline` on the authorize request to return a refresh
token.

**Why Dropbox is the only OAuth tile.** Google Drive and OneDrive were both evaluated
and dropped, because neither offers Dropbox's true-public-client experience:

- **Google Drive** — Google's Web application client (the only type `launchWebAuthFlow`
  can use) *requires* a `client_secret` at the token exchange even with PKCE (confirmed:
  omitting it returns `"client_secret is missing"`). A secret can't ship in a client-side
  extension, so a refresh token would need a server-side broker. The only secret-less
  Google path is `chrome.identity.getAuthToken`, which is Chrome-only and Chrome-manages
  the tokens (no stored refresh token, doesn't fit the uniform model). Not worth the split.
- **OneDrive** — technically the closest fit (public/native client, *no* secret, long-lived
  refresh token, app-folder scope). Dropped only because registering the Entra app now
  requires an Azure directory, and Azure signup demands a credit card. Revisit if that
  friction ever lifts; the client would be a near-copy of the Dropbox one (register the
  redirect as **Mobile and desktop / native**, never SPA, to avoid the 24h refresh cap).

Everyone else (pCloud, Fastmail, Yandex, Koofr, Filen, Internxt) is already reachable via
the WebDAV tile, and Backblaze / R2 / Storj / Wasabi / iDrive / MinIO via S3, so no other
OAuth work is warranted.

## Dedicated providers worth naming

Only worth a bespoke integration if users ask for it and the API is clean.

| Provider | API (July 2026) | Verdict |
|---|---|---|
| pCloud | REST + OAuth2, official JS/PHP SDKs, Swiss | cleanest OAuth story of the privacy set |
| Filen | TS/Rust/Go SDKs, REST API, plus WebDAV + S3 gateways | best "private name with a first-class API"; already reachable via WebDAV/S3 |
| Internxt | open source, CLI + WebDAV + S3 gateway | already reachable via the two adapters |
| Storj | S3-compatible + native libuplink | already covered by S3 |
| MEGA | official C++ SDK (native), maintained browser-compatible `megajs` (unofficial, MIT), E2EE, permissive licenses, stable API | **feasible + shippable** (medium effort — `megajs` does login/upload/crypto and even works cross-origin, so possibly no mobile native-HTTP needed). Held back not by difficulty but by two trust issues: no OAuth so it's the full MEGA **account password** (no app passwords; store the session id, not the password), and bundling an *unofficial* account-crypto lib in a password manager needs a real security review. Skip unless demand mounts. |

## Proton Drive: not yet

Historically no public API (people used the reverse-engineered Proton-API-Bridge
that rclone rides on). Proton shipped an **official SDK** (ProtonDriveApps/sdk,
TypeScript-first, MIT code), but evaluating it (July 2026) confirms it's not
worth it yet, for reasons independent of effort:

- **The SDK doesn't do auth.** It explicitly excludes login, session management,
  and the address provider ("official clients wire these in"). Proton has no
  OAuth: you'd implement the full **SRP password login + 2FA + account key
  hierarchy** yourself, i.e. users typing their Proton *account* password into a
  password manager. That's the bulk of the work and a trust problem.
- **The terms forbid shipping it.** "Not yet ready for third-party production
  use"; personal / non-commercial only. Bramble is a public product (CWS / App
  Store / Play), so it's out of bounds regardless of the MIT code license.
- **Pre-release + a breaking crypto migration** at end-2026 / early-2027, after
  which clients on older SDK releases stop interoperating.

Revisit once it's production-ready for third parties, the migration has landed,
and the terms permit public distribution (~2027). Until then Proton users can
manually drop an exported `.bramble` into Proton Drive.

## Recommendation and phasing

The mechanism above is platform plumbing; the adapters below are the reach.

1. **S3-compatible + WebDAV clients, plus manual backup.** A fetch-based S3
   client (SigV4 signing) and WebDAV client (Basic auth) in the shared core,
   since there is no existing HTTP client to reuse. A new optional `backup`
   capability on the platform that reads the at-rest blob. Device-local config,
   content-hash object naming, keep-last-N retention, and the Back up now button.
   This proves the pipe end to end and, in one shot, covers Backblaze / Storj /
   Wasabi / R2 / MinIO and Nextcloud / ownCloud / Fastmail / Filen / Internxt.
2. **Extension automatic scheduling.** The `chrome.alarms` poke and on-unlock
   triggers, the decision rule, and skip-if-unchanged.
3. **Mobile automatic (opportunistic).** The same client and config, fired on
   resume and unlock. Native background scheduling deferred.
4. **OAuth consumer provider (Dropbox).** Built and live: PKCE public client,
   refresh-token creds, app-folder REST client, connect run in the background service
   worker (`shell.connectBackupOAuth`). Dropbox is the only OAuth tile; Google Drive and
   OneDrive were evaluated and dropped (see "Why Dropbox is the only OAuth tile" above).
   MEGA and Proton stay deferred (Proton "planned once its SDK stabilizes").

Because the payload is already ciphertext, the user-facing promise (the provider
never sees anything readable) holds for every backend, not only the private ones.

## References

- Proton: [SDK preview](https://proton.me/blog/proton-drive-sdk-preview), [SDK update Jan 2026](https://proton.me/blog/drive-sdk-january-2026), [ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk), [Proton-API-Bridge](https://github.com/henrybear327/Proton-API-Bridge)
- [pCloud API docs](https://docs.pcloud.com/)
- [Filen (GitHub org)](https://github.com/FilenCloudDienste)
- [Internxt WebDAV / rclone](https://internxt.com/webdav-rclone)
- [MEGA C++ SDK](https://github.com/meganz/sdk)
- [Backblaze B2 S3-compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)
