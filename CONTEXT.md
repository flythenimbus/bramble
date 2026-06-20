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
- **EntriesBlobStore** — the single reader/writer of the on-disk entries format
  for the adapter context (`core/vault/entries-blob.ts`). `writeEntriesBlob(payload)`
  encrypts an `EntriesPayload` under the VEK, preserves the slot list, and writes the
  vault blob; `readEntriesPayload()` is its inverse. Parameterized by the crypto +
  storage adapters, so EntryMutations, the sync-enrollment path (`useSyncEnrollment`),
  and the mobile roster-sync `VaultSyncPort` all share one implementation — the
  on-disk entries format has one writer in that context. (The extension *background*
  uses a different transport — offscreen IPC + a write-queue — and is a separate
  writer by necessity.) `createVaultSyncPort` (`core/sync/apply-remote.ts`) builds the
  roster-sync port directly over an EntriesBlobStore, so a remote merge writes exactly
  what a local edit does.

## Crypto

- **buildCryptoAdapter** — the single `CryptoAdapter` method -> wasm-call mapping
  (`core/adapters/crypto-wasm.ts`), shared by every transport: the mobile webview
  binds it to its lazy wasm loader + vault-session hooks; the extension offscreen
  routes its `CRYPTO_*` IPC messages through it. Each platform's `wasm-loader`
  only owns instantiation; the `VaultCrypto` interface (the wasm surface) is
  declared once in `core/wasm.ts`.

## Autofill detection

- **PageFieldModel** — the parsed, in-memory description of a web page's fillable
  fields: the login fields (username/password/new-password), the card fields, and
  the one-time-code inputs, holding live element references. Produced once by
  `parsePageFields(root)` (the pure parser in `content/detection.ts`) and cached;
  the content script's MutationObserver invalidates it. Callers (content, fill,
  capture, picker) read the model instead of each re-scanning the DOM, and
  `candidateKind(el)` becomes a lookup against the model rather than a fresh scan.
  Stale references (elements no longer `isConnected`) are dropped on read.
