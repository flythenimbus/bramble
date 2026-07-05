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

`chrome.storage.local` is durable for the profile but can be evicted if the user
clears "cookies and site data." The background calls `navigator.storage.persist()`
to request exemption from eviction under disk pressure (and on Chrome
`unlimitedStorage` already exempts it). The real backstops against loss are **P2P
sync** (other devices hold a copy) and **export** (a `.bramble` backup the user
saves): the vault is not pinned to one browser profile.
