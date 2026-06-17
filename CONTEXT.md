# Bramble domain vocabulary

Shared names for the concepts the codebase is built around. Architecture reviews
and refactors should use these terms exactly. Crypto/storage terms live in
`docs/README.md` (VEK, KEK, DEK, Slot, primary unlock method); this file holds the
module-level concepts that name good seams.

## Vault entries

- **VaultEntries** — the in-memory triple that fully describes the entry state of
  a vault: `{ entries, stamps, tombstones }`. `entries` is the decrypted
  `Entry[]`; `stamps` maps entry id -> its HLC stamp; `tombstones` maps a deleted
  id -> the HLC of its deletion. Sync convergence depends on stamps and tombstones
  travelling with the entries, so they are one value, not three.
- **EntryMutations** — the module (`core/vault/entry-mutations.ts`) that owns every
  local change to VaultEntries: add, import (bulk, one write), update, delete.
  Each mutation is a transition `(current: VaultEntries, input) -> next: VaultEntries`
  that performs the encrypt-and-write as its effect and returns the next state;
  it holds no React state. `EntryData` is validated against `entryDataSchema` at
  this seam before anything is encrypted. The autofill index is refreshed here on
  every persist, so it can never drift from what was written.
- **writeEntriesBlob / readEntriesPayload** — the persist primitive pair under
  EntryMutations. `writeEntriesBlob(payload)` encrypts an `EntriesPayload` under
  the VEK, preserves the slot list, and writes the vault blob.
  `readEntriesPayload()` is its inverse. Both EntryMutations and the sync
  enrollment path (`useSyncEnrollment`) go through these, so the on-disk entries
  format has one writer.

## Autofill detection

- **PageFieldModel** — the parsed, in-memory description of a web page's fillable
  fields: the login fields (username/password/new-password), the card fields, and
  the one-time-code inputs, holding live element references. Produced once by
  `parsePageFields(root)` (the pure parser in `content/detection.ts`) and cached;
  the content script's MutationObserver invalidates it. Callers (content, fill,
  capture, picker) read the model instead of each re-scanning the DOM, and
  `candidateKind(el)` becomes a lookup against the model rather than a fresh scan.
  Stale references (elements no longer `isConnected`) are dropped on read.
