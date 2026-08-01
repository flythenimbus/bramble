# Password changelog

A login keeps its recently superseded passwords so a rotation that hasn't
propagated yet is still recoverable.

## Why

Some systems apply a password change asynchronously. Entra ID is the common
example: you rotate, the new password is accepted by the portal, and for the
next several minutes some services still expect the old one. If the old value
was overwritten and gone, you are locked out of those services until propagation
finishes, with no way to get back in.

Keeping the last few values turns that from a lockout into an inconvenience.

## Shape

`LoginEntryData` gains an optional field:

```ts
passwordChangelog?: { value: string; changedAt: number }[]
```

Newest first, capped at `MAX_PASSWORD_CHANGELOG` (5). `changedAt` is the epoch
ms at which that value *stopped* being current, so a row reads "this password
was replaced at this time".

The cap is deliberate. This is a propagation-lag safety net, not an audit trail.

### Retention is bounded by rotations, not by time

Be precise about what the cap does, because "keeps the last 5" reads more
reassuringly than it behaves. A row is evicted only when a **sixth rotation
pushes it off the end**. Nothing expires on a timer.

So a password you rotate once stays in the vault indefinitely, because most
entries never get rotated five more times. In practice the cap bounds how much
is kept, not how long.

There is also no way to remove a row: no per-row delete, no "clear history", and
no setting to stop recording. The only paths that drop a value are five further
rotations or deleting the entry outright.

That matters most in the case where you would most want it gone: rotating
*because* a password was compromised, or saving a value pasted into the field by
mistake. Both are retained like any other. This is a known limitation, not an
oversight; see "Not included".

### Timestamp precision

`changedAt` comes from the replacing edit's HLC wall time
(`packages/core/src/sync/hlc.ts`), which is epoch milliseconds. Two rotations a
couple of seconds apart are therefore trivially distinguishable, and the detail
view formats them to the second (`formatDateTimeExact`) rather than to the
minute, because "which of these two did I set 3 seconds ago" is exactly the
question a user in the propagation window is asking.

## Who may write it

`vault/password-changelog.ts` is the **only** writer. Every mutation in
`vault/entry-mutations.ts` (`add`, `importMany`, `update`) routes its new entry
through `withPasswordChangelog`, which derives the field from the entry already
on disk and **discards whatever the caller supplied**.

That rule exists because the edit form rebuilds an entry from its own fields. A
field it does not know about is dropped on every save. `passkeys` solves this by
hand-carrying the value through the form as a hidden field; the changelog
instead never trusts the inbound value at all, so the form needs no knowledge of
it and cannot destroy it.

The same rule means an import file cannot seed a changelog, so a hostile file
cannot pre-fill the log or grow it past the cap.

### What counts as a change

A row is recorded only when the password actually differs from the stored one.
Notably the breach-check write-back (`EntryDetailRoute`) re-saves an entry with
an unchanged password to attach a `breach` result; that must not log a row.

A previously blank password is not recorded either: filling in a password for
the first time supersedes nothing.

## Where it does not go

Superseded passwords are encrypted at rest exactly like the current one (per
entry DEK under the VEK). They are deliberately absent from every projection out
of the vault:

- **Autofill index** (`vault/autofill-index.ts`) projects named fields, so the
  changelog never reaches the content script or the native autofill providers.
  An old password must never be fillable.
- **Search** (`screens/VaultHome/vault-search.ts`) matches an explicitly built
  `searchText` haystack, not a field sweep.
- **KDBX export** (`export/kdbx.ts`) maps named fields and writes
  `HistoryMaxItems=0`.
- **Credential exchange** (`exchange/to-cxf.ts`) builds CXF credentials from
  named fields, so the changelog does not leave for another manager or the OS.
- **Native autofill** re-reads the vault rather than the index, but extracts keys
  by name on both platforms (`VaultReader.kt`, `AutofillBridge.swift`), so an old
  password can never be offered as a dataset.

Each of these is safe by construction rather than by a filter, and
`entry-mutations.test.ts` pins the autofill one.

Copying a superseded value goes through the sensitive `clipboard.copy()` path,
not `copyPlain`, so it inherits the timed clipboard auto-clear.

## What it costs

Retaining old passwords is a real trade, and the honest version is worth stating
rather than leaving implicit. Every manager that ships password history accepts
the same one.

An attacker who can read the vault already holds the *current* password for the
entry, so the marginal loss is not that account. It is:

- **Reuse.** A superseded password may still be live on some other site that was
  never migrated.
- **The scheme.** A sequence like `Summer2025!` → `Summer2026!` → `Winter2026!`
  reveals how the user generates passwords. That is worth more than any single
  value, because it helps guess credentials the attacker never captured. A
  changelog is a pattern oracle.

Accepted deliberately: the feature is worthless without retaining the values, and
the exposure only exists in a scenario where the vault is already lost.

## Sync

The changelog rides inside the entry ciphertext, so it merges with the entry.
Entry merge is whole-entry last-writer-wins on the HLC stamp (see
[p2p-sync.md](p2p-sync.md)), which means two devices rotating the same login
while partitioned still resolve to one winner, and the loser's rotation is
dropped along with the changelog row it would have written. That is the
pre-existing conflict-loser behaviour, not something the changelog changes.

Note the naming: p2p-sync.md reserves "entry history" for a *different* planned
feature, stashing the sealed losing version of a sync conflict. This is
unrelated and deliberately named "changelog" to keep the two apart.

## Not included

- **Import.** KDBX `History` elements, and the equivalents in the 1Password and
  Bitwarden exports, are still skipped on import. Only rotations performed in
  Bramble produce rows.
- **Export.** The changelog stays local to the vault.
- **A retention setting.** The cap is a constant.
- **Any way to purge.** No per-row delete, no "clear history", no off switch. If
  the retention behaviour above turns out to bother real users, a clear action
  plus a recording toggle is the fix, and both belong behind
  `password-changelog.ts` so the edit form still cannot touch the field.
