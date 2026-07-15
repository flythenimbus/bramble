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
  largely intact.
- **Sync runs only for the active (unlocked) vault in v1.** Merging a vault needs
  its VEK (the entries list is VEK-encrypted, not just the per-entry secrets), so
  "sync every vault in the background" would mean holding every vault's VEK in
  memory at once, a security regression. A vault catches up the moment you open it,
  which is already how mobile behaves. Scheduled cloud backups still cover every
  vault, because they copy the sealed blob and need no VEK.
- **One "primary vault" per device** is what mobile autofill serves, what biometric
  unlock is armed for, and what the picker pre-selects. Secondary vaults are
  password / security-key / recovery only until per-vault native caches are a
  fast-follow.
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

| Key (today) | Multi-vault | Scope |
|---|---|---|
| `vault-blob-b64` / `vault.vlt1` | `vault-blob-b64:<id>` / `vault.vlt1.<id>` | per vault |
| `vault-blob-backup-b64` / `vault.vlt1.bak` | `...:<id>` | per vault |
| `sync.group` | `sync.group:<id>` | per vault |
| `sync.deviceKeypair` | `sync.deviceKeypair:<id>` | per vault |
| `sync.signingKey` | `sync.signingKey:<id>` | per vault |
| `sync.deviceId` | `sync.deviceId:<id>` | per vault |
| `sync.lastSyncedAt` | `sync.lastSyncedAt:<id>` | per vault |
| `backup.targets` / `backup.config` | `...:<id>` | per vault |
| `sync.relay` / `sync.iceUrl` | unchanged | device (signaling endpoints) |
| `pref.autoLockMinutes`, theme, locale | unchanged | device |
| `pref.securityKeyLabels` | unchanged (keyed by globally-unique slotId) | device |
| `vault.vek` (session VEK) | unchanged (one active vault) | device |

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
  snapshot, and every `sync.*:<id>` / `backup.*:<id>` key, removes the registry
  record, reassigns `primaryId` if it pointed here, and if it was the last vault
  drops back to first-run setup.

## Restore destination

Reachable from the locked / picker screen via the "Restore from backup" row. After
the backup password is verified (non-destructively, as today), ask for a
destination:

- **Replace an existing vault** (choose which; the default when only one exists), or
- **Add as a new vault** (enter a label -> `createVaultRecord`).

Replacing a vault resets **that vault's** sync identity (today's restore calls
`resetSyncState`; scope it to the one vault), so its paired devices diverge and
re-reconcile: warn before doing it. At 0 vaults (true first run) there is no
destination question; restore just creates the first vault and asks only for a
label. Backup files carry no identity (no in-blob id), so the user's explicit choice
is the matching mechanism, which is fine.

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

### Per-vault namespacing and joining

- Namespace every `sync.*` key by vault id (table above). Keep the host holding one
  session at a time, keyed to the active vault: no per-vault session maps needed for
  v1, which is simpler than the full multi-session rework.
- **Joining a group adds a vault.** Today enrollment rebuilds a whole vault and
  overwrites the single blob (`useSyncEnrollment.ts` -> `writeVaultBlob`). Change it
  to `createVaultRecord` + write the received blob under the new id + set up that
  vault's `sync.*:<id>` namespace. **Dedup by `groupKey`:** before creating a
  record, check whether an existing vault already has this `groupKey`; if so, merge
  into it rather than create a duplicate. Being the inviter still requires the
  shared vault unlocked (to `export_vek`), which is fine for an interactive pairing.
- Make `resetSyncState` and `rotateDeviceId` operate on one vault's namespace, so
  creating or restoring a vault never disturbs another vault's pairing.
- The device-management (roster) UI becomes per-vault: it shows the active vault's
  roster, not a global device list.

## Mobile autofill and biometric

Autofill reads out of process from a fixed location (iOS App Group keys
`autofill.bundle` / `autofill.slot` in `BrambleConstants.swift`; Android
`filesDir/vault.vlt1` via `VaultReader.kt`), and biometric caches exactly one VEK
globally (iOS one Keychain item, Android one Keystore alias). Nothing in the fill
request carries a vault id, so a provider cannot know which of several vaults to
search.

v1 keeps this single-source shape by serving the **primary vault** only:

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

End state: **everything in the namespaced layout** (uniform, no permanent legacy
special-case), sync identity preserved so nobody has to re-pair. But the migration is
**staged across the phases, not done in one pass**, because moving a stored key
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
a non-issue, and no re-pair fires. Every stage is idempotent (write the namespaced key
before deleting the legacy one, so a crash re-migrates) and must never call
`resetSyncState` (that would discard the identity being preserved). This mirrors the
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
- **Phase 4: per-vault backups + restore choice.** Namespace `backup.*`; each vault
  backs up independently; the restore destination flow.

## Decisions (settled)

- **Identity:** local UUID + optional local label; no vault-format change.
- **Migration:** migrate everything to the namespaced layout, sync identity
  preserved, no re-pair (see [Migration](#migration)).
- **Concurrency:** one vault unlocked at a time.
- **Labels:** optional; duplicates allowed; blank displays as "Vault N" by position;
  shown in the pre-unlock picker.
- **Sync:** active-vault-only in v1.
- **Primary vault:** unified. One pointer drives mobile autofill, biometric unlock,
  and the picker's default selection. Secondary vaults are password / security-key /
  recovery only.
- **Backups:** per-vault, in v1 (Phase 4).

## Still open

- **Autofill arming (Phase 3).** Whether the primary vault's autofill bundle can be
  repackaged from the sealed blob without the VEK. If not, switching the primary to a
  never-opened vault needs a one-time unlock to arm.
- **Firefox.** The per-vault namespacing and active-vault session switching also have
  to land in the Firefox event-page transport, which is mid-port
  ([firefox-port.md](firefox-port.md)).
- **Full multi-vault autofill / per-vault biometric** (search all vaults, per-vault
  Keychain / Keystore items) remains a post-v1 native follow-up.

## Confirmed unaffected

- Recovery codes and the one-primary-slot invariant (already per-vault,
  [auth-and-unlock.md](auth-and-unlock.md)).
- Import from other managers (merges into the active unlocked vault).
- Scheduled cloud backups mechanics (copy the sealed blob, so they can run for any
  vault without unlocking, unlike a sync merge).
- The Rust core and the VLT1 format (no change; a vault stays one blob = one slot set
  + one entries list).
