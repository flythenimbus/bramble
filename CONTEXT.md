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
  local change to VaultEntries: add, import (bulk, one write), update, delete
  (single or bulk). Each mutation is a transition
  `(current: VaultEntries, input) -> next: VaultEntries` that performs the
  encrypt-and-write as its effect and returns the next state; it holds no React
  state. `EntryData` is validated against `entryDataSchema` at this seam before
  anything is encrypted. The autofill index is refreshed here on every persist, so
  it can never drift from what was written. The bulk forms exist because a persist
  re-encrypts and rewrites the WHOLE vault: `importMany` and `removeMany` collapse
  a batch into one write rather than one per entry, and `remove` is expressed in
  terms of `removeMany` so there is a single delete path.
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
- **PortableVault** — a `.bramble` file holding a subset of entries, sealed under a
  key generated for that file alone (`seal_portable_vault` / `open_portable_vault`
  in core-rust, framed as VLT1 by `core/export/portable-vault.ts`). The key is the
  whole point: sealing under the session VEK would make any exported file a second
  door to the entire vault, guarded by whatever password was typed into an export
  dialog rather than by the master password. Both calls are session-free, so they
  work on a locked vault and cannot disturb an unlocked one. The container framing
  stays in TypeScript so VLT1 has one implementation, not one per language.

## Bulk actions

- **BulkAction** — a self-contained descriptor for one action over the vault list's
  selection (`app/bulk-actions/`), mirroring EntryMode. Registering one in
  `app/bulk-actions/index.ts` is the only step to add it: the toolbar menu, its
  enablement and its dialog all read from the descriptor, and nothing in
  SelectionBar / VaultHome / VaultHomeRoute changes. `isAvailable(platform)` hides
  an action the platform cannot perform; `isEnabled(entries)` greys out one this
  selection does not suit. Every action owns a dialog and there is deliberately no
  run-immediately path, because these mutate or export many secrets at once.

## Autofill detection

- **PageFieldModel** — the parsed, in-memory description of a web page's fillable
  fields: the login fields (username/password/new-password), the card fields, and
  the one-time-code inputs, holding live element references. Produced once by
  `parsePageFields(root)` (the pure parser in `content/detection.ts`) and cached;
  the content script's MutationObserver invalidates it. Callers (content, fill,
  capture, picker) read the model instead of each re-scanning the DOM, and
  `candidateKind(el)` becomes a lookup against the model rather than a fresh scan.
  Stale references (elements no longer `isConnected`) are dropped on read.
- **Segmented widget / mirror**: a one-time code split across N single-character
  **boxes**, often alongside a visually-hidden **mirror** input holding the
  assembled code for the form and for OS-level code autofill. The model keeps all
  of them; `splitOtpFields` tells the boxes from the mirror at fill time, because
  they are written to differently (see docs/autofill.md).
