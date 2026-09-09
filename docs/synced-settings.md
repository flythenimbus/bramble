# Synced settings (planned)

How a setting that belongs to a *vault* rather than a *device* travels between
devices. The email alias provider is the first one that needs it (see
[email-aliases.md](email-aliases.md)), but the point of this design is that it is
the mechanism, not that one setting: hand-picking what goes over the wire should
be a one-word change in a table the compiler already forces you to fill in.

## Where things stand

Nothing settings-like syncs today, and precisely so. Sync moves two payloads:
`EntriesPayload` is `{ entries, tombstones }` and `RosterPayload` is
`{ devices, revoked }`, which is device membership. Nothing under
`core/src/sync/` calls `getMeta` or `setMeta` at all.

Every setting is a `storage.setMeta` key, and `usePrefs` already sorts them into
two kinds through an exhaustive table:

```ts
type PrefScope = "device" | "vault";
const PREF_SCOPE: Record<keyof Prefs, PrefScope> = { ... };
```

That table is the reason a new preference does not compile until someone decides
what it is, which CONTEXT.md calls out as the shape to prefer. This design adds a
third answer to the same question.

## The extension point

```ts
type PrefScope = "device" | "vault" | "synced";
```

- **device** — describes this app or this machine. Auto-lock timeout, theme.
  Stored flat.
- **vault** — describes one vault on this device. Its unlock gate. Stored at
  `<key>:<vaultId>`.
- **synced** — describes the vault itself, wherever it is opened. Stored in the
  vault's encrypted payload and merged like any other replicated state.

Adding a synced setting is then: add the field to `Prefs`, give it a key in
`META_KEYS`, and write `"synced"` in `PREF_SCOPE`. `usePrefs` routes the read and
the write; no consumer of `usePrefs` knows or cares which scope it got, because
the hook's surface (`prefs`, `loaded`, `update`) does not change.

Everything below exists to make that one word safe.

## Which settings are eligible

Not all of them, and the constraint is not taste. **A synced setting lives in the
VEK-encrypted payload, so it cannot be read while the vault is locked.** The
extension background reads several prefs from `chrome.storage.local` precisely
because it must answer while locked: `getAutoLockMinutes`, `getLockOnScreenLock`,
`getAutofillEnabled` (`background/prefs.ts`). A setting that decides how the app
behaves before unlock can never be synced, and the table should not pretend
otherwise.

The rule, worth stating in the code next to the scope table:

> If anything needs the value while the vault is locked, it is device-scoped.
> Everything else is a candidate.

That is why the alias provider is a good first one. It is only ever used behind an
unlock: the entry form, and an in-page row that a locked vault already replaces
with the unlock prompt.

## Why not the two obvious wire formats

Both were tried on paper and both are wrong, which is worth recording so they are
not re-proposed.

**A new field on the payload, read naively.** `EntriesPayloadSchema` is a plain
`z.object`, so zod strips unknown keys, and `encodeEntriesPayload` re-parses on
every write (`sync/entries-payload.ts:32`). Measured with a throwaway test: an
older client drops a new field on read *and* on write-back. The Chromium
extension is publicly released, so those clients exist.

**A settings-shaped entry in the `entries` array.** Appealing, because entries
merge as opaque sealed envelopes an old client cannot drop. But `getEntryMode`
falls back to login for unrecognised types (`app/entry-modes/index.ts:21`), so on
every older device it appears as a junk login: counted in the stats, written into
exports, and one tidy-up away from a tombstone that deletes the configuration on
every device. That trades a silent strip for a user-visible booby trap.

## The wire format

A map of stamped records, keyed by the pref's existing meta key:

```ts
settings?: Record<string, { hlc: Hlc; value: unknown | null }>
```

Four properties, each load-bearing:

**Absent means "no opinion", never "deleted".** This is what makes old clients
harmless. `applyRemotePayload` always computes `mergeEntriesPayload(local, remote)`
and never replaces local with remote (`sync/apply-remote.ts:69`); each device
writes its own blob. So an old client that strips the map damages only its own
copy, and when its stripped payload comes back, the merge sees no opinion and
keeps what it has. An old device cannot carry a synced setting, and cannot destroy
one.

**Clearing is an explicit `value: null`.** For the same reason: absence is what an
old client produces, so it cannot also mean "the user turned this off".

**One stamp per key, not one for the map.** Two devices changing two different
settings must both win. Per-key stamps get that for free, because
`mergeReplicas` is already generic over anything carrying an `hlc`
(`sync/merge.ts:77`).

**The value is validated on read, never trusted.** Exactly as `pref.generator` is
today: `usePrefs` runs `normalizeGeneratorSettings` on whatever it finds, because
a stored object may have been written by another build. A synced value has the
same problem plus a remote writer, so each synced pref declares a normalizer and
a bad value falls back to the default rather than propagating.

## Every seam this touches

The mechanism is small; the plumbing is not. The first two would ship broken
without being obvious in review.

1. **`buildPayload` rebuilds the payload from `VaultEntries` on every local write**
   (`vault/entry-mutations.ts:102`), and `VaultEntries` is `{ entries, stamps,
   tombstones }`. Unless it carries the settings map too, **every ordinary entry
   edit silently wipes every synced setting.** The failure is invisible locally
   and surfaces as settings that keep reverting.

2. **`payloadsEquivalent` decides whether a merge is worth writing and
   re-broadcasting** (`sync/apply-remote.ts:49`) and compares entries and
   tombstones only. A settings-only change would compare equal, so the write is
   skipped and it never propagates: the setting would appear to sync only when it
   happened to ride along with an entry edit.

3. **`sanitizeRemoteEntriesPayload` drops future-dated stamps** so a peer cannot
   pin an un-deletable record (`sync/entries-payload.ts:43`). Settings stamps need
   the same, or a clock-skewed peer pins a setting nobody can change.

4. **`mergeEntriesPayload`** gains the map merge: per key, higher stamp wins;
   a key present on one side only is kept.

5. **One writer.** `EntryMutations` owns every local change to the payload, which
   is what keeps the autofill index from drifting from disk. A settings write is
   another mutation there, not a second writer racing it.

6. **`usePrefs` routing.** Reads: device and vault as today; synced from the
   decrypted payload. Synced prefs read as their defaults until the vault is
   unlocked, and the provider must reset them on a vault switch before the read
   lands, the way it already does for vault-scoped prefs.

7. **Migration, once.** A device-local value is adopted into the synced map only
   when the map has no entry for that key, so a device that never had one cannot
   write a default that then wins the merge.

## Decisions taken

**Outer VEK layer only.** Entries carry a second per-entry DEK; this map, sitting
beside `tombstones`, does not. That is the protection the vault's structure
already has. It also *simplifies* the alias key, which is VEK-wrapped by hand
today and would no longer need to be.

**Vault-scoped by construction.** The map lives inside one vault's encrypted
payload, so it cannot leak into another. Strictly stronger than the
`<key>:<vaultId>` convention, and it satisfies CONTEXT.md's MUST without anyone
having to key it correctly.

**No VLT1 change.** The map lives in the encrypted payload, so the binary
container is untouched, exactly as tombstones were when they were added.

**Keyed by the existing meta key.** A pref that changes scope keeps its name, so
migration is a move rather than a rename, and a key can never mean two things.

## Compatibility, and what is actually being claimed

Two different claims get confused here, so they are separated.

### The format is safe for released clients

Verified against the current code rather than reasoned about:

- **An unknown field does not crash an old client.** `EntriesPayloadSchema` is a
  plain `z.object`, so zod strips unknown keys instead of throwing. Confirmed with
  a throwaway test that ran a payload carrying an extra field through
  `decodeEntriesPayload`.
- **An old client damages only its own copy.** It strips on read and on
  write-back, so its local blob loses the map. Nothing else does.
- **A stripped payload cannot delete a current device's copy.**
  `applyRemotePayload` always computes `mergeEntriesPayload(local, remote)` and
  never replaces local with remote (`sync/apply-remote.ts:69`), and every device
  writes its own blob.
- **Enrollment has nothing to lose.** The inviter ships its payload to a joiner
  that is creating a fresh vault, so the joining side has no prior map.
- **Background readers are indifferent.** They destructure `.entries`
  (`background/autofill-index.ts:355`, `background/passkey-store.ts:75`).

### The implementation is where the risk actually is

The point above is about a design that does not exist yet, and it holds only if
the merge rule and the `VaultEntries` threading are written correctly. That
threading lives in `buildPayload`, which is the single write path for **every
entry in the vault**. So the honest statement is not "this cannot harm users":

> The format change is safe for old clients. The implementation touches the most
> important write path in the app, and a bug there could damage entries, not just
> settings.

Settings reverting is annoying. A wrong `buildPayload` is data loss. The plan puts
that work in its own step for this reason, and the tests below exist to make it
fail loudly rather than quietly.

### Known rough edges, accepted

- **Old devices silently never receive synced settings**, with no signal to the
  user, because there is no version negotiation to explain it. A gap, not harm.
- **A backup taken by an old client will not contain them**, so restoring one
  loses them. True of any state that client did not have.
- **Migration collision.** Someone who configured the same setting on two devices
  before this lands will find one wins and the other is silently replaced. Nobody
  is affected today, because the alias provider is unreleased. That is an argument
  for doing this now rather than after it ships.

## Confidence tests

These are the ones that decide whether the change is safe, and each targets a
failure that is otherwise silent. Written before the code they cover, and each one
confirmed to FAIL with its fix reverted, since a test that cannot fail is worse
than none.

1. **An old-shaped payload round-trips without touching vault content.** Merge a
   payload that has no `settings` map with one that does; assert entries and
   tombstones are byte-identical to the plain two-way merge. This is the one that
   says the format change cannot damage data.

2. **An entry mutation preserves the settings map.** Add, edit, archive and delete
   an entry through `EntryMutations`; assert the map survives each. This is the
   highest-risk seam: `buildPayload` rebuilds the payload from `VaultEntries` on
   every write, so without threading, every edit wipes every synced setting, and
   nothing local looks wrong.

3. **A settings-only change is not judged redundant.** Assert
   `payloadsEquivalent` returns false when only the map differs. Without this the
   merge is skipped, nothing is written, nothing re-broadcasts, and the setting
   appears to sync only when it happens to ride along with an entry edit.

4. **Absent is not deleted.** Merge a payload holding a setting with one that has
   no map at all; assert the setting survives. This is what makes an old client
   harmless, so it is the property most worth pinning.

5. **Cleared is not absent.** Merge a `value: null` at a higher stamp over a real
   value; assert the value is gone. Distinguishing these is why clearing is
   explicit.

6. **Per-key independence.** Two devices change two different settings; assert
   both survive the merge. A single stamp for the whole map would pass every test
   above and fail this one.

7. **A future-dated settings stamp is dropped.** Mirror the entry guard: assert
   `sanitizeRemoteEntriesPayload` discards a settings record stamped years ahead,
   so a clock-skewed or hostile peer cannot pin a setting nobody can change.

8. **Migration adopts only into an empty slot.** Assert a device-local value is
   taken up when the map has no entry for that key, and ignored when it does, so a
   device that never had one cannot write a default that then wins.

The device test in the plan is the one that proves the whole thing: configure on
one device, confirm it arrives on the other, then edit an entry on each and
confirm the setting survives both.

## Plan

| Step | Work | Risk |
|---|---|---|
| 1 | `settings` map on the payload schema; the merge rule; `payloadsEquivalent`; `sanitize`. Confidence tests 1 and 3-7 first. | low, isolated |
| 2 | Thread through `VaultEntries` and `buildPayload`; a settings mutation in `EntryMutations`. Confidence test 2. | **highest**, silent if wrong |
| 3 | `PrefScope` gains `"synced"`; `usePrefs` routes reads and writes; per-pref normalizers; the locked-vault rule documented beside the table. | medium |
| 4 | Move the alias provider onto it, dropping its hand-rolled VEK wrapping, and migrate the existing meta key once. Confidence test 8. | medium, one-way |
| 5 | Settings copy: say it syncs. Locales. | low |
| 6 | Device test: configure on one device, confirm it lands on the other; then edit an entry on each and confirm it survives. | the one that proves it |

Estimated 3 to 4 days, most of it steps 2 and 6. That is a day more than moving
the alias provider alone would cost, and it buys every later setting for the price
of a word in a table.

## What would make this wrong

- If **per-device values** turn out to be wanted for something that looks synced.
  Nothing here supports that, and retrofitting per-device records inside a synced
  map is worse than what it replaced.
- If the eligible set stays at one. A mechanism for a single setting is
  over-built; the case rests on there being a second and third (a shared alias
  provider, and plausibly the generator settings, which are device-scoped today
  for no strong reason).
- If syncing a third-party credential materially widens a breach. It does not
  today: the key is already inside the vault on the device holding it, and sync
  moves it only between devices that already share the vault key.
