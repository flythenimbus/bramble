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
copied byte for byte, and opens with the master password. (A vault with file
attachments is backed up as a ZIP holding that same blob plus the attachments'
sealed files; see "Backups with attachments" below. Without attachments the file is
exactly the blob, as it always was.) A **portable vault** is a
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
  if backing off          -> skip (failed recently; see below)
  due     = lastBackupAt is null or now - lastBackupAt >= interval(frequency)
  if not due              -> skip (not due)
  changed = currentVaultHash != lastVaultHash
  if not changed          -> skip (unchanged)
  -> run
```

A due-but-unchanged vault is skipped: the previous backup already captures the
current state. On upload failure `lastBackupAt` is not advanced, so it stays due
and retries, surfacing the error in the UI.

**Retry backoff.** "Stays due" on its own means *due at every trigger*, which on the desktop's
five-minute tick is twelve authentication attempts an hour, unattended, for as long as a
credential stays wrong. Providers notice: Nextcloud throttles an account after enough failed
sign-ins from one address, so an unbounded retry loop manufactures a lockout that outlives the
correction, and the WebDAV client's `reason()` already has to explain that to the user.

So a failure also stamps `failedAt` and increments `failures`, and `isDue` holds the target off
for `retryDelayMs(failures, frequency)`: doubling from fifteen minutes, **capped at the target's
own interval**. The cap is the part that matters, since it means a backoff can never stretch a
daily backup into a weekly one however long it has been failing; a daily target that cannot
authenticate settles at one attempt a day rather than 288.

Four things deliberately do not back off:

- **A skipped target.** A locked vault produces no outcome at all, so it never counts as a
  failure. Backing it off would delay the very run it is waiting for.
- **"Back up now."** It bypasses the whole decision rule, so the escape hatch stays available
  at any point in a backoff.
- **An edited target.** `clearBackoff` runs on every edit and on a frequency change, because the
  edit is usually the fix, and a corrected password that sits out an accumulated backoff looks
  like it did not work.
- **An interrupted transfer.** On mobile the OS can cut an upload off when the app is left (see
  [Leaving the app mid-upload](#leaving-the-app-mid-upload)). Nothing refused it, so it is
  recorded as `transfer/interrupted` rather than as a failure, and the target is due at the next
  chance whatever its interval, which is what makes "it will run again next time you open
  Bramble" true. An interruption of a vault the target already holds is not recorded at all,
  since nothing was lost.

A success clears the counter along with the error. Both fields are optional and absent until a
target first fails, so an older stored list reads unchanged and an older build ignores them and
retries the way it always did.

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
  and never guaranteed. See [Mobile: backups without a
  scheduler](#mobile-backups-without-a-scheduler).
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

**A snapshot name only ever appears on a complete file.** Many WebDAV servers write a PUT in
place, so an upload cut off partway would leave a truncated file named exactly like a good backup,
which the prune would count toward keep-last-N and nothing would flag until a restore failed on
it. WebDAV therefore writes to a hidden temporary beside the snapshot (`.<name>.partial`) and
`MOVE`s it into place, which is atomic within one server, deleting the temporary if either step
fails. An app killed between the two leaves the temporary behind, so the prune also sweeps this
vault's temporaries that the server dates as over an hour old; a younger one may be another
device's upload still in flight to the same folder. S3 needs none of this, since an object exists
only once the whole upload has arrived. Nextcloud stages uploads in a `.part` file of its own,
which is why testing against it never showed the problem.

### Restore

Restore takes either kind of backup file and tells them apart by their first bytes
(`VLT1` or a ZIP's `PK`), never by the name. A plain backup is written as the vault
unchanged. An archive's inner vault is written as the vault, then each attachment is
put into that vault's own store (see "Backups with attachments").

Restore never overwrites a vault: with none on the device the backup becomes the first
one and is unlocked; otherwise it is added as a new vault, left locked. It is not the
same path as importing a portable vault, which merges entries into the open vault, and
Import turns a full backup away and points at Restore. That split is deliberate: a user
recovering from a backup wants exactly the state in the file, as its own vault.

The decisions live in `core/backup/restore.ts` rather than in the screen, so they are
tested: `readPickedBackup` classifies the file, and `commitRestore` runs once the password
is verified, in a fixed order (record, vault, attachments, unlock) so the restored vault
never opens with its files missing.

### Backups with attachments

A vault with [file attachments](file-attachments.md) is backed up as **one
self-contained file**: a ZIP holding `vault.bramble` (the same bytes a plain backup
has) plus `blobs/<hash>` for each attachment. One file restores everything, with
nothing else to reach, which is the property a backup exists for. Code:
`core/backup/archive.ts` and `core/backup/zip.ts`.

**A backup is the whole vault, or it is not made.** There is no size limit and no
partial backup. An earlier version capped backups at 100 MB and, over it or with files
missing, uploaded the vault without them and said so in amber. A backup that looks like
one and is not is worse than none, so that is gone, and the rule now is to scale or to
refuse loudly, never to drop data quietly.

- **A vault without attachments is unchanged.** It is backed up as its raw blob, byte
  for byte, fingerprinted with the same hash the runners always stored, so no target
  re-uploads because the code changed, and older builds still restore those files.
- **Still `.bramble`.** The ZIP keeps the extension, the way `.1pux` is a ZIP with its
  own, so the snapshot names the prune matches and the file-picker filters keep working.
  Anyone can rename one to `.zip` and look inside; `unzip -t` and Python's zipfile
  accept it, CRCs included.
- **Our own ZIP, laid out rather than built.** Stored entries only (everything inside is
  ciphertext, which does not compress), a fixed DOS timestamp so identical content packs
  to identical bytes, and ZIP64 exactly where a size or offset needs it. The archive is a
  list of parts, header bytes in memory and references into the blob store, read on
  demand: its size is exact before anything is read, and no platform ever holds it
  whole. fflate is not used for this because both its halves hold the archive in memory.
- **Which attachments go in** is read from the vault's own manifest, so a deleted
  attachment whose file has not been collected yet never rides along.
- **When a backup cannot be whole, it waits.** `planBackup` sets `blocked`:
  - `missing`: the vault lists files this device does not hold (they have not arrived
    from another device yet).
  - `locked`: the list is sealed and no key in hand opens it.

  The runner then uploads nothing, marks each due target `waiting` with the reason, shown
  in amber under the last backup, and leaves it due; the next backup that is made clears
  it. Waiting is not failing, so it never feeds the retry backoff. "Export a backup" and
  "Back up now" refuse the same way, with the same reason.
- **A locked vault is planned from a cached list.** Each plan that can read the list
  stores it (`backup.attachments:<vaultId>`, just the blob hashes, which already name the
  files on this device's disk) with the hash of the vault bytes it was read from. While
  locked, a list cached for those exact bytes stands in: no write reaches a vault without
  its key, so it is exactly right. Anything else waits for an unlock. An empty store says
  nothing on its own, because synced records can name files that never arrived; treating
  it as "no attachments" would upload a vault without them.
- **Every writer packs the same way.** The scheduled runner, "Back up now" and "Export a
  backup" all go through `planBackup` and store the same fingerprint (the vault's hash
  plus the attachment hashes), so a manual backup is not followed by a redundant
  scheduled one. `backupPlanner` keeps one plan per vault per run, so the fingerprint,
  the wait and the upload describe the same file and the archive is laid out once.
- **Deciding reads no attachment.** The fingerprint comes from hashes; only laying out
  the archive reads each attachment, once, for its CRC.

**Uploading one of any size.** Every provider takes a body read on demand
(`BackupUpload`), and anything from one part (`PART_SIZE`, 16 MB) up goes up in pieces
that each fit one request:

- **S3** uses a multipart upload. The object exists only once completed, so it is as
  atomic as one PUT. The completion's ETags come from the server's own ListParts rather
  than from response headers, which no transport returns, and that list is checked
  against what was sent, so a part the server lost stops the completion. On any failure
  the upload is aborted, and `sweepIncomplete` aborts this vault's stale ones during the
  prune, since an abandoned multipart upload holds storage the user pays for but cannot
  see. MinIO sends ETags with `&#34;` for their quotes, which the parser leaves as is;
  they are decoded before they go back (the real-server test caught this).
- **Dropbox** uses an upload session (start, append in parts, finish with the commit).
  The file appears only at the commit, and Dropbox expires abandoned sessions itself.
- **WebDAV** has no standard way to upload in parts, so a large backup is one PUT whose
  body the transport streams (see `HttpBodySource` in `core/adapters/http.ts`). Before the
  temporary file is moved into place its stored size is checked with a PROPFIND, so a
  server that took a short body without complaint never gets a snapshot out of it.

**Restoring one of any size.** The picked file is read in slices (`fileSource`): the
vault and the ZIP directory up front, then each attachment streamed into the restored
vault's store in 1 MiB reads, verified by an incremental SHA-256 (`createBlobHasher`,
`@noble/hashes`) rather than one that buffers the file. The reader is strict, because a
backup is untrusted input: only `vault.bramble` and `blobs/<64 lowercase hex>`, no
duplicates, stored entries whose local headers agree with the directory, no entries
whose bytes overlap, no comment, and the vault's CRC must match. The archive itself
needs no trust: the vault authenticates itself, and each attachment is re-hashed
against its name as it is stored, so no vault key is involved. A tampered archive can
fail an attachment, and the restore then says so; it cannot deliver wrong data.

**Per platform**, the parts no shared code can do:

- **Extension.** Chrome ends a service worker whose `fetch()` response takes over 30
  seconds or whose one call takes over 5 minutes, and a large upload does both. So the
  scheduled runner sends from the offscreen document instead (`http-host.ts`,
  `background/host-http.ts`): each request is a job started with one message and polled
  with more, so no message waits on the upload, and each poll is an extension API call
  that keeps the worker alive meanwhile. Bodies cross as a Blob in the IndexedDB handoff
  store. Exports are assembled into a Blob a chunk at a time and downloaded.
- **Desktop.** Large bodies cross the IPC in raw chunks into a sink in the shell
  (`src-tauri/src/stream.rs`): a request whose body reads from a bounded channel, or an
  export written beside the chosen file and renamed into place only once it holds every
  byte. The upload's length is declared rather than chunked, since some WebDAV servers
  refuse a chunked PUT, and its timeout scales with the size.
- **Mobile.** Reads go native (`readFileRange`), since Capacitor's Filesystem only reads
  whole files. A large body is spooled to a cache file a chunk at a time and sent from it
  natively (`sendFile`), with the file's length declared.

Tested against real servers, not only against mocks: the provider integration suite
(`BRAMBLE_IT=1`, `docker compose up -d`) uploads past one part to MinIO and Nextcloud
and reads it back, and `e2e/extension/backup-attachments-servers.spec.ts` attaches 120 MB
to a vault, lets the scheduled run back it up from the background to each server, reads
the result back with `mc` and `curl`, checks it with `unzip -t`, restores it, and opens
the attachments byte for byte.

The extension's runner can reach a locked vault's targets too, on credentials wrapped under
another unlocked vault's key (the device-global list they were migrated from). A locked vault
holding attachments is planned from its cached list there, or waits, as on desktop below.

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
  A request with a body goes through `backup_send_raw` instead: the body as raw
  IPC bytes, the rest of the request base64'd JSON in an `x-bramble-request`
  header. Tauri's JSON IPC would carry the body as an array of numbers, several
  hundred megabytes of JSON for one part. A body too large for one call (a large
  WebDAV backup) streams through `backup_stream_open` instead; see "Backups with
  attachments".
- **Locked vaults are planned from a cached list.** Which attachments go in is
  sealed in the payload, so a locked vault's list cannot be read. The list cached
  at its last unlock stands in while the vault's bytes are unchanged; without one
  the vault waits for an unlock rather than going up alone (see "Backups with
  attachments"). A backup made while locked is as complete as one made unlocked.
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
construction is provider-side scope, and the setup form now says so per provider
rather than leaving it here (`ScopeHint`).

**Append-only is the version of that which actually matters.** Of the three
things a stolen credential can do, reading is a marginal gain over the local
vault file it could already read, and running up a storage bill is an
inconvenience. Deleting is the one that costs something irreplaceable: it is not
bounded by the master password the way everything else is, it survives wiping
the machine, and destroying backups before encrypting anything is the documented
ransomware playbook. Bramble asks for `DELETE` for exactly one reason, keep-N
retention, so **Keep everything** gives it up: `selectForPruning` returns nothing
and `runBackup` never lists or deletes, which lets the user hand over a
credential with neither permission.

That reading of `keep` needed a guard. `slice(0)` is every element, so before
this, `keep: 0` selected *every snapshot* for deletion; it was safe only because
the select offered 5/10/30/100 and nothing could reach it. Repurposing the value
without `if (keep <= 0) return []` would have shipped a backup-destroyer.

A tightened credential also has to not look like a breakage, which it does not:
a keep-N target whose provider refuses `DELETE` still backs up, and one that
refuses `LIST` does too, because pruning is already non-fatal. Pinned by tests,
since that is the sort of tolerance a later refactor removes without noticing.

**WebDAV cannot be scoped, and that is the honest answer.** A Nextcloud app
password is account-wide by construction: it reaches every file in the account,
not just the backup folder, and no permission exists to narrow it. So the
containment is a *separate account* used only for backups, which is what the
form recommends. Two partial measures are worth knowing and neither is a
substitute: a server admin can deny `DELETE` over WebDAV for a group with the
Files access control app, which gets the append-only property from the server
side instead of the credential; and Nextcloud's trash and versioning make a
delete recoverable for a while, though the same app password can empty the trash,
so it is a speed bump rather than a barrier.

### Starting with the session

The schedule is a timer in this process, so every claim above is conditional on the app running.
On a machine that gets rebooted and then used through the browser extension all week, a daily
backup is not a daily backup. So the desktop app can start at login, and Settings, General carries
a toggle for it: **Start Bramble at login**, phrased by what it buys rather than by what it does.

On macOS a launch agent the app writes itself (below), and elsewhere `tauri-plugin-autostart` over
the `auto-launch` crate, which means a `Run` registry value on Windows and an XDG
`~/.config/autostart` entry on Linux. XDG rather than a systemd user unit deliberately: this is a
tray app, and an XDG entry starts once the graphical session exists where a user unit wanting
`default.target` can come up with no display to render into. The TPM tier above is the reason that
will need revisiting.

The plugin records `current_exe()` and has no way to name anything else. Under Nix that is
`.bramble-desktop-wrapped`, which started directly misses the environment `wrapGAppsHook3` sets: no
TLS backend for WebKit, no loader for the tray icon (#108). So the Nix wrapper sets
`BRAMBLE_LAUNCHER` to itself, and when that is an absolute path the app repairs the entry the
plugin wrote: `autostart_set_enabled` does it right after the plugin enables, and every launch does
the same for an entry an earlier build or version left. The repair swaps the program on the
`Exec=` line in place, keeping any key a desktop added to switch the entry off, and reads the file
where auto-launch writes it (`$HOME/.config/autostart/Bramble.desktop`, which ignores
`XDG_CONFIG_HOME`). Without the variable the repair does nothing. The path is still a store path,
so after an upgrade the entry starts the old version until the new one is launched once, and
nothing if the old path was collected first.

**macOS writes its own agent, so System Settings names the app** (#138). The plugin's was
`~/Library/LaunchAgents/Bramble.plist` holding only `Label`, `ProgramArguments` and `RunAtLoad`,
and Login Items & Extensions listed it under the signing team, "Webvana Inc.", with a generic
icon; the notification on enabling said "Software from 'Webvana Inc.'" as well.
`launchd.plist(5)` says an app installing a legacy plist should name its bundle identifier in
`AssociatedBundleIdentifiers`, but adding the key to that file was not enough. Tested by hand on
macOS 26.6 against the signed 0.13.0, reading the records with `sfltool dumpbtm`:

- macOS keeps one record per label and picks its parent the first time it sees the plist. It does
  read a later edit (the record's generation goes up and it gains the bundle id), but the parent
  stays: the key turned the generic icon into the app's, still under "Webvana Inc.".
- Deleting the plist and writing it again under the same label reuses that record, parent and all.
- An unseen label written with the key in a single write is filed under the app, and the
  notification says "Bramble.app" can run in the background.
- A deleted agent's record outlives its file for a while, then goes.

So the agent is labelled with the bundle identifier and lives at `app.bramble.desktop.plist`,
written whole by `autostart_set_enabled`, key included. Every launch moves a `Bramble.plist` the
plugin left to the new label, starting the same program, and deletes it; one that does not parse
is kept and logged. Switching off removes both. The plugin stays on Windows and Linux. The move
makes a new record, which comes up enabled even where someone switched the old one off in System
Settings and left the in-app toggle on. The toggle only ever reflected whether the file exists, so
the two already disagreed, and the move announces itself with the same notification.

Status: each step above was tested by hand; a signed build doing the move end to end has not been.

The registered entry passes `--hidden`, and the main window is configured `visible: false` so an
ordinary launch shows it explicitly and a login launch never flashes one. That inverts the usual
arrangement, so the show/hide decision is the first thing `setup` does, before anything fallible:
a failure between window creation and that call would otherwise leave the app running with no
window at all.

**The state is the OS's, not a pref.** A login item is user-visible and removable outside the app,
so `useAutostart` asks rather than stores, and asks again after every write instead of trusting
it. Unknown (`null`) is a real state, distinct from off: the toggle disables rather than guessing,
because guessing "off" invites a second write of an entry that already exists. The hook shares
state between instances, since two Settings sections offer this at once and per-instance state
would leave one asserting the opposite of the other.

**Setting up a backup suggests it.** The Backups section shows a prompt when a target is scheduled
and autostart is off, because that is the moment the connection between the two is obvious and the
user is already thinking about it. It is dismissible (`pref.autostartPromptDismissed`): leaving the
machine on is a perfectly good reason to decline, and a suggestion that cannot be silenced is a
nag.

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

**~~A TPM-sealed fourth tier on Linux.~~ Abandoned; the idea does not work, and the reason is
worth keeping.** The plan was `LoadCredentialEncrypted=` in a systemd **user** unit, handing the
app a secret sealed to the TPM with no keyring daemon involved. Three things kill it, checked on
Debian 13 with systemd 257 and a real TPM2 rather than reasoned about:

1. **User-scoped credentials cannot use the TPM at all.**
   `systemd-creds --user --with-key=tpm2` answers `Selected key not available in --uid= scoped
   mode, refusing.` That is a scope rule, not a permission problem: it refuses before it ever
   touches `/dev/tpmrm0`.
2. **A user-scoped credential is not secret from the user's own processes.** `systemd-creds --user
   decrypt` succeeds from any plain shell, and there is no per-user secret file behind it; the man
   page says the key incorporates "the selected user's numeric UID and username, as well as the
   system's machine-id", all of which any local process can read. It resists a file copied to
   another machine, and nothing else.
3. **System scope is where the TPM lives, and it is out of reach.** Encrypting needs
   `/var/lib/systemd/credential.secret`, which is `-r-------- root root`, and the credential is
   delivered to a *system* unit running as a system user. A GUI tray app in the user's session
   cannot be one.

Even granting all three, there is a fourth problem that is not systemd's: for an **unattended**
backup, whatever unseals the secret has to be available to the process with no user present, so
anything the app can do, code running as the app's user can also do. TPM sealing moves "readable
from a stolen disk" to "readable only on this machine" — which is what the Secret Service tier
already gives, and what full-disk encryption largely gives on top. It does not touch the threat
this tier was supposed to address.

So the Linux ladder stops where it is, and the honest mitigation is not a stronger box for the key
but a **weaker key**: see the provider-side scoping note in [The trade, stated
plainly](#the-trade-stated-plainly). Bounding what a stolen credential can do beats trying to hide
it from a process that runs as its owner.

**One assumption the UI relies on that is still unverified on hardware.** `secure_store`'s tier 2
links keys into the session AND the per-UID persistent keyring, which the crate documents as
surviving a logout subject to an expiry timer
(`/proc/sys/kernel/keys/persistent_keyring_expiry`, typically three days, refreshed on access).
The card says "Backs up on schedule" on the strength of that. Check it on a real session: generate
a target, log out, log back in, confirm the scheduler still runs before a reboot.

*(The other one, where `externalBin` lands in a Debian package, is settled: `test:apt` asserts
`/usr/bin/bramble-proxy` on Debian 12 and Ubuntu 22.04, `test:nix` asserts the same sibling in the
Nix store, and the shipped macOS disk image carries it at `Contents/MacOS/bramble-proxy`.)*

**Run at last, and both pass.** Bring the stack up with `docker compose up -d`, then:

- `BRAMBLE_IT=1 pnpm --filter @vault/core exec vitest run providers.integration` — 6 passing.
  The round trip, keep-N against the server's own listing, and **two vaults sharing one folder
  staying out of each other's retention**, against real Nextcloud and real MinIO. That last one is
  the finding from the security review, now covered against servers rather than a fake.
- `cargo test -- --ignored` in `clients/desktop/src-tauri` — 1 passing. The Rust SigV4 signer
  against MinIO, which validates strictly, for PUT, a byte-identical GET, and DELETE. Our vectors
  only ever proved the two signers agreed with each other; this proves the desktop's agrees with a
  server, and it is the whole desktop S3 path end to end apart from the UI.

**And the locked run is verified.** On KDE Plasma 6 (Wayland, Debian 13), with both vaults
**locked**, one tick at 01:53:25 uploaded a snapshot for each, into the same folder, with each
vault's own key tag, and folded the run state back per vault. That is the claim the whole desktop
credential design exists to support — credentials in the OS store rather than under the master
password, so a schedule can be kept by a process nobody is watching — and it had never been
observed before.

The same run settled the review's HIGH finding in the field rather than only in tests: with a
keep of 5, one vault uploaded seven snapshots and pruned to five while leaving the other vault's
two alone, in a shared folder.

### Testing the scheduler without being fooled by it

Both of us got this wrong once, so it is worth stating. A scheduled run needs **two** gates open,
and a target that has just backed up has neither:

- **Due**: `now - lastBackupAt >= interval`. The shortest frequency is daily, so a target that ran
  a minute ago is not due for 24 hours.
- **Changed**: the vault's hash must differ from `lastVaultHash`. An unchanged vault is skipped,
  because the previous snapshot already captures it.

A test that ignores this sees nothing happen and reads it as a broken scheduler. To make a target
due immediately, close the app (it rewrites `meta.json` on exit) and clear both fields:

```bash
python3 - <<'EOF'
import json
p = "~/.local/share/app.bramble.desktop/meta.json"  # expand it
m = json.load(open(p))
for k, v in m.items():
    if k.startswith("backup.targets"):
        for t in v:
            t.pop("lastBackupAt", None)
            t.pop("lastVaultHash", None)
json.dump(m, open(p, "w"))
EOF
```

**"Back up now" is not a way to test any of this.** It deliberately bypasses due, changed, *and*
the retry backoff, so it will happily run a target that the scheduler is correctly refusing to.

Count snapshots per vault, never per bucket: two vaults share a folder by default, so a whole
bucket count makes a passing prune look like a failure.

```bash
docker run --rm --network host --entrypoint sh minio/mc -c \
  'mc alias set l http://localhost:9000 bramble bramble-test-secret >/dev/null && mc ls -r l/bramble-test' \
  | awk '{print $NF}' | sed 's/.*-v/v/;s/\.bramble//' | sort | uniq -c
```

Finally, every tick now writes one line to the app log
(`~/.local/share/app.bramble.desktop/logs/bramble.log`), including the ticks that do nothing.
Before that, the run happened in the webview and reported only to a console nobody could read, so
"nothing was due" and "the scheduler never ran" were indistinguishable from outside — which is a
bad property for a feature whose whole promise is that it works while you are not looking.

*(`apt install bramble` from `apt.bramble.sh` on a clean machine is done, and is now
`pnpm run test:apt`.)*

**Dropbox on desktop.** The OAuth connect is extension-only (`shell.connectBackupOAuth`), so the
desktop shows the S3 and WebDAV tiles and hides one-click sign-in.

**The extension's cross-vault credential fallback is temporary by design.** `decryptSecrets` tries
every resident vek because targets migrated off the device-global list were wrapped under whichever
vault happened to be active then. Once those have aged out (every migrated target re-saved, or
gone), it should be narrowed to the owning vault, which is what a per-vault model should mean.

**arm64 packages.** amd64 only, like Signal. The build container takes `--platform`, so this is a
runner or an emulated build rather than new code.

## Mobile: backups without a scheduler

**Mobile now ships** (`cloudBackup: true`), and the question this paragraph used to ask has an
answer: a Capacitor webview cannot reach an arbitrary provider, so it needed a native transport
after all. The extension's answer did not transfer, exactly as the warning here suspected.

What made it worth building is that the same transport was also the only thing standing between
the email-alias feature and two providers that send no CORS headers, so one native HTTP primitive
discharged both. It is `HttpTransport` (`@core/adapters/http`), implemented in Rust on the desktop
and as an in-house Capacitor plugin on iOS and Android; see docs/email-aliases.md for why neither
`CapacitorHttp` nor `HttpURLConnection` could be used.

Mobile splits the work differently from the desktop, and the split is the point. The desktop has
to do **both** halves in Rust, because its credentials live in the OS store and never enter the
webview. Mobile holds its credentials in the vault, so it signs in JS with the secret it just
unwrapped and sends only the bytes natively: `signingTransport(cfg, send)` in `@core/backup`.
That is why mobile provides no `BackupCredentialsAdapter` at all -- it has no credential store,
and the "no credential store" UI that adapter drives is for a Linux session missing Secret
Service, not for a phone.

**What mobile cannot promise is a schedule.** There is no background scheduler on either OS, so
`clients/mobile/src/backup.ts` runs on unlock and on resume, and the frequency setting means
"next time you open Bramble after this long" rather than a wall-clock time. Credentials stay
VEK-wrapped, so a run only happens while that vault is open.

**A lock mid-run is the normal case, not an edge.** Auto-lock fires when the app is backgrounded,
so the runner starts nothing new once locked (listing vaults and unwrapping a credential are
gated) but finishes and records what is already in hand: an upload whose credential was unwrapped
before the lock completes, and its outcome is saved. Reading and saving the target list have to
stay ungated together. The runner re-reads the list after uploading and saves a merged copy, so a
gated read beside an ungated save would write an empty list and delete every target;
`backup.lock.test.ts` drives the real core runner, not a mock, to catch exactly that pairing.

**Automatic runs show on the settings screen.** The runner reports what it is uploading through
the optional `backupActivity` adapter, and mobile storage implements `subscribeMeta`, so an open
settings screen shows "Backing up" for a run it did not start, disables Back up now while it
runs, and shows the result without being reopened.

### Leaving the app mid-upload

iOS suspends a backgrounded app within seconds, which froze an upload partway and surfaced later
as a network error nobody could explain. Each native request now asks for background time
(`beginBackgroundTask`), so an upload that fits in it finishes and is recorded. Measured on the
simulator, iOS granted about 27 seconds to a lone request and about 7 when several were running,
so this covers a typical vault, not a large one on a slow link.

When the time runs out the request is cancelled cleanly and rejected with code `interrupted`,
which the JS adapter turns into `TRANSFER_INTERRUPTED`. The settings screen then says so in amber,
not red, since nothing failed: "Interrupted: Bramble was closed before this backup was confirmed",
followed by "It will run again next time you open Bramble" (or, for a target set to Off, to tap
Back up now), with the time of the last complete backup beside it, which is what the reader
actually needs. The wording is "confirmed" rather than "finished" because the simulator showed
iOS cancelling its side of an upload whose bytes had already left, and the object landed anyway.
Bramble cannot tell the two apart and a retry is safe in both. The atomic WebDAV write above is
what makes a cut-off upload harmless to the snapshots already there.

An alias request cut off the same way may already have reached the provider, so it does not say
"could not reach the provider": it says Bramble was closed before the provider answered and to
check before trying again, since a blind retry could make a second alias.

**Android freezes a left app too**, just later and less politely. Measured on a Pixel 8 (Android
17), Bramble stays the "previous app" for about 60 seconds after Home, then drops to cached, and
the cached-apps freezer stops the process 10 seconds later, WebView included. Switching through
other apps gets it there sooner. A request frozen mid-flight is worse than one that fails: the
frozen time counts against its timeout, so when Bramble was reopened, a 1 MiB PUT the server had
stored (201 at 152 seconds) came back as `timeout`. A real backup would have recorded a failure,
backed off, and for WebDAV stopped between the upload and the `MOVE`.

So the Android plugin holds a foreground service (`TransferService`, type `dataSync`) while any
request is in flight, which exempts the process from the freezer. It is started as the request
begins, while Bramble is still in front, and lingers five seconds after the last one ends so the
several requests of one backup share it. Its notification is deferred, so a request that finishes
within ten seconds shows nothing, and on Android 13+ without the notification permission it shows
only in the Task Manager. A request that fails after Bramble was left with no service holding it
(the start was refused, or Android 15's six-hours-a-day `dataSync` budget ran out) is reported as
`interrupted`, the same as iOS.

The service keeps the *process*; it cannot keep the *page*. Chromium freezes a hidden WebView page
60 seconds after it is hidden (the `freeze` event fires at 63 seconds), regardless of process
state, and its opt-outs, Web Locks included, do not apply on mobile. So a request already in flight
finishes in the background, and whatever JavaScript comes next (a WebDAV `MOVE`, the prune,
recording the outcome) runs when Bramble is reopened. Nothing is mislabelled in between: the target
still reads as due, and a finished `.partial` waits beside the snapshots. If the process is killed
before then, nothing is recorded, the target stays due, and the prune later sweeps the temporary.

The Android plugin used to block while a request ran, and Capacitor runs every plugin method in the
app on one shared thread, so a two-minute upload held up every other native call (crypto,
storage, biometrics) for two minutes, in the foreground too. It now enqueues and resolves from
OkHttp's own threads, which is what the iOS half always did.

### Timeouts sized to the body

iOS's request timeout counts only data received, and nothing arrives while a body uploads.
Measured through a proxy throttling the upload direction, a 2 MiB upload that had sent 627 KB
and was still moving died at exactly 61 seconds under a flat 60-second limit. Android has a
milder form: OkHttp's read timer starts once the body is handed to the OS, which may still be
draining megabytes of it.

Both plugins therefore scale the idle limit to the body: 60 seconds plus the time to send it at an
8 KiB/s floor, slower than a poor 2G uplink. A request with little or no body keeps about a minute
to notice a stall; a 2 MiB vault gets about five. The same upload then completed after 121
seconds. iOS caps the whole request at an hour; Android's call limit is the larger of 600 seconds
and twice the idle limit.

Stall detection driven by upload progress cannot replace this, because iOS reports bytes handed to
the OS, not bytes that have left it, so a slow drain after the last write looks exactly like a
stall. The floor is a stated trade-off: below 8 KiB/s a large upload still times out, and since a
timeout cannot tell "never arrived" from "arrived but the answer did not", such a backup may land
while being reported as failed. It is retried either way, and the extra snapshot is pruned.

### Verification

**Verified on a Pixel 8 (September 2026)** against the repo's `docker-compose.yml`, tunnelled to the
phone with `adb reverse`, which is also why cleartext `http://localhost` worked there:

- **S3 to MinIO.** Signed in JS, sent over the native plugin, and accepted by a real SigV4
  validator. The object is a genuine sealed vault (`VLT1` header, same as the desktop's).
- **WebDAV to Nextcloud.** The backup folder did not exist, so the phone created it with `MKCOL`.
  That is the case the Android plugin's rule for request bodies (empty for every method except GET
  and HEAD) was written for.
- **The opportunistic run.** A target that had never run was added, then the vault was locked and
  unlocked with nothing else pressed: it uploaded by itself. The two targets already backed up on
  that same unlock were correctly left alone, so an unlock does not re-upload what is current.

**The same three on the iOS Simulator** (iOS 26.4), through the Swift `URLSession` plugin rather
than OkHttp. The simulator shares the Mac's network, so `localhost` reaches the containers with no
tunnel, and App Transport Security lets loopback cleartext through with no exception in the
Info.plist. S3 and WebDAV both landed as sealed vaults, `MKCOL` created the folder, and an unlock
uploaded the due target by itself while leaving the current ones alone.

**Leaving the app, on the same simulator**, with the throttling proxy in front of both containers
and Bramble sent to the background by launching Settings (`simctl launch booted
com.apple.Preferences`):

- An upload that fit in the background time finished while Bramble was in the background and was
  recorded on return.
- One that did not was recorded as interrupted with no failure count or backoff, both wordings
  (scheduled and Off) showed as written, and a lock and unlock retried it by itself and cleared
  the message.
- The 2 MiB timeout measurement above, before and after the fix.

These measure native behaviour. What JavaScript does while backgrounded could not be measured
reliably, because an attached Web Inspector may keep the WebContent process alive.

**Leaving the app, on the Pixel 8** (Android 17), through the same throttling proxy via `adb
reverse`, with a vault grown to 1.87 MB. "Back up now", then Home after two seconds: the service
started (`Background started FGS: Allowed ... uidState: TOP`), S3 landed at once, and both WebDAV
uploads finished while hidden, after 263 seconds at 8 KiB/s, with the process never frozen. The
page froze at 63 seconds, so each folder held a finished `.partial`; on reopening, both were moved
into place and all three targets recorded the new vault with no error, although auto-lock had
locked the vault by then. Without the service, the same kind of upload was frozen at 74 seconds and
reported `timeout` on return despite having landed.

Not yet verified: backups on a physical iPhone (a real device cannot reach the Mac's `localhost`
and would refuse cleartext to a LAN address, so it needs an HTTPS tunnel); Android's `interrupted`
path, which needs the service refused or its daily budget spent; and a resume, rather than an
unlock, as the trigger on either platform.

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

**Errors and limits.** A failed call carries Dropbox's own words: its `user_message`
(written for end users) when present, else its `error_summary` tag, so a target card reads
`Dropbox upload failed (409: path/insufficient_space)` rather than a bare status. A 429 waits
out `Retry-After`, or 1s, 2s, 4s without one, at most three times; a longer wait is left to
the next scheduled run.

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
