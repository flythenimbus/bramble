# Sync conflicts Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop sync from silently dropping an edit when two devices change, or one changes and one deletes, the same entry before they sync: keep every concurrent version and let the user choose.

**Architecture:** Every entry version and tombstone carries its causal history: a per-writer version vector, plus an optional LWW `floor` for lineages that pass through an older build. The entries merge becomes a multi-value register: union, prune top-down by stamp, display the highest surviving stamp, and keep the rest sealed in a new `conflicts` list. Writes name the versions they supersede, and a resolution supersedes them all. The UI shows a badge and a compare view.

**Tech Stack:** TypeScript, zod, vitest, React + Lingui, MV3 extension background, Biome.

**Spec:** [sync-conflicts.md](sync-conflicts.md), Phase A. Read it first. It decides the history model, the fork-key and sequential-writer rules, the bases table, top-down pruning, the tombstone join and the older-builds rules; this plan argues from them.

## Global Constraints

- No new dependencies. Property tests use a seeded PRNG written in the test file (mulberry32).
- Persisted format changes are additive and optional: `vv`, `floor`, `conflicts`. A payload with none of them must parse, and two all-legacy payloads must merge to exactly today's output: the same entries in the same order, and no `vv`, `floor` or `conflicts` keys.
- Never silently drop a version. No caps on siblings.
- `packages/core/src` (tests included) must not import `node:` modules.
- UI copy goes through Lingui (`t` / `<Trans>` / `<Plural>`). After UI changes, run `pnpm i18n:extract` and `pnpm i18n:check`, and report any missing translations.
- Comments are terse and one line long. No em dashes anywhere (code, comments, docs, commits).
- Commit to `main`. Messages: `type(scope): summary` plus a body explaining why; no `Co-Authored-By` trailer; no testing status.
- Checks per task:
  - Run the touched files' tests with `CI=true npx vitest run <files>` from the package.
  - Run `pnpm -r run typecheck`.
  - Run `npx biome check <changed files>`, and only ever format the files you touched.
  - Tasks 4, 6 and 9 also run `CI=true pnpm -r run test`.
- **Main stays safe to release after every task.**
  - After Task 4, nothing writes history yet, so sync behaves exactly as today.
  - From Task 6, conflicts are kept but stay invisible until Task 8 ships the UI. Kept-but-invisible is still strictly better than today's silent drop.

## Review Focus

- **Vault switch or lock with conflicts held.** Switching vaults or locking must clear the conflicts and causal state, or one vault's siblings get written into another's blob. Pinned in Task 6.
- **Key rotation with unresolved conflicts.** `sealAll` must re-seal siblings, or they become undecryptable after a password-to-key rotation. Pinned in Task 6.
- **An older build relaying stale stripped copies.** Neither a live copy (via top-down pruning) nor a tombstone copy (via the legacy-tombstone rule) may prune a sibling or kill a delete-conflicted edit, once the original or a descendant has reached the device. A copy arriving first can, as LWW would (the final review narrowed this; see the spec's "Older builds"). Pinned in Task 4.
- **The extension popup and background racing on one entry.** They must write under different writer keys, or the per-writer max calls one an ancestor of the other. Pinned in Task 5.
- **Autofill and passkey lookups.** They read the displayed version only, so a sibling's password is never offered for fill. Pinned in Task 6.

---

### Task 1: A breach refresh is not an edit

**Files:**
- Modify: `packages/core/src/vault/entry-mutations.ts` (add `setBreach` beside `touch`)
- Modify: `packages/core/src/hooks/useVault.tsx` (expose `setEntryBreach`, wired like `touchEntry`)
- Modify: `packages/core/src/app/routes/EntryDetailRoute.tsx:20-35` (the refresh effect uses it instead of `updateEntry`)
- Test: `packages/core/src/vault/entry-mutations.test.ts`

**Interfaces:**
- Produces: `EntryMutations.setBreach(current: VaultEntries, id: string, breach: { leaked: boolean; checkedAt: number }): Promise<VaultEntries>` and `useVault().setEntryBreach(id: string, breach: { leaked: boolean; checkedAt: number }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
it("setBreach keeps the sync stamp and updatedAt", async () => {
	let t = 1000;
	const h = harness(() => t);
	const a = await h.mutations.add(empty(), login("a"));
	const id = a.entries[0]!.id;
	t = 9000;
	const next = await h.mutations.setBreach(a, id, { leaked: true, checkedAt: 9000 });
	expect(next.entries[0]).toMatchObject({ breach: { leaked: true, checkedAt: 9000 }, updatedAt: 1000 });
	expect(compareHlc(next.stamps.get(id)!, a.stamps.get(id)!)).toBe(0);
});
it("setBreach no-ops for an unknown id or a non-login", async () => { /* expect(same).toBe(state); writes unchanged */ });
```
Add `setBreach` to the `it.each` table that checks every mutation preserves the settings map.

- [ ] **Step 2: Run, expect FAIL** (`setBreach is not a function`): `cd packages/core && CI=true npx vitest run src/vault/entry-mutations.test.ts`
- [ ] **Step 3: Implement** `setBreach` like `touch`: replace `breach` on the login, keep `stamps` as they are, then `persist`.
- [ ] **Step 4: Run the file and `src/app/screens/EntryDetail`, expect PASS.** Typecheck, Biome.
- [ ] **Step 5: Commit** `fix(sync): stop a breach refresh from outranking an edit made elsewhere`

### Task 2: Causal history primitives

**Files:**
- Create: `packages/core/src/sync/causal.ts`, `packages/core/src/sync/causal.test.ts`
- Modify: `packages/core/src/sync/index.ts` (export it)

**Interfaces:**
- Produces:

```ts
export type VersionVector = Record<string, Hlc>;
export const VersionVectorSchema: z.ZodType<VersionVector>; // z.record(z.string(), HlcSchema)
export interface Causal { vv: VersionVector; floor?: Hlc }
export interface Versioned { readonly hlc: Hlc; readonly vv?: VersionVector; readonly floor?: Hlc }
export function causalOf(v: Versioned): Causal;              // legacy (no vv): { vv: {}, floor: v.hlc }
export function writerOf(v: Versioned): string;              // vv key whose value equals hlc; legacy: hlc.node
export function inHistory(writer: string, stamp: Hlc, v: Versioned): boolean; // stamp <= floor, or stamp <= vv[writer]
export function isAncestor(x: Versioned, y: Versioned): boolean;      // inHistory(writerOf(x), x.hlc, y)
export function containsHistory(outer: Versioned, inner: Versioned): boolean; // H(inner) within H(outer)
export function joinCausal(versions: readonly Versioned[]): Causal;  // per-key max of vv, max floor; [] -> { vv: {} }
export function nextCausal(a: { hlc: Hlc; bases: readonly Versioned[]; held: readonly Versioned[] }): Causal;
export function isFutureVersion(v: Versioned, now?: number): boolean; // hlc, floor or any vv value future
export function causalKey(v: Versioned): string;             // stable: formatHlc(hlc), sorted vv entries, floor
```

`nextCausal` writes under `hlc.node`, unless the joined bases don't contain that key's latest event. The latest event is the max of `vv[key]` across `held`, plus the own event of any legacy version in `held` whose `hlc.node` is the key. In that case it reuses the first of this node's fork keys (keys starting `${hlc.node}~`, found in `held`) whose latest event the bases contain, or else mints `${hlc.node}~${formatHlc(hlc)}`. The result is `joinCausal(bases)` plus `{ [writer]: hlc }`, with `floor` omitted when undefined.

- [ ] **Step 1: Write the failing tests** (helper `h(wall, node)` builds an `Hlc`; `v(hlc, vv?, floor?)` builds a `Versioned`)

```ts
it("a legacy version claims every event up to its stamp", () => {
	expect(causalOf(v(h(5, "a")))).toEqual({ vv: {}, floor: h(5, "a") });
	expect(writerOf(v(h(5, "a")))).toBe("a");
	expect(isAncestor(v(h(4, "b"), { b: h(4, "b") }), v(h(5, "a")))).toBe(true);
});
it("a chain is ancestry, concurrent writers are not", () => {
	const s1 = v(h(1, "a"), { a: h(1, "a") });
	const s2 = v(h(2, "b"), { a: h(1, "a"), b: h(2, "b") });
	const c = v(h(3, "c"), { a: h(1, "a"), c: h(3, "c") });
	expect(isAncestor(s1, s2)).toBe(true);
	expect(isAncestor(s2, c)).toBe(false);
	expect(isAncestor(c, s2)).toBe(false);
});
it("a floor covers every version stamped at or before it", () => {
	expect(isAncestor(v(h(4, "z"), { z: h(4, "z") }), v(h(9, "a"), { a: h(9, "a") }, h(5, "q")))).toBe(true);
});
it("containsHistory needs the floor and every component covered", () => { /* T{a:2,b:3} in E{a:2,b:3,c:4}: true; in E{a:2,c:4}: false; legacy T(5) in E with floor 5: true; in E{a:9} with no floor: false */ });
it("nextCausal on nothing is just its own event", () => {
	expect(nextCausal({ hlc: h(7, "a"), bases: [], held: [] })).toEqual({ vv: { a: h(7, "a") } });
});
it("nextCausal inherits a legacy base's claim as its floor", () => {
	expect(nextCausal({ hlc: h(9, "a"), bases: [v(h(5, "b"))], held: [] })).toEqual({ vv: { a: h(9, "a") }, floor: h(5, "b") });
});
it("an edit around this device's own unresolved sibling forks the writer, and the fork is reused", () => {
	const mine = v(h(2, "a"), { a: h(2, "a") });
	const theirs = v(h(3, "b"), { b: h(3, "b") });
	const first = nextCausal({ hlc: h(4, "a"), bases: [theirs], held: [mine, theirs] });
	const fork = Object.keys(first.vv).find((k) => k.startsWith("a~"))!;
	expect(first.vv.a).toBeUndefined();
	const next = { hlc: h(4, "a"), ...first };
	expect(isAncestor(mine, next)).toBe(false);
	const second = nextCausal({ hlc: h(5, "a"), bases: [next], held: [mine, next] });
	expect(Object.keys(second.vv).filter((k) => k.startsWith("a~"))).toEqual([fork]);
});
it("a legacy version of this node counts as its latest event", () => { /* held [v(h(6,"a"))], bases [] -> writer is a fork key */ });
it("no fork when the bases contain this device's latest event", () => { /* bases [s2] held [s1,s2] for node a -> vv has key "a" */ });
it("isFutureVersion catches a future vv component", () => { /* hlc now, vv {x: now + HLC_MAX_DRIFT_MS + 1} -> true */ });
it("causalKey separates a stripped copy from its source", () => { /* same hlc, with and without vv: keys differ */ });
```

- [ ] **Step 2: Run, expect FAIL** (module not found): `cd packages/core && CI=true npx vitest run src/sync/causal.test.ts`
- [ ] **Step 3: Implement** `causal.ts` to the interfaces above.
- [ ] **Step 4: Run, expect PASS.** Typecheck, Biome.
- [ ] **Step 5: Commit** `feat(sync): causal history for entry versions`

### Task 3: The payload carries causal history and conflicts

**Files:**
- Modify: `packages/core/src/vault-format.ts:95-102` (`EncryptedEntrySchema`)
- Modify: `packages/core/src/sync/entries-payload.ts` (`TombstoneSchema`, `EntriesPayloadSchema`, `sanitizeRemoteEntriesPayload`)
- Modify: `packages/core/src/sync/apply-remote.ts` (`payloadsEquivalent`)
- Test: `packages/core/src/sync/entries-payload.test.ts`, `packages/core/src/sync/apply-remote.test.ts`

**Interfaces:**
- Consumes: `VersionVectorSchema`, `isFutureVersion`, `causalKey` (Task 2).
- Produces: optional `vv?: VersionVector` and `floor?: Hlc` on `EncryptedEntry` and `Tombstone`, and `conflicts?: EncryptedEntry[]` on `EntriesPayload`.

- [ ] **Step 1: Write the failing tests**
  - `"vv, floor and conflicts round-trip through encode and decode"`: `decodeEntriesPayload(encodeEntriesPayload(p))` deep-equals `p` for a payload with all three.
  - `"a payload without them still parses and encodes without adding keys"`: the encoded JSON contains no `"vv"`, `"floor"` or `"conflicts"`.
  - `"sanitize drops a conflict or tombstone with a future floor or vv component"`, and leaves `conflicts` absent when it was absent.
  - `"a stripped copy is not equivalent to its source"`: `payloadsEquivalent(withVv, stripped)` is `false`.
  - `"a tombstone whose vv grew under the same stamp is not equivalent"`.
  - `"conflicts are part of equivalence"`: payloads differing only in `conflicts` are not equivalent.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add the optional fields to the schemas. The sanitizer filters `entries`, `conflicts` and `tombstones` with `isFutureVersion`. `payloadsEquivalent` compares sets of `` `${id}|${causalKey(v)}` `` for entries, conflicts and tombstones, plus settings as today.
- [ ] **Step 4: Run, expect PASS** for both files, then the whole `src/sync` folder. Typecheck, Biome.
- [ ] **Step 5: Commit** `feat(sync): carry version history and conflicts in the entries payload`

### Task 4: The sibling merge, admission and witnessing

**Files:**
- Modify: `packages/core/src/sync/vault-merge.ts` (stop using `merge.ts`, and rewrite its header comment)
- Modify: `packages/core/src/sync/merge.ts` (header only: the kernel now serves the roster alone)
- Modify: `packages/core/src/sync/apply-remote.ts` (`admit`, `remoteStamps`)
- Test: `packages/core/src/sync/vault-merge.test.ts`, `packages/core/src/sync/apply-remote.test.ts`, and `packages/core/src/sync/vault-merge.property.test.ts` (create)

**Interfaces:**
- Consumes: Task 2 and Task 3.
- Produces:

```ts
export function mergeEntriesPayload(a: EntriesPayload, b: EntriesPayload): EntriesPayload; // same signature
export interface EntryConflict { versions: number; deleted: boolean } // versions = undisplayed live siblings
export function entryConflicts(payload: EntriesPayload): Map<string, EntryConflict>; // only ids with a conflict
export function heldVersions(payload: EntriesPayload, id: string): Versioned[]; // displayed, conflicts and tombstone for id
```

Per id, across both payloads:

```
live = entries ∪ conflicts for id; collapse same-hlc copies: keep the one with vv, else the first seen (a before b)
tomb = merge the two tombstones for id:
       one missing -> the other
       same hlc -> the one with vv, else the first seen
       one legacy and inHistory(its own event, the other) -> the other
       else { id, hlc: max, ...joinCausal(both) }; if that vv is {} and floor equals hlc, emit no vv and no floor
kept = []
for v in live by hlc descending:
       if tomb && isAncestor(v, tomb): skip            (dead)
       if kept.some((k) => isAncestor(v, k)): skip    (pruned)
       kept.push(v)
entries   <- kept[0] when present; conflicts <- kept[1..]; tombstones <- tomb when present (kept forever, as today)
deleted   <- kept.length > 0 && tomb && !kept.some((e) => containsHistory(e, tomb))
```

Ids keep their first-seen order (a's then b's), as today; `conflicts` is omitted when empty; settings merge unchanged.

Admission: candidates are remote entries and conflicts whose `(id, hlc)` this device holds in neither list. Refused versions are filtered out of both lists before the merge. `remoteStamps` adds every conflict's `hlc`, `floor` and `vv` values, and those of the entries and tombstones too.

- [ ] **Step 1: Write the failing tests**
  - In `vault-merge.test.ts` (each asserts `entries`, `conflicts` and `entryConflicts`):
    - `"two all-legacy payloads merge exactly as before"`: a fixed fixture with the expected output hardcoded, including id order and no new keys.
    - `"a descendant replaces its ancestor with no conflict"` (S1 to S2 to S3 against S1).
    - `"concurrent edits keep both and display the higher stamp"`.
    - `"a resolution supersedes every sibling"`.
    - `"a delete that saw the edit removes the entry"`.
    - `"a delete concurrent with an edit keeps the entry and flags it deleted"`, in both stamp orders.
    - `"keeping an entry after a delete conflict supersedes the tombstone"`.
    - `"a stripped live copy is the same version"`.
    - `"a stale stripped copy of a superseded version does not prune a sibling"`: X edited into R elsewhere, sibling Y stamped below X, and a stripped X arriving. Y survives.
    - `"a stripped copy of an older delete does not kill a delete-conflicted edit"`.
    - `"an older build's genuine edit dominates everything stamped before it"`.
    - `"an edit around an unresolved sibling keeps the sibling"`, built with `nextCausal`.
  - In `vault-merge.property.test.ts`, seeds 1 to 200, simulating 3 devices over 40 random steps of add, edit, delete, resolve and partial sync, with writes built through `nextCausal` and the spec's bases table:
    - `"isAncestor matches the true ancestry"`. The simulator records each version's true ancestor set, and for every pair of versions `isAncestor(x, y)` must equal "x is in y's true ancestors".
    - `"converges in every merge order"`. Merging the devices' final payloads as a left fold, a right fold and a shuffled fold gives identical `id|causalKey` sets. Also check `merge(a,b) ~ merge(b,a)` and `merge(a,a) ~ a` for every pair.
    - `"nothing is lost unless something saw it"`. Every version ever written is, after a full merge, either kept, or a true ancestor of a kept version, or a true ancestor of a delete in the tombstone.
    - `"a mixed group converges"`. One of the 3 devices is an older build, simulated faithfully: its reads strip `vv`, `floor` and `conflicts`, and it merges with today's algorithm (`replicaFrom`, `mergeReplicas`, `liveRecords` from `merge.ts`). Gossip pairwise until nothing changes. It must settle within 20 rounds; the newer devices must hold identical payloads; and for ids without a delete conflict, the older device's `id -> hlc` must equal theirs.
  - In `apply-remote.test.ts`:
    - `"a remote conflict that doesn't decrypt here is refused"`: it is absent from the written payload and present in `rejected`.
    - `"conflict stamps and vv values are witnessed"`.
    - `"a remote payload carrying only a new conflict is a change and is written"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `CI=true pnpm -r run test`, expect PASS.** Typecheck, Biome.
- [ ] **Step 5: Commit** `feat(sync): keep concurrent versions of an entry instead of dropping one`

### Task 5: The extension background writes history under its own writer key

**Files:**
- Modify: `clients/extension/src/background/sync-clock.ts` (`makeClock(\`${id}#bg\`)`)
- Modify: `clients/extension/src/background/vault-io.ts`. The `mutate` callback also receives the payload, and the function witnesses conflict stamps beside entries and tombstones.
- Modify: `clients/extension/src/background/corner-prompt.ts:149,224`, `clients/extension/src/background/passkey-store.ts:133,175`
- Test: `clients/extension/src/background/corner-prompt-commit.test.ts`, `clients/extension/src/background/passkey-store.test.ts` (create if absent), `clients/extension/src/background/vault-io.settings.test.ts`

**Interfaces:**
- Consumes: `nextCausal`, `heldVersions`.
- Produces: `reencryptOuterWithEntryChange(blob, mutate: (entries: EncryptedEntry[], payload: EntriesPayload) => Promise<EncryptedEntry[]>, vaultId?)`.

- [ ] **Step 1: Write the failing tests**
  - `"a corner-prompt update supersedes the displayed version only"`: seed a payload with a conflict for the target id. After the update the conflict survives, and the new envelope's `vv` descends from the old displayed version.
  - `"a new corner-prompt login gets its own vv"`.
  - `"background stamps carry the #bg node"`: the new envelope's `hlc.node` ends with `#bg`.
  - The create and replace cases for `savePlacement`.
  - In `vault-io.settings.test.ts`: `"a background write keeps conflicts"`, beside the existing settings case.
- [ ] **Step 2: Run, expect FAIL**: `cd clients/extension && CI=true npx vitest run src/background`
- [ ] **Step 3: Implement.**
  - New envelopes spread `nextCausal({ hlc, bases: [], held: [] })`.
  - Replacements spread `nextCausal({ hlc, bases: [enc], held: heldVersions(payload, enc.id) })`.
- [ ] **Step 4: Run `src/background`, expect PASS.** Typecheck, Biome.
- [ ] **Step 5: Commit** `feat(extension): background writes record which version they supersede`

### Task 6: Local writes and the vault state carry history

**Files:**
- Modify: `packages/core/src/vault/entry-mutations.ts`
- Create: `packages/core/src/vault/entry-mutations.harness.ts`. Move the `harness()` here from the test file, with a `node` parameter defaulting to `"device-a"`.
- Modify: `packages/core/src/hooks/useVault.tsx`
- Modify: `CONTEXT.md` (the `VaultEntries` glossary entry, plus new entries for causal history and siblings)
- Test: `packages/core/src/vault/entry-mutations.test.ts`, and `packages/core/src/hooks/useVault.conflicts.test.tsx` (create; copy the setup from `useVault.readEntries.test.tsx`)

**Interfaces:**
- Consumes: `nextCausal` and `Causal` (Task 2), and `mergeEntriesPayload`, `entryConflicts` and `EntryConflict` (Task 4).
- Produces:

```ts
export interface VaultEntries {
	entries: Entry[];
	stamps: Map<string, Hlc>;
	causal: Map<string, Causal>;          // displayed version's history; absent = legacy
	tombstones: Map<string, Hlc>;
	tombstoneCausal: Map<string, Causal>; // absent = legacy
	conflicts: EncryptedEntry[];          // undisplayed live versions, sealed
	settings?: SyncedSettings;
}
export function emptyVaultEntries(): VaultEntries;
export function vaultEntriesFromPayload(payload: EntriesPayload, decrypted: Entry[]): VaultEntries;
useVault().conflicts: ReadonlyMap<string, EntryConflict>;
```

`EntryMutationsDeps.crypto` gains `"decryptEntries"`. The new fields are required on purpose, so every construction site has to deal with them. A private `heldFor(current, id)` returns the displayed version (from `stamps` and `causal`), that id's conflicts and its tombstone.

- [ ] **Step 1: Write the failing tests**
  - `"add stamps a version of its own"`: `causal.get(id)` equals `{ vv: { "device-a": stamp } }`.
  - `"update supersedes only the displayed version"`: seeded with a conflict for the id. After `update` the conflict is still there, and `causal` descends from the old displayed version.
  - `"update of an entry with a legacy version inherits its floor"`.
  - `"remove supersedes every sibling and the old tombstone"`: no conflict remains for the id, and `tombstoneCausal` contains every sibling's history.
  - Extend the `it.each` "preserves the map" table so every mutation also preserves `conflicts` and the other entries' `causal`, in memory and on disk.
  - `"sealAll re-seals conflicts"`: the conflicts in the sealed payload decrypt with the harness crypto, with `id`, `hlc` and `vv` unchanged.
  - `"vaultEntriesFromPayload keeps vv, floor and conflicts"`.
  - In `useVault.conflicts.test.tsx`:
    - `"loading a payload with a conflict exposes it"`.
    - `"a stored payload with siblings but no displayed version is canonicalized on load"`.
    - `"switching to another vault clears conflicts and causal state"`: load vault A with a conflict, switch to empty vault B and add an entry. B's written payload has no `conflicts`, and `conflicts` is empty.
    - `"locking clears conflicts"`.
    - `"the autofill index holds only displayed versions"`: a sibling's password never appears in the `setIndex` calls.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `buildPayload` spreads `causal` and `tombstoneCausal` into the envelopes and tombstones, and threads `conflicts` through, omitting the key when empty.
  - Each mutation takes its bases from the spec's table.
  - `sealAll` decrypts the conflicts with `decryptEntries` and re-encrypts each one with `encryptEntry`, keeping `id`, `hlc`, `vv` and `floor`.
  - In `useVault`, replace `stampsRef`, `tombstonesRef` and `settingsRef` with one `vaultStateRef: Omit<VaultEntries, "entries">`. Every reset site assigns a fresh empty state, so none can miss a field.
  - `loadEntries` runs `mergeEntriesPayload(payload, emptyEntriesPayload())` before decrypting, builds the state with `vaultEntriesFromPayload`, and witnesses conflict stamps.
  - Mirror `entryConflicts` into state for `conflicts`, set on load and in `commitEntries`.
- [ ] **Step 4: Run `CI=true pnpm -r run test`, expect PASS.** Typecheck, Biome.
- [ ] **Step 5: Commit** `feat(vault): local writes record which versions they supersede`

### Task 7: Resolving a conflict, and exports that say what they leave out

**Files:**
- Modify: `packages/core/src/vault/entry-mutations.ts` (`resolve`)
- Modify: `packages/core/src/hooks/useVault.tsx` (`readConflictVersions`, `resolveConflict`)
- Modify: `packages/core/src/app/bulk-actions/export.tsx` (`ExportDialog`), `packages/core/src/app/screens/Settings/components/KdbxExportDialog.tsx`
- Test: `packages/core/src/vault/entry-mutations.test.ts`, `packages/core/src/hooks/useVault.conflicts.test.tsx`, `packages/core/src/app/bulk-actions/export.test.tsx` (create), `packages/core/src/app/screens/Settings/components/KdbxExportDialog.test.tsx` (create)

**Interfaces:**
- Produces:

```ts
export type ResolveChoice =
	| { kind: "keep" }                      // displayed content
	| { kind: "use"; data: EntryData }      // a sibling's content, through the changelog rule like update
	| { kind: "keepBoth"; data: EntryData } // the sibling becomes a new entry
EntryMutations.resolve(current: VaultEntries, id: string, choice: ResolveChoice): Promise<VaultEntries>;
export interface ConflictVersion { hlc: Hlc; data: EntryData }
export type ConflictChoice = { kind: "keep" } | { kind: "use"; hlc: Hlc } | { kind: "keepBoth"; hlc: Hlc };
useVault().readConflictVersions(id: string): Promise<ConflictVersion[]>;
useVault().resolveConflict(id: string, choice: ConflictChoice): Promise<void>;
```

"Keep it" on a delete conflict is `{ kind: "keep" }`; "Delete it" is the existing `deleteEntry`.

- [ ] **Step 1: Write the failing tests**
  - `"keep supersedes every sibling and the tombstone with the displayed content"`: no conflict remains, and the content is unchanged.
  - `"use writes the sibling's content and keeps the displayed password in the changelog"`.
  - `"keepBoth adds the sibling as a new entry and resolves the original"`: two entries, no conflict.
  - `"resolve is one write"`.
  - `"readConflictVersions decrypts every sibling, newest first"`.
  - `"the selection export dialog counts entries with other versions"`: 2 of 3 selected entries have `versions > 0`, and it shows "2 of these entries have a sync conflict. Only the version you see is exported." Nothing shows when none qualify; delete-only conflicts don't count.
  - The same for `KdbxExportDialog`, counting the whole vault.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The bases are every live version for the id plus its tombstone. `keepBoth` is an `add` (no bases) plus a `keep`, in one `persist`. Each dialog notice is a Lingui `<Plural>`.
- [ ] **Step 4: Run, expect PASS.** Typecheck, Biome.
- [ ] **Step 5: Commit** `feat(vault): resolve a sync conflict, and say when an export leaves versions out`

### Task 8: The badge and the compare view

**Files:**
- Modify: `packages/core/src/app/screens/VaultHome/list-item.ts`: `toListItem(entry, showBreaches, conflict?: EntryConflict)` adds `conflict: boolean` to `VaultListItem`.
- Modify: `packages/core/src/app/components/EntryRow.tsx` (a `conflict` badge beside the `leaked` one, around line 220)
- Modify: `packages/core/src/app/routes/VaultHomeRoute.tsx`, `packages/core/src/app/routes/EntryDetailRoute.tsx`
- Create: `packages/core/src/app/screens/EntryDetail/ConflictBanner.tsx`
- Modify: `packages/core/src/app/screens/EntryDetail/EntryDetail.tsx`: new props `conflict?: EntryConflict`, `onReadConflictVersions: () => Promise<ConflictVersion[]>`, `onResolveConflict: (choice: ConflictChoice) => Promise<void>`.
- Test: `packages/core/src/app/screens/VaultHome/list-item.test.ts`, `packages/core/src/app/screens/EntryDetail/EntryDetail.test.tsx`, `packages/core/src/app/screens/EntryDetail/ConflictBanner.test.tsx` (create)

**Interfaces:**
- Consumes: `conflicts`, `readConflictVersions`, `resolveConflict` and `deleteEntry` from `useVault`.

Copy (English source strings):
- **Badge:** "Conflict".
- **Banner, versions:** "This entry was changed on two devices before they synced." with the button "Compare versions".
- **Banner, delete:** "This entry was deleted on one device and changed on another before they synced." with the buttons "Keep it" and "Delete it".
- **Both:** when both apply, the banner shows both lines, and the compare view also offers "Delete it".
- **Compare view:** each version shows when it was saved (`hlc.wall`, via `formatDateTime`) and its body through `getEntryMode(data.type).Detail`, with a `copy` that copies but never calls `onUse`. The buttons are "Keep this one" on the displayed version, and "Use this one" and "Keep both" on each sibling.

Use the shared `Button` (`app/components/ui/button.tsx`).

- [ ] **Step 1: Write the failing tests**
  - `toListItem` sets `conflict` only when an `EntryConflict` is passed.
  - The banner renders the versions copy for `{ versions: 1, deleted: false }`, the delete copy for `{ versions: 0, deleted: true }`, and both for `{ versions: 1, deleted: true }`.
  - "Use this one" calls `onResolveConflict` with `{ kind: "use", hlc }` for that version; "Keep both" and "Keep this one" call it with their kinds.
  - Copying a field in the compare view doesn't call `onUse`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Then run `pnpm i18n:extract` and `pnpm i18n:check`, and report which catalogs need translating.
- [ ] **Step 4: Run the touched tests, expect PASS.** Typecheck, Biome.
- [ ] **Step 5: Commit** `feat(ui): show a sync conflict and let the user choose`

### Task 9: Two devices end to end, the copy, and the full suite

**Files:**
- Create: `packages/core/src/sync/two-device.test.ts`. Two harnesses from Task 6 with nodes `"laptop"` and `"phone"` exchange payloads through `applyRemotePayload` over `createVaultSyncPort`, with an in-memory store.
- Modify: `README.md` ("How sync works"), `website/src/pages/index.astro` (the Nerd talk "Same entry" line and the same-login FAQ), `docs/p2p-sync.md` ("Rules" and "Conflict loser"), `docs/sync-conflicts.md` (Status line)

- [ ] **Step 1: Write the scenario tests**
  - `"both devices edit one login, sync, and both show the same conflict"`.
  - `"resolving on one device clears it on the other after a sync"`.
  - `"phone deletes while laptop edits: the entry stays, flagged deleted, on both"`.
  - `"laptop edits around its own unresolved conflict and the sibling survives"`.
  - `"an older build in the group degrades to LWW and never crashes"`, reusing Task 4's faithful older-build simulation.
- [ ] **Step 2: Run, expect PASS.** Tasks 1 to 8 should make these pass. A failure means a bug in an earlier task: fix it there, with its own test.
- [ ] **Step 3: Update the copy.** A same-entry edit is no longer silently lost: both versions are kept and you choose. Keep the "never compares plaintext" point, and set the spec's Status to "Phase A built".
- [ ] **Step 4: Run the full suite** and report pass or fail with durations: `CI=true pnpm -r run test`, `pnpm -r run typecheck`, `pnpm --filter @vault/website run build`, `CI=true pnpm test:e2e:build` and `CI=true pnpm test:e2e:sync`. Run Biome on the changed files.
- [ ] **Step 5: Commit** `docs: a same-entry conflict is now kept and shown, not dropped`

Device testing is the user's step, not this plan's: pair the extension with a phone, edit the same login on both while one is locked, unlock, and check the badge, compare view and resolution on each.
