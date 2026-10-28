# Mailbox Plan 3: Client Transport

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A platform-neutral mailbox sync engine in `packages/core`: it posts closed deltas and
snapshots, collects and merges them under the spec's acknowledgement rules, heals gaps, compacts
its own backlog, mirrors the roster into membership and moves file blobs. It is proven against
Plan 1's server.

**Architecture:** The engine (`packages/core/src/sync/mailbox/`) reaches the server through a
signed HTTP client, and the device through four ports:
- the `MailboxCryptoPort` from Plan 2;
- a `MailboxVaultPort` that reads and merges the vault;
- a `MailboxStateStore` for the engine's own bookkeeping;
- a blob mover, so mobile can move bytes natively later.

Pure pieces (the plaintext format, delta cutting, sequence tracking) are unit-tested in core.
Flows run against the real server: a test-only entrypoint in `services/mailbox` serves the
in-memory server on a fake clock, and tests in `clients/mobile` spawn it as a process. No app is
wired up (that is Plan 4).

**Tech Stack:** TypeScript, zod 4, Vitest 4, WebCrypto Ed25519 in tests. No new dependencies.

**Spec:** [mailbox-service.md](mailbox-service.md). Also read Plan 1's "Outcome"
([plan 1](mailbox-service-plan-1-server.md)): this plan settles its items 3, 4, 9 and 10, and its
closing note on reconciliation.

## Global Constraints

- **The engine never holds a key.** It seals, opens, signs and verifies only through
  `MailboxCryptoPort` (`envelope.ts`).
- **Acknowledgement, from the spec:**
  - "A recipient acknowledges a message only once its merge is durably written to that device's
    vault storage."
  - "If the merge dropped anything as future-dated, the recipient does not acknowledge and
    retries on a later fetch."
  - "Entries `admit` refuses, and whole messages that fail to verify or open, go to local
    quarantine ... and are acknowledged."
- **Retry, never quarantine.** Anything `openMessage` rethrows, and a merge that did not run,
  means retry: no ack and no quarantine.
- **A delta is closed per entry.** From the spec: "For every entry id it touches, it carries
  everything the sender holds for that id: the displayed version, its siblings, its tombstone,
  the file records attached to it and their cascades. A change to a synced setting carries that
  setting's record."
- **`replaces` only names the device's own messages.** Sequence numbers live only inside the
  ciphertext.
- **Quarantine is append-only and never destroyed.** Nothing in this plan shows the user an
  error for the app's own faults.
- **Requests.**
  - Every request is signed per `protocol.ts`.
  - A server URL must be an origin (path `/`), because a signature covers the path the server
    sees.
  - Read only the status and body of a response: the desktop and mobile `HttpTransport`s return
    no response headers.
- **Persisted state is parsed with zod.** This covers `MailboxState` and quarantine records. A
  state that fails to parse is replaced by a fresh one and never thrown on.
- **Where tests live.**
  - `packages/core` tests import nothing from `node:`.
  - Tests that need the server live in `clients/mobile/src/sync/mailbox/` and spawn
    `services/mailbox/src/test/serve.ts` with `process.execPath`.
  - Nothing in `packages/` or `clients/` imports from `services/`.
- **Out of scope:** UI, user-visible strings and the feature flag. Plan 4 adds the flag with the
  wiring.
- **Tests and commits.** Run tests with `CI=true`. Commits are conventional, carry no co-author
  trailer, and say nothing about verification status. Comments stay terse.

**Design calls:** `LIMITS` in `sync/mailbox/limits.ts`, `as const`. Tests override them through
`MailboxContext.limits`.

| Key | Value | Meaning |
| --- | --- | --- |
| `partBudget` | `12 * 1024 * 1024` | Bytes of payload JSON per message. `MAX_MESSAGE_BYTES` is 16 MiB, less the signature, seal header and roster. |
| `compactCount` | `64` | Compact once this many of the device's own messages are logged since the last compaction. |
| `compactBytes` | `4 * 1024 * 1024` | ...or once they total this many bytes. |
| `requestEveryMs` | `3_600_000` | At most one snapshot request per gap sender, and one answer per requester, per hour. |
| `reconcileEveryMs` | `86_400_000` | Reconcile membership daily, and whenever the roster changed. |
| `directGets` | `20` | New wants fetched directly per sync. |

**Policies this plan decides:**
- **Replay** (Plan 1 item 4). There is no server nonce. Clients reconcile membership on a
  schedule and re-activate when the inbox says `not_active`, so a replayed `{active: false}` or
  `add` is undone by the next sync.
- **A missing body** (item 10). A message whose body answers 404 is acknowledged and treated as a
  gap.
- **Wants for hashes the mailbox already holds** (item 9). A new want is first fetched directly.
- **Version skew.**
  - A body sealed under a newer version byte, or a plaintext with a newer `v` or an unknown
    `kind`, is held: not acknowledged and not quarantined, until this device updates or the
    message expires.
  - A malformed plaintext at a known version is quarantined.

## Review Focus

1. **Held messages filling an inbox page.** A page whose messages are all held must end the
   drain, not refetch forever. Test in Task 10.
2. **A lock or vault switch mid-drain.** A merge that returns `null`, or an `openMessage` that
   rethrows, stops the drain with nothing acknowledged or quarantined. Task 10.
3. **A stale roster.** A device paired elsewhere, whose roster entry rides a delta this device
   has not merged yet, must not be removed by reconciliation. Task 13.
4. **A vault larger than one message.** A delta or snapshot over `LIMITS.partBudget` splits into
   closed parts and still converges. Tasks 4 and 11.
5. **A replayed request.** An old `{active: false}` replayed inside the skew window leaves the
   device inactive; its next sync notices and re-activates. Task 13.

---

### Task 1: Canonical keys, and a server clients can spawn

**Files:**
- Modify: `packages/core/src/sync/mailbox/protocol.ts` (`SIG_KEY_RE`)
- Test: `packages/core/src/sync/mailbox/protocol.test.ts`,
  `services/mailbox/src/core/mailboxes.test.ts`
- Create: `services/mailbox/src/test/memory.ts`. `makeServer`, `memoryBodies`, `ServerOpts` and
  `TestServer` move here from `harness.ts` unchanged, and `harness.ts` re-exports them. The move
  is needed because `serve.ts` runs under plain Node and `harness.ts` imports vitest.
- Create: `services/mailbox/src/test/serve.ts`
- Create: `clients/mobile/src/sync/mailbox/test-server.ts`
- Test: `clients/mobile/src/sync/mailbox/test-server.integration.test.ts`

**Interfaces:**
- Produces: `SIG_KEY_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/`.
- Produces: `serve.ts`.
  - It runs `makeServer({ quotaBytes, token })` from `QUOTA_BYTES` and `MAILBOX_TOKEN`, on
    port 0.
  - It prints `mailbox listening on <url>` as `bin.ts` does.
  - It adds test routes outside `/v1`: `POST /__test/advance?ms=`, `POST /__test/sweep` (runs
    `sweep(deps)`), `POST /__test/can-post?value=true|false`, and `GET /__test/now`, which
    answers the clock as text.
- Produces:

```ts
// clients/mobile/src/sync/mailbox/test-server.ts
export interface TestMailbox {
	url: string;
	advance(ms: number): Promise<void>;
	sweep(): Promise<void>;
	setCanPost(value: boolean): Promise<void>;
	close(): Promise<void>;
}
export function startTestMailbox(env?: { QUOTA_BYTES?: string; MAILBOX_TOKEN?: string }): Promise<TestMailbox>;
```

- [ ] **Step 1: Write the failing tests**

`protocol.test.ts`:

```ts
it("accepts only the canonical spelling of a key", () => {
	const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
	expect(SIG_KEY_RE.test(key)).toBe(true);
	expect(SIG_KEY_RE.test(`${key.slice(0, 42)}B=`)).toBe(false);
});
```

`mailboxes.test.ts`, "refuses a non-canonical spelling of a member's key": the creator `add`s
another member's key with its last character before `=` bumped by one (`A` to `B`), and gets
400.

`test-server.integration.test.ts`, "serves the mailbox on a fake clock the test can move":
`/health` answers `ok`, and `/__test/now` grows by exactly `86_400_000` after
`advance(86_400_000)`. Close in `finally`.

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter @vault/core exec vitest run src/sync/mailbox/protocol.test.ts; CI=true pnpm --filter bramble-mailbox-server test; CI=true pnpm --filter @vault/platform-mobile exec vitest run src/sync/mailbox`
Expected: the protocol and members tests FAIL; the mobile test fails to import `./test-server`.

- [ ] **Step 3: Implement**

`startTestMailbox`:
- Spawns `process.execPath` on `services/mailbox/src/test/serve.ts`, resolved from this file's
  URL, with `PORT=0`.
- Reads the URL from the first stdout line matching `mailbox listening on (\S+)`.
- Rejects if the child exits first or 10 s pass.
- `close()` sends SIGTERM and waits for the exit.

- [ ] **Step 4: Run them to verify they pass**

Run: the Step 2 command, then `pnpm --filter bramble-mailbox-server typecheck`.
Expected: PASS, and the server suite still has all its tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sync/mailbox/protocol.ts packages/core/src/sync/mailbox/protocol.test.ts services/mailbox/src/core/mailboxes.test.ts
git commit -m "fix(mailbox): accept only the canonical spelling of a key"
git add services/mailbox/src/test clients/mobile/src/sync/mailbox
git commit -m "test(mailbox): a fake-clock server client tests can spawn"
```

### Task 2: The merge reports what it set aside and refused

**Files:**
- Modify: `packages/core/src/sync/apply-remote.ts` (`ApplyResult`, `admitAndMerge`,
  `applyRemotePayload`)
- Test: `packages/core/src/sync/apply-remote.test.ts` (reuse its `hlc`, `payload`, `fakePort`)

**Interfaces:**
- Produces:

```ts
export interface ApplyResult {
	payload: EntriesPayload;
	changed: boolean;
	/** sanitizeRemoteEntriesPayload dropped something as future-dated. */
	setAside: boolean;
	/** Versions this call refused; not ones `rejected` already held. */
	refused: EncryptedEntry[];
}
```

- [ ] **Step 1: Write the failing tests**
  - "reports a future-dated version as set aside": a remote entry stamped
    `Date.now() + HLC_MAX_DRIFT_MS + 60_000` gives `setAside: true`; an ordinary remote gives
    `false`.
  - "reports a future-dated setting as set aside": a settings record with that stamp gives
    `true`.
  - "returns the versions this call refused": with `fakePort(local, { unopenable })`,
    `refused` equals the unopenable entry. A second call with the same `rejected` set returns
    `refused: []`.
- [ ] **Step 2: Run to verify they fail**
  Run: `CI=true pnpm --filter @vault/core exec vitest run src/sync/apply-remote.test.ts`.
  Expected: FAIL, because `setAside` and `refused` are undefined.
- [ ] **Step 3: Implement.**
  - `setAside` is true when any array of `remote` (`entries`, `conflicts`, `tombstones`,
    `files`, `fileTombstones`, `fileCascades`), or its settings key count, is longer than in the
    sanitized payload.
  - `admitAndMerge` returns the refused versions it collects.
- [ ] **Step 4: Run to verify they pass.** Run the Step 2 command, then
  `CI=true pnpm --filter @vault/core test`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(sync): the merge reports what it set aside and refused`.

### Task 3: Quarantine what never landed in the vault

**Files:**
- Modify: `packages/core/src/vault/quarantine.ts`
- Test: `packages/core/src/vault/quarantine.test.ts`

**Interfaces:**
- Produces:

```ts
export type QuarantinedMessage = {
	/** The body as it arrived, base64. */
	mailboxMessage: string;
	mailboxId: string;
	messageId: string;
	sender: string;
	reason: "malformed" | "bad_signature" | "unopenable" | "bad_plaintext" | "revoked_sender";
	quarantinedAt: number;
};
export type QuarantineRecord = QuarantinedEntry | UnreadableStore | QuarantinedMessage;
/** Add records without touching the vault: for things that never landed in it. */
export async function appendQuarantine(
	deps: { storage: QuarantineStore; vaultId: string; now?: number },
	add: { entries?: EncryptedEntry[]; messages?: Omit<QuarantinedMessage, "quarantinedAt">[] },
): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**
  - "appends refused entries without rewriting the vault": `writeEntriesBlob` is never called,
    and the stored records contain the entry with `quarantinedAt`.
  - "keeps a whole message with its reason, once per message id": appending the same
    `messageId` twice stores one record.
  - "carries an unreadable store forward when appending": a non-JSON store becomes an
    `UnreadableStore` record beside the new ones.
- [ ] **Step 2: Run to verify they fail.**
  Run: `CI=true pnpm --filter @vault/core exec vitest run src/vault/quarantine.test.ts`.
  Expected: FAIL, because `appendQuarantine` is not exported.
- [ ] **Step 3: Implement.** `quarantineEntries` and `appendQuarantine` share one
  read-dedupe-write helper. Entries dedupe by `entryVersionKey`, and messages by
  `mailboxId` plus `messageId`.
- [ ] **Step 4: Run to verify they pass.** Run the Step 2 command, then the core suite.
- [ ] **Step 5: Commit**: `feat(vault): quarantine what never landed in the vault`.

### Task 4: Closed deltas

**Files:**
- Create: `packages/core/src/sync/mailbox/limits.ts` (the design-call constants above)
- Create: `packages/core/src/sync/mailbox/delta.ts`
- Test: `packages/core/src/sync/mailbox/delta.test.ts`,
  `packages/core/src/sync/mailbox/delta.property.test.ts`

**Interfaces:**
- Produces:

```ts
/** Per closure group, a fingerprint of what this device held for it when it last posted. */
export type PostedIndex = Record<string, string>;
/** The groups whose fingerprint differs from `posted`, packed into closed parts, and the index
 * to keep once they are posted. Nothing changed: `parts` is empty. A snapshot is
 * `cutDelta(payload, {})`. */
export async function cutDelta(
	payload: EntriesPayload,
	posted: PostedIndex,
	budget?: number, // default LIMITS.partBudget
): Promise<{ parts: EntriesPayload[]; index: PostedIndex }>;
```

**Groups (the algorithm the signature leaves open):**
- `e:<id>` for each id in `entries`, `conflicts` or `tombstones`. It holds:
  - `heldVersions(payload, id)`;
  - every record in `files` with `entryId === id`;
  - every `fileCascades` mark on one of those files.
- `f:<id>` holds whatever no entry group claims:
  - a file record with no `entryId`;
  - a `fileTombstones` record;
  - a cascade mark whose file is not in `files`.
- `s:<key>` holds one settings record.

**Fingerprints and packing:**
- **Fingerprint:** the first 32 hex characters of `sha256Hex` over the group's sorted lines. Each
  version's line is its kind tag plus `causalKey`. Each file's line is
  `id|formatHlc(hlc)|hash|metaBlob`. Each tombstone and cascade line is `id|causalKey`. A
  setting's line is `JSON.stringify` of its record.
  - Using `causalKey` rather than the stamp catches a tombstone gaining history under an
    unchanged `hlc`.
- **Packing:** take the groups in key order. Each is appended to the current part until it would
  push the part's `JSON.stringify` UTF-8 length past `budget`.
  - A single group over budget throws `Error("one entry's history is larger than a mailbox message")`.
  - Parts are valid `EntriesPayload`s: optional arrays appear only when non-empty.

- [ ] **Step 1: Write the failing tests** (`delta.test.ts`, payloads from
  `test/vault-fixtures.ts`):
  - "an unchanged payload cuts nothing": cutting against the index of an earlier cut gives
    `parts: []`.
  - "an edit carries the entry's whole history and files":
    - Setup: entry A has a displayed version, a sibling and a file whose cascade is marked;
      entry B is untouched.
    - After A changes, the single part holds A's version, sibling, file and cascade, and nothing
      of B.
  - "a setting change carries only that setting".
  - "deleting a file carries its tombstone and its entry's new closure".
  - "a tombstone gaining history under the same stamp is a change": only `vv` or `floor`
    differs, and the delta is non-empty.
  - "packs groups into closed parts under the budget": with `budget = 2000` and five entries,
    `parts.length > 1`, and every id's versions sit in exactly one part.
  - "a group over the budget throws".
- [ ] **Step 2: Write the property test** (`delta.property.test.ts`).
  - Style: `mulberry32` as in `vault-merge.property.test.ts`, seeds 1 to 100, 30 steps.
  - Devices: two harness devices (`vault/entry-mutations.harness.ts` plus `createFileMutations`
    with the placeholder sealer from `two-device.files.test.ts`).
  - Each step applies one random op to A or B: `add`, `update`, `remove`, `setSetting`,
    `files.attach` or `files.detach`; or merges B into A with `applyRemotePayload`.
  - After a step, with probability 1/3, A cuts a delta against its index and keeps the parts and
    the new index. A cuts once more at the end.
  - It asserts `payloadsEquivalent(fold(R, shuffled parts), mergeEntriesPayload(R, A.final))` for
    `R` = empty and for `R` = B's final payload.
- [ ] **Step 3: Run to verify they fail.**
  Run: `CI=true pnpm --filter @vault/core exec vitest run src/sync/mailbox/delta`. Expected:
  FAIL, because `./delta` does not exist.
- [ ] **Step 4: Implement `cutDelta`** in `delta.ts`.
- [ ] **Step 5: Run to verify they pass.** Same command. Expected: PASS, every seed.
- [ ] **Step 6: Commit**: `feat(mailbox): closed deltas cut against what was last posted`.

### Task 5: The sealed plaintext

**Files:**
- Create: `packages/core/src/sync/mailbox/plaintext.ts`
- Test: `packages/core/src/sync/mailbox/plaintext.test.ts`
- Modify: `packages/core/src/sync/mailbox/envelope.ts`, `envelope.test.ts`

**Interfaces:**
- Produces:

```ts
const Seq = z.int().min(0);
export const MailboxPlaintextSchema = z.discriminatedUnion("kind", [
	z.object({ v: z.literal(1), kind: z.literal("delta"), epoch: MessageIdSchema, seq: Seq.min(1),
		entries: EntriesPayloadSchema, roster: RosterPayloadSchema }),
	z.object({ v: z.literal(1), kind: z.literal("snapshot"), epoch: MessageIdSchema, seq: Seq,
		part: z.int().min(1), parts: z.int().min(1), answers: SigKeySchema.nullable(),
		entries: EntriesPayloadSchema, roster: RosterPayloadSchema }),
	z.object({ v: z.literal(1), kind: z.literal("snapshot_request"), of: SigKeySchema.nullable() }),
]);
export type MailboxPlaintext = z.infer<typeof MailboxPlaintextSchema>;
export function encodePlaintext(m: MailboxPlaintext): string;
export function decodePlaintext(
	json: string,
): { ok: true; message: MailboxPlaintext } | { ok: false; why: "unsupported" | "malformed" };
```

- **Delta and snapshot numbers.** Each part of a delta is its own delta with its own `seq`. A
  snapshot's `seq` is the sender's last delta number: it covers through that number, and takes
  none of its own. `answers` repeats the `of` of the request it answers: `null` for a catch-up
  or a compaction, the snapshot's own sender, or a gone sender it answers for.
- **Version skew.** `decodePlaintext` reports `unsupported` for any `v` other than 1, or a `kind`
  it does not know. It reports `malformed` for broken JSON, or a known `v` and `kind` that fail
  the schema.
- **The envelope.** `MailboxOpenReason` gains `"unsupported"`. `openMessage` checks the version
  byte (`sealed[0] !== 1`) after the signature and before the mailbox-id check. An unsigned body
  is still `bad_signature`.

- [ ] **Step 1: Write the failing tests.**
  - `plaintext.test.ts`:
    - each kind round-trips;
    - "a newer version is unsupported, not malformed" (`{ v: 2, kind: "delta" }`);
    - "an unknown kind is unsupported";
    - "a delta without an epoch is malformed";
    - "text that is not JSON is malformed".
  - `envelope.test.ts`:
    - First, make the fake port's sealed bytes start with `0x01`, as the core's do (strip it on
      open).
    - Then add "holds a signed body sealed under a newer version as unsupported": sealed byte 0
      is `2` under a valid signature, and `mailboxOpen` is not called.
- [ ] **Step 2: Run to verify they fail.**
  Run: `CI=true pnpm --filter @vault/core exec vitest run src/sync/mailbox`.
  Expected: the plaintext tests fail on import; the new envelope test fails with `unopenable`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.** Run the Step 2 command, then the mobile integration
  test `src/sync/mailbox-crypto.integration.test.ts` (real core). Expected: PASS.
- [ ] **Step 5: Commit**: `feat(mailbox): the sealed message plaintext, and holding newer versions`.

### Task 6: The signed client

**Files:**
- Create: `packages/core/src/sync/mailbox/api.ts`
- Create: `packages/core/src/test/mailbox-fakes.ts`
- Test: `packages/core/src/sync/mailbox/api.test.ts`,
  `clients/mobile/src/sync/mailbox/api.integration.test.ts`

**Interfaces:**
- Produces:

```ts
export interface MailboxSigner { readonly sigKey: string; sign(message: string): Promise<string>; }
export interface MailboxServer { url: string; token?: string; }
export class MailboxApiError extends Error {
	readonly status: number;
	readonly code: MailboxErrorCode | "unexpected";
}
export interface SignedRequest { method: "GET" | "PUT"; url: string; headers: Record<string, string>; }
export interface MailboxApi {
	readonly mailboxId: string;
	/** Now on the server's clock, as corrected by stale_time answers. */
	serverNow(): number;
	create(body: CreateMailboxBody): Promise<MembersResponse>;
	members(): Promise<MembersResponse>;
	changeMembers(body: MembersBody): Promise<MembersResponse>;
	activate(active: boolean): Promise<MembersResponse>;
	setRetention(days: number): Promise<void>;
	post(messageId: string, body: Uint8Array, to?: string[]): Promise<PostResponse>;
	replaces(snapshotId: string, replaced: string[]): Promise<void>;
	inbox(wantedAfter?: string): Promise<InboxResponse>;
	/** `null`: the server has no body for it (404). */
	message(messageId: string): Promise<Uint8Array | null>;
	wants(hashes: string[]): Promise<void>;
	ack(body: Partial<AckBody>): Promise<void>;
	/** A signed blob transfer for a mover to run. A PUT's content hash is the blob's hash. */
	blobRequest(method: "GET" | "PUT", hash: string): Promise<SignedRequest>;
}
export function mailboxApi(deps: {
	http: HttpTransport; server: MailboxServer; signer: MailboxSigner; mailboxId: string;
	now?: () => number;
}): MailboxApi;

export interface MailboxBlobMover {
	upload(hash: string, request: SignedRequest): Promise<PostResponse>;
	download(hash: string, request: SignedRequest): Promise<"stored" | "missing">;
}
/** Moves bytes through JS: reads and writes `blobs`, sends through `http`. */
export function storeBlobMover(http: HttpTransport, blobs: BlobStore): MailboxBlobMover;
```

- Produces (`test/mailbox-fakes.ts`, for core and mobile tests):
  - `ed25519Signer(): Promise<MailboxSigner & { verify(sigKey, message, sigB64): Promise<boolean> }>`,
    over WebCrypto. Its `sigKey` is canonical base64.
  - `fakeMailboxCrypto(mailboxId: string, signer): MailboxCryptoPort`. Its seal is reversible:
    `0x01` followed by the JSON of `{aad, plaintext}`. Open checks the AAD.

**Behaviour:**
- **Construction:** throws `Error("a mailbox server is an origin, with no path")` unless the URL
  is http(s) with path `/` and no query or hash.
- **Bodies:** JSON bodies are sent as UTF-8 with `application/json`; message and blob bodies as
  `application/octet-stream`.
- **Signing:** `contentSha256` is `sha256Hex` of the body bytes (`EMPTY_SHA256` for none).
  `to` is sent as `encodeURIComponent(to.join(","))`, and the signed path is the path and query
  exactly as sent.
- **Clock correction:** a `401 stale_time` with `serverTime` sets
  `offset = serverTime - now()`, then retries once with a fresh signature.
- **Errors:** any other non-2xx parses `ErrorResponseSchema` into
  `MailboxApiError(status, code)`. A body that does not parse gives `code: "unexpected"`.
- **Responses:** 2xx JSON is parsed with the protocol's response schemas.

- [ ] **Step 1: Write the failing tests** (`api.test.ts`, with a fake `HttpTransport` that
  records requests):
  - "signs the canonical request with the roster key": verify the `x-bramble-sig` header over
    `canonicalRequest` with the signer's `verify`. The token header is present only when
    configured.
  - "retries once on stale_time with the server's clock": the second request's time header is
    within 1 s of `serverTime`. A second `stale_time` throws `MailboxApiError` with code
    `stale_time`.
  - "maps error bodies": `409 {"error":"exists"}` gives code `exists`; `500 "oops"` gives
    `unexpected`.
  - "returns null for a missing body".
  - "signs a blob upload with the blob's hash as its content hash".
  - "refuses a server URL with a path".
- [ ] **Step 2: Write the failing integration tests** (`api.integration.test.ts`, one
  `startTestMailbox()` per file, `fetchTransport`):
  - "creates, activates, posts, collects and acknowledges through the real server, correcting
    its clock":
    - A creates the mailbox with `[A, B]`, and B activates.
    - A posts to everyone and gets `recipients: 1`.
    - B's inbox lists the message, and `message()` returns the bytes.
    - After B acks, B's inbox is empty.
    - The test server's fake clock is a year off the real one, so the first request exercises
      `stale_time`.
  - "moves a blob through the store mover": A uploads a blob from a `memoryBlobStore`, and B
    downloads it into its own store. An unknown hash is `"missing"`.
- [ ] **Step 3: Run to verify they fail.** Run
  `CI=true pnpm --filter @vault/core exec vitest run src/sync/mailbox/api.test.ts` and
  `CI=true pnpm --filter @vault/platform-mobile exec vitest run src/sync/mailbox`. Expected:
  FAIL on import.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run to verify they pass.** Same commands. Expected: PASS.
- [ ] **Step 6: Commit**: `feat(mailbox): the signed mailbox client`.

### Task 7: State, context and the vault port

**Files:**
- Create: `packages/core/src/sync/mailbox/state.ts`, `context.ts`, `vault-port.ts`
- Modify: `packages/core/src/sync/roster.ts` (`activeSigKeys`)
- Test: `state.test.ts`, `vault-port.test.ts` (beside them), `sync/roster.test.ts`

**Interfaces:**
- Produces:

```ts
// state.ts
export const SenderTrackSchema = z.object({
	epoch: MessageIdSchema, through: z.int().min(0), above: z.array(z.int()),
});
export const MailboxStateSchema = z.object({
	epoch: MessageIdSchema,              // this device's sender epoch, fresh per state
	nextSeq: z.int().min(1),
	posted: z.record(z.string(), z.string()),                  // PostedIndex
	log: z.array(z.object({ id: MessageIdSchema, bytes: z.int().min(0), at: z.int() })),
	active: z.boolean(),
	catchUp: z.boolean(),                // ask everyone for a snapshot on the next sync
	senders: z.record(z.string(), SenderTrackSchema),         // by sigKey
	snapshots: z.record(z.string(), z.object({ epoch: MessageIdSchema, seq: z.int(),
		parts: z.int(), got: z.array(z.int()) })),             // split snapshots in flight
	gaps: z.array(SigKeySchema),         // senders to ask for a snapshot
	toAnswer: z.record(z.string(), SigKeySchema.nullable()),  // requester: whose gap
	requested: z.record(z.string(), z.int()),                // sigKey or "*": when asked
	answered: z.record(z.string(), z.int()),                 // requester: when answered
	uploaded: z.array(BlobHashSchema),   // hashes this device uploaded eagerly
	wants: z.array(BlobHashSchema),      // the wants list last sent
	reconciled: z.object({ roster: z.string(), at: z.int() }).nullable(),
});
export type MailboxState = z.infer<typeof MailboxStateSchema>;
export type SenderTrack = z.infer<typeof SenderTrackSchema>;
export type SnapshotParts = MailboxState["snapshots"][string];
export interface MailboxStateStore { load(): Promise<MailboxState>; save(s: MailboxState): Promise<void>; }
export function freshState(random: (n: number) => Uint8Array): MailboxState;
/** Missing or unparsable state loads as a fresh one. */
export function metaStateStore(
	storage: Pick<StorageAdapter, "getMeta" | "setMeta">, key: string,
	random: (n: number) => Uint8Array,
): MailboxStateStore;

// vault-port.ts
export interface MailboxEnvelope { entries: EntriesPayload; roster: RosterPayload; }
export interface MailboxApplied { setAside: boolean; refused: EncryptedEntry[]; }
export interface MailboxVaultPort {
	readLocal(): Promise<MailboxEnvelope>;
	/** The roster after merging `remote`'s verified entries, not written. */
	previewRoster(remote: RosterPayload): Promise<RosterPayload>;
	/** Merge, quarantining refused entries; resolve once written. `null`: the merge did not run
	 * (locked, or another vault is active): retry later, never acknowledge. */
	apply(remote: MailboxEnvelope): Promise<MailboxApplied | null>;
	quarantine(add: { messages: Omit<QuarantinedMessage, "quarantinedAt">[] }): Promise<void>;
}
export function createMailboxVaultPort(deps: {
	sync: VaultSyncPort;
	rejected: Set<string>;
	readEntries(): Promise<EntriesPayload>;
	readRoster(): Promise<RosterPayload>;
	writeRoster(roster: RosterPayload): Promise<void>;
	/** verifyRosterEnvelope bound to this host's roster_verify; null when unparsable. */
	verifyRoster(rosterJson: string): Promise<string | null>;
	quarantine: QuarantineStore;
	vaultId: string;
	/** False once the vault this port was built for is no longer the one unlocked. */
	current?(): boolean;
}): MailboxVaultPort;

// context.ts
export interface MailboxContext {
	api: MailboxApi;
	crypto: MailboxCryptoPort;
	vault: MailboxVaultPort;
	blobs: { store: BlobStore; mover: MailboxBlobMover };
	groupKeyB64: string;
	sigKey: string;
	now: () => number;
	random: (n: number) => Uint8Array;
	/** Tests shrink these. */
	limits?: Partial<Record<keyof typeof LIMITS, number>>;
}

// roster.ts
/** Active devices' sigKeys, canonical and deduplicated. */
export function activeSigKeys(roster: RosterPayload): string[];
```

**`apply` does, in order:**
1. If `current?.()` is false, return `null`.
2. Verify the remote roster, merge it with `mergeRemoteRoster`, and write it when it changed.
3. Merge the entries with `applyRemotePayload(sync, remote.entries, { rejected })`.
4. Quarantine `refused` with `appendQuarantine`.
5. Check `current?.()` again. If false, return `null`: the next sync repeats an idempotent merge
   rather than acking one that landed in the wrong vault.

**The other methods:**
- `previewRoster` merges the verified roster in memory only.
- `quarantine` appends whole-message records.

- [ ] **Step 1: Write the failing tests.**
  - `state.test.ts`:
    - "a missing or unparsable state loads fresh, with an epoch of message-id shape";
    - "a saved state loads back".
  - `roster.test.ts`: "activeSigKeys skips revoked, unkeyed and non-canonical keys".
  - `vault-port.test.ts` (a harness device as the vault, an in-memory roster and quarantine
    store):
    - "merges entries and roster and reports a refusal, quarantining it": a remote entry whose
      ciphertext lacks the harness's `ct:` prefix is refused, recorded in quarantine and absent
      from the vault.
    - "reports a future-dated entry as set aside".
    - "returns null and writes nothing once the vault is no longer current".
    - "previews a roster with a verified new device, without writing it".
    - "ignores a roster that verification refuses".
- [ ] **Step 2: Run to verify they fail.**
  Run: `CI=true pnpm --filter @vault/core exec vitest run src/sync/mailbox src/sync/roster.test.ts`.
  Expected: FAIL on import.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.** Same command, then the core suite and
  `pnpm run typecheck`.
- [ ] **Step 5: Commit**: `feat(mailbox): engine state and the vault port`.

### Task 8: Sequence tracking

**Files:**
- Create: `packages/core/src/sync/mailbox/sequence.ts`
- Test: `sequence.test.ts`

**Interfaces:**
- Consumes: `SenderTrack` (the `SenderTrackSchema` type) and `MailboxState["snapshots"]` values
  from Task 7.
- Produces:

```ts
export function recordDelta(track: SenderTrack | undefined, epoch: string, seq: number): SenderTrack;
export function recordSnapshot(track: SenderTrack | undefined, epoch: string, seq: number): SenderTrack;
/** Another member's snapshot answered this sender's gap: everything seen counts as covered. */
export function healed(track: SenderTrack | undefined): SenderTrack | undefined;
export function hasGap(track: SenderTrack | undefined): boolean;
/** Count a snapshot part; `complete` once every part of that (epoch, seq) arrived. */
export function recordPart(
	pending: SnapshotParts | undefined,
	p: { epoch: string; seq: number; part: number; parts: number },
): { pending: SnapshotParts | undefined; complete: boolean };
```

**Rules:**
- An unknown sender, or a new epoch, starts at `through = seq - 1` for a delta, or
  `through = seq` for a snapshot. Earlier numbers came before this device was listening, and the
  catch-up covers them.
- A seq at or below `through` changes nothing. A higher one joins `above`, then `through`
  advances while `through + 1` is in `above`.
- A snapshot sets `through = max(through, seq)` and drops `above` entries at or below it.

- [ ] **Step 1: Write the failing tests.** Each rule above is one test:
  - "the first delta sets the baseline";
  - "a skipped number is a gap until it arrives" (1, 2, 4 gives a gap; then 3 clears it);
  - "a repeat or older number changes nothing";
  - "a new epoch starts over";
  - "a snapshot covers through its number";
  - "a snapshot below the gap keeps it";
  - "another member's snapshot heals a gone sender";
  - "a split snapshot completes only when every part arrived".
- [ ] **Step 2: Run to verify they fail.**
  Run: `CI=true pnpm --filter @vault/core exec vitest run src/sync/mailbox/sequence.test.ts`.
  Expected: FAIL on import.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(mailbox): per-sender sequence tracking`.

### Task 9: Files, and the test device

**Files:**
- Create: `packages/core/src/sync/mailbox/files.ts`
- Create: `clients/mobile/src/sync/mailbox/test-device.ts`
- Test: `clients/mobile/src/sync/mailbox/files.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 6 and 7.
- Produces:

```ts
// files.ts
/** Collect delivered blobs; the hashes to acknowledge. A held hash is acknowledged without a
 * download, a missing one is acknowledged (the manifest will want it again), and a failed
 * download is left for the next sync. */
export async function collectBlobs(ctx: MailboxContext, blobs: InboxResponse["blobs"]): Promise<string[]>;
/** Send the wants list when it changed; fetch up to `LIMITS.directGets` new wants directly. */
export async function syncWants(ctx: MailboxContext, state: MailboxState, local: EntriesPayload): Promise<void>;
/** Upload what other members want that this device holds. */
export async function uploadWanted(ctx: MailboxContext, wanted: string[]): Promise<void>;

// test-device.ts
export interface TestDevice {
	name: string;
	sigKey: string;
	ctx: MailboxContext;
	state: MailboxState;
	vault: ReturnType<typeof harness> & { files: FileMutations };
	blobs: BlobStore;
	roster: { current: RosterPayload };
	/** Flip to simulate a lock or a vault switch. */
	current: { value: boolean };
	entries(): Promise<VaultEntries>;
	quarantined(): Promise<QuarantineRecord[]>;
}
export async function testGroup(
	box: TestMailbox,
	names: string[],
	opts?: { now?: () => number; limits?: MailboxContext["limits"] },
): Promise<TestDevice[]>;
```

**What `testGroup` builds:**
- A random group key and mailbox id.
- One `ed25519Signer` and one `fakeMailboxCrypto` per device.
- `mailboxApi` over `fetchTransport`.
- A harness vault per device, whose file sealer stores the source bytes as the blob, keyed by
  their SHA-256.
- A `memoryBlobStore` and a `storeBlobMover`.
- `createMailboxVaultPort` with an identity `verifyRoster` and `current: () => current.value`.
- A shared starting roster listing every device with its `sigKey`.
- A fresh state each.

**Wants:** hashes named by `wantedFromPayload(local)` and missing from `blobs.list()`, sorted,
capped at `MAX_WANTS`. Send only when the list differs from `state.wants`. "New" means not in
the previous `state.wants`.

- [ ] **Step 1: Write the failing tests** (`files.integration.test.ts`; mailbox created and
  devices activated through `ctx.api` directly):
  - "lists the blobs its manifest names but its store lacks": B's manifest names hash H without
    bytes; after `syncWants`, A's inbox `wanted` contains H.
  - "uploads what another member wants and holds": after A runs `uploadWanted([H])`, B's inbox
    lists blob H.
  - "fetches a new want directly when the mailbox already holds it":
    - A uploads H while C is eligible but inactive.
    - C activates, and its `syncWants` stores H with no further upload.
  - "collects a delivered blob, and acknowledges one it holds without downloading".
- [ ] **Step 2: Run to verify they fail.**
  Run: `CI=true pnpm --filter @vault/platform-mobile exec vitest run src/sync/mailbox`.
  Expected: FAIL on import.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.** Same command.
- [ ] **Step 5: Commit**: `feat(mailbox): file blobs through the mailbox`.

### Task 10: Collecting the inbox

**Files:**
- Create: `packages/core/src/sync/mailbox/receive.ts`
- Test: `packages/core/src/sync/mailbox/receive.test.ts` (stub `MailboxApi`),
  `clients/mobile/src/sync/mailbox/receive.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 5 to 9.
- Produces:

```ts
export interface DrainResult {
	merged: number;
	/** Left pending: set aside or unsupported. */
	held: number;
	/** A merge did not run or a crypto call failed for a local reason: stop, retry later. */
	interrupted: boolean;
	/** The inbox said this device is not active (or not a member). */
	deactivated: boolean;
	/** Hashes others want that the mailbox lacks, every page. */
	wanted: string[];
}
export async function drainInbox(ctx: MailboxContext, state: MailboxState): Promise<DrainResult>;
```

**Per message, in inbox order:**
1. `api.message(id)` returns `null`: acknowledge it, and add the sender to `state.gaps`.
2. `openMessage`:
   - `unsupported`: hold the message.
   - Any other `MailboxOpenError`: quarantine it with its reason, acknowledge it, and add the
     sender to the gaps.
   - Anything else: set `interrupted` and stop.
3. `decodePlaintext`:
   - `unsupported`: hold the message.
   - `malformed`: quarantine it as `bad_plaintext`, acknowledge it, and add the sender to the
     gaps.
4. A `snapshot_request`: acknowledge it. If the sender is active in this device's own roster
   (`(await ctx.vault.readLocal()).roster`), set `state.toAnswer[sender] = of` first. A request
   from anyone else is ignored, so a revoked device is never sent a snapshot.
5. A delta or snapshot:
   1. If the sender is not in `activeSigKeys(await vault.previewRoster(message.roster))`,
      quarantine the message as `revoked_sender` and acknowledge it. It is not a gap.
   2. Otherwise `vault.apply`:
      - `null`: set `interrupted` and stop.
      - `setAside`: hold the message, but still record its sequence number. It will merge
        later; it was not lost.
      - Otherwise acknowledge it.
   3. Record the sequence:
      - a delta: `recordDelta`;
      - a snapshot part: `recordPart`. Once complete, `recordSnapshot` for its sender, and, when
        `answers` names someone else, `healed` for them.
6. **Markers:** add the sender to the gaps, and acknowledge the marker.
7. **Blobs:** acknowledge what `collectBlobs` returns.

**Paging and the end of the drain:**
- Acknowledge once per page.
- Collect `wanted` through `wantedAfter` and `wantedMore`.
- Fetch the next page while `more` is true and the page acknowledged something.
- A `403 not_active` or `not_member` sets `deactivated` and `state.active = false`.
- After the last page, add every sender for whom `hasGap` holds to `state.gaps`.

- [ ] **Step 1: Write the failing core tests** (`receive.test.ts`, stub api):
  - "ends the drain on a page that acknowledges nothing": the stub answers `more: true` forever,
    with one held message, and `inbox` is called once.
  - "acknowledges a body the server lost and asks its sender for a snapshot": `message()` returns
    `null`, the id is acked, and `state.gaps` holds the sender.
- [ ] **Step 2: Write the failing integration tests** (`receive.integration.test.ts`; bodies
  built with `sealMessage` and `encodePlaintext` and posted through A's `ctx.api`):
  - "merges a delta and acknowledges it".
  - "holds a message whose merge set something aside, and merges it once time passes":
    - A's entry is stamped an hour ahead.
    - B holds the message and the inbox still lists it.
    - After `vi.setSystemTime` two hours on, B merges it and acknowledges it.
  - "quarantines a message that does not open, acknowledges it, and marks a gap".
  - "quarantines a revoked sender's message without merging it, and ignores its snapshot
    request".
  - "quarantines refused entries and merges the rest".
  - "stops without acknowledging when the merge does not run": `current.value = false`.
  - "stops without acknowledging when opening fails for a local reason": `mailboxOpen` rejects
    with "vault is locked".
  - "holds a body from a newer version".
  - "counts an expiry marker as a gap and acknowledges it": `advance(366 days)`, then `sweep()`.
  - "records the sequence and finds a skipped number": B acknowledges message 2 of 3 through
    the api without merging it, and `state.gaps` holds A.
- [ ] **Step 3: Run to verify they fail.** Run the core and mobile commands from Tasks 8 and 9.
  Expected: FAIL on import.
- [ ] **Step 4: Implement `drainInbox`.**
- [ ] **Step 5: Run to verify they pass.**
- [ ] **Step 6: Commit**: `feat(mailbox): collect, merge and acknowledge the inbox`.

### Task 11: Sending

**Files:**
- Create: `packages/core/src/sync/mailbox/send.ts`
- Test: `clients/mobile/src/sync/mailbox/send.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 4 to 9.
- Produces:

```ts
export type PostOutcome = "posted" | "nothing" | "collect_only" | "quota_exceeded";
export async function postChanges(ctx: MailboxContext, state: MailboxState, local: MailboxEnvelope): Promise<PostOutcome>;
/** The whole state, split into parts, to `to` (everyone when absent). Ids posted, last part last. */
export async function postSnapshot(ctx: MailboxContext, state: MailboxState, local: MailboxEnvelope,
	to: string[] | undefined, answers: string | null): Promise<string[]>;
/** Ask `of`'s sender (or everyone, `of` null) for a snapshot, at most once per `LIMITS.requestEveryMs`. */
export async function requestSnapshot(ctx: MailboxContext, state: MailboxState, of: string | null): Promise<void>;
export async function answerRequests(ctx: MailboxContext, state: MailboxState, local: MailboxEnvelope): Promise<void>;
export async function compact(ctx: MailboxContext, state: MailboxState, local: MailboxEnvelope): Promise<void>;
```

**`postChanges`:**
1. `cutDelta(local.entries, state.posted)`. No parts: `"nothing"`.
2. Eager upload. For every file record in the parts whose hash this device holds and which is
   not in `state.uploaded`, upload it, then add it to `state.uploaded`. The spec's "the device
   that attaches a file" is read as "any device that holds the bytes of a record it is posting
   for the first time": the server stores a hash once, so a second uploader costs bytes, never
   correctness.
3. Post each part as a delta:
   - `seq = state.nextSeq`, then `nextSeq++` on any 2xx;
   - a fresh 16-byte message id;
   - a log entry `{id, bytes, at: api.serverNow()}` when `stored`.
4. Set `state.posted = index` only after the last part.
5. `402 collect_only` and `quota_exceeded` return their outcome and leave `posted` as it was.

**Snapshots and requests:**
- `postSnapshot` posts `cutDelta(local.entries, {})` parts with `seq = state.nextSeq - 1`,
  logging the stored ones.
- `requestSnapshot` posts `{kind: "snapshot_request", of}`:
  - to `[of]` first;
  - if that reaches nobody (`recipients: 0`), to everyone.
  - `of: null` posts to everyone.
- `answerRequests` answers each `state.toAnswer` entry with `postSnapshot([requester], of)`,
  unless that requester was answered within `LIMITS.requestEveryMs`. Either way, it then clears the
  entry.

**`compact`:**
1. It runs once the log reaches `LIMITS.compactCount` messages or `LIMITS.compactBytes` bytes.
2. Targets are the active members other than this device whose `lastCheckedDay` is `null` or
   below `Math.floor(log[0].at / 86_400_000)`.
3. With no targets, it clears the log.
4. Otherwise it posts a snapshot to the targets, then calls `replaces` on the snapshot's last
   part, naming every logged id, in chunks of `MAX_LIST`. The log becomes the snapshot's parts.

- [ ] **Step 1: Write the failing tests**:
  - "posts a closed delta with the next sequence number, then nothing until the next change".
  - "uploads a new attachment before the delta that names it": in B's inbox, the blob's
    `createdAt` is no later than the message's.
  - "splits a delta larger than one message into closed parts": with
    `limits.partBudget = 2000`, B merges every part and matches A.
  - "keeps the delta while collect-only, and posts it after": `setCanPost(false)`, then `true`.
  - "answers a snapshot request once per hour".
  - "compacts the backlog for a member that has not checked in":
    - `compactCount: 3`; B is active but never collects; A posts 3 deltas, then compacts.
    - B's inbox holds exactly one snapshot from A.
  - "clears the log when every member checked in since".
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit**: `feat(mailbox): post deltas and snapshots, and compact the backlog`.

### Task 12: Membership

**Files:**
- Create: `packages/core/src/sync/mailbox/members.ts`
- Test: `packages/core/src/sync/mailbox/members.test.ts` (stub api),
  `clients/mobile/src/sync/mailbox/members.integration.test.ts`

**Interfaces:**
- Produces:

```ts
export async function ensureActive(ctx: MailboxContext, state: MailboxState, roster: RosterPayload): Promise<"active" | "waiting">;
export async function reconcileMembers(ctx: MailboxContext, state: MailboxState, roster: RosterPayload): Promise<void>;
export async function switchOff(ctx: MailboxContext, state: MailboxState): Promise<void>;
```

**`ensureActive`:**
1. `state.active`: return `"active"`.
2. Otherwise `activate(true)`. On success, set `active` and `catchUp`.
3. `404 not_found`: create the mailbox with `activeSigKeys(roster)` plus this device. The
   creator skips the catch-up, since nobody else is active yet. A `409 exists` from that create
   means another device won the race: activate once more.
4. `403 not_eligible`: return `"waiting"`.

**`reconcileMembers`** runs when the roster's fingerprint differs from `state.reconciled`, or
`LIMITS.reconcileEveryMs` has passed:
- `desired = activeSigKeys(roster)` plus this device;
- add what the server lacks, and remove every listed key not in `desired`, in chunks of
  `MAX_MEMBERS`;
- record the fingerprint and the time.

**`switchOff`:** `activate(false)` and `state.active = false`. The device stays eligible.

- [ ] **Step 1: Write the failing tests**:
  - Core, "falls back to activating when a concurrent create won": the stub answers
    `not_found`, then `exists`, then success.
  - Integration:
    - "the first device creates the mailbox with every active roster device eligible", and a
      revoked device is absent.
    - "a later device activates and asks for a catch-up".
    - "a device no member has listed waits".
    - "reconciliation adds roster devices and removes every other key".
    - "switching off deactivates but stays eligible".
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit**: `feat(mailbox): membership mirrors the roster`.

### Task 13: The engine

**Files:**
- Create: `packages/core/src/sync/mailbox/sync.ts`, `packages/core/src/sync/mailbox/index.ts`
  (the public surface: `mailboxSync`, `mailboxApi`, `storeBlobMover`,
  `createMailboxVaultPort`, `metaStateStore`, and their types)
- Test: `clients/mobile/src/sync/mailbox/sync.integration.test.ts`

**Interfaces:**
- Produces:

```ts
export type MailboxStatus = "synced" | "waiting" | "retry" | "collect_only" | "quota_exceeded";
export interface MailboxSync { sync(): Promise<MailboxStatus>; switchOff(): Promise<void>; }
export function mailboxSync(deps: Omit<MailboxContext, "now" | "random"> & {
	state: MailboxStateStore; now?: () => number; random?: (n: number) => Uint8Array;
}): MailboxSync;
```

**`sync()` order:** concurrent calls share one run.
1. Load the state and `readLocal()`.
2. `ensureActive`. `"waiting"`: save, return.
3. If `catchUp`: `requestSnapshot(null)`, and clear it.
4. `drainInbox`.
   - `deactivated`: run `ensureActive` again (a replayed `{active: false}` is undone here).
   - `interrupted`: save, return `"retry"`.
5. Request snapshots, answer requests and upload what is wanted:
   - `requestSnapshot` for each sender in `state.gaps`, removing each once asked, or once
     skipped because it was asked within the hour. A gap still open in tracking comes back at
     the end of the next drain.
   - `answerRequests`.
   - `uploadWanted(drain.wanted)`.
6. Read local again (the drain merged), then `postChanges`, `compact` and `syncWants`.
7. Reconcile only when the drain held nothing and the post was `"posted"` or `"nothing"`.
   Because the drain merged first, a roster entry that rode a delta reaches this device before
   it judges membership.
8. Save the state after the post and at the end.
9. Return `collect_only` or `quota_exceeded` from the post, else `"synced"`.

- [ ] **Step 1: Write the failing tests** (the spec's Phasing scenarios plus the Review Focus).
  Devices only ever `sync()` one at a time:
  - "two devices that are never online together converge on entries and files".
  - "a late activation catches up from the others' snapshots".
  - "a future-dated message is retried, not lost".
  - "a lost message is healed by a snapshot": B acks one of A's messages through the api without
    merging it.
  - "compaction keeps an absent member's backlog to one snapshot".
  - "an expired message becomes a marker, and the returning device heals".
  - "a revoked device's posts are quarantined, and reconciliation removes it".
  - "a full quota and collect-only keep collecting".
  - "a stale roster does not evict a newly paired device" (Review Focus 3):
    - A adds C to its roster, then syncs, and C activates.
    - B, whose roster still lacks C, syncs.
    - C is still active.
  - "a replayed deactivation is undone on the next sync" (Review Focus 5): A's `activate(false)`
    is sent through the api directly.
  - "the same flow converges with the real core's crypto": the
    `mailbox-crypto.integration.test.ts` port over the built wasm, for two devices.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.** Run the mobile command three times. Each scenario
  starts its own mailbox, so the results must not depend on order.
- [ ] **Step 5: Commit**: `feat(mailbox): the mailbox sync engine`.

### Task 14: Docs and the full check

**Files:**
- Modify: `docs/mailbox-service.md`
  - **Status:** the client transport is built.
  - **"Messages":** the plaintext kinds, epochs and numbering, as built.
  - **"Gaps and self-healing":** the 404, marker and proxy-heal rules.
  - **"Clients":** version skew holds newer messages.
  - **"API sketch":** canonical keys, the replay policy, origin-only server URLs.
- Modify: `docs/README.md` (the row for this plan is written with it)

- [ ] **Step 1: Edit the docs.**
- [ ] **Step 2: Run everything CI runs**
  Run: `CI=true pnpm run test && pnpm run typecheck && pnpm run ci:check && pnpm run wasm:verify`
  Expected: all pass.
- [ ] **Step 3: Commit**: `docs(mailbox): the client transport as built`.

### After the plan (Plan 4)

- **The flag and the wiring.**
  - Each platform builds a `MailboxVaultPort` from its merge path, returning `null` where its
    wrapper skips a merge today:
    - desktop `roster.ts` on a session-generation change;
    - mobile `sync-manager.ts` on a session-generation change;
    - the extension's `applyRemoteNow` with no `pinnedCtx`.
  - On the extension the engine runs in the background, with crypto in the offscreen host.
- **Native transports.**
  - Check that the desktop and mobile `HttpTransport`s send `content-length` for byte bodies.
  - Desktop throws on `HttpBodySource`.
  - Android moves about 0.5 MB/s over the Capacitor bridge, so snapshots and blobs need a native
    mover there.
- **The settings and devices list**, with `lastCheckedDay` per device.
