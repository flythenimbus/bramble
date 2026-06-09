# Storage and persistence

Where the vault bytes live, how writes survive a crash, and how the background
service worker commits a write it cannot make directly. Code:
`packages/platform-extension/src/storage.ts`.

## Two backends

A vault is backed by one of:

- **File System Access (FSA)**: a real file the user picked, with the handle
  stored in IndexedDB. Preferred, but `createWritable()` requires a fresh user
  gesture, so the background cannot write to it unprompted.
- **chrome.storage.local**: the fallback when the platform blocks the file picker
  (for example Brave Shields). No gesture constraint, so the background can write
  through directly.

`pickerSupported()` gates picking a *new* file (it needs `window` plus the picker
APIs). It deliberately does not gate reading the stored handle: IndexedDB is
reachable from the service worker, so the SW can fetch an existing FSA handle even
though it cannot pick a new file. `canWriteFromBackground()` returns true only for
the chrome.storage.local backend, and that distinction drives the corner-prompt
commit path.

## Crash recovery via a backup key

Every write snapshots the current on-disk bytes into a backup key
(`vault-blob-backup-b64`) **before** truncating the target.

The danger is FSA: `createWritable()` truncates immediately, so a crash between
truncate and `close()` would otherwise leave a partial, unreadable file with no
second copy. The pre-write snapshot gives a known-good fallback, restored by
`restoreVaultFromBackup`. Because chrome.storage.local writes are atomic, the
backup key always holds either a complete previous blob or nothing, never a
partial one.

Two deliberate asymmetries:

- On vault creation (nothing on disk yet) the snapshot step clears any stale
  backup, so a pre-creation snapshot cannot later be restored over a freshly
  created vault.
- `restoreVaultFromBackup` skips the snapshot step, since overwriting the backup
  with the (likely corrupt) live file would discard the only good copy.

Snapshotting is best-effort: if it fails, the write still proceeds, because
failing a save just because a backup could not be taken would leave the user
unable to save at all.

## Pending-blob stashing (FSA + background)

When the background needs to commit a corner-prompt save but the vault is
FSA-backed, it cannot reach disk without a gesture. So it encrypts the new outer
blob via the offscreen document, base64-encodes the full vault bytes, and stashes
them under `PENDING_BLOB_KEY` in `chrome.storage.session`.

The next popup or options mount calls `flushPendingVaultBlob`, which writes the
stashed bytes through (snapshotting first, since it is replacing whatever is on
disk) and clears the key. `getPendingFlushCount` lets the UI surface that a
pending save is waiting. The stash is in-memory (wiped on browser restart), but
the bytes are ciphertext, so surviving a vault lock is fine.
