# Sync conflicts: keep every edit, then merge fields (plan)

**Status:** Phase A built 2026-10-23 (all targets share the core; not yet device-tested, and the new UI strings await translation). The website's sync copy still describes last-writer-wins, on purpose: it deploys on every push, so it changes when a release with Phase A ships. Phase B built 2026-10-24 (B1: part stamps recorded; combining switched off by `COMBINE_CONCURRENT_EDITS` until most devices run it; not yet device-tested). Flipping the constant (B2) is a separate release, with the README and site copy.

Today two devices that edit the same entry before they sync lose one edit whole and say nothing
(see "Conflict loser" in [p2p-sync.md](p2p-sync.md)). This plan fixes that in two phases:

- **Phase A** keeps every concurrent version and shows the conflict. No edit is ever silently lost,
  and the merge still compares only stamps.
- **Phase B** merges concurrent edits field group by field group inside the crypto core, so edits
  that touched different parts of an entry combine on their own. Anything it can't combine
  safely falls back to a Phase A conflict.

## Already done: a use is not an edit

`EntryMutations.touch` used to restamp the entry on every copy or fill (coalesced to once a
minute), so using a login on one device beat an edit made to it on another. It now writes
`lastUsedAt` without restamping, which makes `lastUsedAt` per-device: it reaches other devices
only with the entry's next real edit, and is the one field that two envelopes with the same id
and stamp may disagree on (`sync/vault-merge.ts`).

## Phase A: keep the losing version, show the conflict

### Prerequisite: a breach refresh is not an edit either

Opening a login whose breach status is over a week old re-checks it and saves the result through
`updateEntry` (`EntryDetailRoute`), which restamps the entry exactly as `touch` used to. Today that
lets viewing a login on one device overwrite an edit made on another; under Phase A it would raise
a conflict nobody caused. The refresh must write `breach` without restamping, making it per-device
like `lastUsedAt`.

### Telling a conflict from an ordinary edit

LWW replaces a version every time anything is edited, so "the loser" is usually just the
previous version. A conflict is a loser that is **concurrent** with the winner, and stamps alone
cannot tell the two apart: device B holding an old version S1 that receives A's S3 (edited S1 to
S2 to S3) must not see S1 as a conflict.

So each version carries its **causal history**, `H(V)`, in two parts:

- `vv: Record<writerId, Hlc>`: per writer, the stamp of its latest event in V's history.
- `floor?: Hlc`: every event stamped at or before it is in V's history. Only lineages that pass
  through a version written by an older build have one (see "Older builds" below).

A version's own event is `(writer, hlc)`, where `writer` is the `vv` key whose value equals the
version's `hlc`. **X is an ancestor of Y iff X's own event is in H(Y)**: `X.hlc <= Y.floor`, or
`X.hlc <= Y.vv[writer(X)]`. Two copies with the same id and `hlc` are the same version.

A write's history is the union of the histories of the versions it supersedes (its **bases**)
plus its own event: `vv` is the component-wise max of the bases' `vv`s plus `{ [writer]: hlc }`,
and `floor` is the max of the bases' floors.

**Each writer's events on one entry must form a chain**: every event a writer makes descends from
all its earlier ones on that entry. The per-writer max is only exact under that rule. The rule
breaks when a device edits the displayed version while its own earlier edit sits in an unresolved
sibling. A naive `vv` would then claim the new version descends from that sibling, and the merge
would prune it. So the writer key is the device's node id unless the bases don't contain that
key's latest event on this entry. In that case the device writes under a **fork key**,
`<nodeId>~<formatHlc(stamp)>`, reusing an existing fork key of its own whose latest event the bases
do contain. A writer's latest event on an entry is the max over every version held for that id
(displayed, sibling and tombstone) of `vv[key]`, plus the own event of any version with no `vv`.

The vector stays small: one key per device that ever edited the entry, plus a fork key for each
time a device edited around an unresolved conflict.

**A writer key must belong to one sequential writer.** Node ids are random per device and per
vault (`ensureDeviceId`), so two devices never share one. The extension is the exception: its
popup and its background service worker each build a clock from the same device id, and both
write entries. A corner-prompt update landing while the popup holds a stale copy would make two
concurrent versions under one key, and the per-writer max would call the earlier one an ancestor
and prune it. So the background clock uses its own node, `<deviceId>#bg`. The extension's UI
contexts (popup, options page, pop-out) still share the device's node. Two of them editing the
same entry at the same instant can still lose one edit, as today; that race needs two windows
open on one entry.

### Which versions a write supersedes

| Write | Bases |
|-------|-------|
| `add`, `importMany`, a new corner-prompt or passkey login | none |
| `update`, `setArchived`, `setTags`, a corner-prompt update, a passkey placement | the displayed version only; siblings stay |
| an edit-form save (Phase B) | the version the form opened; one displayed since then stays, as its sibling |
| `remove`, `removeMany` | every live version and the tombstone: deleting the entry you see deletes the entry, but edits you haven't received yet still come back as a delete conflict |
| a resolution | every live version and the tombstone |
| `touch`, the breach refresh | not a new version: the displayed version keeps its stamp |

### Siblings, not a loser list

An entry id holds a set of **siblings**: the versions no other held version descends from. That
is a multi-value register (Dynamo/Riak siblings). Merging is union, then prune **top-down by
stamp**: walk the versions from the highest stamp down, and keep one unless it is dead under the
tombstone or is an ancestor of a version already kept. On histories built by the rules above,
"ancestor" is inclusion of histories, a partial order, so this equals dropping every ancestor,
and the merge is commutative, associative and idempotent. Pruning is also what makes it
associative: without it, merging (X, Y) then Z keeps X even when Z descends from X, while
merging (X, Z) then Y doesn't. Property tests over random histories and every merge order are
required, and the simulator must check `isAncestor` against the true ancestry it tracked.

Top-down matters once older builds are involved, where legacy claims make "ancestor"
non-transitive. Suppose an older build relays a stripped copy of X after X was edited into R
elsewhere, and a sibling Y stamped below X is still held. Dropping every ancestor at once lets
the stale copy's claim prune Y, a version it never saw. Top-down prunes the stale copy under R
first, so it never gets the chance.

Deletes merge into **one tombstone per id**: `hlc` is the max, `vv` the component-wise max, and
`floor` the max. By the chain rule its history is exactly the union of the deletes' histories.
Two tombstones with histories always join, even at the same stamp: a joined tombstone carries
the stamp of its newest delete, so one stamp can sit on different histories, and keeping either
copy would make the result depend on merge order (found by the property test). One exception: a
legacy tombstone at the other's stamp, or whose own event is already in the other's history, adds
nothing. It is a stripped copy of a delete already known (an older build relaying an old
tombstone after a later delete raised the stamp), and joining its claim would kill every
delete-conflicted edit stamped below it.

- A live version is **dead** iff its own event is in the tombstone's history.
- A tombstone is **superseded** iff some surviving live version's history contains all of it:
  `T.floor <= E.floor`, and every `T.vv[k] <= max(E.vv[k], E.floor)`. A superseded tombstone stays
  in the graveyard, as tombstones do today, but raises nothing.

The highest-stamp surviving live version is displayed and autofilled, exactly as today; the other
surviving live versions are **conflicts**. An entry also has a **delete conflict** when it is
visible and its tombstone is not superseded ("deleted on your laptop, edited on your phone",
decided 2026-10-23). It stays visible until someone chooses: hiding it would make the edit just
as invisible as dropping it. There's no cap: siblings only come from real concurrency, and
capping them would silently drop data.

An attachment the delete never saw raises a delete conflict too: the entry's newest version stays
shown, so the file has somewhere to be. A kept entry shows its attachments, including those the
delete marked. See [file-attachments.md](file-attachments.md), "Deleting an entry hides its
attachments".

### Wire format

- `vv` and `floor` on each `EncryptedEntry` and each tombstone, in the outer index, so choosing
  versions stays blind.
- `conflicts: EncryptedEntry[]` on the payload: the surviving live versions that aren't displayed,
  still sealed.
- No separate resolution record: a resolution is a write whose bases are all the siblings.

`vv` values are full `Hlc` objects, like every other stamp in the payload. That costs roughly 120
bytes per writer per edited entry, a 7 to 17% larger outer payload for a vault whose entries have
all been edited once. Entries nobody has touched since the upgrade carry nothing.

### Older builds

`EntriesPayloadSchema`, `EncryptedEntrySchema` and `TombstoneSchema` are plain `z.object`s, so
older builds strip `vv`, `floor` and `conflicts` on read and on write-back. The synced-settings
rule carries over ([synced-settings.md](synced-settings.md)): an absent `conflicts` means no
opinion, never "resolved".

A version with no `vv` is treated as an LWW claim: its history is **every event stamped at or
before its `hlc`** (`vv = {}`, `floor = hlc`), and its writer is `hlc.node`. That is what an older
build means by a write. Unlike "compare legacy versions by stamp", it keeps ancestry a single
consistent order. A newer build editing a legacy base inherits the claim as its `floor`.

- **Same-stamp copies.** A legacy copy with the same id and `hlc` as a version that has a `vv` is
  the same version stripped, so the merge keeps the `vv` copy and ignores the copy's claim. That
  matters for tombstones in particular: joining a stripped copy's floor in would silently turn
  every delete conflict back into "the delete wins".
- **What degrades.** An older build's genuine edit still dominates every version stamped before
  it, which is exactly today's LWW. In a mixed group the outcome can then depend on merge order,
  but every device converges once gossip settles. Nothing is worse than today.
- **A stale copy that arrives first.** An older build only relaying a stripped copy is harmless
  when the original, or a version descending from it, reaches the device first: the copy is then
  recognised and pruned. If the stripped copy arrives first, its LWW claim can prune versions it
  never saw, or kill a delete-conflicted edit, on that device, exactly as LWW would. A forked
  write is stamped with its fork key as the node, so a stripped copy of one still names its
  writer; otherwise such a copy could even bring back a deleted entry, which is worse than LWW.
  A property test pins the bound: in a mixed group the version LWW would keep always survives,
  and an entry every delete saw stays deleted.
- **Equivalence.** `payloadsEquivalent` must count a `vv` copy as different from a stripped one,
  or a device keeps its stripped copy forever and makes LWW claims it doesn't need to.

### Everything that carries the payload

`VaultEntries` must carry each version's `vv`/`floor`, each tombstone's, and the conflicts, and
`buildPayload` must thread them through, or the next local write erases them. That is the trap
the settings map hit in the extension background, so every write site needs a test that the new
fields survive it. The sites are:

- `entry-mutations.ts` and `useVault`'s load path. The load path also canonicalizes the stored
  payload by merging it with an empty one before decrypting. A quarantine that set aside an
  undecryptable displayed version can otherwise leave its siblings with nothing displayed.
- The extension's background writers (`corner-prompt.ts`, `passkey-store.ts`, through
  `vault-io.ts`), which must also witness the conflicts' stamps before writing.
- The merge-side admission check, which must also test-decrypt incoming conflicts, and the clock,
  which must witness their stamps and every `vv` component.
- The remote sanitizer, which must drop any version whose `hlc`, `floor` or any `vv` component is
  future-dated.
- `sealAll`. Conflicts are sealed under DEKs wrapped by the current vault key, so rotating the key
  must re-seal them as well.

### UI

A conflict badge on the entry in the list, and on the detail screen a banner with a compare view
that decrypts the siblings on demand (`decryptEntries` already exists). Each version renders
through its type's existing `mode.Detail` body, with a copy handler that doesn't record a use. It
offers:

- **Keep this one.** Resolves with the displayed content.
- **Use this one.** On a sibling: resolves with that sibling's content, through the same
  password-changelog rule as an edit.
- **Keep both.** The sibling becomes a new entry with a new id, and the original resolves with
  the displayed content.

A delete conflict offers **Keep it** and **Delete it**. When an entry has both sibling versions
and a delete conflict, the banner says both and the compare view also offers **Delete it**. The
UI is shared across targets; run `pnpm i18n:extract` for the new strings.

Known limits, not built in Phase A:

- **Fill only sees the displayed version.** Autofill and every passkey lookup (extension
  background, Android `VaultReader`) read the displayed version only. A passkey created inside a
  version that lost the display can't be used until the conflict is resolved, but today it's
  lost outright.
- **Some exports leave the other versions out.** A selection export (.bramble) and a KeePass
  export include only the displayed version. The export dialogs say how many conflicted entries
  that affects. A full backup is the sealed vault and keeps everything.

### Effort

About 1.5 to 2 weeks:

- **Core (3 to 4 days).** `vv` on writes, the sibling merge with property tests, `payloadsEquivalent`
  and the remote sanitizer covering the new fields, and mixed-version tests.
- **UI (2 to 3 days).** The badge, the compare view and i18n.
- **Wiring and device testing (2 to 3 days).** The extension, desktop, iOS and Android.

Risk is low to medium: the change is additive, the merge stays blind, and older builds behave as
they do today.

## Phase B: combine edits to different parts of an entry

Decided with the user 2026-10-23. When two devices change the same entry before they sync,
changes to **different parts** combine on their own; if both changed the **same part**, the pair
stays a Phase A conflict for the user to choose. Combining happens during sync (background sync
included) and when a vault loads, it is silent (a combined entry just looks edited), and it ships
in two releases (see "Rollout").

The failures that matter even if it "works": an entry nobody wrote (one device's username with
the other's password), a removal on one device quietly undone by the other's addition, devices
that never agree on the combined result, and any credential lost to a combine.

### What a part is

A **part** is one top-level field of the decrypted entry, except fields that must move together:

| Part | Fields |
|------|--------|
| credential (login) | `username`, `password`, `totp` |
| card (card) | `cardholderName`, `number`, `brand`, `expMonth`, `expYear`, `cvv` |
| key (ssh-key) | `publicKey`, `privateKey`, `passphrase`, `keyType` |
| one part per field | every other field: `name`, `notes`, `customFields`, `archivedAt`, `autofillEnabled`, `autoSubmit`, `subdomainMatch`, and any field this build doesn't know (a newer build's), compared as opaque JSON |
| item by item | `urls` (by string), `tags` (by `tagKey`), `passkeys` (by `credentialId`) |

A field named like one of its type's groups (a future top-level `credential` on a login) is a part
of its own, named `field:credential`, so it can't take the group's place.

Not parts, because they are derived or per-device: `createdAt` (take the earliest), `updatedAt`
and `lastUsedAt` (take the latest), `breach` (follows whichever credential is kept), and
`passwordChangelog` (the union of both sides' rows plus any superseded password, through
`withSupersededPasswords`, still capped; a superseded password is dated when the password that won
replaced it, not when the versions combined). A different `type` on the two sides is a conflict.
`customFields` has no item ids, so it is one part: both devices editing custom fields is a
conflict.

### Part stamps

Every write records, inside the encrypted entry JSON (so older builds keep it; see vault-format.md
"Forward compatibility"):

- `partStamps: Record<part, Hlc>`: the stamp of the write that last changed each part. A write
  copies the previous stamps and restamps only the parts whose value it changed.
- `itemStamps: { urls?, tags?, passkeys?: Record<itemKey, Hlc> }`: the stamp of the write that
  added each list item. A tag's key is case-folded without the device's locale (`tagKey`'s
  locale-aware fold stays for display), since keys are compared across devices.
- `partStampsAt: Hlc`: the version's own stamp at the time it wrote these. A version whose `hlc`
  differs was rewritten by a build that doesn't keep part stamps (Phase A or older), so all of
  its parts and items count as changed at its own `hlc`. A version with no part stamps at all
  counts the same way.

Only stamps older than `partStampsAt` are stored, plus clears: a present part or item without one
reads back as changed at the version's own stamp. Most stamps are the write's own, so this keeps an
entry close to its plain size (the final review measured a typical login at 4.5 times it with every
stamp stored).

`touch` and the breach refresh don't restamp the version, so they don't touch part stamps.

A resolution supersedes every version the user compared, not just the one it keeps. Wherever one
of them disagrees with the kept content (a part's value, or an item it lacks), keeping that value
was a choice, so the resolution restamps it at its own stamp. Otherwise the kept value would carry
an older stamp than the dropped one, and a later combine with an edit of the dropped version
(which never saw the resolution) would bring the dropped value back. The combine property tests
found this. A resolution over a delete restores everything it keeps, so it restamps all of it.

### Combining two versions

Both versions are siblings, so neither descends from the other. Decisions use the Phase A
histories with one restriction, **seen** (my call after the builder check):

- A stamp X records through its `vv` (a write that carried a history) counts as seen by Y only
  if Y's `vv` covers it: `Y.vv[stamp.node] >= stamp`.
- A stamp X covers only through a `floor` (an older build's write, or one from before the
  upgrade) counts as seen by Y if Y's `vv` or Y's `floor` covers it.

A `floor` is an older build's last-writer-wins guess. It may stand in for older builds' events,
which have nothing better, but never for a newer build's change it can't have seen; otherwise an
older build's edit stamped later could drop a passkey or restore an old password a newer build
had changed. With the restriction, such a pair is a conflict instead. (A stamp's writer key is its
`node`, which is why forked writes are restamped; see "Older builds".)

- **A part.** If the values are equal, keep it. Otherwise, if X's part stamp is seen by Y, Y has
  the newer value: take Y's. If Y's is seen by X, take X's. If neither, both changed it: **the
  pair doesn't combine** and stays a conflict. If both are seen and the values still differ, some
  write kept a value without restamping it, and the higher stamp isn't the answer: no combine.
  A side with no stamp for the part never set it, unless it has seen the other side's stamp and
  still lacks the value: then it cleared it (an older build's clear records no stamp).
- **A list.** An item on both sides stays. An item only on X stays if its add stamp is **not**
  seen by Y (X added it concurrently), and goes if it is (Y saw it and removed it). Symmetric
  for Y. A re-added item has a new add stamp, so it survives a concurrent removal of the old one.
  Order: the higher-stamp version's order, then the other side's new items in its order. Two
  items under one key (a duplicated URL) mean no combine.
- **Stale stamps** (an older build's edit): every part counts as changed at its `hlc`, a stamp
  only its own claim covers, so the other side never sees it; it combines only where the values
  happen to be equal. Its list items carry no real add stamps, so an item only on the stale side
  can't be told from one the other side removed: **no combine** (the final review found removals
  undone). An item on both sides keeps the other side's add stamp when the stale side has seen it,
  so a combined version never passes the stale claim on as an add. Two stale versions don't
  combine at all: neither carries anything to combine by.

Three or more siblings combine in a fixed order (by stamp, highest first), folding each into the
result while it combines and leaving it as a sibling when it doesn't.

### The combined version

A combined version is a pure function of the siblings it replaces, so every device that combines
the same set writes the same version and nothing bounces:

- `vv`: the join of the inputs' histories, plus its own event; `floor`: their max.
- `hlc`: the highest input's `wall` and `counter + 1`, with a synthetic node,
  `~merge:<id>`, where `<id>` is a SHA-256 (base64url, 16 bytes) of the inputs' sorted
  `causalKey`s. The node is unique per input set, so two devices that combined different sets
  never share a stamp, and it doubles as the writer key, used once.
- Plaintext: built as above; `partStamps` and `itemStamps` carried from the side each value came
  from; `partStampsAt` is the combined `hlc`. A login keeps its `urls` list when it ends up empty.

A combined version is an **ancestor** of any version or delete whose history holds all its inputs:
it is a pure function of them, so whoever saw them all has seen it. Without that, a delete made
by a device that held the inputs uncombined would come back as a delete conflict against the
combined version (found by the final review).

Ciphertext differs per device (fresh DEK), the content doesn't. A device that combined a
different set produces a different version; when they meet they are siblings again and combine
again, finitely.

**The rules are a wire protocol** (my call after the builder check). Two builds that combine the
same inputs differently would write different content under one stamp, and devices would keep
different entries forever without noticing. So:

- `COMBINE_RULES_VERSION` (starting at 1) is the stamp's counter offset: `counter` is the highest
  input's `counter + COMBINE_RULES_VERSION`. Results for the same inputs share the writer key
  `~merge:<id>`, so a newer rules version's result descends from an older one's and replaces it,
  instead of the two bouncing as siblings. A device that already pruned the inputs keeps the
  older result; that is accepted.
- Within one rules version the output is frozen: golden test vectors (inputs and expected
  plaintext) live in the repo, and changing parts, normalization or list rules means bumping the
  version.
- A field added later is its own opaque part unless its release also bumps the rules version;
  builds on older rules treat it as its own part anyway.

### Saving the edit form (decided with the user 2026-10-23)

The edit form keeps the values it opened with, so a change that syncs in while it is open was
silently overwritten on Save: the save superseded whatever was displayed at that moment. Phase B
makes that worse, because the overwritten parts would then carry fresh part stamps and win later
combines too.

So the form records the version it opened (its stamp, history and decrypted data), and saving
supersedes **that** version, not the displayed one. Part stamps are restamped only where the
saved value differs from the opened version's. A change that arrived meanwhile is then concurrent
with the save: the two combine, or conflict where both touched the same part. The pop-out draft
carries the opened version with its values. This also helps under B1 with combining off: the
overwrite becomes a visible conflict instead of a silent loss. Phase A's bases table gains a row:
an edit-form save supersedes the version the form opened.

### Where it runs

In `applyRemotePayload` after the merge, and in `useVault`'s load after canonicalizing, through a
new `VaultSyncPort`/crypto hook that decrypts the siblings, combines, and seals the result. On
desktop and mobile that is the same process that already decrypts entries to show them; in the
extension it is the background, which already decrypts entries for corner-prompt saves. The
device witnesses the combined stamp so its next write sorts after it. Only ids with siblings
are touched, so the cost is negligible.

It can't make things worse than Phase A, by construction:

- **Each entry on its own.** One entry whose versions won't open or won't combine keeps its
  conflict; the others still combine.
- **Checked before it replaces anything.** A combined version must open again under the vault's
  key before it prunes its inputs, so a key that changed mid-combine (mobile's one global key)
  leaves the conflict instead of an unreadable entry.
- **Into what's on disk, not over it.** Nothing coordinates the extension background's writes
  (a corner-prompt or passkey save) with a view's or a merge's, so the load-time combine and
  every merge write merge into a fresh read: a merge loses nothing by being applied again.
- **A failure is a conflict.** Any error leaves the versions as Phase A would show them.

Native autofill (Android `VaultReader`, the iOS extension) reads only the displayed version, so
combining at sync time, not at display time, is what gets the combined password to fill.

### Older builds

- A Phase A or older build that edits a combined entry keeps `partStamps` (unknown keys survive)
  but not `partStampsAt`'s meaning, which the mismatch check catches.
- A combined version stripped by an older build is a legacy copy whose writer is its synthetic
  node, so descendants still recognise it (the same reason forked writes are restamped).
- Phase A builds treat a combined version as an ordinary newer version, which it is.

### Rollout

1. **B1**: every writer records `partStamps`, `itemStamps` and `partStampsAt` (core mutations,
   resolutions, the extension's corner prompt and passkey placement). The combine code ships
   too, switched off by a constant (`COMBINE_CONCURRENT_EDITS = false`); tests run it on.
2. **B2**: flip the constant once most devices write part stamps. Nothing else changes in code:
   the final review's B2 blockers were fixed in B1. The README and site copy ("never compares
   plaintext", "you choose between both versions") change in that release. Until then CI also
   runs the two-peer sync suite with combining on (`pnpm test:e2e:sync:combine`, built with
   `VITE_COMBINE_CONCURRENT_EDITS=1`), so B2's behaviour is tested on every push.

### Edge cases (checked against the rules above)

- **Password on the phone, notes on the laptop.** Different parts: combines.
- **Password on both.** Same part: stays a conflict. Nothing combines for that pair, even its
  other parts.
- **Username on one, password on the other.** Same part (credential): conflict, never a mixed
  credential.
- **Archive on one, edit on the other.** Different parts: an archived entry with the edit.
- **Delete on one, edit on the other.** Not a field merge: stays a Phase A delete conflict.
- **Both add the same URL or tag.** On both sides: kept once. Tags compare by `tagKey`, so "Work"
  and "work" are one item; the higher-stamp side's spelling wins.
- **One adds a URL, the other removes a different one.** Item rules: both happen.
- **One removes a URL the other never had seen added.** The add stamp isn't in the remover's
  history, so it is kept: a removal can't cancel an addition it never saw.
- **Both edit custom fields.** One part: conflict.
- **Passkey created on one device, notes edited on the other.** Combines; the passkey is an item.
- **The same passkey on both with different `signCount` or `lastUsedAt`.** Same item: the
  higher-stamp side's copy (counters never go backwards between versions in practice; both are
  low-stakes).
- **A field one build doesn't know** (a newer build added it). Its own opaque part: combines
  when only one side changed it, conflict when both did.
- **Empty vs absent** (`notes: ""` vs no `notes`). Equal: normalized to absent before comparing.
- **One side's edit from an older build.** Its stamps are claims only, so they can't count as
  having seen a newer build's change: a passkey a newer build added survives, and a password a
  newer build changed against the older build's other edits is a conflict, not a silent revert.
  An older build can make a combine less likely, never wrong.
- **An older build relays a stripped copy, or a later version inherits its floor.** Same rule:
  a floor never covers a newer build's change.
- **Two builds with different combine rules.** The higher rules version's result replaces the
  lower one's for the same inputs.
- **Three devices, two combinable, one conflicting.** The two combine; the third stays a sibling
  of the result.
- **Two devices combine at once.** Same inputs, same version: one write, no ping-pong.
- **An edit-form save over a version a sync replaced.** The two become siblings; when they changed
  different parts they combine right away (the save reloads, and a load combines), not at the next
  sync.
- **Combine, then a resolution elsewhere that didn't see it.** The resolution and the combined
  version are siblings; they combine or conflict like any pair.
- **The kept password history.** Rows from both sides survive (capped at 5, the documented loss).
- **A conflict the user is resolving when a combine lands.** The Phase A `seen` check refuses the
  stale choice and the compare view reloads.
- **Key rotation.** A combined version is an ordinary sealed version; rotation re-seals it like
  any other.

### Effort

About 2 weeks: part and item stamps on every writer, the combine function with property tests
(the Phase A simulator extended with part-level truth), the port hook on each target, and the
flag. Risk is high, which is why it ships switched off: this changes how persisted data on users'
devices is merged, a convergence bug corrupts or ping-pongs vaults, and part stamps can't be
taken back out of people's vaults once written.

## Order

Phase A first. It delivers "no edit is silently lost" on its own, and the conflicts it surfaces
show how often real concurrent edits happen. If users rarely see them, the compare view may be
enough and Phase B can wait.
