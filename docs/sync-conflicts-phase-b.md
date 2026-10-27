# Sync conflicts Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When two devices change different parts of the same entry before they sync, combine the changes on their own; keep a Phase A conflict only when both changed the same part. Ship it switched off (B1), so devices first start recording part stamps.

**Architecture:** Every write records, inside the encrypted entry, which write last changed each part and added each list item (`partStamps`, `itemStamps`, `partStampsAt`). A pure, versioned combine function turns a set of sibling versions into one combined version with a deterministic stamp, using the Phase A histories with the "seen" restriction. Sync and vault load run it through the existing sync port and crypto adapter, behind `COMBINE_CONCURRENT_EDITS`. Separately, saving the edit form supersedes the version the form opened, so a change that synced in meanwhile becomes a sibling instead of being overwritten.

**Tech Stack:** TypeScript, zod, vitest, React, Web Crypto (SHA-256), MV3 extension background, Biome.

**Spec:** [sync-conflicts.md](sync-conflicts.md), "Phase B: combine edits to different parts of an entry". The part table, the seen rule, the list rules, the combined-version stamp, the rules version and the edit-form decision are fixed there; this plan argues from them.

## Global Constraints

- `COMBINE_CONCURRENT_EDITS` stays `false` in committed code. Tests turn it on through an option or a module mock, never by editing the constant.
- `COMBINE_RULES_VERSION = 1`. A combined version's `hlc` is `{ wall: max.wall, counter: max.counter + COMBINE_RULES_VERSION, node: "~merge:" + base64url(SHA-256(sorted input causalKeys joined by "\n")).slice(0, 22) }`, where max is the highest input stamp.
- Part stamps live inside the encrypted entry JSON only. `vault/parts.ts` is their only writer, the way `password-changelog.ts` is the changelog's.
- No new dependencies; SHA-256 through `globalThis.crypto.subtle`.
- Main stays safe to release after every task: until the flag flips, the only behavior change is Task 6 (an edit-form save racing a sync becomes a visible conflict instead of a silent overwrite).
- `packages/core/src` must not import `node:` modules. Lingui for any UI copy, then `pnpm i18n:extract`. Terse comments, no em dashes. Commit to main; `type(scope): summary` plus a why body; no `Co-Authored-By`; no testing status.
- Checks per task: the touched files' tests with `CI=true npx vitest run <files>` from the package, `pnpm -r run typecheck`, `npx biome check <changed files>`. Tasks 2, 4 and 7 also run `CI=true pnpm -r run test`.

## Review Focus

- **A pop-out draft from a window running the previous build** restores in the new edit route (the old draft is plain form values, with no opened version). It should still open and save as before. Pinned in Task 6.
- **An import of a `.bramble` export carrying another vault's part stamps.** The imported entries must start fresh stamps, not inherit foreign ones. Pinned in Task 2.
- **Card, SSH key and note entries.** They combine by their own parts, not only logins. Pinned in Task 3.
- **A payload with no siblings.** Combining must be free: nothing decrypted, nothing written. Pinned in Task 4.
- **The extension background's corner-prompt update while the entry has siblings.** It must record part stamps against the version it actually replaced. Pinned in Task 2.

---

### Task 1: Parts and part stamps

**Files:**
- Create: `packages/core/src/vault/parts.ts`, `packages/core/src/vault/parts.test.ts`
- Modify: `packages/core/src/vault/entry-normalize.ts` (`baseEntryFields`), `packages/core/src/hooks/useVault.tsx` (`BaseEntryData`)

**Interfaces:**
- Produces:

```ts
export type ItemList = "urls" | "tags" | "passkeys";
export type PartStamps = Record<string, Hlc>;
export type ItemStamps = Partial<Record<ItemList, Record<string, Hlc>>>;
// BaseEntryData gains: partStamps?: PartStamps; itemStamps?: ItemStamps; partStampsAt?: Hlc;
export function partsOf(data: EntryData): Map<string, unknown>;            // part name -> normalized value
export function itemsOf(data: EntryData, list: ItemList): Map<string, unknown>; // item key -> item
export function partsEqual(a: unknown, b: unknown): boolean;               // stable-JSON equality
export function effectivePartStamps(data: EntryData, version: Versioned): { parts: PartStamps; items: Required<ItemStamps> };
export function withPartStamps(next: Entry, prev: { data: EntryData; version: Versioned } | undefined, hlc: Hlc): Entry;
```

Parts per the spec's table: `credential` = username, password, totp (login); `card` = cardholderName, number, brand, expMonth, expYear, cvv; `key` = publicKey, privateKey, passphrase, keyType; every other top-level field is its own part named after the field, including unknown ones. Not parts: `id`, `type`, `createdAt`, `updatedAt`, `lastUsedAt`, `breach`, `passwordChangelog`, `partStamps`, `itemStamps`, `partStampsAt`, and the item lists. Item keys: urls by string, tags by `tagKey`, passkeys by `credentialId`. Normalization before comparing: `""`, `[]` and `undefined` are the same.

`effectivePartStamps`: when `partStampsAt` is missing or differs from `version.hlc`, every part and every item counts as stamped `version.hlc`. `withPartStamps`: starts from `prev`'s effective stamps (none when `prev` is undefined), restamps with `hlc` each part whose value differs and each item added, drops removed items, and sets `partStampsAt = hlc`. Caller-supplied stamps on `next` are discarded.

- [ ] **Step 1: Write the failing tests** in `parts.test.ts`:
  - `"credential, card and key fields move as one part"`: `partsOf` of a login has `credential` holding all three fields and no `username` key.
  - `"every other field is its own part, unknown ones included"`: a login with `{ futureField: 1 }` has a `futureField` part.
  - `"empty, absent and [] compare equal"`.
  - `"tags are keyed case-insensitively and passkeys by credentialId"`.
  - `"a stale version counts every part and item as changed at its own stamp"`: no `partStampsAt`, or a mismatching one.
  - `"withPartStamps restamps only what changed"`: prev stamps `{name: s1, notes: s1, credential: s1}`, change notes only, so `notes` is the new stamp and the rest stay `s1`.
  - `"withPartStamps stamps added items, keeps existing ones, drops removed ones"`.
  - `"withPartStamps discards stamps the caller supplied"`.
  - `"a new entry stamps every part and item at its own stamp"`.
- [ ] **Step 2: Run, expect FAIL** (module not found): `cd packages/core && CI=true npx vitest run src/vault/parts.test.ts`
- [ ] **Step 3: Implement** `parts.ts`, and add the three optional fields to `baseEntryFields` (`z.record(z.string(), HlcSchema)`, an object of three such records, `HlcSchema`) and to `BaseEntryData`.
- [ ] **Step 4: Run `src/vault`, expect PASS.** Typecheck, Biome.
- [ ] **Step 5: Commit** `feat(vault): parts of an entry, and the stamps that say who changed each`

### Task 2: Every writer records part stamps (B1)

**Files:**
- Modify: `packages/core/src/vault/entry-mutations.ts` (add, importMany, update, setArchived, setTags, resolve)
- Modify: `clients/extension/src/background/corner-prompt.ts` (save, update), `clients/extension/src/background/passkey-store.ts` (create, attach)
- Test: `packages/core/src/vault/entry-mutations.test.ts`, `clients/extension/src/background/corner-prompt-commit.test.ts`, `clients/extension/src/background/passkey-store.test.ts`

**Interfaces:**
- Consumes: `withPartStamps` (Task 1).
- Produces: every version written from here on has `partStampsAt === hlc`.

Each writer passes `withPartStamps(next, prev, version.hlc)`, where `version.hlc` is the stamp actually written (after `nextVersion`'s fork restamp). `prev` is `{ data: displayed entry, version: { hlc: stamps.get(id), ...causal.get(id) } }` for edits; `undefined` for add, import and a keep-both copy. For resolutions it is the content kept (`keep`: the displayed one; `use`: the chosen sibling's data and envelope). The background writers use the decrypted envelope and the envelope itself.

- [ ] **Step 1: Write the failing tests:**
  - `"add and import stamp every part at the write's stamp"`. Include an imported item that arrives with foreign `partStamps`; they are replaced.
  - `"update restamps only the parts it changed"`.
  - `"archive stamps archivedAt and tagging stamps the tags it added"`.
  - `"resolve keeps the kept content's stamps and sets partStampsAt to the new stamp"`.
  - `"an edit around its own sibling stamps parts with its fork-key stamp"`.
  - Extension: `"a corner-prompt update stamps the credential part against the version it replaced"`, with the payload holding a sibling.
  - Extension: `"a passkey attach stamps the passkey item"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the calls in each writer.
- [ ] **Step 4: Run `CI=true pnpm -r run test`, expect PASS.** Typecheck, Biome.
- [ ] **Step 5: Commit** `feat(sync): record which write changed each part of an entry`

### Task 3: The combine function

**Files:**
- Create: `packages/core/src/sync/combine.ts`, `packages/core/src/sync/combine.test.ts`, `packages/core/src/sync/combine.golden.test.ts`
- Modify: `packages/core/src/sync/index.ts`

**Interfaces:**
- Consumes: `partsOf`, `itemsOf`, `partsEqual`, `effectivePartStamps` (Task 1); `joinCausal`, `causalKey`, `Versioned`, `Causal` (Phase A).
- Produces:

```ts
export const COMBINE_CONCURRENT_EDITS = false;
export const COMBINE_RULES_VERSION = 1;
export interface Sibling { envelope: EncryptedEntry; data: EntryData }
export interface Combined { data: EntryData; hlc: Hlc; causal: Causal; replaces: EncryptedEntry[] }
export function seenBy(stamp: Hlc, holder: Versioned, other: Versioned): boolean;
export async function combineSiblings(siblings: readonly Sibling[]): Promise<Combined | null>;
```

`seenBy`: if `holder.vv?.[stamp.node]` is at or above `stamp`, it is seen only when `other.vv?.[stamp.node]` is too; otherwise it is seen when `inHistory(stamp.node, stamp, other)` holds (other's `vv` or `floor`).

`combineSiblings` folds the siblings highest stamp first. It tries each next one against the running result and keeps it out when any part conflicts or the `type` differs. It returns null when fewer than two fold. The running result's history for `seenBy` is `joinCausal` of the folded inputs.

Output plaintext:
- Each part comes from the side the rule picks, with that side's part stamp.
- Each list is merged by the item rule, with the item stamps it kept, in order: the higher-stamp side's items, then the other side's new items.
- Timestamps: `createdAt` is the min, `updatedAt` and `lastUsedAt` the max.
- `breach` comes from the side whose credential was kept.
- `passwordChangelog` goes through `withSupersededPasswords` with every input as superseded.
- `partStampsAt` is the combined `hlc`.

The `hlc` follows the Global Constraints. `causal.vv` is `joinCausal(inputs).vv` plus `{ [hlc.node]: hlc }`; `causal.floor` is the join's floor.

- [ ] **Step 1: Write the failing tests** in `combine.test.ts`, one per spec edge case:
  - `"password on one side, notes on the other: combines"`.
  - `"both changed the password: no combine"`.
  - `"username on one, password on the other: no combine"`.
  - `"archive on one, edit on the other: combines archived"`.
  - `"both add the same tag in different case: one tag, the higher stamp's spelling"`.
  - `"a removal the other side saw wins; one it never saw doesn't"`.
  - `"a re-added item survives a concurrent removal"`.
  - `"both edit custom fields: no combine"`.
  - `"an older build's edit can't drop a passkey a newer build added"`: the builder-check scenario.
  - `"an older build's edit against a newer build's password change: no combine"`.
  - `"card, SSH key and note entries combine by their own parts"`.
  - `"different types: no combine"`.
  - `"three siblings, two combinable: two fold, the third is left out"`.
  - `"the combined stamp is deterministic and sorts after every input"`: combining the same set in any input order gives an equal `hlc` and `causal`.
  - `"a higher rules version's result descends from a lower one's"`: mock the version to 2 and check `isAncestor(v1, v2)`.
  - `"password history keeps every superseded password"`.
  - `"a stripped copy of a combined version is still an ancestor of its descendants"`: its writer is the synthetic node.
- [ ] **Step 2: Write `combine.golden.test.ts`**: three fixed scenarios (login password plus notes; tags add and remove; card plus name) with the expected plaintext JSON and `hlc` written out literally. Pin the values from the first green run after checking each by hand against the spec. Note in the file that changing an expected value means bumping `COMBINE_RULES_VERSION`.
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement** `combine.ts`.
- [ ] **Step 5: Run `src/sync`, expect PASS.** Typecheck, Biome.
- [ ] **Step 6: Commit** `feat(sync): combine sibling versions part by part`

### Task 4: Combine during sync and on load, behind the flag

**Files:**
- Modify: `packages/core/src/sync/combine.ts` (add `combinePayload`), `packages/core/src/sync/apply-remote.ts`, `packages/core/src/hooks/useVault.tsx` (`loadEntries`), `clients/extension/src/background/sync.ts` (`makeVaultSyncPort`)
- Test: `packages/core/src/sync/combine.test.ts`, `packages/core/src/sync/two-device.test.ts`, `packages/core/src/hooks/useVault.conflicts.test.tsx`, `clients/extension/src/background/sync.test.ts`

**Interfaces:**
- Consumes: `combineSiblings` (Task 3), `normalizeEntryData`.
- Produces:

```ts
export interface CombineCrypto {
	decryptEntries(ps: { ciphertext: string; iv: string; wrappedDek: string; dekIv: string }[]): Promise<(string | null)[]>;
	encryptEntry(json: string): Promise<{ ciphertext: string; iv: string; wrappedDek: string; dekIv: string }>;
}
export async function combinePayload(payload: EntriesPayload, crypto: CombineCrypto): Promise<{ payload: EntriesPayload; stamps: Hlc[] }>;
// VaultSyncPort gains: combineSiblings?(payload: EntriesPayload): Promise<{ payload: EntriesPayload; stamps: Hlc[] }>;
// applyRemotePayload options gain: combine?: boolean (default COMBINE_CONCURRENT_EDITS)
```

`combinePayload` only touches ids with entries in `conflicts`. It decrypts that id's displayed and sibling envelopes and skips any that don't decrypt. It seals each combined version as `{ id, ...encryptEntry(JSON of data without id), hlc, ...causal }`, then returns `mergeEntriesPayload(payload, { entries: sealed, tombstones: [] })` plus the combined stamps.

`applyRemotePayload` calls `port.combineSiblings` after `admitAndMerge` when `combine` is on, and witnesses the combined stamps too. `createVaultSyncPort` implements `combineSiblings` with its crypto, whose `Pick` gains `"encryptEntry"`. The extension implements it with offscreen `CRYPTO_DECRYPT` and `CRYPTO_ENCRYPT` per entry. `loadEntries`, when the constant is on, combines after canonicalizing, witnesses, and writes the result through the entries blob store before decrypting.

- [ ] **Step 1: Write the failing tests:**
  - `"a payload with no siblings is returned as is without decrypting"`.
  - `"combinePayload replaces combinable siblings with one sealed version"`.
  - In `two-device.test.ts`, with `{ combine: true }`: `"password on the phone, notes on the laptop: both end with one entry holding both"`.
  - Also in `two-device.test.ts`: `"both devices combine the same siblings into the same version, then stop"`. After a second exchange, `applyRemotePayload` reports `changed: false` on both.
  - Also in `two-device.test.ts`: `"with combining off, siblings stay siblings"`.
  - Also in `two-device.test.ts`: `"a delete conflict is left for the user"`: combining never touches the tombstone, so the entry stays flagged deleted.
  - `useVault` with the constant mocked on: `"loading a payload with combinable siblings shows one entry and writes it"`.
  - Extension: `"the background port combines through the offscreen crypto"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `CI=true pnpm -r run test`, expect PASS.** Typecheck, Biome.
- [ ] **Step 5: Commit** `feat(sync): combine siblings during sync and on load, switched off`

### Task 5: Combine property tests

**Files:**
- Create: `packages/core/src/sync/combine.property.test.ts`

**Interfaces:**
- Consumes: `combinePayload`, `mergeEntriesPayload`, `nextVersion`, `withPartStamps`, `heldVersions`; a fake `CombineCrypto` where ciphertext is `"ct:" + json`.

A seeded simulator of 3 devices runs seeds 1 to 200 over 40 steps. Its steps:
- edit one random part of the displayed entry: credential, notes, name, a tag added or removed, or a URL added;
- delete;
- resolve keep;
- partial sync: merge, then `combinePayload`.

Writes go through `nextVersion` and `withPartStamps`. Truth records, for each part value, the label of the write that set it and that write's true ancestors.

- [ ] **Step 1: Write the properties:**
  - `"combining converges"`: after pairwise gossip until nothing changes (at most 20 rounds), every device's payload is equal by version keys.
  - `"no entry nobody wrote"`: for each displayed entry, its `credential` tuple equals one tuple some single write produced.
  - `"each part ends at a write nothing else superseded"`: for each displayed entry with no siblings left, each part's value comes from a write that no other write to that part truly descends from.
- [ ] **Step 2: Run, expect PASS.** Any failure is a bug in Task 3 or 4: fix it there with its own unit test first.
- [ ] **Step 3: Commit** `test(sync): combine converges and never builds an entry nobody wrote`

### Task 6: Saving the edit form supersedes the version it opened

**Files:**
- Create: `packages/core/src/app/routes/edit-draft.ts`, `packages/core/src/app/routes/edit-draft.test.ts`
- Modify: `packages/core/src/vault/entry-mutations.ts` (`update`), `packages/core/src/hooks/useVault.tsx` (`openVersion`, `updateEntry`), `packages/core/src/app/routes/EntryEditRoute.tsx`
- Test: `packages/core/src/vault/entry-mutations.test.ts`, `packages/core/src/hooks/useVault.conflicts.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface OpenedVersion { hlc: Hlc; vv?: VersionVector; floor?: Hlc; data: Entry }
useVault().openVersion(id: string): OpenedVersion | undefined;
useVault().updateEntry(id: string, data: EntryData, opened?: OpenedVersion): Promise<void>;
EntryMutations.update(current: VaultEntries, id: string, data: EntryData, opened?: OpenedVersion): Promise<VaultEntries>;
// edit-draft.ts
export interface EditDraft { values: EntryFormDraft; opened?: OpenedVersion }
export function readEditDraft(draft: unknown): EditDraft | undefined; // a plain FieldValues draft (previous build) -> { values }
```

When `opened` is given and its `hlc` differs from the displayed stamp:
- the save's bases are `[opened]`;
- the changelog and part stamps are computed against `opened.data` and `opened`;
- the version displayed before the save is sealed with `encryptEntry`, keeps its own `hlc` and causal, and moves into `conflicts`.

Otherwise `update` behaves as today. `EntryEditRoute` captures `opened` once on mount, from the restored draft if there is one, else from `openVersion`. It registers a draft getter returning `{ values, opened }` and passes `opened` to `updateEntry`.

- [ ] **Step 1: Write the failing tests:**
  - `"a save from a version no longer displayed becomes a sibling of the one that is"`: the newer version ends in `conflicts` with its own `hlc`, the save is displayed, and `isAncestor(opened, save)` holds while `isAncestor(newer, save)` doesn't.
  - `"a save from the displayed version works as before"`.
  - `"the save restamps only parts it changed relative to the version opened"`.
  - `useVault`: `"openVersion snapshots the displayed version"`.
  - `edit-draft`: `"a draft from this build carries the opened version"`.
  - `edit-draft`: `"a plain draft from the previous build restores its values"`.
  - `edit-draft`: `"anything else restores nothing"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `src/vault src/hooks src/app`, expect PASS.** Typecheck, Biome.
- [ ] **Step 5: Commit** `fix(vault): an edit-form save supersedes the version the form opened`

### Task 7: Docs and the full suite

**Files:**
- Modify: `docs/sync-conflicts.md` (Status line; Phase A bases table gains the edit-form row), `CONTEXT.md` (Part, Part stamps, Combined version), `docs/p2p-sync.md` ("Conflict loser": Phase B built, switched off)

- [ ] **Step 1: Update the docs.** Status: "Phase B built (B1: part stamps recorded; combining switched off by `COMBINE_CONCURRENT_EDITS` until most devices run it)".
- [ ] **Step 2: Run the full suite**, and report pass or fail with durations:
  - `CI=true pnpm -r run test`
  - `pnpm -r run typecheck`
  - `CI=true pnpm test:e2e:build`
  - `CI=true pnpm test:e2e:sync`
  - Biome on the changed files.
- [ ] **Step 3: Commit** `docs: Phase B combines different parts of an entry, recorded now and switched on later`

Flipping the flag (B2) is a later, separate change: set the constant, update the README and site copy ("never compares plaintext", "you choose between both versions"), and release.
