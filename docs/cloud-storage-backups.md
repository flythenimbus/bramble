# Cloud storage backups (planned)

Design note for the "scheduled cloud backups" feature flagged in the README:
Bramble periodically writes an encrypted backup to a storage provider the user
chooses, on a schedule the user sets. It records the mechanism (how and when a
backup runs, and why it needs no multi-device coordination) and which providers
to target, so the surface is decided before any code.

Fast-moving facts (provider API availability, SDK maturity) are dated **July
2026** and flagged where they may shift. Re-verify before building.

## The insight that shapes everything

A Bramble backup is already client-side-encrypted ciphertext: the exported
`.bramble` blob only opens with the master password, the same as a local export
(see `vault-format.md` and `encrypted-import.md`). The storage provider never
sees plaintext, whatever provider it is.

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

Backup configuration is **device-local**: a list of targets, each with its own
provider, credentials, and schedule. A vault can back up to several destinations
at once (say Drive daily, R2 weekly, Nextcloud monthly). It is stored the way
device preferences and sync endpoints already are, per-device under `backup.*`
keys, and is **never** placed in a sync payload. The P2P sync code is untouched:
no new wire field, no roster change, no synced settings record.

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

### Config and state (device-local)

A vault holds a list of targets under `backup.targets`; each carries its own
non-secret provider config, VEK-wrapped credentials, schedule, and run state:

```
backup.targets: BackupTargetConfig[]   // each:
  { id, providerId, provider: s3|webdav,
    endpoint, region, bucket, prefix | serverUrl, path,   // non-secret
    frequency: off|daily|weekly|monthly, keep,
    creds: { iv, ciphertext },          // VEK-wrapped secret credentials
    lastBackupAt, lastVaultHash, lastError? }             // per-target run state
```

Stored via the same per-device meta storage as `sync.relay` and the `pref.*`
values. "Back up now" fans out to every target; scheduling evaluates each target
independently.

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
Grandfather-father-son retention (hourly / daily / weekly / monthly) is a
possible later refinement.

### Restore

Restore already exists: creating a new vault lets the user select a `.bramble`
file to import, and a `.bramble` is the raw vault blob, so importing one is a
full restore. No new restore flow is needed for this feature.

### Helper text

Shown under the frequency selector (Lingui `<Trans>` in the shared Settings UI,
so run `pnpm i18n:extract` after wiring it):

> Backups are best-effort, not a fixed time. Bramble backs up at most once per
> {frequency}, the next time you unlock the extension after one is due, so how
> often backups actually happen depends on how often you open Bramble on this
> device. Unchanged vaults are skipped. Need one right now? Use Back up now.

Mobile swaps "unlock the extension" and "open Bramble on this device" for "open
the app".

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

## Dedicated providers worth naming

Only worth a bespoke integration if users ask for it and the API is clean.

| Provider | API (July 2026) | Verdict |
|---|---|---|
| pCloud | REST + OAuth2, official JS/PHP SDKs, Swiss | cleanest OAuth story of the privacy set |
| Filen | TS/Rust/Go SDKs, REST API, plus WebDAV + S3 gateways | best "private name with a first-class API"; already reachable via WebDAV/S3 |
| Internxt | open source, CLI + WebDAV + S3 gateway | already reachable via the two adapters |
| Storj | S3-compatible + native libuplink | already covered by S3 |
| MEGA | C++ SDK + JS/Python libs, E2EE | heavier and crypto-fiddly; skip unless demanded |

## Proton Drive: not yet

Historically no public API (people used the reverse-engineered Proton-API-Bridge
that rclone rides on). As of Jan 2026 Proton shipped an **official SDK in
preview** and is migrating its own clients onto it through 2026. Caveats: it is
preview (interface still changing), personal / non-commercial use only right now,
and a crypto-model migration is slated for late 2026 / early 2027. Not
production-safe this year. Revisit around 2027.

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
4. **OAuth consumer providers** (Dropbox, Google Drive, pCloud) for mainstream
   one-click users. Defer MEGA and Proton; note Proton as "planned once its SDK
   stabilizes".

Because the payload is already ciphertext, the user-facing promise (the provider
never sees anything readable) holds for every backend, not only the private ones.

## References

- Proton: [SDK preview](https://proton.me/blog/proton-drive-sdk-preview), [SDK update Jan 2026](https://proton.me/blog/drive-sdk-january-2026), [ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk), [Proton-API-Bridge](https://github.com/henrybear327/Proton-API-Bridge)
- [pCloud API docs](https://docs.pcloud.com/)
- [Filen (GitHub org)](https://github.com/FilenCloudDienste)
- [Internxt WebDAV / rclone](https://internxt.com/webdav-rclone)
- [MEGA C++ SDK](https://github.com/meganz/sdk)
- [Backblaze B2 S3-compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)
