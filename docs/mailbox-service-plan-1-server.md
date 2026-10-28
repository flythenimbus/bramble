# Mailbox Plan 1: Protocol and Self-Hostable Server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working mailbox server any self-hoster can run with `node`, speaking the signed HTTP
protocol every later client and the hosted Worker will share.

**Architecture:** The wire protocol (constants, zod schemas, the canonical string a request signs)
lives in `packages/core` under GPL so clients and servers share one definition. The server in
`services/mailbox` (AGPL) is a Hono app over a Drizzle SQLite schema and a `BodyStore` for
ciphertext, with every storage and platform difference behind those two seams: this plan
implements them for Node (better-sqlite3 and a directory on disk); the hosted plan adds D1 and R2.

**Tech Stack:** Node 24 running TypeScript directly (type stripping), Hono 4, Drizzle ORM 0.45
with better-sqlite3, zod 4, WebCrypto Ed25519 and SHA-256, Vitest 4.

**Spec:** [mailbox-service.md](mailbox-service.md)

## The milestone

The mailbox is a milestone of six plans, each shipping something testable on its own, written
in order so each one builds on the real interfaces of the last:

1. **Protocol and self-hostable server** (this plan).
2. **Client crypto.** Mailbox id and seal-key derivation and envelope seal/open in `core-rust`,
   exported through wasm, uniffi and the desktop host, behind the `CryptoAdapter`.
3. **Client transport.** The mailbox as a sync transport in `packages/core`: closed deltas,
   sequence numbers and gaps, acknowledgement rules, compaction, eligibility reconciliation,
   eager and wanted blobs, tested against this plan's server.
4. **Apps and self-host release.** Wiring on the extension, mobile and desktop, settings and the
   devices list, end-to-end tests, the Docker image and S3 body store.
5. **Hosted service.** The D1/R2 Worker adapter and cron, rate limits and the observability
   settings, the billing Worker (accounts, ALTCHA, Stripe, refunds, disputes, ledger), the website
   checkout and the account UI.
6. **Crypto payments** through BTCPay Server.

## Global Constraints

- `services/mailbox` is `bramble-mailbox-server`, `AGPL-3.0-only`. The shared protocol stays in
  `packages/core` (`GPL-3.0-only`); nothing in `packages/` or `clients/` imports from `services/`.
- The protocol module imports only `zod`: the server runs it directly under Node, which cannot
  resolve `packages/core`'s extensionless relative imports or `@core/*` aliases.
- Server code runs unbundled on Node 24: ESM, relative imports with `.ts` extensions, erasable
  syntax only (no `enum`, `namespace` or parameter properties; `erasableSyntaxOnly` enforces it).
- Validation is zod wherever input crosses a boundary: JSON bodies, path parameters and signing
  headers go through `@hono/zod-validator` (`zValidator`) with the protocol's schemas, the
  environment through a zod schema, and tests parse responses with the protocol's response
  schemas. Hand-written checks only where zod cannot reach (the streamed blob body).
- New dependencies, all in `services/mailbox`: `hono@^4.13.14`, `@hono/node-server@^2.1.5`,
  `@hono/zod-validator@^0.9.1`, `drizzle-orm@^0.45.4`, `better-sqlite3@^13.0.3`, `zod@^4.6.7`;
  dev: `drizzle-kit@^0.31.11`,
  `@types/better-sqlite3@^9.6.0`, plus the workspace's existing `vitest@^4.1.12`,
  `typescript@^5.9.3`, `@types/node@^24.13.3`. `better-sqlite3` joins `onlyBuiltDependencies`.
- The server never deletes a message or blob before every delivery of it is acknowledged,
  superseded by a snapshot, or expired. Multi-step writes are ordered so a crash leaves a duplicate
  or an orphan (which the sweep removes), never an early deletion: body before row, new rows
  before deleting replaced ones, row deletion before body deletion.
- No request logging, no stored IP addresses. The Node server logs its listening line and
  configuration errors only, and never echoes the token.
- Retention ceiling defaults to 365 days. `MAILBOX_TOKEN`, when set, is at least 16 URL-safe
  characters (the `RELAY_TOKEN` rule) and `GET /health` stays open.
- Signed requests use the device's roster Ed25519 key (`sigKey`, standard base64 of 32 bytes,
  as `roster_sig_generate_key` makes it) over the canonical string in Task 1. The clock window is
  5 minutes, the same bound as `HLC_MAX_DRIFT_MS`.
- Run tests with `CI=true`. Commits use the repo's conventional style, carry no co-author trailer,
  and say nothing about verification status.

## Review Focus

1. **Acknowledging what was never yours.** A member that acks another member's message id, or an
   id that does not exist, must change nothing; only its own deliveries go. Pinned in Task 6.
2. **A message id chosen by someone else.** Ids are client-chosen, so a member who reuses another
   member's id must get `id_conflict`, never silently dedupe away the other's post. Pinned in
   Task 6.
3. **A device whose clock is wrong.** Devices that are never online together cannot correct each
   other. A request outside the window gets `stale_time` with `serverTime`, so the client can
   correct and retry rather than fail forever. Pinned in Task 3.
4. **Path-shaped ids.** Mailbox ids, message ids and blob hashes become storage keys and file
   paths. Anything off its pattern (`..`, `/`, uppercase hex) is a 400 before storage is touched,
   and the disk store refuses such a key on its own. Pinned in Tasks 4 to 7.
5. **Removing a member mid-flight.** A removed or deactivated member's pending deliveries, wants
   and markers go, and anything left with no deliveries is deleted then, not at the ceiling.
   Pinned in Task 5.

---

### Task 1: The wire protocol

**Files:**
- Create: `packages/core/src/sync/mailbox/protocol.ts`
- Create: `packages/core/src/sync/mailbox/protocol.test.ts`
- Modify: `packages/core/src/sync/entries-payload.ts:41` (re-export `BLOB_HASH_RE` from the
  protocol instead of defining it, so the blob-hash rule has one home)

**Interfaces:**
- Produces, all exported from `protocol.ts`:
  - `SIGNING_DOMAIN = "bramble-mailbox/v1"`
  - `HEADERS = { key: "x-bramble-key", time: "x-bramble-time", contentSha256: "x-bramble-content-sha256", sig: "x-bramble-sig", token: "x-bramble-token" } as const`
  - `EMPTY_SHA256` (SHA-256 hex of zero bytes), `MAX_CLOCK_SKEW_MS = 300_000`,
    `MAX_MESSAGE_BYTES = 16 * 1024 * 1024`, `MAX_BLOB_BYTES = 95_000_000`,
    `DEFAULT_RETENTION_DAYS = 365`, `INBOX_PAGE = 500`, `MAX_LIST = 1000`, `MAX_WANTS = 10_000`,
    `MAX_MEMBERS = 64`
  - `MAILBOX_ID_RE = /^[A-Za-z0-9_-]{43}$/` (32 bytes base64url), `MESSAGE_ID_RE = /^[A-Za-z0-9_-]{22}$/`
    (16 bytes base64url), `SIG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/`, `BLOB_HASH_RE = /^[0-9a-f]{64}$/`
  - Schemas and their `z.infer` types: `CreateMailboxBody { members: SigKey[]; retentionDays?: number }`,
    `SettingsBody { retentionDays: number }`, `MembersBody { add: SigKey[]; remove: SigKey[] }`,
    `ActivationBody { active: boolean }`,
    `PostMessageBody { id: string; body: string /* base64 */; to?: SigKey[]; replaces?: string[] }`,
    `AckBody { messages: string[]; blobs: string[]; markers: number[] }`, `WantsBody { hashes: string[] }`,
    `MembersResponse { members: { sigKey: string; status: "eligible" | "active"; lastCheckedDay: number | null }[] }`,
    `PostResponse { stored: boolean; recipients: number }`,
    `InboxResponse { messages: { id; sender; size; createdAt }[]; blobs: { hash; size; uploader; createdAt }[]; wanted: string[]; markers: { id; sender; count; expiredAt }[]; more: boolean; retentionDays: number; usedBytes: number; quotaBytes: number | null; serverTime: number }`,
    `ErrorResponse { error: MailboxErrorCode; serverTime?: number }`
  - `type MailboxErrorCode = "bad_request" | "bad_signature" | "stale_time" | "token_required" | "not_member" | "not_active" | "not_eligible" | "not_found" | "exists" | "id_conflict" | "too_large" | "quota_exceeded" | "hash_mismatch" | "collect_only"`
  - `canonicalRequest(r: { method: string; pathAndQuery: string; time: number; contentSha256: string }): string`
  - `sha256Hex(data: Uint8Array | string): Promise<string>` (WebCrypto, so it runs in Node,
    Workers and every app host)

- [ ] **Step 1: Write the failing tests**

```ts
describe("canonicalRequest", () => {
	it("joins domain, upper-cased method, path with query, time and body hash with newlines", () => {
		expect(canonicalRequest({ method: "post", pathAndQuery: "/v1/mailboxes/abc/acks?x=1", time: 1730000000000, contentSha256: EMPTY_SHA256 }))
			.toBe(`bramble-mailbox/v1\nPOST\n/v1/mailboxes/abc/acks?x=1\n1730000000000\n${EMPTY_SHA256}`);
	});
});
describe("sha256Hex", () => {
	it("hashes the empty input to EMPTY_SHA256 and 'abc' to the known digest", async () => {
		expect(await sha256Hex(new Uint8Array())).toBe(EMPTY_SHA256);
		expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});
describe("id patterns", () => {
	it("accept well-formed ids and refuse path-shaped ones", () => {
		expect(MAILBOX_ID_RE.test("A".repeat(43))).toBe(true);
		expect(MAILBOX_ID_RE.test(`${"A".repeat(41)}/.`)).toBe(false);
		expect(MESSAGE_ID_RE.test("../../../../etc/passwd")).toBe(false);
		expect(BLOB_HASH_RE.test("A".repeat(64))).toBe(false);
		expect(SIG_KEY_RE.test(`${"A".repeat(43)}=`)).toBe(true);
	});
});
describe("schemas", () => {
	it("default AckBody lists to empty and cap them at MAX_LIST", () => {
		expect(AckBodySchema.parse({})).toEqual({ messages: [], blobs: [], markers: [] });
		expect(AckBodySchema.safeParse({ messages: Array(MAX_LIST + 1).fill("A".repeat(22)) }).success).toBe(false);
	});
	it("refuse a PostMessageBody whose `to` is empty", () => {
		expect(PostMessageBodySchema.safeParse({ id: "A".repeat(22), body: "", to: [] }).success).toBe(false);
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter @vault/core exec vitest run src/sync/mailbox/protocol.test.ts`
Expected: FAIL, cannot resolve `./protocol`.

- [ ] **Step 3: Implement `protocol.ts` with the exports above**

Imports `zod` only. `MembersBody.add`/`remove` and `AckBody` lists default to `[]`; list lengths are
capped (`MAX_MEMBERS` for members and `to`, `MAX_LIST` for `replaces` and acks, `MAX_WANTS` for
wants); `retentionDays` is an integer from 1 to 3650. In `entries-payload.ts`, replace the local
definition with `export { BLOB_HASH_RE } from "./mailbox/protocol";` so `backup/archive.ts` and
every other importer keep working unchanged.

- [ ] **Step 4: Run the tests and the core suite**

Run: `CI=true pnpm --filter @vault/core exec vitest run src/sync/mailbox src/backup src/sync/entries-payload.test.ts && pnpm --filter @vault/core typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sync/mailbox packages/core/src/sync/entries-payload.ts
git commit -m "feat(mailbox): the wire protocol shared by clients and servers"
```

### Task 2: Server package, schema and test harness

**Files:**
- Modify: `services/mailbox/package.json` (scripts, dependencies, `"@vault/core": "workspace:*"`)
- Modify: `pnpm-workspace.yaml` (`better-sqlite3` in `onlyBuiltDependencies`), `pnpm-lock.yaml`
- Modify: `biome.json` (exclude `services/mailbox/drizzle`: drizzle-kit writes its migration
  metadata in its own JSON style, which `biome ci` would otherwise fail)
- Create: `services/mailbox/tsconfig.json`, `services/mailbox/drizzle.config.ts`
- Create: `services/mailbox/src/core/schema.ts`, `services/mailbox/src/core/bodies.ts`,
  `services/mailbox/src/core/app.ts`, `services/mailbox/src/node/db.ts`
- Create: `services/mailbox/drizzle/` (generated by `drizzle-kit generate`)
- Create: `services/mailbox/src/test/harness.ts`, `services/mailbox/src/core/app.test.ts`

**Interfaces:**
- Consumes: Task 1's protocol, imported as `@vault/core/src/sync/mailbox/protocol.ts`.
- Produces:
  - `schema.ts`: Drizzle `sqliteTable`s `mailboxes (id pk, retentionDays, createdAt)`,
    `members (mailboxId, sigKey, status "eligible"|"active", addedAt, lastCheckedDay nullable; pk mailboxId+sigKey)`,
    `messages (mailboxId, id, sender, size, createdAt, expiresAt; pk mailboxId+id)`,
    `deliveries (mailboxId, messageId, member; pk all three)`,
    `blobs (mailboxId, hash, size, uploader, createdAt, expiresAt; pk mailboxId+hash)`,
    `blobDeliveries (mailboxId, hash, member; pk all three)`,
    `blobWants (mailboxId, member, hash, createdAt; pk all three)`,
    `expiryMarkers (id integer pk autoincrement, mailboxId, member, sender, count, expiredAt)`.
    Times are epoch-ms integers; `lastCheckedDay` is `Math.floor(ms / 86_400_000)`. Index
    `deliveries` and `blobDeliveries` on `(mailboxId, member)`.
  - `bodies.ts`: `interface BodyStore { put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, opts?: { sha256?: string }): Promise<void>; get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>; delete(key: string): Promise<void>; keys(): AsyncIterable<{ key: string; modifiedAt: number }> }`,
    `messageKey(mailboxId, id) = "m/<mailboxId>/<id>"`, `blobKey(mailboxId, hash) = "b/<mailboxId>/<hash>"`.
    `put` with `sha256` rejects with `HashMismatchError` and stores nothing when the bytes do not
    hash to it.
  - `app.ts`: `type Db = BaseSQLiteDatabase<any, any, typeof schema>` (better-sqlite3 is a sync
    driver and D1 an async one; both fit, and every call is awaited);
    `interface Entitlement { canPost(mailboxId: string): Promise<boolean> }`;
    `interface AppDeps { db: Db; bodies: BodyStore; entitlement: Entitlement; now: () => number; config: { retentionMaxDays: number; quotaBytes: number | null; token: string | null } }`;
    `createApp(deps: AppDeps): Hono<{ Variables: { sigKey: string; contentSha256: string } }>` with
    `GET /health` returning `200 "ok"`.
  - `node/db.ts`: `openDb(file: string): { db: Db; close(): void }`, applying the migrations in
    `services/mailbox/drizzle` with `drizzle-orm/better-sqlite3/migrator`.
  - `test/harness.ts`: `memoryBodies(): BodyStore`;
    `makeServer(opts?: { quotaBytes?: number; token?: string; retentionMaxDays?: number; canPost?: boolean }): { app; deps; clock: { now: number } }`
    over `openDb(":memory:")`;
    `makeDevice(app): Promise<{ sigKey: string; request(method: string, path: string, body?: unknown | Uint8Array, opts?: { time?: number; token?: string }): Promise<Response> }>`,
    which generates an Ed25519 key with WebCrypto, sets the `HEADERS` and signs
    `canonicalRequest(...)` (JSON-encoding a non-`Uint8Array` body);
    `makeRemoteDevice(baseUrl: string)`: the same signing over `fetch`, for Task 9's real port.

- [ ] **Step 1: Add the dependencies, scripts and configs**

`package.json` scripts: `"start": "node src/node/bin.ts"`, `"test": "vitest run"`,
`"typecheck": "tsc --noEmit"`, `"db:generate": "drizzle-kit generate"`. `tsconfig.json` (not
extending the base, whose DOM libs and bundler resolution don't fit a server): `target ES2024`,
`module`/`moduleResolution NodeNext`, `strict`, `noUncheckedIndexedAccess`,
`erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, `types: ["node"]`. Then:

Run: `pnpm install && pnpm audit --prod`
Expected: install succeeds, `better-sqlite3` builds, no new advisories from the added packages.

- [ ] **Step 2: Write the failing tests**

```ts
it("answers the health probe", async () => {
	const { app } = makeServer();
	const res = await app.request("/health");
	expect(res.status).toBe(200);
	expect(await res.text()).toBe("ok");
});
it("creates every table from the migrations", () => {
	const { db } = openDb(":memory:");
	const names = db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`).map((r) => r.name);
	expect(names).toEqual(expect.arrayContaining(["mailboxes", "members", "messages", "deliveries", "blobs", "blob_deliveries", "blob_wants", "expiry_markers"]));
});
it("memoryBodies refuses bytes that do not match the declared hash", async () => {
	const bodies = memoryBodies();
	await expect(bodies.put("b/x/y", new Uint8Array([1]), { sha256: EMPTY_SHA256 })).rejects.toBeInstanceOf(HashMismatchError);
	expect(await bodies.get("b/x/y")).toBeNull();
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `CI=true pnpm --filter bramble-mailbox-server test`
Expected: FAIL, modules missing.

- [ ] **Step 4: Implement the schema, generate the migration, implement the rest**

Run `pnpm --filter bramble-mailbox-server db:generate` after writing `schema.ts`, and commit the
generated `drizzle/` folder. `memoryBodies` lives only under `src/test/`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `CI=true pnpm --filter bramble-mailbox-server test && pnpm --filter bramble-mailbox-server typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/mailbox pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(mailbox): server package, SQLite schema and test harness"
```

### Task 3: Signed requests and the token gate

**Files:**
- Create: `services/mailbox/src/core/auth.ts`, `services/mailbox/src/core/auth.test.ts`
- Modify: `services/mailbox/src/core/app.ts` (mount the middleware on `/v1/*`)

**Interfaces:**
- Consumes: `HEADERS`, `canonicalRequest`, `sha256Hex`, `MAX_CLOCK_SKEW_MS`, `SIG_KEY_RE` from Task 1;
  `AppDeps` from Task 2.
- Produces:
  - `tokenGate(token: string | null): MiddlewareHandler`: when `token` is set, a request without a
    matching `x-bramble-token` gets `403 { error: "token_required" }`, compared in constant time.
  - `signedRequest(now: () => number): MiddlewareHandler`: verifies the four signing headers,
    answers `401 { error: "stale_time", serverTime }` outside the window and
    `401 { error: "bad_signature" }` for a bad key, signature or encoding, and sets `sigKey` and
    `contentSha256` on the context.
  - `SigningHeadersSchema` (zod, in `auth.ts`): the four signing headers, validated by
    `zValidator("header", ...)` inside `signedRequest`; a failure is `401 bad_signature`.
  - `signedJson<S extends z.ZodType>(schema: S, maxBytes: number)`: a middleware tuple for JSON
    routes. Hono's `bodyLimit` answers `413 too_large` past `maxBytes`. A body-hash check reads the
    cached `arrayBuffer` and answers `401 bad_signature` when its SHA-256 differs from the signed
    `contentSha256`. Then `zValidator("json", schema, hook)`, so the handler reads
    `c.req.valid("json")`. Hono caches the body, so it is read once.
  - `param<S extends z.ZodType>(schema: S)`: `zValidator("param", schema, hook)`. Every route's
    `:id`, `:mid` and `:hash` go through it, built from `MailboxIdSchema`, `MessageIdSchema` and
    `BlobHashSchema`.
  - `validationHook`: the shared `zValidator` hook, rendering a failure as
    `400 { error: "bad_request" }` (or `401 bad_signature` for headers), never echoing input.
  - `class HttpError extends Error { status; code: MailboxErrorCode }` and an `app.onError` that
    renders it as `ErrorResponse` (unknown errors are a bare 500 with no detail).

- [ ] **Step 1: Write the failing tests**

Against a throwaway route `POST /v1/echo` registered in the test with
`...signedJson(z.object({ n: z.number() }), 1024)`, which returns `c.var.sigKey` and
`c.req.valid("json")`:

```ts
it("accepts a correctly signed request and exposes the signer", async () => { /* 200, body.sigKey === device.sigKey */ });
it("refuses a signature by a different key", async () => { /* swap x-bramble-key for another device's: 401 bad_signature */ });
it("refuses a body that differs from the signed hash", async () => { /* sign one body, send another: 401 bad_signature */ });
it("answers a clock outside the window with the server's time", async () => {
	const res = await device.request("POST", "/v1/echo", {}, { time: clock.now - MAX_CLOCK_SKEW_MS - 1 });
	expect(res.status).toBe(401);
	expect(await res.json()).toEqual({ error: "stale_time", serverTime: clock.now });
});
it("accepts a clock at the edge of the window", async () => { /* time = now + MAX_CLOCK_SKEW_MS: 200 */ });
it("refuses a request without the token when one is configured, but keeps /health open", async () => { /* 403 token_required; /health 200 */ });
it("refuses a JSON body larger than the limit before parsing it", async () => { /* 413 too_large */ });
it("answers a body the schema rejects with bad_request, without echoing it", async () => { /* { n: "x" } -> 400 { error: "bad_request" } exactly */ });
it("refuses missing or malformed signing headers as bad_signature", async () => { /* drop x-bramble-sig; non-numeric time -> 401 */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter bramble-mailbox-server exec vitest run src/core/auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `auth.ts`**

Verify with `crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"])` and
`crypto.subtle.verify({ name: "Ed25519" }, ...)`: the same primitive `roster_sign` produces, and
available in both Node 24 and Workers. A malformed header is `bad_signature`, never a 500.

- [ ] **Step 4: Run the tests**

Run: `CI=true pnpm --filter bramble-mailbox-server exec vitest run src/core/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/mailbox/src/core
git commit -m "feat(mailbox): signed requests and the private-server token"
```

### Task 4: Disk body store

**Files:**
- Create: `services/mailbox/src/node/disk-bodies.ts`, `services/mailbox/src/node/disk-bodies.test.ts`

**Interfaces:**
- Consumes: `BodyStore`, `HashMismatchError` from Task 2.
- Produces: `diskBodies(root: string): BodyStore`. A key's path is `root` joined with its `/`
  segments; a key with any segment outside `[A-Za-z0-9_-]+` throws before touching the disk.

- [ ] **Step 1: Write the failing tests**

```ts
it("round-trips a streamed body and reports its size", async () => { /* put stream of 3 MiB, get -> same bytes, size */ });
it("leaves nothing behind when the hash does not match", async () => { /* rejects HashMismatchError; get -> null; no temp files in root */ });
it("treats deleting a missing key as done", async () => { await expect(store.delete("m/a/b")).resolves.toBeUndefined(); });
it("lists keys with their modification times", async () => { /* two puts -> keys() yields both with modifiedAt > 0 */ });
it("refuses a key that would leave the root", async () => {
	await expect(store.put("m/../escape", new Uint8Array([1]))).rejects.toThrow();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter bramble-mailbox-server exec vitest run src/node/disk-bodies.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `diskBodies`**

Stream into a sibling temp file while hashing (`node:crypto` `createHash("sha256")`), compare,
then `rename` into place; on mismatch or error, unlink the temp file. `get` returns
`Readable.toWeb(createReadStream(path))` with `stat().size`.

- [ ] **Step 4: Run the tests**

Run: `CI=true pnpm --filter bramble-mailbox-server exec vitest run src/node/disk-bodies.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/mailbox/src/node
git commit -m "feat(mailbox): disk body store for the self-hosted server"
```

### Task 5: Mailboxes and membership

**Files:**
- Create: `services/mailbox/src/core/mailboxes.ts`, `services/mailbox/src/core/mailboxes.test.ts`
- Create: `services/mailbox/src/core/cleanup.ts` (shared by Tasks 5 to 8)
- Modify: `services/mailbox/src/core/app.ts` (mount the routes)

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:
  - Routes: `POST /v1/mailboxes/:id` (create), `PATCH /v1/mailboxes/:id` (settings),
    `GET /v1/mailboxes/:id/members`, `POST /v1/mailboxes/:id/members`,
    `POST /v1/mailboxes/:id/activation`.
  - `requireMember(deps, mailboxId, sigKey, need: "any" | "active"): Promise<{ status: "eligible" | "active" }>`,
    throwing `404 not_found` for an unknown mailbox, `403 not_member` for a stranger and
    `403 not_active` when `need` is `"active"` and the caller is only eligible.
  - `cleanup.ts`: `dropMember(deps, mailboxId, sigKey, keepRow: boolean): Promise<void>` (removes
    the member's deliveries, blob deliveries, wants and markers, then its row unless `keepRow`) and
    `deleteUndelivered(deps, mailboxId): Promise<number>` (deletes message and blob rows with no
    deliveries left, then their bodies; returns how many).

Behaviour the tests pin:
- Create: the body's `members` must include the caller (else `400 bad_request`). All listed keys
  become `eligible`, the caller `active`. `retentionDays` defaults to and is clamped to
  `config.retentionMaxDays`. An existing id is `409 exists`. A malformed `:id` is
  `400 bad_request`.
- Settings: active members only; `retentionDays` is clamped to the ceiling.
- Members: changes need an `active` caller. `add` inserts missing keys as `eligible` and leaves
  existing ones alone. `remove` calls `dropMember(..., keepRow: false)` then `deleteUndelivered`.
- Activation: `{ active: true }` needs an existing row (else `403 not_eligible`). `{ active: false }`
  calls `dropMember(..., keepRow: true)`, sets `eligible`, then `deleteUndelivered`.
- `GET members` is open to eligible and active members, so a device can see where it stands
  before activating.

- [ ] **Step 1: Write the failing tests**

```ts
it("creates a mailbox with the caller active and everyone else eligible", async () => { /* GET members -> statuses */ });
it("refuses to create a mailbox that does not list its creator", async () => { /* 400 */ });
it("answers 409 for an id that already exists", async () => { /* second create -> exists */ });
it("clamps retention to the server's ceiling", async () => { /* retentionMaxDays 30: create asking 365, PATCH asking 90 -> the mailboxes row holds 30 both times */ });
it("lets an eligible device activate, and refuses a stranger", async () => { /* eligible -> 200; stranger -> 403 not_eligible */ });
it("only lets active members change the list", async () => { /* eligible caller -> 403 not_active */ });
it("a removed device cannot make itself eligible again", async () => { /* remove B; B posts members add [B] -> 403 not_member */ });
it("removing a member drops its pending deliveries and deletes what nobody else awaits", async () => {
	// A, B active; A posts to B (Task 6 route); A removes B; the message row and body are gone
});
it("deactivating keeps the member eligible but stops deliveries to it", async () => { /* status eligible; later posts not addressed to it */ });
it("refuses a malformed mailbox id before touching storage", async () => { /* POST /v1/mailboxes/not-a-mailbox-id -> 400 bad_request */ });
```

The two tests that post messages land in this task's file but stay `it.todo` until Task 6, then
are switched on there.

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter bramble-mailbox-server exec vitest run src/core/mailboxes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the routes, `requireMember` and `cleanup.ts`**

- [ ] **Step 4: Run the tests**

Run: `CI=true pnpm --filter bramble-mailbox-server exec vitest run src/core/mailboxes.test.ts`
Expected: PASS (the two `todo`s reported as todo).

- [ ] **Step 5: Commit**

```bash
git add services/mailbox/src/core
git commit -m "feat(mailbox): mailboxes, eligibility and activation"
```

### Task 6: Messages, inbox, acknowledgement and compaction

**Files:**
- Create: `services/mailbox/src/core/messages.ts`, `services/mailbox/src/core/messages.test.ts`
- Modify: `services/mailbox/src/core/app.ts`, `services/mailbox/src/core/mailboxes.test.ts`
  (switch on the two `todo`s)

**Interfaces:**
- Consumes: Tasks 1 to 5; `deps.entitlement.canPost`.
- Produces routes: `POST /v1/mailboxes/:id/messages`, `GET /v1/mailboxes/:id/inbox`,
  `GET /v1/mailboxes/:id/messages/:mid`, `POST /v1/mailboxes/:id/acks`; and
  `usedBytes(deps, mailboxId): Promise<number>` (sum of message and blob sizes), used by Task 7.

Behaviour the tests pin:
- Post, active callers only:
  - Entitlement refusal is `402 collect_only`; collecting and acknowledging still work.
  - Base64-decoded body over `MAX_MESSAGE_BYTES` is `413 too_large`.
  - Recipients are every active member except the caller, intersected with `to` when given.
    With none, the response is `{ stored: false, recipients: 0 }` and nothing is written.
  - Over quota is `507 quota_exceeded`.
  - Same `(mailbox, id)` from the same sender returns the original `PostResponse`; from another
    sender it is `409 id_conflict`.
  - `expiresAt` is `createdAt + mailbox.retentionDays` days.
  - Write order: body, message row, deliveries, then the replacements.
- `replaces`: only the caller's own messages count. For each, delete its deliveries to this
  post's recipients, then `deleteUndelivered`. Ids the caller does not own are ignored silently.
- Inbox, active callers only:
  - The caller's pending messages, oldest first, `INBOX_PAGE` at a time, with `more`.
  - Its markers, `retentionDays`, `usedBytes`, `quotaBytes` and `serverTime`.
  - Sets the caller's `lastCheckedDay`.
  - `blobs` and `wanted` stay empty until Task 7.
- Message body: `application/octet-stream`, only to a caller with a pending delivery (else
  `404 not_found`).
- Acks: delete only the caller's own deliveries of the listed ids, then `deleteUndelivered`.
  Unknown ids and other members' ids change nothing. Listed markers are deleted where they
  belong to the caller.

- [ ] **Step 1: Write the failing tests**

```ts
it("delivers to every other active member and to nobody eligible", async () => { /* A,B active, C eligible: B's inbox has it, C gets 403 not_active on inbox */ });
it("addresses only the members named in `to`", async () => { /* A,B,C active; to:[B] -> C's inbox empty */ });
it("stores nothing when there is nobody to deliver to", async () => { /* A alone -> stored:false; usedBytes 0 */ });
it("keeps a message until the last recipient acknowledges it", async () => {
	// A posts to B and C; B acks -> body still served to C; C acks -> row and body gone
});
it("ignores acks for messages the caller was never sent", async () => {
	// A posts to B only; C (active) acks its id -> B still has it
});
it("treats a repeated id from the same sender as the same post", async () => { /* second post -> same PostResponse; one delivery */ });
it("refuses another member's id", async () => { /* B posts A's id -> 409 id_conflict; A's message intact */ });
it("lets a snapshot replace only its sender's messages, only for its recipients", async () => {
	// A posts m1, m2 to B,C; B acks m1; A posts snapshot s to:[C] replaces:[m1,m2] -> C has only s; B still has m2
	// B posts b1 to C; A's snapshot replaces:[b1] -> b1 untouched
});
it("refuses posts but serves the inbox when the entitlement says collect-only", async () => { /* canPost false -> 402; inbox 200; acks 200 */ });
it("refuses a post that would exceed the quota", async () => { /* quotaBytes 10, body 11 bytes -> 507 */ });
it("pages the inbox and records the caller's check-in day", async () => { /* INBOX_PAGE+1 posts -> first page more:true; GET members shows lastCheckedDay */ });
it("serves a body only to a pending recipient", async () => { /* stranger/non-recipient -> 404 */ });
it("refuses a malformed message id", async () => { /* GET .../messages/not-an-id -> 400 bad_request */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter bramble-mailbox-server exec vitest run src/core/messages.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `messages.ts`**

- [ ] **Step 4: Run the server suite**

Run: `CI=true pnpm --filter bramble-mailbox-server test`
Expected: PASS, including the two switched-on membership tests.

- [ ] **Step 5: Commit**

```bash
git add services/mailbox/src/core
git commit -m "feat(mailbox): messages, inbox, acknowledgement and compaction"
```

### Task 7: Blobs and wants

**Files:**
- Create: `services/mailbox/src/core/blobs.ts`, `services/mailbox/src/core/blobs.test.ts`
- Modify: `services/mailbox/src/core/app.ts`, `services/mailbox/src/core/messages.ts` (fill
  `blobs` and `wanted` in the inbox)

**Interfaces:**
- Consumes: Tasks 1 to 6 (`usedBytes`, `deleteUndelivered`, `BodyStore.put` with `sha256`).
- Produces routes: `PUT /v1/mailboxes/:id/blobs/:hash`, `GET /v1/mailboxes/:id/blobs/:hash`,
  `PUT /v1/mailboxes/:id/wants`. Acks for blobs go through Task 6's `POST .../acks` (`blobs: []`),
  which this task extends to blob deliveries.

Behaviour the tests pin:
- Upload, active callers only:
  - The signed `contentSha256` must equal `:hash` (else `400 hash_mismatch`).
  - `content-length` over `MAX_BLOB_BYTES` is `413` before reading.
  - Entitlement refusal is `402`; quota is checked against the declared length (`507`).
  - The body is streamed into the store with `sha256: hash`; a mismatch is
    `400 hash_mismatch` and leaves no row.
  - Deliveries go to every other active member, and every `blobWants` row for the hash is
    deleted.
  - A hash already present returns `{ stored: true, recipients: <current count> }` without
    re-reading the body. No other active member means `{ stored: false, recipients: 0 }`.
- Download: any active member while the blob exists.
- Wants: replaces the caller's set, at most `MAX_WANTS`.
- Inbox:
  - `blobs` lists the caller's pending blob deliveries.
  - `wanted` lists the distinct hashes other active members want that are not already in this
    mailbox.

- [ ] **Step 1: Write the failing tests**

```ts
it("stores a blob once and delivers it to every other active member", async () => { /* A uploads; B, C inbox blobs contain it */ });
it("refuses bytes that do not match the hash, and keeps nothing", async () => { /* sign with hash H, send other bytes -> 400 hash_mismatch; GET -> 404 */ });
it("refuses a declared length over MAX_BLOB_BYTES without reading the body", async () => { /* 413 */ });
it("refuses a path-shaped or upper-case hash", async () => { /* 400 */ });
it("tells holders what others want, and forgets a want once the blob arrives", async () => {
	// B wants H; A's inbox wanted:[H]; A uploads H -> B's want gone, B has a blob delivery
});
it("deletes the blob after its last recipient acknowledges it", async () => { /* B, C ack -> GET 404, body gone */ });
it("answers a re-upload of a present hash without storing it again", async () => { /* stored:true, one body */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter bramble-mailbox-server exec vitest run src/core/blobs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `blobs.ts` and extend acks and the inbox**

Read the body as `c.req.raw.body`; never buffer it. The signature step already verified
`contentSha256`, so equality with `:hash` plus the store's hash check is the whole content check.

- [ ] **Step 4: Run the server suite**

Run: `CI=true pnpm --filter bramble-mailbox-server test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/mailbox/src/core
git commit -m "feat(mailbox): content-addressed blobs and wants"
```

### Task 8: Retention sweep

**Files:**
- Create: `services/mailbox/src/core/sweep.ts`, `services/mailbox/src/core/sweep.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 7.
- Produces: `sweep(deps: AppDeps): Promise<{ messages: number; blobs: number; markers: number; mailboxes: number; orphans: number }>`,
  idempotent, run by the Node entry hourly and by the hosted cron later.

What one sweep does, in this order:
1. **Expired messages** (`expiresAt <= now`): for each pending delivery, add to a marker per
   `(member, sender)`, inserting it or adding to `count`. Then delete the deliveries, the rows and
   the bodies.
2. **Expired blobs:** delete them with their deliveries and bodies. No marker: a returning device
   wants what its manifest names, and the wants path re-uploads it.
3. **Old markers:** delete markers whose `expiredAt` is older than the ceiling.
4. **Abandoned mailboxes:** delete every row of a mailbox whose members have all not checked in
   for the ceiling (a never-checked member counts from the mailbox's `createdAt`), then its bodies.
5. **Leftovers:** `deleteUndelivered` for every mailbox.
6. **Orphan bodies:** delete store keys with no row that are more than one hour old. The age
   matters because a post writes its body before its row.

- [ ] **Step 1: Write the failing tests** (the harness clock advances `deps.now`)

```ts
it("expires a message at the ceiling and leaves a marker for each recipient that missed it", async () => {
	// A posts two messages to B; advance past retention; sweep -> messages 2; B's inbox markers [{ sender: A.sigKey, count: 2 }]
});
it("keeps a message one millisecond before it expires", async () => { /* advance to expiresAt - 1 -> nothing swept */ });
it("deletes a marker once its member acknowledges it, and old markers on their own", async () => { /* ack markers; and advance past ceiling */ });
it("expires blobs without leaving markers", async () => { /* blob gone, no marker */ });
it("deletes a mailbox nobody has checked in to for the ceiling", async () => { /* advance; mailboxes 1; GET members -> 404 */ });
it("keeps a recent orphan body and deletes an old one", async () => { /* put a body with no row; sweep -> kept; advance 1h+1ms; sweep -> orphans 1 */ });
it("is a no-op the second time", async () => { /* sweep twice -> second report all zero */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter bramble-mailbox-server exec vitest run src/core/sweep.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `sweep.ts`**

- [ ] **Step 4: Run the server suite**

Run: `CI=true pnpm --filter bramble-mailbox-server test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/mailbox/src/core
git commit -m "feat(mailbox): retention sweep, expiry markers and orphan cleanup"
```

### Task 9: The Node server

**Files:**
- Create: `services/mailbox/src/node/config.ts`, `services/mailbox/src/node/config.test.ts`
- Create: `services/mailbox/src/node/server.ts`, `services/mailbox/src/node/server.test.ts`
- Create: `services/mailbox/src/node/bin.ts`
- Modify: `services/mailbox/README.md` (how to run it)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `ConfigSchema` (zod, coercing the strings) and
    `parseConfig(env: Record<string, string | undefined>): { port: number; dataDir: string; token: string | null; retentionMaxDays: number; quotaBytes: number | null }`,
    throwing `ConfigError` that names the offending variable and never includes the token's value.
    - `PORT`: default `7401`, the relay being `7400`.
    - `DATA_DIR`: default `./data`.
    - `MAILBOX_TOKEN`: optional; `/^[A-Za-z0-9_-]{16,}$/`.
    - `RETENTION_MAX_DAYS`: integer 1 to 3650, default `365`.
    - `QUOTA_BYTES`: optional positive integer per mailbox; unset means no quota.
  - `startServer(env): Promise<{ url: string; close(): Promise<void> }>`: opens
    `<dataDir>/mailbox.db`, uses `<dataDir>/bodies`, serves `createApp` with
    `@hono/node-server`, runs `sweep` once at start and hourly on an unref'd timer, and logs one
    line: `mailbox listening on <url>`.
  - `bin.ts`: calls `startServer(process.env)`. On `ConfigError` it prints the message and exits
    1 before listening, as the relay does.

- [ ] **Step 1: Write the failing tests**

```ts
// config.test.ts
it("defaults to port 7401, ./data, 365 days, no token and no quota", () => { /* parseConfig({}) */ });
it("refuses a short token without echoing it", () => {
	expect(() => parseConfig({ MAILBOX_TOKEN: "short-secret" })).toThrow(ConfigError);
	try { parseConfig({ MAILBOX_TOKEN: "short-secret" }); } catch (e) { expect(String(e)).not.toContain("short-secret"); }
});
it("refuses a retention outside 1 to 3650 days and a non-numeric quota", () => { /* ConfigError */ });

// server.test.ts: a real port (PORT=0) and a temp DATA_DIR
it("serves health, accepts a signed create, and keeps data across a restart", async () => {
	// startServer -> fetch /health 200; signed POST /v1/mailboxes/<id> 200 via fetch; close; startServer again on the same dir -> GET members 200
});
```

`makeDevice` from the harness gains a `fetch`-based variant that takes a base URL, so the same
signing code drives the real port.

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true pnpm --filter bramble-mailbox-server exec vitest run src/node`
Expected: FAIL.

- [ ] **Step 3: Implement `config.ts`, `server.ts`, `bin.ts` and the README section**

The README gains: run with `pnpm --filter bramble-mailbox-server start`; the environment
variables above; that a public deployment belongs behind a TLS reverse proxy; and that clients
reach it at `https://<host>` with the token in the app's settings, never in the URL.

- [ ] **Step 4: Run the server suite, typecheck and a manual start**

Run: `CI=true pnpm --filter bramble-mailbox-server test && pnpm --filter bramble-mailbox-server typecheck`
Expected: PASS.
Run: `DATA_DIR=$(mktemp -d) pnpm --filter bramble-mailbox-server start` then `curl -s localhost:7401/health`
Expected: the listening line, then `ok`. Stop it with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add services/mailbox
git commit -m "feat(mailbox): the self-hostable Node server"
```

### Task 10: Bring the docs in line

**Files:**
- Modify: `docs/mailbox-service.md` ("Acknowledgement and deletion", "Retention", "Storage on the
  hosted service", "API sketch", the tables, "Self-hosting")

The build settled details the design left open. The design doc should describe what exists:

- **Ordered writes instead of one atomic write.** Acknowledging and compaction are ordered
  writes with a sweep behind them, not single transactions. The invariant in this plan's Global
  Constraints is what the design's atomicity was for, and it holds on D1, where interactive
  transactions do not exist.
- **Markers carry `(sender, count)`, not a sequence range.** Sequence numbers live only inside
  the ciphertext, so the server learns less. A marker is a cue to request a snapshot; the
  recipient's own sequence tracking finds the exact gap.
- **Blobs expire without markers.** The wants path recovers them.
- **The real API.** Create is `POST /v1/mailboxes/:id` and settings are `PATCH`. Requests carry
  the five `x-bramble-*` headers and sign the canonical string.
- **Self-hosting.** `DATA_DIR` joins the variables. `TRUST_PROXY` goes, because the Node server
  never reads an address. `STORAGE=s3` arrives with Plan 4.

- [ ] **Step 1: Edit the sections above**

- [ ] **Step 2: Check formatting**

Run: `pnpm run ci:check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add docs/mailbox-service.md
git commit -m "docs(mailbox): describe the protocol and server as built"
```

### After the plan

- **Nix hash.** Task 2's new dependencies change the workspace's pnpm store, so the desktop
  flake's `pnpmDeps` hash in `clients/desktop/nix/package.nix` goes stale. Refresh it on a machine
  with Nix (`pnpm run test:nix` reports the expected hash) before the next Nix release.
- **Pushing** waits for the owner.

## Outcome

Status: built, 2026-10-27, on `feat/mailbox-service` (unpushed). The server suite has 80 tests; one
fresh review of the plan's range found no Critical issues and six Important ones, all fixed with
a test that failed first. Not yet run anywhere but this machine: the Nix build and CI.

### Calls made during the build

Each was a deviation from the text above, made where the plan was wrong or silent:

- **Ordered writes, scoped cleanup.** Cleanup after an ack, replacement or removal only considers
  the ids involved (and, for an ack, only deliveries the caller actually held), because a post
  writes its row before its deliveries. The sweep's global pass waits an hour.
- **Deliveries are addressed when the body lands.** One `INSERT ... SELECT` against the members
  active then, instead of a list fixed before the upload. Repeating a post or upload fills in
  missing deliveries, so `recipients` in a repeat's answer is who it is for now, not a stored copy
  of the first answer.
- **Raw message bodies.** Message bodies travel as raw bytes with `id` and `to` in the signed
  query, not base64 in JSON. `replaces` is its own request after the snapshot.
- **`more` and `wanted` are paged apart.** `more` means "you have more to collect"; `wanted`
  pages by hash with `wantedAfter` and `wantedMore`.
- **D1's 100-parameter cap.** Every multi-row insert and `IN` list is chunked (`sql.ts`), so the
  same core runs on D1.
- **Cascading foreign keys.** Removing a member, message, blob or mailbox takes its deliveries,
  wants and markers in one statement.
- **Case-proof disk keys.** Body paths are hex-encoded on disk, because macOS and Windows
  filesystems fold case.
- **A memberless mailbox is unclaimed.** A create interrupted between its two writes can be
  completed by the next one.
- **Validation details.**
  - Signing headers are a zod schema checked inside the signature middleware (a failure is 401,
    not the validator's 400).
  - Signed JSON without a JSON content type is refused, since Hono would read it as `{}`.
  - Uploads require `content-length` and record the bytes actually received.
- **Small API choices.**
  - Membership-changing routes return the member list.
  - Settings and acks return 204.
  - An unknown snapshot, or one the caller did not send, answers `replaces` with 404.

### Left for later

Found by the final review, judged minor, not done:

1. `docs/mailbox-service.md` still opens with "Status: design, not built".
2. Lowering `RETENTION_MAX_DAYS` does not reach mailboxes created before it. Apply
   `min(stored, ceiling)` where retention is used.
3. `SIG_KEY_RE` accepts non-canonical base64, so one key can be listed twice. Restrict the last
   character before the `=` to `[AEIMQUYcgkosw048]`, before clients ship.
4. A signed request can be replayed within the five-minute window: an old `{active:false}`, or
   an `add` after a `remove`. Decide on a policy before Plan 3.
5. Temp files a crash leaves in the disk store are never swept.
6. Sweeps have no in-flight guard; one running past an hour overlaps the next.
7. The orphan pass makes one query per stored body, too many for a Worker. Batch it in Plan 5.
8. Quota is checked, then written, so concurrent posts can overshoot it.
9. A want for a hash already in the mailbox creates no delivery. A late member must GET it
   directly, or the server could turn such a want into a delivery.
10. A 404 covers both "not yours" and "row present, body missing". The client needs a
    self-heal rule for the second (ack it and treat it as a gap).
11. A re-upload of a hash landing between a row's deletion and its body's could lose the new
    body.
12. A repeated post under collect-only gets 402 rather than its answer.
13. Two protocol requirements are only in this doc: uploads must send `content-length`, and the
    server must sit at the host root, since signatures cover the path as the server sees it.
14. The default `DATA_DIR` (`services/mailbox/data` when run from the package) is not
    git-ignored.
15. Unexpected 500s log nothing. The message, with no request data, would help a self-hoster.
16. There is no `HOST` variable; the server binds every interface, as the relay does.
17. `MAX_MEMBERS` caps a request, not a mailbox.
18. One test casts a response instead of parsing it with the protocol schema.
19. Two posts of the same id from different members at the same moment can overwrite each
    other's body before the row conflict is noticed.

For Plan 3: membership reconciliation should remove every key not active in the roster, not only
revoked ones, since any active member can add arbitrary keys.
