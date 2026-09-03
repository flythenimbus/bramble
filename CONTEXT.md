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
  (single or bulk), archive/restore. Each mutation is a transition
  `(current: VaultEntries, input) -> next: VaultEntries` that performs the
  encrypt-and-write as its effect and returns the next state; it holds no React
  state. `EntryData` is validated against `entryDataSchema` at this seam before
  anything is encrypted. The autofill index is refreshed here on every persist, so
  it can never drift from what was written. The bulk forms exist because a persist
  re-encrypts and rewrites the WHOLE vault: `importMany`, `removeMany` and
  `setArchived` collapse a batch into one write rather than one per entry, and
  `remove` is expressed in terms of `removeMany` so there is a single delete path.
- **Archived** — an entry carrying `archivedAt`. Retired from use but not deleted:
  it stays in the vault, in backups and in exports, and keeps its id, but leaves
  the vault list and every autofill projection (see docs/autofill.md, which names
  the three places that rule is written). Deliberately NOT a delete: no tombstone
  is written, so `setArchived(ids, false)` restores it, and a concurrent delete on
  another device still wins the merge because a tombstone beats a record. Being an
  ordinary field on the encrypted entry, it needs no vault-format change and
  converges through the same last-writer-wins merge as any edit. The list treats
  archived and live as disjoint views rather than a filter over one list
  (`VaultSearch.archived`), so an archived entry can never be mistaken for a live
  one in a list the user fills from.
- **Tags** — free-form labels on an entry (`tags?: string[]`), the vault's organisation
  axis. Every rule about them lives in `core/vault/tags.ts` and nowhere else: tags display
  as typed but compare case-insensitively (`tagKey`), whitespace is hyphenated so every
  stored tag is reachable by the whitespace-delimited `#tag` search syntax, and
  `normalizeTags` is the single gate that entry forms, bulk actions, four importers and
  the KDBX mapper all go through. `allTags` is the vault's vocabulary, offered as
  suggestions in both the search box and the editor so spellings don't drift into `work`
  / `Work` / `wrok`. Filtering is `#tag` inside the existing `q` search param rather than
  a param of its own, so clicking a tag and typing one produce the same URL. Like
  Archived, they are an ordinary field on the encrypted entry: no format change, and
  convergence through the same merge as any edit. They stay OUT of the autofill index,
  which matches pages, not organisation.
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

## Vault scoping

**MUST: no setting affects a vault other than the one it was set in.**

Every persisted value is one of two things, and which one is a decision, never a
default:

- **Device-scoped** — describes the app or the machine, and is deliberately the
  same in every vault: auto-lock timeout, theme, locale, the sync relay endpoint.
- **Vault-scoped** — describes ONE vault: its unlock gate, its sync identity, its
  backup targets. Stored at `<key>:<vaultId>` (`syncKeyFor`), listed in
  docs/multiple-vaults.md.

Anything that grants a capability against a vault's data is vault-scoped. When the
two readings are arguable, it is vault-scoped: a setting wrongly shared hands one
vault a permission its owner never granted, and that is not a cosmetic bug. It
shipped once — `pref.biometricPasscodeFallback` was flat, so a second vault opened
with passcode fallback already on and the gate re-arm honoured it, leaving a vault
openable by a device passcode its owner had never allowed.

The rule is enforced where it can be. `PREF_SCOPE` in `hooks/usePrefs.tsx` is
exhaustive over `Prefs`, so a new preference does not compile until its scope is
declared. Prefer that shape to a comment for anything else that grows this way.

Two consequences worth stating, because both have been got wrong:

- **Reading is scoped too, not just writing.** The provider re-reads vault-scoped
  prefs when the active vault changes, and resets them to their defaults first, so
  the window before the read lands shows the closed position rather than the
  previous vault's answer.
- **Native caches are settings too.** A keychain item or an App Group value that
  gates a vault is subject to this rule exactly as a pref is: it is keyed by vault
  id, and a process that cannot know the vault id has no business reading it.

## Autofill detection

- **PageFieldModel** — the parsed, in-memory description of a web page's fillable
  fields: the login fields (username/password/new-password), the card fields, and
  the one-time-code inputs, holding live element references. Produced once by
  `parsePageFields(root)` (the pure parser in `content/detection.ts`) and cached;
  the content script's MutationObserver invalidates it, but only for a batch that
  moved something field-shaped. Callers (content, fill, capture, picker) read the
  model instead of each re-scanning the DOM, and `candidateKind(el)` becomes a
  lookup against the model rather than a fresh scan. Stale references (elements no
  longer `isConnected`) are dropped on read.
- **PageScan** — the one DOM collection a parse is allowed: every `input` in the
  tree, in DFS pre-order, gathered by `createScan()` and filtered by each detector
  rung. Traversal crosses open shadow roots only on pages that have one (a
  memoized census decides), so everywhere else a rung is a native
  `querySelectorAll`. Both paths yield the same pre-order, which rung 1 of
  `detectLoginFields` depends on. See docs/field-detection.md.
- **Segmented widget / mirror**: a one-time code split across N single-character
  **boxes**, often alongside a visually-hidden **mirror** input holding the
  assembled code for the form and for OS-level code autofill. The model keeps all
  of them; `splitOtpFields` tells the boxes from the mirror at fill time, because
  they are written to differently (see docs/autofill.md).
