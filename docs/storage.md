# Storage and persistence

Where the vault bytes live, how writes survive a crash, and how a legacy
file-backed vault is migrated. Code: `packages/platform-extension/src/storage.ts`.

## One backend: chrome.storage.local

The vault (the VLT1 binary blob, base64-encoded under `vault-blob-b64`) lives in
**`chrome.storage.local`** — the extension's own sandboxed storage. This is the
same backend mobile uses. It needs no user gesture, it survives service-worker
restarts, and the background can read and write it headlessly. `unlimitedStorage`
lifts the quota, so vault size is not a concern.

The **format is location-independent**: the exact same VLT1 bytes were previously
written to a File System Access file; only *where* they are stored changed. See
`vault-format.md` for the layout.

### Why not a real file (File System Access)

Earlier builds stored the vault in a real file the user picked, via the File
System Access API (an `FileSystemFileHandle` persisted in IndexedDB). That gave
users a portable file but cost them a permission that only `requestPermission`
can (re)grant, and `requestPermission` requires a **user gesture (transient
activation)**. Under MV3 the background service worker is killed after ~30s idle,
and the granted permission lapses with it. Reopening the popup then hit
`requestPermission` with no activation, the vault read threw
`SecurityError: User activation is required`, and the UI fell back to the unlock
screen — indistinguishable from an auto-lock, even though nothing had locked.
`chrome.storage.local` has none of this: it is inside the origin's sandbox, so no
per-file permission exists to lapse.

The "I want a real file" use case is served two other ways instead: **P2P sync**
(the vault is replicated across the user's own devices) and an **export** to a
`.bramble` file on demand, rather than a file that must stay attached and
re-permissioned forever.

## Crash recovery via a backup key

Every write snapshots the current vault bytes into a backup key
(`vault-blob-backup-b64`) **before** overwriting the live blob, so an interrupted
write leaves a recoverable previous copy (`restoreVaultFromBackup`, run when
`readVaultBlob` no longer decodes). `chrome.storage.local` writes are atomic, so
the backup key always holds either a complete previous blob or nothing, never a
partial one.

Two deliberate asymmetries:

- On vault creation (nothing stored yet) the snapshot step clears any stale
  backup, so a pre-creation snapshot cannot later be restored over a freshly
  created vault.
- `restoreVaultFromBackup` skips the snapshot step, since overwriting the backup
  with the (likely corrupt) live blob would discard the only good copy.

Snapshotting is best-effort: if it fails, the write still proceeds, because
failing a save just because a backup could not be taken would leave the user
unable to save at all.

## Legacy File System Access migration

An install that predates this change still has its vault in a real file, with the
handle in IndexedDB and nothing in `chrome.storage.local`. Migration is lazy and
gesture-safe:

- `hasVaultHandle()` reports a vault exists if either a local blob **or** a legacy
  handle is present, so the unlock screen shows normally.
- On the **first unlock** — a real click, so the one-time file read is permitted —
  `readVaultBlob` finds no local blob, reads the legacy file, writes those bytes
  into `chrome.storage.local`, and drops the IndexedDB handle. Every read after
  that is local and gesture-free.
- Local storage is written before the handle is dropped, so a crash mid-migration
  simply re-migrates next time. The **original file is never modified or deleted**
  — it remains on disk as the user's own backup.

This block (`getLegacyHandle` / `migrateLegacyVault` / `clearLegacyHandle`) is
read-only legacy support and can be deleted once no file-backed installs remain.

## Durability

Extension `storage.local` is treated separately from website data, so **"clear
cookies and site data" does not wipe the vault** on either browser (Chrome:
"extension storage is not cleared when a user clears browsing data"; Firefox:
"data saved using the storage.local API is correctly persisted in these
scenarios"). What actually clears it is uninstalling the extension, an explicit
"clear this extension's data", or deleting the browser profile.

The remaining risk is automatic **eviction under disk pressure**, and it differs by
browser:

- **Chrome:** `chrome.storage.local` is its own store (not the quota-managed origin
  storage). The `unlimitedStorage` permission (declared in the manifest) exempts it
  from quota *and* eviction, so `navigator.storage.persist()` is effectively a no-op
  here.
- **Firefox:** `storage.local` is IndexedDB-backed and quota-managed, so eviction can
  apply — except eviction "skips over origins that have been granted data persistence
  by using `navigator.storage.persist()`". That call (in `background.ts`) is what
  earns its keep on Firefox; `unlimitedStorage` also lifts the quota.

`persist()` only prevents *silent* eviction; it never blocks a user who deliberately
clears data (the browser asks first). The real backstops against loss are **P2P sync**
(other devices hold a copy) and **export** (a `.bramble` backup the user saves): the
vault is not pinned to one browser profile.
