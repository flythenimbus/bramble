# Multiple vaults plan: parallel vaults on one device

Plan for letting one install hold more than one vault side by side, and pick which
to unlock at launch. Handy for sharing a device between people, or walling off
separate sets of logins behind their own master passwords. Listed as a roadmap
item in the README.

Touches every layer that today assumes exactly one vault: storage
([storage.md](storage.md)), the vault format ([vault-format.md](vault-format.md)),
unlock ([auth-and-unlock.md](auth-and-unlock.md)), routing
([routing.md](routing.md)), sync ([p2p-sync.md](p2p-sync.md)), and mobile autofill
([autofill.md](autofill.md), [mobile-port.md](mobile-port.md)). Read those first;
this document only describes the deltas.

## Bottom line

- **A vault gets a local UUID and an optional local label, both kept outside the
  encrypted blob.** No vault-format change, no Rust change, no migration of the
  crypto path. This matches how security-key labels are already stored (in local
  metadata, keyed by slot id, never in the blob). The `groupKey` already gives a
  synced vault a portable cross-device identity, so an in-blob id buys little for a
  real compat cost (see [Why not an in-blob id](#why-not-an-in-blob-id)).
- **One vault is unlocked at a time.** The crypto adapter holds a single VEK and
  the mobile Rust core is a process-global singleton; rather than rework both, the
  active vault is swapped by locking and reselecting. This keeps `VaultProvider`
  largely intact. **Superseded on the extension (2026-07): vaults now unlock
  independently via a background per-vault VEK map, because the single global VEK
  was corrupting freshly created vaults. Mobile stays single-active. See
  [Per-vault VEK](#per-vault-vek).**
- **Sync runs only for the active (unlocked) vault in v1.** Merging a vault needs
  its VEK (the entries list is VEK-encrypted, not just the per-entry secrets), so
  "sync every vault in the background" would mean holding every vault's VEK in
  memory at once, a security regression. A vault catches up the moment you open it,
  which is already how mobile behaves. Scheduled cloud backups still cover every
  vault, because they copy the sealed blob and need no VEK.
- **One "primary vault" per device** is what mobile autofill serves, what biometric
  unlock is armed for, and what the picker pre-selects. Secondary vaults are
  password / security-key / recovery only until per-vault native caches are a
  fast-follow. **Superseded (2026-07): there is no primary vault. Autofill and
  biometric follow the active unlocked vault. See [Per-vault VEK](#per-vault-vek).**
- **Order of work:** core storage + registry first (no UI), then the create + pick
  UI, then per-vault sync, then mobile autofill / biometric, then per-vault
  backups. Each phase ships on its own.

## What single-vault looks like today

The choke points, so the deltas below have context:

- **One blob at a fixed key.** Extension `VAULT_BLOB_KEY = "vault-blob-b64"`
  (`packages/platform-extension/src/storage.ts`), mobile `VAULT_FILE = "vault.vlt1"`
  (`packages/platform-mobile/src/adapters/storage.ts`). The shared `StorageAdapter`
  (`packages/core/src/adapters/storage.ts`) is id-less by design: `readVaultBlob()`
  / `writeVaultBlob(blob)` take no identifier.
- **No vault identity anywhere.** The VLT1 header is `MAGIC + VERSION + slotCount`
  with no id, label, or timestamp (`packages/core/src/vault-format.ts`). A vault is
  identified purely by its storage location.
- **Flat global metadata.** `sync.group`, `sync.deviceKeypair`, `sync.signingKey`,
  `sync.deviceId`, `sync.relay`, `sync.iceUrl`, `sync.lastSyncedAt`, `backup.*`,
  `pref.*` are all un-namespaced, implicitly belonging to "the" vault.
- **Create overwrites.** `createVault` (`packages/core/src/hooks/useVault.tsx`)
  writes the fixed key with no "does a vault exist?" guard, after wiping sync
  identity via `resetSyncState`.
- **The router only arbitrates unlock vs unlocked.** `authRoute` (`/`) shows
  unlock; setup is out of band (`firstRun = !hasVault` in
  `screens/Auth/Auth.tsx`, `shell.openSetup()` opens `OptionsApp`).
- **One VEK, one sync session.** The crypto adapter holds a single VEK; the
  extension offscreen and mobile manager each hold a single sync session.

## Data model

### The registry (device-local, never in the blob)

A small registry in platform metadata is the source of truth for what vaults exist:

```
vault.registry   -> [{ id: uuid, label: string, createdAt: number }, ...]
vault.primaryId  -> uuid            // the primary vault (autofill / biometric / default pick)
```

Both are device-local preferences, not synced and not in any blob. The label lives
here (not in the header) for two reasons: the header is the one readable-at-rest
part of a vault, so a label there would leak vault names; and a label is a local
preference (a vault synced as "Work" on one device can be "Company" on another).

Label policy: labels are **optional** and **need not be unique** (the id
disambiguates). A vault with a blank label is displayed as "Vault N" by its position
in the list, resolved at render time rather than stored, so the fallback stays
correct as vaults are added and removed.

### Per-vault storage keys

Everything that belongs to a vault is namespaced by its id. Everything that is a
device setting stays global.

| Key (pre-namespacing) | Multi-vault | Scope |
|---|---|---|
| `vault-blob-b64` / `vault.vlt1` | `vault-blob-b64:<id>` / `vault-<id>.vlt1` | per vault |
| `vault-blob-backup-b64` / `vault.vlt1.bak` | `...:<id>` / `vault-<id>.vlt1.bak` | per vault |
| `sync.group` | `sync.group:<id>` | per vault |
| `sync.deviceKeypair` | `sync.deviceKeypair:<id>` | per vault |
| `sync.signingKey` | `sync.signingKey:<id>` | per vault |
| `sync.deviceId` | `sync.deviceId:<id>` | per vault |
| `sync.lastSyncedAt` | `sync.lastSyncedAt:<id>` | per vault |
| `backup.targets` / `backup.config` | `...:<id>` | per vault |
| `pref.biometricPasscodeFallback` | `pref.biometricPasscodeFallback:<id>` | per vault |
| `pref.biometricAutoPrompt` | `pref.biometricAutoPrompt:<id>` | per vault |
| `sync.relay` / `sync.iceUrl` | unchanged | device (signaling endpoints) |
| `pref.autoLockMinutes`, theme, locale | unchanged | device |
| `pref.securityKeyLabels` | unchanged (keyed by globally-unique slotId) | device |
| `vault.vek` (session VEK) | unchanged (one active vault) | device |

The two biometric prefs are per vault because they describe ONE vault's unlock gate,
not the device: the gate itself is a per-vault keychain item. They shipped flat, and a
second vault then opened already showing passcode fallback and unlock-on-open switched
on, having never been given either - after which the re-arm wrote that borrowed setting
into the second vault's gate. See docs/auth-and-unlock.md for the full invariant list.

Giving each vault its own `sync.deviceKeypair` / `sync.signingKey` / `sync.deviceId`
falls out of namespacing and is also the more private choice: a peer in vault A's
roster cannot correlate this device into vault B's roster. It matches the existing
reset-on-new-vault behavior, which already treats sync identity as belonging to one
vault.

### `StorageAdapter` changes

The id-less interface is the seam every platform implements, so the change starts
here. Add a registry surface and thread the id through blob I/O:

```
// registry
listVaults(): VaultMeta[]
createVaultRecord(label?: string): string      // allocates a uuid, registers it
renameVault(id: string, label: string): void
deleteVaultRecord(id: string): void
getPrimaryVaultId(): string | null
setPrimaryVaultId(id: string): void

// blob I/O, now per vault
hasAnyVault(): boolean
readVaultBlob(id: string): Uint8Array | null
writeVaultBlob(id: string, blob: Uint8Array): void
restoreVaultFromBackup(id: string): Uint8Array | null

// per-vault metadata helper, so sync/backup code stays readable
getVaultMeta(id: string, key: string): string | null
setVaultMeta(id: string, key: string, value: string): void
removeVaultMeta(id: string, key: string): void
```

Each platform adapter (extension, mobile) implements the namespacing and the
one-time migration (see [Migration](#migration)).

## Unlock UX: the vault picker

Drive the launch decision off vault count. `count === 1` must look exactly like
today, so single-vault users see no change.

- **0 vaults** -> setup (create the first vault), as today.
- **1 vault** -> that vault's unlock screen directly, no picker.
- **N vaults** -> a picker: one row per vault (label + created date), styled on the
  existing passkey picker (`choiceRow` in
  `packages/platform-extension/src/content/html/save-passkey-body.ts`, styles
  `.tp-choice` / `.tp-avatar` in `content/html/corner-styles.ts`), plus a "Create
  new vault" row (the passkey picker already has a "create new" row variant to copy)
  and a "Restore from backup" row. The primary vault is pre-highlighted / first.
  Vault labels are shown here, before any unlock; this is an accepted, deliberate
  choice (the labels are already device-local plaintext, and revealing that a vault
  named "Work" exists is not a meaningful leak).

Selecting a vault sets the active id and shows that vault's unlock screen, whose
method chips (password / security key / biometric / recovery) then reflect that
vault's slots. After unlock, `/vault` as today. A "Switch vault" action locks and
returns to the picker.

### Router and context

Extend the router context slice from `{ isLocked, ready, entries }` to also carry
`{ count, activeId }`. Add a `/select` route for the picker.

- `authRoute` (`/`): if `count > 1 && activeId == null` redirect to `/select`;
  else render unlock for the active / sole vault. Keep the documented hydration
  asymmetry: do **not** gate `authRoute` on `ready`, and make sure the new
  `/ <-> /select` pair cannot loop during the `(isLocked=false, ready=false)`
  mount window. Selection state must be part of the injected context and follow the
  same "context not ready, don't decide" rule (see [routing.md](routing.md)).
- `/select`: the picker. Selecting sets `activeId` in the registry provider and
  navigates to `/`.

A new `VaultRegistryProvider` sits above `VaultProvider` and owns the vault list,
`primaryId`, `activeId`, and the select / create / rename / delete actions.
`VaultProvider` consumes `activeId` and passes it into every storage call; when
`activeId` changes it reloads (`hasVault`, slots, `isLocked = true`,
`entries = []`). `useVault` stays almost as-is, just parameterized by the active id.

## Create, switch, delete

- **Create** allocates a new registry record and writes a fresh blob under
  `...:<newId>`, instead of overwriting. It must not touch any other vault's blob or
  sync state. The per-vault `resetSyncState` only clears the new vault's namespace.
  The first vault created becomes the primary by default.
- **Switch** = lock the active vault, clear `activeId`, go to `/select`.
- **Delete** is destructive and irreversible, and it only removes **this device's**
  copy: a synced copy on another device survives, and the UI must say so plainly so
  nobody reads delete as destroy-everywhere. Delete wipes that vault's blob, backup
  snapshot, and every `sync.*:<id>` key, removes the registry record, and if it was
  the last vault drops back to first-run setup.

  It must also erase everything else keyed to that vault, or the bytes are gone while
  readable copies of the contents and the key that opens them live on:
  - the mobile credential provider's mirror (`autofill.clearProviderData`). The App Group
    bundle + slot are a self-contained, master-password-openable copy of the vault, and
    they are NOT namespaced by id, so nothing else reclaims them. `clearIndex` does not
    do this: it is a no-op on iOS by design, since the mirror has to survive lock.
  - the biometric VEK item (`biometric.disable(id)`), which also drops the shared autofill
    mirror of that VEK. Otherwise the key outlives the data it opened.

  - its backup targets (`backup.targets:<id>`), which hold cloud credentials wrapped under
    the vek that just went away.

  All of it is best-effort (`.catch`): once the blob is erased the delete has to finish,
  so a failing native call can't strand a half-deleted vault. `primaryId` no longer exists.

  Known gap: on Android `KeepUnlockedStore`'s on-disk (Keystore-wrapped) VEK cache survives
  a delete. There is no `AutofillBridge` plugin on Android to route `clearProviderData` to,
  and `BiometricVaultPlugin.deleteSecret` clears only that vault's Keystore alias. Smaller
  than the iOS leak was (Android's service reads the vault file, so the entry data goes with
  the blob) but it is still key material outliving its vault. Needs a native entry point.

## Restore destination

Reachable from the setup flow and from Settings -> Data -> "Restore from backup". After
the backup password is verified (non-destructively, as today):

- **0 vaults (true first run):** restore fills the first vault and unlocks it in place
  (the un-suffixed legacy blob), with an optional label. Unchanged.
- **A vault already exists:** restore is added as a **new** vault (`createRecord(label)` +
  `writeVaultBlob(bytes, newId)`), created **locked**; the user opens it from the picker
  with the backup's password. It never overwrites an existing vault, and its sync identity
  is empty (namespaced keys don't exist yet), so no `resetSyncState` is called and other
  vaults' sync state is untouched.

**Shipped this way (safe subset).** The earlier plan offered "replace an existing vault
(choose which)" as an option; that destructive path is intentionally dropped for now, since
a stray restore silently overwriting the on-device vault was a real data-loss footgun (the
old `restore()` did an id-less `writeVaultBlob` -> primary + a wildcard `resetSyncState`).
"Replace a specific vault" can come back later as an explicit, warned choice. Backup files
carry no identity (no in-blob id), so the user's explicit action is the matching mechanism.

## Setup shell: one tabbed flow (create / restore / join)

`VaultSetup` (driven by `OptionsApp.SetupShell`) is a single tabbed flow used for BOTH first-run
(0 vaults) and add-a-vault (1+). The tabs are the same in both views - **Create new vault /
Restore from backup / Join a device** - and the only difference when adding is a vault-name field
and an "Add a vault" heading (`adding = vaults.length > 0`). Each tab renders its panel inline,
driven by a plain callback prop (`onCreate` / `onRestore` / `onJoin`); none swaps the page.

- **Dropped the old first-run "Open existing vault" tab.** It was a master-password form that
  decrypted the on-device blob (`unlock`), but it only ever appeared with 0 vaults - with 1+ the
  shell is already the add-a-vault view, which never had that tab - and with 0 vaults there is
  nothing on-device to unlock (`readDecodedBlob` just fails). The real "bring an existing vault"
  path is the `.bramble` restore. `VaultSetupMode` is now `"create" | "restore" | "join"` (no
  `"open"`); the dead `onUnlock` plumbing and `PasswordCard`'s unlock branches were removed. The
  "Point at your existing vault file" copy was misleading - `unlock` never picked a file. (a7f0a2b5)
- **"Restore from backup" is a real tab, not a page swap.** Its panel is an embedded `RestoreShell`
  rendered inline (an `embedded` prop drops the full-screen wrapper + its own header; `SetupHeader`
  supplies the title), so the header + tabs stay put - matching Create and Join. On success it
  bubbles `onRestored({ addedNew })` so the setup flow owns the terminal (a new "Vault added"
  screen for a restored-into-new locked vault, else "Vault unlocked"), consistent with
  create -> recovery-code and join -> connecting. `RestoreShell` is imported directly (not `lazy`):
  it only decodes a `.bramble` blob with deps already in this bundle, so a lazy fetch would just lag
  the primary tab; only the genuinely-heavy `ImportShell` (kdbx/csv parsers) stays lazy. The
  standalone `?screen=restore` path (Settings -> Data -> Restore) is unchanged - still full-screen
  with its own done screen. (e94c8827) The always-true `restore` capability that gated the setup
  `onRestore` prop + the Settings "Import a backup" row was removed as dead indirection (both are now
  unconditional; commit a04bcfc1).
- **"Join a device"** is a tab shown in every circumstance, on every platform (`canJoin = true`).
  Join is just "create a vault + pair into it", and creating a parallel vault is already offered, so
  gating join alone was inconsistent. On mobile the joined vault is single-active like any other
  (only the active vault syncs; it goes quiet in the background after a switch) - a UX caveat, not a
  breakage. The `perVaultSync` flag no longer hides this tab; it now only describes simultaneous
  multi-vault sync (extension). See
  [Join adds a vault instead of overwriting](#join-adds-a-vault-instead-of-overwriting).
- **Auth screen.** The "New to {app}? / Create new vault" prompt under the unlock form is hidden
  when `vaults.length > 1`: with multiple vaults the pre-unlock picker owns "create another vault",
  so the link there is redundant. Still shown for a single vault (no picker to fall back on).
  (20b9be96)

## Sync

The sync **engine** is already vault-agnostic and needs no change: signaling rooms
are derived from the `groupKey` (`deriveRoomId` in `sync/nostr.ts`), so different
vaults already land in different rooms and never cross-talk; the merge kernel
(`sync/merge.ts`, `sync/apply-remote.ts`) is a pure port-driven function; and core
sessions are handles, not singletons (`transport/peer-session.ts`). The work is all
in the persistence and host wiring around it.

### Active-vault-only in v1

Merging a vault requires its VEK. The per-entry secrets stay sealed through a
merge, but the **list** of entry envelopes is itself VEK-encrypted (the HLC stamps
ride under the VEK but outside the per-entry DEK, `vault-format.ts`), and the merge
must decrypt that outer layer to compare stamps and reseal the merged list
(`sync/entries-blob.ts`). That is why sync is torn down the instant a vault locks.

So syncing every enrolled vault in the background would mean holding every vault's
VEK resident, i.e. every vault effectively unlocked while the user opened one. That
is a security-model regression and collides with the single-VEK core (process-global
on mobile). The cost is not the sockets (one relay socket + one peer connection per
device + two timers per vault, all cheap and linear, and the relay socket could even
be multiplexed since the protocol already accepts multiple rooms). The cost is VEK
residency.

v1 therefore syncs only the active (unlocked) vault. Switching vaults tears down and
restarts the session on the new one. This is nearly free (today's single session,
re-pointed at the active id) and is already how mobile behaves (mobile only syncs a
vault while it is open, per [p2p-sync.md](p2p-sync.md)). A vault you do not open on a
device catches up the moment you open it. The implicit-backup promise is preserved
by scheduled cloud backups, which upload the sealed blob and need no VEK, so those
genuinely can run for every vault.

Continuous background-sync-all is a **later** project: it needs a separate per-vault
"sync key" that opens only the mergeable outer index without exposing entry secrets,
cached while the vault is otherwise locked. That is a real crypto/format change, out
of scope here.

### The seven sync keys, and which are per-vault

There are exactly seven `sync.*` metadata keys. Five are per-vault (they identify one
vault's group + this device's membership in it); two are device-global endpoints:

| Key | Holds | Per-vault? |
|---|---|---|
| `sync.group` | group key + roster | per-vault |
| `sync.lastSyncedAt` | last-reconcile timestamp | per-vault |
| `sync.deviceId` | this device's roster node id | per-vault |
| `sync.deviceKeypair` | Noise static keypair | per-vault |
| `sync.signingKey` | Ed25519 roster-signing keypair | per-vault |
| `sync.relay` | signaling relay URL | device-global |
| `sync.iceUrl` | ICE/TURN URL | device-global |

The three identity keys are semantically per-vault (they authenticate this device in one
vault's roster) but are stored flat today (extension: plaintext `chrome.storage.local`;
mobile: `deviceKeypair`/`signingKey` in the Keychain/Keystore secure store, the rest in
Preferences). `sync.relay` / `sync.iceUrl` stay flat.

### Namespacing: every vault by id, one-time copy migration

**Every** vault is addressed by id: its blob at `<base>:<id>`, its five `sync.*` keys at
`<base>:<id>`. `syncKeyFor(flatKey, vaultId)` (`packages/core/src/sync/sync-keys.ts`) always
returns `<flatKey>:<vaultId>`; `blobKeyFor(id)` always returns `<base>:<id>`. There is no
"legacy vault" special case and no `legacyBlobVaultId` in the registry.

A pre-namespacing single vault (blob + `sync.*` keys at the un-suffixed locations) is brought
into the namespace by a **one-time copy migration** in the storage adapter's `runMigration`
(`storage.ts` extension, `adapters/storage.ts` mobile). It **copies** the flat blob, its recovery
snapshot, and the five sync keys to their `:<id>` names, then writes the registry (the cutover),
then deletes the flat keys. A copy, never a move, so it is crash-safe under MV3's ~30s
service-worker deaths: an interrupt before the cutover just re-runs (the flat data is still
authoritative); after it, the flat keys are unread orphans that best-effort cleanup removes. It is
concurrency-safe (`copyFlatVaultToNamespaced` copies only values that still exist, so a racing
context can't clobber a namespaced key with null; and on the extension, where two UI documents can
race the first-run migration with separate per-context memos, every no-registry cutover write
re-checks for a registry a racing context published first and adopts it, so concurrent migrations
converge on one vault id instead of the loser clobbering the winner's registry - pinned by
deterministic racing-context tests in `storage.test.ts`) and value-preserving (byte-identical sync keys →
the device's Noise static / roster id / groupKey are unchanged → **peers keep recognizing it, no
re-pair**). An install already on the transitional layout is detected by raw-reading the retired
`legacyBlobVaultId` pointer (Zod strips it on a normal parse) and migrating the vault it names.
Runs identically on the extension (`chrome.storage.local`) and mobile (native filesystem +
Preferences). See the migration tests in `storage.test.ts` on both platforms.

### The active vault must reach the background

Today sync binds to the **primary** vault, because the port reads the blob with no id
(`vault-io.ts` `readVaultBlob()`/`writeVaultBlob()` -> `reg.primaryId`), and the background
has no notion of an active vault. For active-vault-only sync the background needs the
active vault id:

- **Extension:** the UI/background writes the active vault id into `chrome.storage.session`
  (alongside the VEK) on unlock, and clears it on lock. The background reads it in
  `maybeStartSync`, in `vault-io` (so the port reads/writes the *active* vault's blob), and
  when building the per-vault sync keys. The blob-change trigger (`background.ts` watches
  only the un-suffixed `VAULT_BLOB_KEY`) must also watch the active vault's namespaced key.
- **Mobile:** single webview context, so `sync-manager` can read the registry's active id
  directly; its `blobStore` (bound once to primary today) must read the active vault.
- On a **vault switch**, tear down the single session and restart it for the new active
  vault (nothing restarts it on switch today).

### Join adds a vault instead of overwriting

`joinGroup` currently overwrites the single blob (`useSyncEnrollment.ts:297`
`writeVaultBlob(...)`, id-omitted) and replaces the one `sync.group` (`:298-301`). Change
it, mirroring `createVault`, to: `createRecord(label?)` -> `newId`, `writeVaultBlob(bytes,
newId)`, and write the received group under `sync.group:<newId>`. **Dedup by groupKey:**
before creating a record, scan existing vaults' `sync.group` values for a matching
`groupKey` and merge into that vault instead. The pairing code carries only the `groupKey`
(no vault id/name), which is the sole cross-device vault identity, so it's the dedup key.
`rotateDeviceId` (`useVault.tsx:347`, clears the device-global `sync.deviceId`) becomes
per-vault (rotate the joining vault's `sync.deviceId:<newId>`), and the join must not call
`resetSyncState` (which would wipe other vaults' sync).

### The enrolled device is rostered in the host, not just the popup

The inviter adds a freshly-joined device to its **local** roster in the sync **host**
(`offscreen-core.ts` `addEnrolledToLocalRoster`, on `onEnrolled`), not only in the popup
(`useSyncEnrollment`'s enrolled handler). The popup path is fragile on **Firefox**: the sync
host runs in the background event page, kept alive through the enroll, but the popup closes
on focus loss and drops the `SYNC_EVENT('enrolled')` — so the roster write never lands where
the ongoing sync (also the event page) reads it via `syncLocalRoster`, and the reconnecting
joiner is rejected `not in roster` (`roster-sync.ts` `inRoster`), which then times out its
handshake. Chromium's persistent offscreen + reliably-open popup masked it. The host signs
the joiner's entry with the inviter's admission material (rides the invite as
`EnrollInviteMsg.admission`; the password already ships for the same-password check) and
merges it as a CRDT union, so it never revokes existing devices. It is idempotent with the
popup write (deterministic Ed25519 over the same canonical entry), which stays as the
UI-refresh path. Security-key inviters (no admission material) add the joiner unsigned,
tolerated through the phase-1 rollout. Landed `57944af1`.

### resetSyncState, per-vault

The extension's `resetSyncState` (`shell.ts:230`) wildcard-removes every `sync.*` key;
mobile's (`sync-manager.ts:341`) removes an explicit list plus the secure-store keys. Both
must scope to one vault's namespace, so creating or restoring a vault never disturbs
another vault's pairing. The device-management (roster) UI (`SyncConnectSection`) also
becomes per-vault: it shows the active vault's roster, not a global device list.

### Increment order

1. `syncKeyFor` helper + tests (naming foundation; changes nothing yet).
2. Active vault id shared to the background (session storage + unlock flow).
3. Thread the active vault into `vault-io` (blob) + the per-vault sync keys + the
   start triggers; restart sync on switch.
4. Per-vault device identity + `rotateDeviceId` + `resetSyncState` scoping.
5. Join = add a vault (createRecord in join, groupKey dedup).
6. Mobile parity (`sync-manager` + per-vault secure-store aliases).
7. Firefox event-page transport.

Each step keeps existing single-vault sync working (the grandfather keys and the
primary-vault default mean an un-migrated install behaves exactly as before).

**Increment 3 landed (extension).** Steps 1-3 are done: `syncKey`/`syncKeyFor`
namespaces the five per-vault keys (`sync.group`, `sync.lastSyncedAt`,
`sync.deviceId`, `sync.deviceKeypair`, `sync.signingKey`); `sync.relay` /
`sync.iceUrl` stay device-global. The extension background resolves the active vault
(`resolveSyncVault`: the session-recorded active vault, else the primary) and threads
it through the enrollment handlers, `maybeStartSync`, the merge port, and the four
bridge functions, and reads/writes that vault's blob. The unlock paths await
`setActiveVault` **before** the crypto unwrap, so the sync that kicks off on unlock
targets the right vault (the timing gotcha). Switch = lock (stopSync) + unlock
(maybeStartSync for the new vault), so no separate restart is needed. The legacy
vault keeps flat keys, so existing single-vault pairings are byte-identical.

Mobile is still primary-only (its `sync-manager` reads flat keys). To avoid a
half-wired enrollment there, the `perVaultSync` capability is extension-only, and
`SyncConnectSection` shows the "sync applies to your primary vault, coming soon" note
for a non-primary vault where `!perVaultSync`. Mobile parity is increment 6.

Verify on the two-profile + local-relay rig: pair vault 1 across two profiles, make a
vault 2 in both, pair vault 2, edit each independently, and confirm each vault's
devices/last-synced are its own and neither pairing disturbs the other.

## Mobile autofill and biometric

**LANDED (2026-07): per-vault biometric + active-vault-aware autofill blob read.** There is no
primary vault; autofill and biometric follow the **active** (single-active) vault, resolved the same
way sync does (`activeVaultId`: the app-recorded `meta:active-vault`, else the first registered
vault). What shipped:

- **Per-vault biometric cache.** The device biometric gate held one VEK, so enabling biometric on a
  second vault silently overwrote the first's cached VEK. Now keyed by vault id end to end: the core
  `BiometricUnlock` interface takes a `vaultId` on every op; iOS stores each VEK under Keychain
  account `vek:<vaultId>` (`BiometricVault.swift`); Android under Keystore alias
  `bramble.biometric.vek:<vaultId>` + prefs `vek_ct:<vaultId>`/`vek_iv:<vaultId>`
  (`BiometricVaultPlugin.java`).
- **Migration blocker fixed (Android).** The namespacing migration (below) copies the flat
  `vault.vlt1` to `vault-<id>.vlt1` and **deletes the flat file** - but the AOSP autofill service read
  `filesDir/vault.vlt1` directly (`VaultReader.kt`), so every migrated Android install would fill
  nothing. `VaultReader` now resolves the active vault and reads `vault-<id>.vlt1`, with a flat
  pre-migration fallback (the service can fire before the app runs its one-time migration). It reads
  `meta:active-vault` / `meta:vault.registry` from the same `CapacitorStorage` prefs the webview
  writes (same UID, cross-process).
- **Autofill biometric read is per-vault (Android).** `BiometricUnlock.kt` (the service's read path)
  resolves the active vault and reads that vault's per-vault Keystore alias + prefs. No mirror is
  needed: the service runs in-app and can resolve the active vault. iOS *does* need a mirror - the
  extension runs out-of-process and can't resolve the active vault - so `setSecret` also writes the
  active vault's VEK to the un-suffixed `vek` account the extension reads (autofill follows the active
  vault); `deleteSecret` clears it.
- **iOS active-vault slot fix (commit 6b322b5c).** iOS autofill isn't hit by the Android blob-path
  blocker (its out-of-process extension reads the App Group *bundle* the app pushes via
  `mobileAutofill.setIndex`, not `vault.vlt1`), and the bundle entries + QuickType + biometric VEK
  already follow the active vault. The one gap: `readPasswordSlot()` (`adapters/autofill.ts`) read
  `readVaultBlob()` with no id -> defaulted to `vaults[0]`, so a multi-vault user whose active vault
  wasn't first got the active bundle paired with the *wrong* vault's slot -> master-password autofill
  unlock derived the wrong VEK (biometric still worked via the mirror). Now reads
  `getMeta(ACTIVE_VAULT_KEY)`; race-free because every unlock path awaits `shell.setActiveVault`
  before `loadEntries()`/`setIndex` (`useVault.tsx:581`). TS, so it's typechecked + built here.

Compat: existing biometric users re-enable once after this update (the old fixed-key cache is orphaned,
not migrated - re-keying a biometric-gated secret needs a live prompt). The existing stale-cache UX
handles this: biometric shows unavailable, they unlock with the master password, then re-enable.

**Device-verify still required** (Kotlin/Java/Swift are not built in CI here): per-vault
enable/unlock/disable on both platforms, autofill fill after a migration, and biometric autofill for
the active vault.

Full multi-vault autofill (search all vaults, label results by vault) is still a **Tier 2**
fast-follow - this is single-active (the service fills whichever vault the app is in), not
multi-vault-at-once.

---

The original v1 plan is kept below for context (superseded: active-vault, not primary-vault). Autofill
reads out of process from a fixed location (iOS App Group keys `autofill.bundle` / `autofill.slot` in
`BrambleConstants.swift`; Android `filesDir/vault.vlt1` via `VaultReader.kt`), and biometric cached
exactly one VEK globally. Nothing in the fill request carries a vault id, so a provider cannot know
which of several vaults to search.

v1 was originally scoped to keep this single-source shape by serving the **primary vault** only:

- Mobile autofill serves the primary vault. The app pushes the primary vault's
  bundle to the App Group (iOS) / keeps it at `vault.vlt1` (Android), as it does
  today for the sole vault. Biometric unlock is armed for the primary vault (the one
  global cached VEK belongs to it).
- The primary vault is chosen in mobile **Settings -> Autofill -> "Autofill vault"**
  (a single-select, shown only with 2+ vaults, defaulting to the sole / first
  vault), with a small "Primary" badge on that vault in the vault-management list so
  it is discoverable where vaults are managed.
- Confirm in this phase whether the autofill bundle can be repackaged from the
  sealed blob without the VEK. If it is built from decrypted entries (likely), then
  switching the primary to a vault never opened on that device requires unlocking it
  once to arm, so prompt "unlock once to enable autofill for this vault."

Framing this as a feature, not a limitation: the primary vault gets the conveniences
(system autofill, one-tap biometric), and secondary vaults are more locked down
(password / security key / recovery only). Full multi-vault autofill (search all
vaults, label results by vault, per-vault biometric and session caches via per-vault
Keychain items / Keystore aliases) is a native fast-follow, not v1.

## Migration

**LANDED (2026-07) as a single one-pass copy migration** - the whole build namespaces every
reader, so `runMigration` copies the pre-namespacing vault's blob + `sync.*` keys to their `:<id>`
names in one shot, cuts over, and cleans up. See
[Namespacing](#namespacing-every-vault-by-id-one-time-copy-migration). The staged reasoning below is
the original plan (when the per-vault readers were expected to land phase by phase); it is kept for
the rationale on why the moves are re-pair-free.

End state: **everything in the namespaced layout** (uniform, no permanent legacy
special-case), sync identity preserved so nobody has to re-pair. The migration was
originally planned **staged across the phases**, because moving a stored key
requires its readers to already be per-vault, and those land phase by phase. Moving
the `sync.*` keys before the sync code reads the namespaced keys (Phase 2) would break
the very pairing the migration is meant to preserve. So each phase migrates only what
its own code already handles.

This staging is a development ordering, not a release requirement. Whether the phases
ship as one release (the migration runs once and does everything, because that build
contains every reader) or as several (each release migrates only what its readers
handle) is a release-cadence choice. Every stage is local and wire-invisible, so an
updated device and a not-yet-updated device keep working either way, with no forced
re-pair.

Why the eventual moves are safe (and re-pair-free): a migration only renames local
storage keys, and that is invisible to the sync wire protocol. Rooms key off the
`groupKey`, peer authentication is the device's Noise / Ed25519 identity, and the
roster is a stored value; all are preserved by moving the key, not its value. So a
migrated device and a not-yet-updated device keep syncing, cross-device update skew is
a non-issue, and no re-pair fires. The migration is idempotent (it COPIES to the namespaced key
and cuts over via the registry write before deleting the un-suffixed one, so a crash re-migrates)
and must never call `resetSyncState` (that would discard the identity being preserved). This mirrors the
gesture-safe legacy File System Access migration in [storage.md](storage.md).

The stages:

- **Phase 0 (landed): register + grandfather the blob in place.** On first access, an
  idempotent, memoised migration detects the existing single vault (`vault-blob-b64` /
  `vault.vlt1`, or a not-yet-migrated legacy FSA handle on the extension), allocates a
  UUID, and registers it as the primary with a blank label. It **moves no bytes**: the
  first vault keeps the un-suffixed blob key (tracked by `legacyBlobVaultId`), so every
  current reader is untouched; only additional vaults are namespaced by id. A fresh
  install starts with an empty registry and bootstraps its first vault at the legacy
  key on first write. Code: `packages/core/src/vault/vault-registry.ts` (pure model),
  the extension and mobile `storage` adapters.
- **Phase 2: move the `sync.*` values** into `vault:<id>:sync.*`, together with the
  sync readers going per-vault. Verify on a real synced pair before release.
- **Phase 4: move the `backup.*` values** similarly, with the backup readers.
- **Finalise: move the primary blob** into the uniform namespace and clear
  `legacyBlobVaultId`, once every reader resolves the blob through the adapter (the
  extension's one direct `VAULT_BLOB_KEY` use is a `background.ts` change watcher).

One mobile wrinkle for the finalise step: the vault **file** path moves, and the
autofill readers use a fixed path (Android reads `vault.vlt1` directly,
`VaultReader.kt`). Point them at the **primary** vault's current path, so the mobile
file move ties to the autofill work (Phase 3) rather than a hardcoded filename.

## Why not an in-blob id

Considered and rejected for v1. Putting the UUID inside the blob costs two things a
local registry id avoids entirely.

- **Compat / rollout.** The blob is exported as `.bramble` and rebuilt verbatim
  during sync enrollment, and `decodeVaultBlob` throws on any version it does not
  recognize (`vault-format.ts`), with no forward tolerance. Bumping v2 -> v3 means a
  v3 vault that syncs or restores onto a not-yet-updated device hard-fails. Because
  the extension is publicly released and iOS/Android version independently, that
  needs a staged rollout: ship a release everywhere that accepts v3 but still writes
  v2, wait for it to propagate, then ship one that writes v3. Two releases times
  three platforms with a bake period. (The one escape hatch is riding an opaque
  "meta-slot" through the existing unknown-slot round-trip, which avoids the version
  bump but burns a slot and lands the id in the unauthenticated slot area.)
- **Crypto scrutiny.** Header integrity comes from the slot verifier,
  `HMAC-SHA256(KEK, magic_version || slot_id)` (`core-rust/src/lib.rs`,
  `compute_verifier`), where `magic_version` is `MAGIC || VERSION`. So MAGIC and
  VERSION are authenticated, but `slotCount` is not, and a new plaintext header field
  would not be either, so it would be malleable at rest. Authenticating it by folding
  it into `magic_version` changes the verifier for every existing vault (they were
  computed over the old 5-byte prefix), forcing a lazy on-unlock re-write of the slot
  through the most sensitive line of crypto in the codebase. Putting it in the
  encrypted region authenticates it for free but makes it unreadable before unlock,
  which defeats using it for the pre-unlock registry and picker.

Readable-before-unlock, authenticated, and no-migration: pick two. A local registry
id sidesteps the triangle, and the `groupKey` already gives synced vaults a portable,
authenticated cross-device identity, so an in-blob id can wait until (and if) backups
need to self-identify.

## Phased plan

Each phase is independently shippable.

- **Phase 0 (complete): storage + registry (no UI).** The pure registry model
  (`vault-registry.ts`), id-aware blob I/O on `StorageAdapter` (id omitted resolves to
  the primary), the extension and mobile adapters, the register-and-grandfather
  migration, and the active-vault-id threading (`VaultRegistryProvider` +
  `useVaultRegistry`; `VaultProvider` operates on the active vault through a
  vault-scoped storage wrapper, metadata stays device-global). Tested: registry model,
  migration, cross-vault isolation, and the registry provider. Per-vault metadata
  helpers are deferred to Phases 2/4 with the sync/backup readers that consume them.
- **Phase 1 (complete): create + picker + management.** `createVault` registers a new
  vault record and writes to its own id instead of overwriting (resetting sync only for
  the first vault on a device); `createRecord` / `clearSelection` / `rename` /
  `setPrimaryVault` / `remove` on the registry, which auto-selects only when a single
  vault exists; the `/select` route + `VaultPicker` (vault rows on the passkey template
  plus "Create new vault"), fed by a registry slice in the router context with
  exact-complement guards; a "choose a different vault" link on the unlock screen; and a
  Settings > General **Vaults** section (rename, set primary, delete with a
  local-only-copy warning, create, and switch-vault, which locks and returns to the
  picker). `StorageAdapter` gained a per-vault `deleteVaultBlob` (extension + mobile).
  Tested: headless picker guards (0/1/N, no `/ <-> /select` loop), registry actions, and
  `deleteVaultBlob`. The picker renders each vault as its own card, and the setup screen is
  registry-aware: first run keeps create / open / open-file, but adding a vault (vaults
  already exist) is create-only with an optional name field and no open-existing /
  open-file paths, which also removes the restore-overwrite footgun until Phase 4's
  destination chooser. Not yet runtime-verified end to end, and switch-vault may briefly
  flash the current vault's unlock screen before the picker (guard-driven navigation).
- **Phase 2: sync per-vault.** Namespace the `sync.*` keys; re-point the single
  session at the active vault; scope `resetSyncState` / `rotateDeviceId`;
  enrollment "join = add a vault" with `groupKey` dedup; per-vault roster UI. Verify
  on a real synced pair, including the migration.
- **Phase 3: mobile autofill + biometric.** Primary-vault selector in Settings; push
  the primary vault's bundle; confirm the arming-requires-unlock question. (Fast
  follow: full multi-vault autofill with per-vault native caches.)
- **Phase 4: per-vault backups + restore choice.** DONE. The restore-destination flow
  landed earlier (existing vault -> add a new one, never overwrite). Scheduled backups
  cover **every** vault, not just the primary: `runScheduledBackups` walks all registered
  vaults (the sealed blob needs no VEK) and uploads each as its own file. Each backup file
  is a standalone VLT1 blob, so restore opens one file -> one vault.

  Phase 4 first shipped with backup *targets* still device-global (one config backing up
  every vault), which turned out to be wrong in use: configuring Nextcloud in a personal
  vault silently configured a work vault with the same server, credentials and folder
  ([issue #49](https://github.com/flythenimbus/bramble/issues/49)). Targets are now per
  vault (`backup.targets:<id>`), as this document's key table always said. Consequences:
  - a target created in a vault writes to **exactly** the folder the user typed;
  - targets adopted from the old shared list are marked `sharedFolder` and keep the
    derived layout they already write to (default vault `<prefix>/`, every other vault the
    sibling `<prefix>-<id>/`, a sibling so keep-N retention on one can't sweep another);
  - the change-hash is per vault now, so editing one vault no longer re-snapshots them all
    (this closes the deferred redundancy noted here before);
  - a target's creds are wrapped under its own vault's vek, so a vault that is locked at
    run time is **skipped, not failed** (no `lastError`; it stays due). Migrated targets
    still decrypt under any resident vek, so existing setups keep their coverage. Removing
    the skip entirely is the deferred device-key wrap below.
  See [cloud-storage-backups.md](cloud-storage-backups.md) for the storage layout and the
  migration.

## Per-vault VEK

Added 2026-07 after a data-corruption bug. This **supersedes** two earlier decisions
on the extension: "one vault unlocked at a time" and "one primary vault." Mobile is
unchanged (still single-active). No Rust / Swift / Kotlin change.

### The corruption that forced it

Symptom: `aes decrypt: aead::Error` unlocking a freshly created vault, on **both** the
master password and the recovery code. Not sync, not p2p. Reproduced by: create a vault,
it unlocks by default, lock it, unlock fails. Other vaults kept working, and it was
intermittent (one new vault would be fine, the next corrupt).

`aead::Error` on both slots means the slots are fine but the **entries were sealed under
a different VEK than the slots wrap**: the two halves of the blob disagree. Root cause is
that the whole extension shares **one** VEK. It lives in the single offscreen WASM,
mirrored by the background's `cachedVek` and session `vault.vek`. `createVault` builds a
vault across **four** offscreen round-trips (`generate_vek`, `wrap_vek_password` for the
password slot, `wrap_vek_password` for the recovery slot, `encrypt_with_vek` for the
entries), and `sendToOffscreen` re-injects that one global VEK for the wrap/encrypt ops
(they are not on `skipKeyInjection`). If any second context (a popout window, the options
tab, a background op) swaps the global VEK between those round-trips, the slots get
wrapped under one key and the entries sealed under another. Unlock recovers the slot's
VEK and then fails to decrypt the entries. Timing-dependent, hence intermittent.

The same class is still latent in `receiveBundle` (join), restore, any entry-seal into an
empty vault, and generally any two views on different vaults fighting over the one VEK.

> The claim that "a non-empty vault self-guards because it decrypts before it re-encrypts"
> used to be wrong. `writeEntriesBlob` sealed the payload *first* and only then read the blob
> for its slot list, never decrypting what was already there. It is true now, but only where
> `verifyVekBeforeWrite` is set (mobile's sync store) — see [Mobile hardening](#mobile-hardening-issue-27).

A create-time self-verify guard (build, then confirm both slots decrypt the entries, else
rebuild) was written and then **reverted**: per-vault VEK removes the race structurally,
and the guard would only have masked bugs in the real fix.

### Decision

- **Independent per-vault unlock.** The background holds `Map<vaultId, vek>`, not one VEK.
  Vaults unlock and lock independently, so two views can hold different vaults open
  without colliding.
- **No primary vault.** Autofill and biometric follow the **active unlocked** vault, not a
  designated primary. (`primaryId` turns out to be effectively dead already, per
  [Surface area](#surface-area), so this mostly means "do not let it back into autofill.")
- **Extension-only, no native change.** The offscreen WASM and the mobile uniffi core stay
  single-VEK. Mobile stays single-active-vault. The vault id was described here as "threaded
  but ignored" on mobile; that was true of the *crypto* calls and remains so, but it is now
  load-bearing for **storage and sync routing** there — see
  [Mobile hardening](#mobile-hardening-issue-27). Ignoring it is what produced issue #27.
  The shared `CryptoAdapter` interface gains only one **optional** member
  (`withVault?(vaultId)`, extension-implemented); mobile code does not change.

### Mechanism: the VEK rides with the op

Every VEK-scoped `CRYPTO_*` message carries a **target vault id**; the background holds the
only durable key state in a `Map<vaultId, vek>`; the offscreen WASM's single VEK slot
becomes a per-op scratch register. No re-injection dance, no `offscreenHasKey`, and no
mutex, but the no-mutex claim holds only if the two rules below (single seam, synchronous
critical section) are followed exactly. An offscreen teardown/recreation no longer loses
anything (the offscreen retains nothing).

**Request envelope.** `vaultId` rides top-level next to `type`/`payload`:
`{ type, vaultId, payload }`. Only the background consumes it; the offscreen never reads it
(it receives key material instead). The six USE-VEK payload schemas
(`crypto/messages.ts`) gain an optional `vekB64` that the background injects and the
offscreen consumes. Views never send `vekB64`, and `extensionOnly` already keeps content
scripts off `CRYPTO_*` entirely (sec-audit A3), so the id adds no new attack surface; the
injected vek travels the same background-to-offscreen channel the old re-injection used.

**One seam injects and strips: `sendToOffscreen`.** This placement is load-bearing:
background modules (corner-prompt, passkey-store, autofill, backup, sync) call
`sendToOffscreen` directly and never pass through the router's `cryptoHandler`, so putting
the map logic in `cryptoHandler` would leave every background-internal op un-keyed. In
`sendToOffscreen`:

- USE-VEK op: look up the vek for `message.vaultId` and inject it as `payload.vekB64`;
  fail fast (`{ok:false, error:"vault locked"}`) with no offscreen trip when the map has
  no entry.
- SET-VEK op: forward untouched; on success cache the returned vek under
  `message.vaultId`, then rewrite the response so the vek never travels past the
  background (unwraps come back `{ok, vekB64}` and leave as the plain boolean callers
  expect).
- Map-only op: answer from the map with no offscreen trip.
- Anything else: pass through.

`cryptoHandler` (session.ts) keeps only the unlock/lock side effects (schedule auto-lock,
`maybeStartSync`, `runDueBackups`, lock-state broadcast), keyed off the already-stripped
result. Delete `offscreenHasKey`, `markOffscreenKey`, the re-injection block, and
`exportAndCacheVek` (the unwrap response now carries the vek, so the extra
`CRYPTO_EXPORT_VEK` round-trip after unlock goes away).

**The vek store.** New `background/vek-store.ts` (imports nothing from background modules,
so session.ts and offscreen-client.ts can both use it without a cycle): the in-memory map,
mirrored to `chrome.storage.session` as one key per vault, `vault.vek:<vaultId>` (per-vault
keys so a view can watch its own vault's key for lock signals), plus the MRU list
`vault.unlockedMru` and the existing `vault.activeId`. `sessionHydration` scans session
keys by prefix and rebuilds the map. **A bare legacy `vault.vek` key (left by the previous
build) is deleted, never attributed to a vault**: nothing records which vault it belonged
to, and guessing "the primary" would recreate the exact cross-key corruption this design
kills. Cost: one forced re-unlock after the update. (`chrome.storage.session` does not
survive a browser restart and all extension contexts update atomically at reload, so this
is the only state-skew case; there is no wire-version skew inside one build.)

**Op classes** (exact message types):

| Class | Messages | Background | Offscreen |
|---|---|---|---|
| USE-VEK | `CRYPTO_WRAP_PASSWORD_SLOT`, `CRYPTO_WRAP_WEBAUTHN_SLOT`, `CRYPTO_ENCRYPT`, `CRYPTO_DECRYPT`, `CRYPTO_ENCRYPT_OUTER`, `CRYPTO_DECRYPT_OUTER` | inject `payload.vekB64` from the map | load the provided vek, run the op, one synchronous section |
| SET-VEK | `CRYPTO_GENERATE_VEK`, `CRYPTO_UNWRAP_PASSWORD_SLOT`, `CRYPTO_UNWRAP_WEBAUTHN_SLOT`, `CRYPTO_ROTATE_VEK` | cache the returned vek under the id; strip it from the reply | run the op and return the vek (unwraps reply `{ok, vekB64}`) |
| Map-only | `CRYPTO_UNLOCK_WITH_VEK`, `CRYPTO_EXPORT_VEK`, `CRYPTO_IS_LOCKED` | answer from the map, no offscreen trip | n/a |
| Lock | `CRYPTO_LOCK` | remove that vault's entry (walk-away paths clear the whole map) | still forwarded once, to zeroize the scratch slot (it may hold the last-loaded vek) |
| VEK-independent | `CRYPTO_GENERATE_SALT`, `CRYPTO_GENERATE_SLOT_ID`, `CRYPTO_VERIFY_PASSWORD_SLOT`, `CRYPTO_VERIFY_WEBAUTHN_SLOT`, `CRYPTO_PASSKEY_MAKE`, `CRYPTO_PASSKEY_GET`, `CRYPTO_OPEN_KDBX` | pass through, no id required | unchanged |

Notes. `CRYPTO_UNLOCK_WITH_VEK` is map-only because the vek is already in the request (its
only live caller is core `biometric-unlock.ts`, mobile-only). `CRYPTO_ROTATE_VEK` has **no
live caller** (grep to confirm before trusting this); keep it wired as inject-old +
cache-new. `CRYPTO_EXPORT_VEK` still returns the raw vek to the calling view, as today
(the shared `CryptoAdapter` contract and mobile's biometric enable depend on it); the
improvement is that the offscreen retains nothing and views never manage key residency,
not that views can never see a vek. `CRYPTO_GENERATE_VEK` likewise still returns the vek
string to its caller (`createVault` discards it).

**The atomicity rule: the whole fix lives here.** In the offscreen, "load the vek, run the
op" must be **consecutive synchronous statements against the resolved wasm module**:

```ts
// offscreen-core dispatchCrypto, USE-VEK ops
const w = await getWasm();               // await BEFORE the critical section
w.unlock_with_vek(p.vekB64);             // sync
return w.encrypt_with_vek(p.plaintext);  // sync, same tick: nothing can interleave
```

Two shapes that look equivalent and are NOT:

- `await adapter.unlockWithVek(vek); return adapter.encryptWithVek(...)`: every
  `buildCryptoAdapter` method awaits `getWasm()` internally, so another message's load can
  run between the two calls. This is the original race reborn inside the fix.
- `await w.unlock_with_vek(vek); return w.encrypt_with_vek(...)`: `await` on a synchronous
  value still yields a microtask, and another handler's load+op pair can run inside that
  yield. On the extension the wasm calls are synchronous (`Awaitable<T>` resolves
  in-process). Do not await between load and op.

The same pairing applies to the unwraps: `unwrap_vek_password` returns only a boolean and
leaves the recovered vek in the slot, so **unwrap + `export_vek` must be one synchronous
section** or the exported vek can be another op's. Concretely: `dispatchCrypto` calls the
wasm module directly for USE-VEK and SET-VEK ops (it already sits next to `getWasm`); the
shared `buildCryptoAdapter` stays untouched for mobile and may remain behind the
VEK-independent ops. Firefox runs the identical code in-process (`deliver` calls
`handleHostMessage` directly), same single-threaded guarantee; the event page's
suspend/resume is covered by session rehydration instead of the old `markOffscreenKey`
dance.

### Active vault, MRU, and the lock taxonomy

With independent unlocks, several vaults can be open at once, but the singleton services
(the sync session, the autofill index, corner-prompt commits, the content-facing passkey
provider, backup runs, restore-on-reopen) still need one arbiter. That stays
`vault.activeId`: **the most recently unlocked or explicitly selected vault**. The
background keeps an MRU list of unlocked vault ids (`vault.unlockedMru`) next to it:
a successful unlock or an explicit `setActiveVault` moves that id to the front; a
per-vault lock removes its entry.

- **Per-vault lock** (the Lock action in a view; `CRYPTO_LOCK` with a vault id): because one vault
  is active in the UI at a time (the popup and the singleton pop-out share its lock state, so two
  different vaults are never open in two views at once), locking is a **clean slate** = the full
  `clearSession` teardown: clear EVERY cached vek, the index, sync, handoffs, and the active id,
  back to the picker. A stray non-active vek left cached from creating a vault while another was
  open is dropped too, so "lock" never leaves a vault openable without re-auth. The per-vault map
  still holds several veks **transiently** during a create (that is what fixes the build-time
  corruption); it is not a persistent multi-view unlocked state. (Two earlier drafts - promote the
  MRU head, then clear-active-but-keep-others-cached - were dropped: the first hijacked the locked
  view into another vault; the second left a "locked" vault openable, contradicting "locking locks
  everything".)
- **Walk-away locks stay global**: the idle auto-lock alarm, the `lock-vault` command, OS
  screen-lock, and view-lock's last-view-close (Immediate mode) clear the entire map,
  every `vault.vek:*` key, the MRU, and the active id, exactly like today's
  `clearSession`. One sliding auto-lock alarm covers all vaults (activity on any vault
  re-arms it); per-vault idle timers are not v1.
- **`vaultLocked()` is redefined as "the active vault has no cached vek."** Every current
  caller (autofill query, corner-prompt, webauthn-provider, backup, the background
  storage-change listeners) means exactly that.
- **Lock signals to views become per-vault**: the scoped view adapter's `onExternalLock`
  watches removal of its own `vault.vek:<id>` session key, so locking vault A no longer
  locks vault B's view. `CRYPTO_IS_LOCKED` answers from the map for the id it is asked
  about. `broadcastLockState` to content scripts fires whenever the active vault's
  effective state changes, including on a promote/switch.
- Accepted transient wrinkle: during `createVault` the session active id lags until the
  post-unlock effect writes it (`useVault.tsx`, the `setActiveVault` effect), so a sync
  tick in that window still targets the previous vault. Harmless because every crypto op
  is explicitly bound (next section); the new vault's first sync starts when the effect
  lands.

### The scoped view adapter, and the create/join binding trap

`CryptoAdapter` gains one **optional** member, `withVault?(vaultId: string): CryptoAdapter`,
so the shared interface stays mobile-compatible (mobile simply doesn't implement it; a
required vault id would force a uniffi surface change). The extension implements it as a
thin copy of `extensionCrypto` whose `send` stamps the top-level `vaultId`. `useVault`
mirrors the existing storage pattern:

```ts
const vcrypto = useMemo(() => crypto.withVault?.(activeId) ?? crypto, [crypto, activeId]);
```

and uses `vcrypto` everywhere it uses `crypto` today (unlock, loadEntries, entry
mutations, slot ops, verify, biometric).

**The trap the implementer must not fall into:** `createVault` calls `createRecord(label)`,
which selects the new id via React state, but the closure it runs in still holds the
wrapper memoized for the **previous** `activeId` (and the memoized
`wrapPasswordSlot`/`wrapRecoverySlot` helpers likewise). Using the ambient `vcrypto` for
the build would cache the new vault's VEK under the old vault's id: the original
corruption with new plumbing. The build path must bind explicitly:

```ts
const newId = await createRecord(label);
const bound = crypto.withVault?.(newId) ?? crypto;   // NOT the ambient vcrypto
await bound.generateVek();
const passwordSlot = await buildPasswordSlot(bound, password);
const recoverySlot = await buildRecoverySlot(bound, code);
const bytes = await buildVaultBytes(bound, [passwordSlot, recoverySlot], emptyEntriesPayload());
```

The same rule applies to every flow that creates a vault record and then runs crypto
against it before the React context catches up: the Phase 2 "join adds a vault" flow and
the restore-as-new-vault flow. Flows that operate on the already-active vault (unlock,
entry CRUD, register/revoke key, password changes, recovery-code reset) correctly use the
ambient `vcrypto`, because unlock screens only render for the selected vault.

### Mobile hardening (issue #27)

Per-vault VEK shipped on the extension only; mobile's Rust core stays a process-global
singleton, so `withVault` is undefined there and the binding at `useVault.createVault` is a
silent no-op. That left mobile with the original hazard, and it reached a user:
[#27](https://github.com/flythenimbus/bramble/issues/27) — a synced vault that no longer
opens under **either** the master password or the recovery code, failing with
`aes decrypt: aead::Error`.

The failure is not a wrong password. The Rust unlock checks an HMAC verifier before any
AES, so an AEAD error means the password was right and the vault's *slots and entries are
sealed under different keys*. Both slots wrap the same VEK, which is why the recovery code
is no help either.

Mobile could reach that state because **storage was vault-scoped while crypto was not**:

- The sync merge store was a module singleton that re-resolved `activeVaultId()` separately
  for its read and its write, so a vault switch mid-merge moved the target.
- `createVault` swapped the global VEK *before* recording the new active vault, so the
  session that `onUnlocked` started targeted the previous vault while the loaded key was the
  new one.
- `deleteVault` never cleared the recorded active vault, so it named a deleted vault.
- An id-less `writeVaultBlob` fell back to `reg.vaults[0]`, a guess that could drop one
  vault's bytes onto another's file.
- `sendBundle` fell back to `export_vek()` at send time, so an invite outliving a vault
  switch shipped the wrong vault's key.

Rename and lock are red herrings in the repro: renaming writes only the registry label and
locking only clears state. They discard the good in-memory plaintext and force a fresh disk
decrypt, which is what *exposes* damage planted earlier.

**Invariant now enforced: a seal may only land in a file whose slots wrap the sealing key.**

- A roster session is bound to one vault id for its lifetime; its blob store's read, slot
  list and write all name that vault. Merges serialize, and each captures a session
  generation so one queued across a teardown is dropped rather than written to a vault we
  have left. `retargetActiveVault` (stop, bump, drain) runs *before* the new active id is
  persisted.
- `activeVaultId()` no longer guesses `vaults[0]` when several vaults exist and none is
  recorded active; the single-vault fallback stays for pre-`setActiveVault` installs.
- `writeEntriesBlob` reads, verifies, seals, writes — in that order. With
  `verifyVekBeforeWrite` (mobile's sync store) it refuses to overwrite a non-empty blob the
  loaded key cannot open. Refusing costs one dropped merge; writing costs the vault.
- Inviting requires an explicitly captured VEK. There is no ambient fallback on either
  platform.
- `decryptEntriesOrRecover` un-bricks an already-damaged vault from the pre-write snapshot,
  but only after that snapshot proves it opens under the key in hand — restoring is
  destructive, and the live file is the user's only other copy.

Still a follow-up: porting the per-vault VEK map to mobile, which would remove this class
structurally rather than fencing it. The extension has a milder instance of the same shape
in `background/sync.ts`, which re-resolves its vault per call.

### Ghost records: registered but never written

A registry record whose blob was never written is a dead end for the user: the picker
offers it, selecting it renders the first-run "Create your vault" screen (`hasVault` is
false), and there's no route to Settings from there, so it can't be deleted. `createVault`
is no escape either - it mints a *new* record rather than filling the selected empty one.
Three ways one got created, all now closed:

- **Join re-entry.** `startJoin` registers a record, then defers the handshake to an effect
  via `pendingJoin` + `joinResolverRef`. A second call overwrote both, so the failure
  cleanup could only ever fire for the newest attempt and the first record was stranded
  forever. The dedup at the top of `startJoin` cannot catch this: it matches a *persisted*
  `sync.group`, which an in-flight join hasn't written yet. Fixed with an in-flight promise
  ref, assigned before the first await, that a re-entrant call rides instead.
- **Blind blob writes minting records.** Mobile's `writeVaultBlob` fell back to
  `reg.vaults[0]?.id`, and with an empty registry minted a record *before* writing the file.
  Anything failing in between left exactly this shape. It now throws: a blind write with an
  empty registry means the caller lost its vault id.

  Restore was the one caller that legitimately wanted that mint, and closing the hole broke it
  (github issue #41: `writeVaultBlob: no vault id, and no vault registered`, on a device whose
  only vault had been backed up and deleted). `RestoreShell`'s no-vault branch now mints the
  record itself and names the id in the write, matching `createVault`. Restoring *onto* an
  existing vault was unaffected, since that branch already called `createRecord`, which is why
  both e2e tests kept passing: each created a vault first, so neither entered the broken branch.

  It needed a second half. `unlock()` records the active vault before the unwrap, and it read
  `activeId`, which `createRecord` had only just set through React state, so the `unlock` in the
  caller's hand still closed over `undefined` and recorded **null**. Untagged crypto ops resolve
  their vault from exactly that key, so the unwrapped VEK was cached under no vault and the very
  next decrypt answered "vault locked". `unlock(password, vaultId?)` takes the id explicitly for
  the same reason `createVault` binds crypto with `withVault(newId)`: a just-minted vault is
  never the one React state names yet.
- **Merges landing in the wrong vault.** The mobile sync manager built its entries blob
  store with the raw adapter, so `writeEntriesBlob` (which passes no id) resolved to
  `reg.vaults[0]` while the store's own `readDecodedBlob` used the *active* vault. With more
  than one vault, every remote merge read the active vault and wrote the result into the
  first one. The store's storage is now scoped per call, matching the read.

Belt and braces: startup reaps records with no blob, no recovery snapshot and no
`sync.group`, so an existing ghost clears itself instead of needing a reinstall. Startup
only, since a vault mid-creation is briefly in exactly that state. `getMeta`/`setMeta` gate
on that pass too, so the UI can't read a pre-reap registry, and on mobile a record written
during it can't be clobbered by the fresh-install `writeRegistry(EMPTY_REGISTRY)`.

The first two apply to **both** storage adapters (the extension's `writeVaultBlob` had the
same mint, byte for byte); the third was mobile-only, since the extension threads
`ctx.vaultId` explicitly through its own merge port in `background/sync.ts`. Two
extension-only wrinkles in the reaper: a file-backed (FSA) vault's record legitimately has
no blob until the first unlock materialises it, so the reap is skipped entirely while a
legacy handle exists; and the handle is only consulted once something would actually be
dropped, to keep the common startup off IndexedDB.

### Enrollment: hand the VEK to the transfer explicitly

Previously called a deferred pre-existing risk. **The scratch-slot model breaks enrollment
outright**, so it moves into scope:

- **Inviter** (`sync/transport/enroll-host.ts`, `sendBundle`): today it builds the bundle
  with `vek: await opts.wasm.export_vek()`, which under scratch semantics exports whatever
  the last op happened to load: nothing, or the **wrong vault's** vek, which would ship
  vault B's key with vault A's entries to the joiner (a cross-vault key disclosure AND a
  corrupt joined vault). Fix: `EnrollOptions` gains `vekB64?: string`; `sendBundle` uses
  `opts.vekB64 ?? await opts.wasm.export_vek()` (the fallback keeps mobile's singleton
  core working untouched). The extension injects it in the background's
  `SYNC_ENROLL_INVITE` handler (`withDeviceKey` in `background/sync.ts`, the same place
  `devicePrivB64` is injected) from the vek store for the resolved `ctx.vaultId`, and
  fails the invite with "unlock this vault first" when absent. `EnrollInviteMsgSchema`
  (extension `sync/messages.ts`) gains `vekB64`.
- **Joiner** (`receiveBundle`): it adopts `bundle.vek` into the slot and then runs the
  `wasmSlotCrypto` wraps and `buildVaultBytes` across many awaits; any concurrent op's
  load lands between them and the rebuilt vault's slots and entries disagree. Fix:
  `wasmSlotCrypto(wasm, vekB64)` loads the vek immediately before **each** wrap/encrypt,
  with no await between load and op on the synchronous (extension) path:

```ts
function loadThen<T>(wasm: CryptoWasm, vekB64: string, op: () => Awaitable<T>): Promise<T> {
  const r = wasm.unlock_with_vek(vekB64);          // sync on the extension, a promise on mobile
  return r instanceof Promise ? r.then(op) : Promise.resolve(op());
}
```

  `receiveBundle` passes `bundle.vek`; the existing standalone adoption line can stay
  (harmless on both platforms). The joiner needs no background plumbing: its vek arrives
  in the bundle, and after the blob is written the normal `unlock()` path unwraps from the
  new slots and caches under the joining vault's id.

### Surface area

From a full recon pass, verified against the code. The crux: the blob-read layer already
threads a `vaultId`, but the **decrypt** uses whatever key is loaded, so reading vault B's
bytes while vault A's key is live silently fails or corrupts. The mechanism, adapter, and
enrollment work is specified above; this is the inventory of everything else that touches
the single-VEK assumption.

- **Deleted single-VEK state** (`background/session.ts`): `cachedVek`,
  `VEK_KEY = "vault.vek"`, `getVek`, `persistVek`, `exportAndCacheVek`.
  (`background/offscreen-client.ts`): `offscreenHasKey`, `markOffscreenKey`, the
  re-injection block, and the `skipKeyInjection` list (injection is now per-op by type).
  `vaultLocked`, `sessionHydration`, `clearSession`, and `cryptoHandler` survive, re-shaped
  as described in [Mechanism](#mechanism-the-vek-rides-with-the-op).
- **Latent cross-vault callers, fixed in this pass** (they call `readAndDecodeVault()`
  **and `writeVault()`** with no id, resolving to the primary blob, while their crypto ops
  will use the active vault's key): `background/corner-prompt.ts` and
  `background/passkey-store.ts`. On this branch today, a corner-prompt save or a passkey
  registration while active != primary seals an entry under the active key and **writes it
  into the primary vault's blob**: silent corruption of a vault that isn't even open. Both
  must resolve `getActiveVaultId()` once per operation and pass it to the blob I/O and (as
  the message `vaultId`) to every crypto op they send. Passkey autofill, like login
  autofill, is a content-script caller that only has an origin, so serving the active
  vault is the correct resolution for it.
- **Autofill** (`background/autofill-index.ts`): a single un-tagged `Map` served to
  content scripts that only carry a hostname; it serves the **active** vault.
  `hydrateAutofillIndexFromDisk` reads the primary blob but decrypts with the active key
  today: pass the active id to `readAndDecodeVault` and tag its `CRYPTO_DECRYPT_OUTER` /
  `CRYPTO_DECRYPT` ops. `clearIndex()` on every active-vault change (lock of the active
  vault, or a promote/switch); the next query rebuilds lazily from the new active vault.
- **Sync** (`background/sync.ts` + `background/vault-io.ts`): `makeVaultSyncPort(ctx)`
  already threads a `SyncVaultCtx` (the reference pattern); its `CRYPTO_DECRYPT_OUTER` /
  `CRYPTO_ENCRYPT_OUTER` (in `readLocalState` / `writeMerged`) and vault-io's
  `reencryptOuterWithEntryChange` gain the ctx's `vaultId`. `resolveSyncVault()` already
  picks active-then-primary.
- **Backup cred decrypt** (`background/backup.ts`): uploads copy the sealed blob (no vek
  needed), but `decryptSecrets` unwraps the backup **target credentials**, which are
  VEK-wrapped. Targets are per-vault now, so the decrypt is tagged with the **target's own
  vault** first, then retried under each other unlocked vault (bounded) — the retry is what
  keeps targets migrated off the old device-global list working, since those were wrapped
  under whichever vault happened to be active back then. No resident vek opening them means
  that vault is locked: the target is **skipped, not failed** (no `lastError`, still due).
  The durable fix (wrap target creds under a device key, not a vault vek) stays deferred and
  would remove the skip. `backup-connect.ts` `wrapSecret` tags the active vault when creating
  a target, and writes it to that vault's list.
- **`primaryId` is effectively dead.** Its doc-comments claim it is the autofill/biometric
  target, but the only live consumers are storage/sync **fallback defaults**
  (`vaultId ?? primaryId` in `storage.ts`, `sync-config.ts`, `useVaultRegistry.syncKey`)
  plus a UI warning banner. No autofill or biometric code reads it. It can be removed as a
  follow-up once those fallbacks resolve the active vault instead.
- **Mobile** (`platform-mobile/src/native-crypto.ts`): the native uniffi plugin holds one
  VEK and every method is a parameterless singleton. The vek never crosses the shared
  interface (the extension injects and strips inside its background), and `withVault` is
  optional, so the native adapter is untouched. (A required vault id would force a
  Rust/uniffi surface change; an optional member is simply absent there.)

### Increments

Each lands green on its own. Increment 2 is the seam flip and ships background + offscreen
**together**: they are one protocol, updated atomically at extension reload, so no
cross-version tolerance is needed inside it. Note that 2 alone does not yet fix the
corruption (un-tagged view ops fall back to the session active id, which preserves today's
behavior, clobbers included); the fix is real once 3 lands.

1. **Inert threading.** Top-level optional `vaultId` on the `CRYPTO_*` envelope; optional
   `vekB64` on the six USE-VEK payload schemas (`crypto/messages.ts`);
   `background/vek-store.ts` (map, session mirror, MRU, active-id helpers), not yet
   consumed. No behavior change.
2. **The seam flip (offscreen + background, one commit).** Offscreen `dispatchCrypto`:
   USE-VEK ops load-then-run synchronously off `payload.vekB64` (falling back to the loaded
   slot when absent, so un-tagged callers keep working until 4); unwraps do the atomic
   unwrap + `export_vek` pairing and reply `{ok, vekB64}`; `CRYPTO_LOCK` zeroizes the
   scratch slot. Background: map + inject/strip in `sendToOffscreen` (an absent `vaultId`
   resolves to the session active id); per-vault session keys + hydration with the
   drop-the-bare-key rule; map ops; MRU + promote; the lock taxonomy; delete
   `offscreenHasKey` / re-injection / `exportAndCacheVek`. Update the test harness's
   `defaultOffscreen` response shapes and session.test.ts expectations in the same commit.
3. **Views.** `withVault` on the extension adapter; `useVault` binds the ambient `vcrypto`;
   the **explicit `bound = crypto.withVault?.(newId)` binding in `createVault`** (and the
   restore-as-new-vault flow); per-vault `onExternalLock` watching `vault.vek:<id>`.
4. **Background consumers.** corner-prompt, passkey-store, autofill hydrate +
   clear-on-switch, the sync port + vault-io, backup cred decrypt fallback: every op
   tagged, every blob read/write id-explicit.
5. **Enrollment.** `vekB64` through `EnrollInviteMsgSchema` + `withDeviceKey` injection;
   `wasmSlotCrypto(wasm, vekB64)` per-op loads; joiner passes `bundle.vek`. (Phase 2's
   "join adds a vault" then binds its ops to the new record's id per the binding trap.)
6. **Cleanup + atomicity guard.** The plan was to remove the absent-id fallback and make an
   un-tagged VEK-scoped op an error, but that was **reconsidered and deferred**: an audit found
   un-tagged-but-correct callers that mean the active vault (`webauthn-proxy`'s `isLocked`, and
   any future one), and the fallback (resolve the active vault) is a *correct* default now that
   every specific-vault caller tags explicitly. The corruption is already fixed structurally by
   inc 3's binding, so the fallback stays as a sensible default rather than a footgun. What
   landed instead: the offscreen atomicity regression test (two differently-keyed dispatches
   raced through `handleHostMessage`, asserting every op sits immediately after its own load, so
   a future stray `await` in the critical section fails loudly). Mobile stays untouched (no
   `withVault`, ids ignored); `primaryId` removal remains a later follow-up.

### Testing

- **Unit, background (session.test.ts on the existing test-harness):** an unwrap caches
  the returned vek under the request's vault id and strips it (the view sees a plain
  boolean); USE-VEK ops carry the right vault's vek (unlock two vaults, send ops tagged A
  and B, assert the injected payloads); an op against a locked vault id fails without an
  offscreen call; hydration rebuilds the map from `vault.vek:*` keys and deletes a bare
  `vault.vek`; a per-vault lock removes one entry and promotes the MRU head (sync
  restarted, index cleared, broadcast fired) while the other vault's key survives; the
  idle alarm / `lock-vault` command / screen-lock / last-view-close each clear everything;
  `vaultLocked()` tracks the active vault only.
- **Unit, offscreen atomicity:** stub the wasm with call-order recording; fire two
  dispatches with different veks through `handleHostMessage` concurrently (`Promise.all`,
  repeated) and assert every op ran immediately after its own load with nothing
  interleaved. This is the regression guard for the no-await rule; if it ever fails, an
  await crept into the critical section.
- **Unit, enrollment:** `sendBundle` prefers `opts.vekB64` over `export_vek`;
  `wasmSlotCrypto` loads before each wrap/encrypt (call-order assertion).
- **Runtime (the two-view rig; cannot be reproduced headless):** create vault 2 in the
  options page while vault 1 is unlocked in the popup; create / lock / unlock repeatedly;
  two views editing different vaults at once; autofill immediately after switching vaults;
  a corner-prompt save while active != primary; an invite from a non-primary active vault;
  a scheduled backup whose target was created under the other vault. After each scenario:
  lock and re-unlock every vault by password AND by recovery code (the original symptom's
  probe), and run a sync pass on the paired two-profile rig.

## Decisions (settled)

- **Identity:** local UUID + optional local label; no vault-format change.
- **Migration:** migrate everything to the namespaced layout, sync identity
  preserved, no re-pair (see [Migration](#migration)).
- **Concurrency:** ~~one vault unlocked at a time~~ **superseded (2026-07): independent
  per-vault unlock on the extension via a VEK map; mobile stays single-active. See
  [Per-vault VEK](#per-vault-vek).**
- **Labels:** optional; duplicates allowed; blank displays as "Vault N" by position;
  shown in the pre-unlock picker.
- **Sync:** active-vault-only in v1.
- **Primary vault:** ~~unified. One pointer drives mobile autofill, biometric unlock,
  and the picker's default selection. Secondary vaults are password / security-key /
  recovery only.~~ **superseded (2026-07): no primary vault; autofill and biometric
  follow the active unlocked vault. See [Per-vault VEK](#per-vault-vek).**
- **Backups:** per-vault, in v1 (Phase 4).

## Still open

**Device-verification status (2026-07-18).** Most of the mobile work was verified on Android (Pixel,
debug build) this session; the remaining gap is mostly iOS + a few new mobile affordances. **Verified
on Android:** the native Kotlin/Java compiles (per-vault biometric + active-vault autofill); the
namespacing migration on real pre-migration data (flat `vault.vlt1` -> `vault-<id>.vlt1`, flat
deleted, master-password unlock opens the migrated vault, all entries intact); the active-vault
pointer; and sync (edit propagation, user-confirmed "works as expected", incl. a non-first vault).
**Still to verify:**
- **iOS** - the whole mobile suite (migration, unlock, per-vault biometric, autofill fill); only Android was on hand.
- **Per-vault biometric** - enable on two vaults, confirm no VEK overwrite (code deployed, not yet exercised).
- **Mobile-as-inviter** - newly exposed once the stale "primary vault" sync-panel gate was removed; invite from mobile -> another device joins + syncs.
- **Two-vault switching** on mobile (lock -> picker -> unlock the other).
- **QR-code scan** in the mobile Join flow (restored this session).
- **Android back gesture** (github #15) + the setup-shell back button.
- **Extension** - the namespacing migration on a real pre-migration profile.
- **Firefox-inviter roster fix** - invite from Firefox, join from a Chromium target.

**Remaining build work (all non-blocking):** backup target-cred device-key wrap (below; a mitigation
ships), the unlocked "switch vault" button (mobile nicety), per-vault device identity (mobile
hardening), and full multi-vault autofill Tier 2 (search all vaults; post-v1). Details below.

- ~~**Per-vault VEK (extension).**~~ **LANDED 2026-07** (all 6 increments + the clean-slate
  lock fix; see [Per-vault VEK](#per-vault-vek)). Fixed the create-time `aead::Error`
  corruption. Runtime-verified by the user across multiple vaults in multiple targets
  (Vivaldi + Firefox), each syncing on its own connection; build/lock/unlock and
  sync-isolation e2e are green.
- ~~**Setup shell UX** (create / restore / join tabs).~~ **LANDED 2026-07.** One tabbed flow for
  first-run + add-a-vault; dropped the dead "Open existing vault" master-password tab; "Restore
  from backup" is an inline tab (embedded `RestoreShell`, not a page swap); Auth hides "Create new
  vault" when `vaults > 1`. See [Setup shell](#setup-shell-one-tabbed-flow-create--restore--join).
- ~~**Join = add a vault** (sync increment 5).~~ **LANDED via the setup shell (2026-07, commit
  8b3e4030): a "Join a device" tab (shown in every circumstance since commit 5b9c0b1c - `canJoin =
  true`; originally gated to `perVaultSync`) collects a
  pairing code + master password and calls `useVault.startJoin`, which dedups by `groupKey`, else
  `createRecord` + `setActiveVault` + runs `joinGroup` in the new vault's context via a deferred
  effect (the join is active-vault-scoped and the captured `joinGroup` holds the old id - the
  binding trap), landing you inside the joined vault unlocked. The Settings "Join with a pairing
  code" entry (which id-less-wrote / overwrote the ACTIVE vault) was REMOVED (commit 454a2d99);
  the not-in-a-group panel keeps invite + points to "Add a vault -> Join a device". The raw
  `joinGroup` action stays for the "join into the active vault" primitive but has no UI entry.**
- **Backup target-cred device-key wrap.** Backup target credentials are VEK-wrapped under the
  vault that owns the target (and, for targets migrated off the old device-global list,
  whichever vault created them). A locked vault's scheduled backup is therefore skipped until
  it is next unlocked. The durable fix wraps target creds under a device key rather than any
  vault VEK, which would also let backups run while everything is locked — separate work, and
  a deliberate security trade-off (cloud credentials would no longer be master-password
  protected at rest), so it wants its own change and its own release note.
- ~~**`primaryId` removal.**~~ **DONE (2026-07, commit `94802182`).** The user-reassignable
  primary pointer is gone from the registry (Zod strips a stored one); the storage/sync fallbacks
  resolve the first/only vault instead. Mobile's out-of-process autofill still serves that fallback
  vault until Tier 1 adds a designated-autofill-vault.
- ~~**Uniform namespacing (retire `legacyBlobVaultId`).**~~ **DONE (2026-07).** Every vault is
  addressed by id on both platforms; the pre-namespacing vault is brought in by a crash-safe,
  value-preserving one-time **copy** migration (no re-pair). See
  [Namespacing](#namespacing-every-vault-by-id-one-time-copy-migration). **Needs device-verify** on
  a real pre-migration profile (open + sync intact) before shipping - see the checklist handed off
  with the change.
- **Mobile multi-vault, Tier 1 (single-active, switchable) - core LANDED 2026-07, needs
  device-verify.** Mobile always stored multiple vaults (namespaced blobs); the runtime is now
  active-vault-aware:
  (a) ~~active-vault pointer~~ **DONE** - `mobileShell.setActiveVault`/`getActiveVault` persist the
  active vault in Preferences (no session store on mobile); unlock records it, the registry restores
  it on reopen (commit 55c2769e).
  (b) **picker + switch already worked** via shared router guards (`router.tsx` `/select`,
  `VaultPicker`, `Auth`'s "Choose a different vault" -> `clearSelection`); it's **locked-only** (the
  guards gate it behind `isLocked`), which is correct because there's no per-vault VEK on mobile -
  `lock()` drops the single native VEK before another vault is picked. An *unlocked* "switch vault"
  button would just `lock()` then route to `/select`; not built yet (nicety).
  (c) ~~sync targets the active vault~~ **DONE** - `sync-manager` resolves the active vault and
  reads/writes its namespaced `sync.group`/`sync.deviceId`/`sync.lastSyncedAt` + blob; the HLC clock
  re-seeds per vault on teardown. This also **fixed a regression the namespacing change introduced**:
  the app's enrollment writes namespaced `sync.group:<id>` but `sync-manager` had read flat, so
  mobile sync was silently broken on this branch. The Noise/Ed25519 keypairs stay device-global in
  secure storage (the migration deliberately skips them); per-vault device identity is a later
  hardening.
  Mobile does **not** need the extension's per-vault VEK map (single webview, lock-on-switch).
  ~~`resetSyncState` would disturb a sibling vault on 2nd-vault-create.~~ **Not an issue - both
  callers already guard it:** `createVault` only resets when `isFirst` (`useVault.tsx`), and
  `RestoreShell` only resets in the `!hasVault` (first/only vault) branch; `startJoin` never resets.
  So creating, restoring, or joining a second vault leaves the sibling's sync untouched. Pinned by
  `useVault.createVault.test.tsx` (resets with 0 vaults, does not with 1). The device-global
  keypairs are the only shared sync state left (see per-vault device identity, below). Per-vault
  biometric + active-vault autofill **have since LANDED** (see
  [Mobile autofill and biometric](#mobile-autofill-and-biometric)); only *simultaneous* multi-vault
  autofill (search all vaults) remains **Tier 2**. **The mobile runtime is still unverified on
  device** - mobile sync (edit propagates) and two-vault switching must be run on a phone.
- ~~**Autofill arming (Phase 3, mobile).**~~ **Moot - autofill follows the active vault on both
  platforms** (no designated autofill vault). Android reads the active vault's blob directly; iOS
  pushes the active vault's bundle on unlock (`setIndex`, built from the decrypted entries + slot,
  so it self-arms as you unlock). Switching the autofill target is just switching (unlocking) the
  vault. See [Mobile autofill and biometric](#mobile-autofill-and-biometric).
- ~~**Firefox multi-vault (event-page transport).**~~ **DONE - runs on Firefox unchanged**
  (verified by the user's multi-vault-on-Vivaldi+Firefox testing + a code survey, 2026-07).
  `resolveSyncVault` reads the active vault from `storage.session` (`sync/sync-config.ts:23`; the
  Firefox manifest floor is FF 128, above the FF 115 `storage.session` landing). The
  [vek-store](#mechanism-the-vek-rides-with-the-op) **persists each VEK to `storage.session`**
  (`background/vek-store.ts` `setVek`/`removeVek`/`clearAllVeks`), so it survives an event-page
  suspend/resume, rehydrates via `vekStoreHydration`, and re-injects per-op; `sendToOffscreen` calls
  `handleHostMessage` in-process on Firefox (`background/offscreen-client.ts:57`) with the same
  per-vault inject/strip seam as Chrome. Every FF-specific branch (`syncHostSuspends` keepalive
  alarm, `keepEventPageAlive`, the in-process `setSyncBridge`) is event-page *lifetime* only and
  resolves the vault per-vault. No FF-specific single-vault/`primaryId` assumption remains; the
  blob-change and `sync.group` change watchers both match the namespaced key variants.
- **Firefox-inviter roster fix: verify on device.** The host-side enrolled-roster add (commit
  57944af1; see [The enrolled device is rostered in the host, not just the
  popup](#the-enrolled-device-is-rostered-in-the-host-not-just-the-popup)) is committed but not yet
  crossed live: invite from Firefox, join from a Chromium target, confirm no `not in roster` +
  convergence. Playwright can't cover it (extension automation is Chromium-only).
- ~~**Per-vault biometric** (per-vault Keychain / Keystore items).~~ **LANDED 2026-07** (core + iOS
  + Android; commits 492418ef, aa7809a9). Device-verify pending. See
  [Mobile autofill and biometric](#mobile-autofill-and-biometric).
- **Full multi-vault autofill** (search *all* vaults at once, label results by vault) remains a
  post-v1 native follow-up. Today's autofill is single-active: the provider fills whichever vault the
  app is in, one at a time.

## Confirmed unaffected

- Recovery codes and the one-primary-slot invariant (already per-vault,
  [auth-and-unlock.md](auth-and-unlock.md)).
- Import from other managers (merges into the active unlocked vault).
- Scheduled cloud backups mechanics (copy the sealed blob, so they can run for any
  vault without unlocking, unlike a sync merge).
- The Rust core and the VLT1 format (no change; a vault stays one blob = one slot set
  + one entries list).
