# Sync vault pinning, silent quarantine and friendly unlock errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop browser sync from writing one vault's entries into another, keep a damaged vault from spreading through its sync group, let an affected vault open silently with its stray entries set aside, and never show a raw crypto error at unlock.

**Architecture:** The extension's sync session gets pinned to a vault id that travels with the offscreen host and back through every storage callback, the way the desktop app already pins its session. Batch entry decryption becomes tolerant (one call, per-entry `null` on failure) in the shared Rust core. The unlock path moves entries the vault can't open into a per-vault quarantine file that is kept until the vault is deleted, and every sync merge refuses incoming entries that don't open under the receiving vault's key. A failed open locks the vault again and maps to calm, translated copy.

**Tech Stack:** TypeScript (React, Lingui, zod, vitest, Playwright), Rust core (`packages/core-rust`, wasm-bindgen + uniffi), Tauri (desktop), Capacitor Kotlin/Swift plugins and Filesystem (mobile), MV3 extension (service worker + offscreen document).

**Spec:** No separate spec document. The Background section below is the spec: it records the diagnosis and the decisions taken with the user on 2026-10-10. An independent review of the first draft was folded in (see "Changes after review").

## Background

A Chromium extension user (1.30.1) with two synced vaults, "work-desktop" and "personal-desktop", gets `Error: aes decrypt: aead::Error` when unlocking work-desktop with the correct password. A read-only diagnostic showed:

- work-desktop holds 544 entries; 499 don't decrypt under its key. Its stored previous copy (`vault-blob-backup-b64:<id>`, the bytes before the last write) holds 45 entries, all readable.
- The last save added exactly those 499 entries and removed or changed nothing. Their writers include devices that only belong to personal-desktop's sync group. They are personal-desktop's entries.
- Six device-list (roster) entries appear in both groups with identical millisecond `addedAt` stamps: the groups' device lists crossed too.

Root cause, confirmed in code and reproduced by `e2e/sync/vault-switch-sync.spec.ts` ("...even when that vault's sync group lists the same devices"):

- `maybeStartSync` (`packages/platform-extension/src/background/sync.ts:253`) starts the offscreen roster-sync host with ONE vault's group key and device keypair, and no-ops while `syncRunning` (`sync.ts:281`), so unlocking another vault never redirects it.
- The host's four callbacks (`syncLocalPayload`, `syncApplyRemote`, `syncLocalRoster`, `syncApplyRoster`, `sync.ts:377-428`) each call `resolveSyncVault()`, i.e. follow whichever vault is active NOW, falling back to the first registered vault (`sync/sync-config.ts:25`). The per-frame peer gate (`currentRoster`, `packages/core/src/sync/transport/roster-sync.ts:223-231,338`) reads the active vault's device list, and falls back to the session's start-time list when that read is empty or unparseable.
- Mobile and desktop use ONE Noise device keypair for all their vaults (`packages/platform-desktop/src/sync/keys.ts:47`, `packages/platform-mobile/src/sync/sync-manager.ts:93`), so a device in both groups passes the other vault's gate.
- Result: while the host still served personal-desktop's group, work-desktop became active and unlocked, and personal-desktop's payload was merged into work-desktop's file. The desktop app pins its session (`packages/platform-desktop/src/sync/roster.ts:165-209`); the extension never did.

Aggravating factors fixed here:

- A correct-password unlock starts sync as soon as the key unwraps (`packages/platform-extension/src/background/session.ts:359`), before entries load, so a damaged vault reaches its sync group before anything can clean it.
- `loadEntries` (`packages/core/src/hooks/useVault.tsx:557`) decrypts the whole vault in one call that throws on the first bad entry, so one stray entry bricks the unlock.
- Merges accept any incoming entry verbatim (`packages/core/src/sync/apply-remote.ts:72`), and the extension runs its relay and desktop-link merges without a queue (`sync.ts:387-391`, unlike desktop's `applyInFlight`).
- `useCryptoErrorMessage` (`packages/core/src/hooks/useCryptoErrorMessage.tsx`) passes unknown messages through, so the raw AEAD error reaches the unlock screen.

Decisions taken with the user:

- Don't bother the user with the app's own faults: no banner, count or confirmation. Clean up silently.
- Silent must not be destructive: unreadable entries are QUARANTINED (kept sealed as they are, local only, never synced, never shown). They are kept until the vault itself is deleted; there is no time-based purge. No tombstones.
- Using the quarantine (rescue, export, restore) is a future feature, not part of this plan. See "Future: using the quarantine".
- Translate the raw error into calm copy that doesn't scare the user.
- Batch decryption stays one call per vault (no per-entry round-trips, no parallelism work).

Two facts that shape the design:

- Local saves REBUILD the whole payload from the decrypted in-memory entries (`packages/core/src/vault/entry-mutations.ts:154-158` re-encrypts `next.entries`). Any entry left in the blob but not in memory is silently dropped by the next save, so unreadable entries MUST be moved out before the in-memory state is built.
- By the time entries are decrypted, the vault's outer layer has already opened under the same key (`useVault.tsx:578-587`). A vault whose entries ALL fail is therefore normally a vault holding only stray entries (exactly what the bug produces in a fresh second vault), not a wrong key. A device that can't decrypt entries at all is detected with a probe instead (Task 4).

Changes after review: dropped the "every entry fails, change nothing" guard (it would lock all-stray vaults out forever) in favour of a probe entry; moved the quarantine out of settings storage (desktop rewrites `meta.json` whole and silently resets it when corrupt, `src-tauri/src/storage.rs:180-191`) into a per-vault file beside the vault; parse every readable entry before writing anything; made a stale sync session truly inert and stoppable after a worker restart; made `VAULT_OPENED` name its vault; queued extension merges per vault; dropped the backup gate (backups skip identical bytes, `core/src/backup/run.ts:71-73`, and cover every registered vault, `background/backup.ts:96-110`); scoped the "couldn't open this vault" copy to unlock; added the missing test-file updates.

## Global Constraints

- Commit directly to `main`; no feature branch.
- No `Co-Authored-By` trailer on commits. Commit bodies carry the change and its reasoning, never testing or verification status.
- No em dashes anywhere: code comments, docs, user-facing copy, commit messages.
- Comments are terse, one line where possible; longer explanations go in `docs/`.
- `packages/core/src` (tests included) must not import `node:*` modules.
- Format only files you touched: `pnpm exec biome check --write <files>`. For Rust, `rustfmt` follows the module tree from `src/lib.rs`; run it, then `git checkout` every file you didn't change.
- New user-facing copy goes through Lingui `t`; afterwards run `pnpm i18n:extract`, `pnpm i18n:translate`, `pnpm i18n:compile`, `pnpm i18n:check`.
- Persisted data changes are additive only: one new per-vault quarantine store (a file on desktop and mobile, a `chrome.storage.local` key on the extension). No change to the vault blob format or the sync wire format.
- Quarantined entries are kept until their vault is deleted. Never purge them on a timer.
- Run tests with `CI=true`. Android unit tests need JDK 21 (Android Studio's bundled JBR as `JAVA_HOME`).
- Baseline before Task 1: `pnpm typecheck`, `CI=true pnpm --filter @vault/core test`, `CI=true pnpm --filter @vault/platform-extension test`, `pnpm wasm:test`, `pnpm test:desktop`. Report pre-existing failures; don't fix them silently.

## Review Focus

1. Vault B is unlocked while vault A's sync session is still live (create a vault, or join a group, while A is unlocked): B's file must never receive A's peers' entries, with or without a shared device key. Test: Task 1 Step 1 and the vault-switch e2e in Task 8.
2. The Chrome service worker restarts while sync runs: the offscreen sessions for the same vault must be kept, not torn down (the bug `offscreen-core.ts:114-131` documents). Test: Task 1 Step 1, offscreen tests "keeps the sessions for the same vault" and "a stop that names the running vault keeps it".
3. The active vault changes while a pairing (enrollment) is in progress, as the desktop-link join does: the enrollment must survive. Test: Task 1 Step 1, "a roster stop leaves a pairing running".
4. The device can't decrypt entries at all (probe fails): nothing is written, nothing is quarantined, the vault locks again and the unlock shows the calm copy. Test: Task 4 Step 5 and Task 5 Step 1.
5. A sync merge lands between the load and the quarantine rewrite: entries it added must survive. Test: Task 4 Step 1, "keeps entries a merge added since the load".

---

### Task 1: Pin extension sync to a vault id

**Files:**
- Modify: `packages/platform-extension/src/sync/messages.ts:13-21,76-80`
- Modify: `packages/platform-extension/src/offscreen-core.ts:69-75,114-176,617-670`
- Modify: `packages/platform-extension/src/offscreen.ts:17-35`
- Modify: `packages/platform-extension/src/background/sync.ts:228-460`
- Modify: `packages/platform-extension/src/background/session.ts:114-118`
- Modify: `packages/platform-extension/src/sync/sync-config.ts:16-28`
- Modify: `docs/multiple-vaults.md` (the sync section that calls the cross-vault case "milder")
- Test: `packages/platform-extension/src/offscreen-roster-sync.test.ts`, `packages/platform-extension/src/background/sync.test.ts`

**Interfaces:**
- Produces: `RosterSyncMsg.vaultId: string`; `SyncBridge` methods take `vaultId` first; background message payloads `SYNC_LOCAL_PAYLOAD {vaultId}`, `SYNC_APPLY_REMOTE {vaultId, payloadJson}`, `SYNC_LOCAL_ROSTER {vaultId}`, `SYNC_APPLY_ROSTER {vaultId, rosterJson}`; offscreen message `SYNC_ROSTER_STOP {keepVaultId: string | null}` (stops the roster sessions unless they serve `keepVaultId`; never touches enrollment); `stopSync(opts?: { keepVaultId?: string | null }): Promise<void>`; `retargetSync(activeVaultId: string | null): void`; `syncApplyRemote(vaultId: string, payloadJson: string): Promise<boolean>` exported from `background/sync.ts`.

- [ ] **Step 1: Write the failing tests.**

In `offscreen-roster-sync.test.ts`, add `vaultId: "A"` to `config()` (every existing test then passes it), and add:

```ts
describe("sessions are pinned to a vault", () => {
	it("keeps the sessions for the same vault", async () => {
		await reset();
		await handleHostMessage("SYNC_ROSTER_SYNC", config({ vaultId: "A" }));
		await handleHostMessage("SYNC_ROSTER_SYNC", config({ vaultId: "A" }));
		expect(started).toHaveLength(2);
		expect(live()).toHaveLength(2);
	});

	it("rebuilds the sessions for a different vault", async () => {
		await reset();
		await handleHostMessage("SYNC_ROSTER_SYNC", config({ vaultId: "A" }));
		await handleHostMessage("SYNC_ROSTER_SYNC", config({ vaultId: "B" }));
		expect(started).toHaveLength(4);
		expect(live()).toHaveLength(2);
	});

	it("a stop that names the running vault keeps it", async () => {
		await reset();
		await handleHostMessage("SYNC_ROSTER_SYNC", config({ vaultId: "A" }));
		await handleHostMessage("SYNC_ROSTER_STOP", { keepVaultId: "A" });
		expect(live()).toHaveLength(2);
	});

	it("a stop for another vault stops the sessions", async () => {
		await reset();
		await handleHostMessage("SYNC_ROSTER_SYNC", config({ vaultId: "A" }));
		await handleHostMessage("SYNC_ROSTER_STOP", { keepVaultId: "B" });
		expect(live()).toHaveLength(0);
	});
});
```

For "a roster stop leaves a pairing running": find how the file (or `offscreen-core`'s other tests) starts an enrollment (`SYNC_ENROLL_INVITE` / `SYNC_ENROLL_JOIN`), start one with a stubbed mesh, send `SYNC_ROSTER_STOP` with `keepVaultId: "B"`, and assert the enrollment session's `stop` was not called. If no enrollment stub exists, add one to the `vi.mock("@core/sync/transport/...")` block that records `stop()` calls.

In `sync.test.ts`, using its `stubChrome` / `loadSync` / `sendToOffscreen` harness, seed a registry with two vaults `A` and `B`, each with `sync.group:<id>` and `sync.deviceKeypair:<id>` in the shapes the file's existing seeds use, as `seedTwoVaults()`:

```ts
describe("sync is pinned to one vault", () => {
	it("hands the host the vault id it starts for", async () => {
		stubChrome(seedTwoVaults(), { [ACTIVE_VAULT_SESSION_KEY]: "A", "sync.openedVault": "A" });
		const sync = await loadSync();
		await sync.maybeStartSync();
		const start = sendToOffscreen.mock.calls.find(([m]) => m.type === "SYNC_ROSTER_SYNC");
		expect(start?.[0].payload?.vaultId).toBe("A");
	});

	it("a session for a vault that isn't active does nothing", async () => {
		stubChrome(seedTwoVaults(), { [ACTIVE_VAULT_SESSION_KEY]: "B" });
		const sync = await loadSync();
		expect(await sync.syncApplyRemote("A", JSON.stringify(emptyEntriesPayload()))).toBe(false);
		expect(sendToOffscreen.mock.calls.some(([m]) => m.type === "CRYPTO_DECRYPT_OUTER")).toBe(false);
		// An empty device list, not "", so the host's gate can't fall back to its start-time list.
		expect(decodeRoster(await sync.syncLocalRoster("A")).devices).toEqual([]);
	});

	it("restarts for the new vault when running for another", async () => {
		stubChrome(seedTwoVaults(), { [ACTIVE_VAULT_SESSION_KEY]: "A", "sync.openedVault": "A" });
		const sync = await loadSync();
		await sync.maybeStartSync();
		await chrome.storage.session.set({ [ACTIVE_VAULT_SESSION_KEY]: "B", "sync.openedVault": "B" });
		await sync.maybeStartSync();
		const stop = sendToOffscreen.mock.calls.find(([m]) => m.type === "SYNC_ROSTER_STOP");
		expect(stop?.[0].payload).toEqual({ keepVaultId: "B" });
		const starts = sendToOffscreen.mock.calls.filter(([m]) => m.type === "SYNC_ROSTER_SYNC");
		expect(starts.at(-1)?.[0].payload?.vaultId).toBe("B");
	});

	it("a vault switch sends a roster stop, never a full disconnect", async () => {
		stubChrome(seedTwoVaults(), { [ACTIVE_VAULT_SESSION_KEY]: "A", "sync.openedVault": "A" });
		const sync = await loadSync();
		await sync.maybeStartSync();
		sync.retargetSync("B");
		await Promise.resolve();
		const types = sendToOffscreen.mock.calls.map(([m]) => m.type);
		expect(types).toContain("SYNC_ROSTER_STOP");
		expect(types).not.toContain("SYNC_DISCONNECT");
	});

	it("runs one vault's merges one at a time", async () => {
		const blob = encodeVaultBlob({ slots: [], entriesIv: new Uint8Array(12), entriesCiphertext: new Uint8Array([1]) });
		stubChrome(
			{ ...seedTwoVaults(), "vault-blob-b64:A": btoa(String.fromCharCode(...blob)) },
			{ [ACTIVE_VAULT_SESSION_KEY]: "A" },
		);
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstRead = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let reads = 0;
		sendToOffscreen.mockImplementation(async (m) => {
			order.push(m.type ?? "");
			if (m.type === "CRYPTO_DECRYPT_OUTER") {
				if (reads++ === 0) await firstRead;
				return { ok: true, data: JSON.stringify(emptyEntriesPayload()) };
			}
			if (m.type === "CRYPTO_ENCRYPT_OUTER") return { ok: true, data: { iv: "AAAAAAAAAAAAAAAA", ciphertext: "AA==" } };
			// Task 7's admission check: every entry opens here.
			if (m.type === "CRYPTO_CHECK_ENTRIES") return { ok: true, data: (m.payload?.entries as unknown[]).map(() => true) };
			return { ok: true };
		});
		const sync = await loadSync();
		const remote = JSON.stringify({
			entries: [{ id: "n", wrappedDek: "w", dekIv: "d", ciphertext: "c", iv: "i", hlc: { wall: 1, counter: 0, node: "p" } }],
			tombstones: [],
		});
		const first = sync.syncApplyRemote("A", remote);
		const second = sync.syncApplyRemote("A", remote);
		await Promise.resolve();
		releaseFirst();
		await Promise.all([first, second]);
		const outer = order.filter((t) => t.endsWith("_OUTER"));
		expect(outer.slice(0, 3)).toEqual(["CRYPTO_DECRYPT_OUTER", "CRYPTO_ENCRYPT_OUTER", "CRYPTO_DECRYPT_OUTER"]);
	});

	it("does not sync when no vault is active", async () => {
		stubChrome(seedTwoVaults(), {});
		const sync = await loadSync();
		await sync.maybeStartSync();
		expect(sendToOffscreen.mock.calls.some(([m]) => m.type === "SYNC_ROSTER_SYNC")).toBe(false);
	});
});
```

Import `encodeVaultBlob` from `@core/vault-format`, `emptyEntriesPayload` and `decodeRoster` from `@core/sync`. If `encodeVaultBlob` rejects an empty slot list, give it one password slot shaped like the `vi.mock("../vault-format")` stub in `packages/core/src/hooks/useVault.unlockIndexRace.test.tsx`. If the merge's write path calls `chrome.runtime.sendMessage` (`broadcastVaultChanged`), add `sendMessage: vi.fn(async () => {})` to `stubChrome`'s `runtime`. `sync.openedVault` is the Task 5 gate; seeding it now keeps these tests valid after Task 5. Export `syncApplyRemote` and `syncLocalRoster` from `sync.ts` for the tests.

- [ ] **Step 2: Run to verify they fail**

Run: `CI=true pnpm --filter @vault/platform-extension exec vitest run src/offscreen-roster-sync.test.ts src/background/sync.test.ts`
Expected: FAIL.

- [ ] **Step 3: Carry the vault id through the messages** (`sync/messages.ts`)

```ts
export const RosterSyncMsgSchema = z.object({
	vaultId: z.string(),
	relayUrl: z.string(),
	iceUrl: z.string().optional(),
	groupKeyB64: z.string(),
	roster: RosterPayloadSchema,
	devicePrivB64: z.string(),
	devicePubB64: z.string(),
});

/** offscreen -> background: which vault a pinned sync callback is for. */
export const SyncVaultMsgSchema = z.object({ vaultId: z.string() });
export const ApplyRemoteMsgSchema = z.object({ vaultId: z.string(), payloadJson: z.string() });
export const ApplyRosterMsgSchema = z.object({ vaultId: z.string(), rosterJson: z.string() });
/** background -> offscreen: stop roster sync unless it serves this vault. Enrollment is untouched. */
export const RosterStopMsgSchema = z.object({ keepVaultId: z.string().nullable() });
```

- [ ] **Step 4: Pin the offscreen sessions** (`offscreen-core.ts`):

```ts
export interface SyncBridge {
	fetchLocalPayload: (vaultId: string) => Promise<string>;
	pushRemotePayload: (vaultId: string, payloadJson: string) => Promise<void>;
	fetchLocalRoster: (vaultId: string) => Promise<string>;
	pushRemoteRoster: (vaultId: string, rosterJson: string) => Promise<void>;
}

/** The vault the live sync sessions serve. */
let syncSessionVaultId: string | null = null;

function rosterSyncConfigKey(opts: RosterSyncMsg): string {
	return JSON.stringify([opts.vaultId, opts.relayUrl, opts.iceUrl ?? "", opts.groupKeyB64, opts.devicePubB64]);
}
```

In `stopSyncSessions` also set `syncSessionVaultId = null`; in `startSyncSessions` set it to `opts.vaultId` where `syncConfigKey` is recorded, and replace the four bridge fields of `common`:

```ts
		// Every callback names the vault this session was started for, never "the active one".
		fetchLocalPayload: () => bridge.fetchLocalPayload(opts.vaultId),
		pushRemotePayload: (json: string) => bridge.pushRemotePayload(opts.vaultId, json),
		fetchLocalRoster: () => bridge.fetchLocalRoster(opts.vaultId),
		pushRemoteRoster: (json: string) => bridge.pushRemoteRoster(opts.vaultId, json),
```

Update `unregisteredBridge` to the new signatures. Add next to `SYNC_DISCONNECT`:

```ts
			case "SYNC_ROSTER_STOP": {
				// A vault switch: stop roster sync for any other vault, and leave a pairing in progress alone.
				const { keepVaultId } = RosterStopMsgSchema.parse(payload);
				const stopping = rosterSyncInFlight.then(() => {
					if (syncSessionVaultId !== null && syncSessionVaultId !== keepVaultId) stopSyncSessions();
				});
				rosterSyncInFlight = stopping.catch(() => {});
				await stopping;
				return { ok: true };
			}
```

- [ ] **Step 5: Send the vault id from the Chrome bridge** (`offscreen.ts`):

```ts
const chromeBridge: SyncBridge = {
	fetchLocalPayload: async (vaultId) => {
		const r = await api.runtime.sendMessage({ type: "SYNC_LOCAL_PAYLOAD", payload: { vaultId } });
		if (!r?.ok || typeof r.data !== "string") throw new Error(r?.error ?? "local payload unavailable");
		return r.data;
	},
	pushRemotePayload: async (vaultId, payloadJson) => {
		const payload: ApplyRemoteMsg = { vaultId, payloadJson };
		await api.runtime.sendMessage({ type: "SYNC_APPLY_REMOTE", payload });
	},
	fetchLocalRoster: async (vaultId) => {
		const r = await api.runtime.sendMessage({ type: "SYNC_LOCAL_ROSTER", payload: { vaultId } });
		return r?.ok && typeof r.data === "string" ? r.data : "";
	},
	pushRemoteRoster: async (vaultId, rosterJson) => {
		await api.runtime.sendMessage({ type: "SYNC_APPLY_ROSTER", payload: { vaultId, rosterJson } });
	},
};
```

- [ ] **Step 6: Resolve the pinned vault in the background** (`background/sync.ts`):

```ts
/** The pinned vault, only while it is still the active one; null makes a stale session inert. */
async function pinnedCtx(vaultId: string): Promise<SyncVaultCtx | null> {
	const active = await resolveSyncVault();
	return active?.vaultId === vaultId ? active : null;
}

const EMPTY_ROSTER = encodeRoster({ devices: [], revoked: [] });

async function syncLocalPayload(vaultId: string): Promise<string> {
	const ctx = await pinnedCtx(vaultId);
	if (!ctx) return encodeEntriesPayload(emptyEntriesPayload());
	const { payload } = await readLocalState(ctx);
	return encodeEntriesPayload(payload);
}

/** One merge at a time per vault: the relay and desktop-link sessions both feed this. */
const applyChains = new Map<string, Promise<unknown>>();

export async function syncApplyRemote(vaultId: string, payloadJson: string): Promise<boolean> {
	const run = (applyChains.get(vaultId) ?? Promise.resolve()).then(() => applyRemoteNow(vaultId, payloadJson));
	applyChains.set(vaultId, run.catch(() => {}));
	return run;
}

async function applyRemoteNow(vaultId: string, payloadJson: string): Promise<boolean> {
	const ctx = await pinnedCtx(vaultId);
	if (!ctx) return false;
	// ...the current syncApplyRemote body from `const remote = ...` on, unchanged
}

export async function syncLocalRoster(vaultId: string): Promise<string> {
	const ctx = await pinnedCtx(vaultId);
	// Empty, not "": "" makes the host fall back to the device list it started with.
	if (!ctx) return EMPTY_ROSTER;
	const group = await getStoredGroup(ctx);
	return group ? encodeRoster(group.roster) : EMPTY_ROSTER;
}

async function syncApplyRoster(vaultId: string, rosterJson: string): Promise<void> {
	const ctx = await pinnedCtx(vaultId);
	if (!ctx) return;
	// ...body unchanged from here
}
```

Router handlers parse `SyncVaultMsgSchema` / `ApplyRemoteMsgSchema` / `ApplyRosterMsgSchema` and pass `vaultId` through. The Firefox in-process bridge becomes:

```ts
setInProcessSyncBridge({
	fetchLocalPayload: syncLocalPayload,
	pushRemotePayload: (vaultId, payloadJson) => syncApplyRemote(vaultId, payloadJson).then(() => {}),
	fetchLocalRoster: syncLocalRoster,
	pushRemoteRoster: syncApplyRoster,
});
```

Track which vault the session serves and redirect when it moves:

```ts
let syncVaultId: string | null = null;

export async function maybeStartSync(expectedVekEpoch?: number): Promise<void> {
	// ...unchanged up to and including the "reading the group" check, then replace `if (syncRunning) return;` with:
	if (syncRunning && syncVaultId === ctx.vaultId) return;
	if (syncRunning) {
		// Still serving a vault the user left: stop it, then start over for this one.
		await stopSync({ keepVaultId: ctx.vaultId });
		return maybeStartSync(expectedVekEpoch);
	}
	syncRunning = true;
	syncVaultId = ctx.vaultId;
	// payload gains: vaultId: ctx.vaultId
	// on the abandon path that resets syncRunning, also reset syncVaultId = null
}

/** Stop sync. With `keepVaultId`, only roster sync for other vaults stops and a pairing is untouched. */
export async function stopSync({ keepVaultId }: { keepVaultId?: string | null } = {}): Promise<void> {
	const stopEpoch = ++syncEpoch;
	syncRunning = false;
	syncVaultId = null;
	void closeSyncLink().catch(() => {});
	stopInFlight = (async () => {
		if (syncHostSuspends) await api.alarms.clear(SYNC_KEEPALIVE_ALARM);
		if (stopEpoch !== syncEpoch) return;
		const message =
			keepVaultId === undefined
				? { type: "SYNC_DISCONNECT" }
				: { type: "SYNC_ROSTER_STOP", payload: { keepVaultId } };
		await sendToOffscreen(message).catch(() => {});
	})();
	await stopInFlight;
}

/** The active vault moved: stop any roster session serving another vault, even one this worker didn't start. */
export function retargetSync(activeVaultId: string | null): void {
	if (syncRunning && syncVaultId === activeVaultId) return;
	void stopSync({ keepVaultId: activeVaultId });
}
```

Sending the stop even when `syncRunning` is false matters: after a worker restart the flag is false while the offscreen sessions live on. Because the offscreen keeps a session that serves `keepVaultId`, this can't tear down a healthy session for the vault the user is in (Review Focus 2).

- [ ] **Step 7: Retarget on active-vault change** (`session.ts`):

```ts
function applyActiveVaultTransition(value: unknown): boolean {
	if (!vekStore.applyActiveVaultId(value)) return false;
	advanceAutofillSession();
	retargetSync(vekStore.getActiveVaultId());
	return true;
}
```

Import `retargetSync` from `./sync` next to `maybeStartSync, stopSync`.

- [ ] **Step 8: Remove the first-vault fallback** (`sync/sync-config.ts`):

```ts
/** The vault to sync: the active vault the UI recorded in session. Null when none is active. */
export async function resolveSyncVault(): Promise<SyncVaultCtx | null> {
	let active: string | null = null;
	try {
		const s = await api.storage.session.get([ACTIVE_VAULT_SESSION_KEY]);
		if (typeof s[ACTIVE_VAULT_SESSION_KEY] === "string") active = s[ACTIVE_VAULT_SESSION_KEY];
	} catch {}
	if (!active) return null;
	const reg = parseRegistry((await api.storage.local.get(VAULT_REGISTRY_KEY))[VAULT_REGISTRY_KEY]);
	return reg.vaults.some((v) => v.id === active) ? { vaultId: active } : null;
}
```

Update the doc comment on `SyncVaultCtx`. Existing tests that relied on the fallback must seed `ACTIVE_VAULT_SESSION_KEY` instead.

- [ ] **Step 9: Run the tests**

Run: `CI=true pnpm --filter @vault/platform-extension test` and `pnpm --filter @vault/platform-extension typecheck`
Expected: PASS.

- [ ] **Step 10: Update `docs/multiple-vaults.md`**: replace the claim that the cross-vault sync case is "milder" with one paragraph: the extension's sync session is pinned to the vault id it started for; every callback carries that id; a session for a vault that is no longer active reads an empty payload and an empty device list, writes nothing, and is stopped by `retargetSync`; merges for one vault run one at a time.

- [ ] **Step 11: Commit**

```bash
git add packages/platform-extension/src/sync/messages.ts packages/platform-extension/src/offscreen-core.ts packages/platform-extension/src/offscreen.ts packages/platform-extension/src/background/sync.ts packages/platform-extension/src/background/session.ts packages/platform-extension/src/sync/sync-config.ts packages/platform-extension/src/offscreen-roster-sync.test.ts packages/platform-extension/src/background/sync.test.ts docs/multiple-vaults.md
git commit -m "fix(extension): pin each sync session to the vault it started for" -m "The offscreen host ran one vault's group while every storage callback followed the active vault, so after a switch a peer of the old group merged its entries into the new vault's file. Callbacks now carry the session's vault id and do nothing unless it is still active, a vault switch stops roster sync for any other vault without touching a pairing in progress, and one vault's merges run one at a time."
```

---

### Task 2: Tolerant batch entry decryption

**Files:**
- Modify: `packages/core-rust/src/lib.rs:612-632` (decrypt_entry), the `wasm_exports` module (~line 640+), the tests module (~line 1000)
- Modify: `packages/platform-desktop/src-tauri/src/crypto.rs:190-205`, `packages/platform-desktop/src/adapters/crypto.ts:140`
- Modify: `packages/platform-mobile/android/app/src/main/java/app/bramble/mobile/NativeCryptoPlugin.kt:226-246`
- Modify: `packages/platform-mobile/ios/App/App/NativeCrypto.swift:227-244`
- Modify: `packages/platform-mobile/src/native-crypto.ts:78,247`
- Modify: `packages/core/src/adapters/crypto.ts:158-161`, `packages/core/src/wasm.ts:86`
- Modify: `packages/platform-extension/src/offscreen-core.ts:361-369`, `packages/platform-extension/src/crypto.ts:173-174`
- Test: `packages/platform-extension/src/offscreen-decrypt-batch.test.ts`

**Interfaces:**
- Produces: Rust `pub fn decrypt_entries_core(payloads: &[EncryptedPayload]) -> Result<Vec<Option<String>>, CryptoError>`; uniffi `decrypt_entries(payloads: Vec<EncryptedPayload>) -> Result<Vec<Option<String>>, CryptoError>`; wasm `decrypt_entries(entries: JsValue) -> Result<JsValue, CryptoError>` returning an array with `null` for failures; TS `CryptoAdapter.decryptEntries(payloads: EncryptedPayload[]): Promise<(string | null)[]>`.
- Semantics: a locked vault fails the whole call; any per-entry failure (wrong key, altered bytes, bad encoding, non-UTF-8) yields `null` for that entry only.

- [ ] **Step 1: Write the failing tests.** Rust (tests module in `lib.rs`, mirroring `entry_encrypt_decrypt_round_trip_core`):

```rust
    #[test]
    fn decrypt_entries_marks_foreign_entries_none() {
        let _guard = VEK_SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unlock_with_vek(B64.encode([0x22u8; KEY_LEN])).unwrap();
        let foreign = encrypt_entry_core("{\"title\":\"Other vault\"}").unwrap();
        unlock_with_vek(B64.encode([0x11u8; KEY_LEN])).unwrap();
        let mine = encrypt_entry_core("{\"title\":\"Mine\"}").unwrap();
        let out = decrypt_entries_core(&[mine, foreign]).unwrap();
        assert_eq!(out, vec![Some("{\"title\":\"Mine\"}".to_string()), None]);
        lock();
        assert!(decrypt_entries_core(&[]).is_err());
    }
```

`offscreen-decrypt-batch.test.ts`: add a `decrypt_entries` to the stub that mirrors the Rust semantics, and replace the "leaves the existing crypto adapter batch strict" test:

```ts
		decrypt_entries: (entries: { ciphertext: string }[]) =>
			entries.map((e) => (e.ciphertext === "broken" ? null : `pt:${e.ciphertext}`)),
```

```ts
	it("returns null for an entry that doesn't decrypt instead of failing the batch", async () => {
		const res = await handleHostMessage("CRYPTO_DECRYPT_BATCH", {
			entries: [entry("a"), entry("broken")],
			vekB64: "vek",
		});
		expect(res).toEqual({ ok: true, data: ["pt:a", null] });
	});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm wasm:test` and `CI=true pnpm --filter @vault/platform-extension exec vitest run src/offscreen-decrypt-batch.test.ts`
Expected: FAIL (`decrypt_entries_core` not found; batch still strict).

- [ ] **Step 3: Implement in `lib.rs`.** Extract the per-entry body so the single and batch forms share it:

```rust
fn open_entry(vek: &[u8], p: &EncryptedPayload) -> Result<String, CryptoError> {
    let ct = b64_decode(&p.ciphertext)?;
    let iv = iv_from(b64_decode(&p.iv)?)?;
    let wrapped = b64_decode(&p.wrapped_dek)?;
    let dek_iv = iv_from(b64_decode(&p.dek_iv)?)?;
    let dek = aes_decrypt(vek, &dek_iv, &wrapped)?;
    let plaintext = aes_decrypt(dek.as_slice(), &iv, &ct)?;
    String::from_utf8(plaintext.to_vec()).map_err(|e| err(format!("utf8: {e}")))
}

/// Decrypt an entry: VEK unwraps the DEK, the DEK decrypts the plaintext.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn decrypt_entry(ciphertext: String, iv: String, wrapped_dek: String, dek_iv: String) -> Result<String, CryptoError> {
    let p = EncryptedPayload { ciphertext, iv, wrapped_dek, dek_iv };
    with_vek(|vek| open_entry(vek, &p))
}

/// Open a whole vault's entries in one VEK section. A failed entry is None; only a locked vault fails the call.
pub fn decrypt_entries_core(payloads: &[EncryptedPayload]) -> Result<Vec<Option<String>>, CryptoError> {
    with_vek(|vek| Ok(payloads.iter().map(|p| open_entry(vek, p).ok()).collect()))
}

#[cfg(feature = "ffi")]
#[uniffi::export]
pub fn decrypt_entries(payloads: Vec<EncryptedPayload>) -> Result<Vec<Option<String>>, CryptoError> {
    decrypt_entries_core(&payloads)
}
```

In the `wasm_exports` module:

```rust
    /// Open many entries in one call; failed entries come back as null.
    #[wasm_bindgen]
    pub fn decrypt_entries(entries: JsValue) -> Result<JsValue, CryptoError> {
        let payloads: Vec<EncryptedPayload> =
            serde_wasm_bindgen::from_value(entries).map_err(|e| err(format!("deserialize: {e}")))?;
        let out = decrypt_entries_core(&payloads)?;
        // json_compatible: None must reach JS as null, not undefined.
        out.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|e| err(format!("serialize: {e}")))
    }
```

- [ ] **Step 4: Run the Rust tests and rebuild wasm**

Run: `pnpm wasm:test` then `pnpm wasm:build && pnpm wasm:build:mobile`
Expected: PASS, both wasm builds succeed.

- [ ] **Step 5: Desktop.** `src-tauri/src/crypto.rs`:

```rust
/// Batch form: one IPC round trip for the whole vault. A failed entry is null; order matches `payloads`.
#[tauri::command]
pub fn crypto_decrypt_entries(payloads: Vec<EncryptedPayload>) -> CmdResult<Vec<Option<String>>> {
    map(vault_crypto::decrypt_entries_core(&payloads))
}
```

`src/adapters/crypto.ts:140`: `decryptEntries: (payloads) => invoke<(string | null)[]>("crypto_decrypt_entries", { payloads }),`

Run: `pnpm test:desktop`. Expected: PASS.

- [ ] **Step 6: Mobile plugins.** Regenerate bindings: `pnpm ffi:bindings`, `pnpm ffi:build:android`, `pnpm ffi:build:ios`. Kotlin:

```kotlin
        call.runCrypto {
            val payloads = (0 until entries.length()).map { i ->
                val e = entries.getJSONObject(i)
                uniffi.vault_crypto.EncryptedPayload(e.getString("ciphertext"), e.getString("iv"), e.getString("wrappedDek"), e.getString("dekIv"))
            }
            val values = JSArray()
            // A failed entry is null, never a rejection of the whole vault.
            for (v in uniffi.vault_crypto.decryptEntries(payloads)) values.put(v ?: JSONObject.NULL)
            call.resolve(JSObject().put("values", values))
        }
```

Swift:

```swift
	@objc func decryptEntries(_ call: CAPPluginCall) {
		let entries = call.getArray("entries") ?? []
		do {
			var payloads: [EncryptedPayload] = []
			payloads.reserveCapacity(entries.count)
			for item in entries {
				guard let d = item as? [String: Any],
					let ct = d["ciphertext"] as? String, let iv = d["iv"] as? String,
					let wd = d["wrappedDek"] as? String, let di = d["dekIv"] as? String
				else {
					call.reject("Malformed entry in decryptEntries")
					return
				}
				payloads.append(EncryptedPayload(ciphertext: ct, iv: iv, wrappedDek: wd, dekIv: di))
			}
			// A failed entry is null, never a rejection of the whole vault.
			let values: [Any] = try App.decryptEntries(payloads: payloads).map { $0 ?? NSNull() }
			call.resolve(["values": values])
		} catch { fail(call, error) }
	}
```

`native-crypto.ts`: the plugin method type becomes `Promise<{ values: (string | null)[] }>` and `decrypt_entries` returns `(string | null)[]`.

Run: `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest` from `packages/platform-mobile/android`, and `xcodebuild -project packages/platform-mobile/ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug build` (`pnpm ios:beta` is the TestFlight release lane; don't use it here). Expected: both compile.

- [ ] **Step 7: TypeScript adapters.**
  - `adapters/crypto.ts`: `decryptEntries(payloads: EncryptedPayload[]): Promise<(string | null)[]>;` with the comment "A failed entry is null; only a locked vault rejects."
  - `wasm.ts`: `decrypt_entries?(entries: EncryptedPayload[]): Awaitable<(string | null)[]>;`
  - `crypto-wasm.ts`: no change. Its `m.decrypt_entries` branch now finds the wasm export; the strict per-entry fallback stays strict, so a module without the export still fails loudly rather than reporting platform errors as stray entries.
  - Extension `crypto.ts`: `send<(string | null)[]>("CRYPTO_DECRYPT_BATCH", ...)`.
  - `offscreen-core.ts` `CRYPTO_DECRYPT_BATCH`: `return withVek(w, p.vekB64, (w) => w.decrypt_entries(p.entries.map(({ ciphertext, iv, wrappedDek, dekIv }) => ({ ciphertext, iv, wrappedDek, dekIv }))));` and add `decrypt_entries(entries: unknown[]): (string | null)[]` to the `SyncVek` type.
  - `useVault.tsx:611` is the only caller; it is rewritten in Task 4. For this task keep it compiling with today's behavior (`plaintexts[i] as string`).

Run: `pnpm typecheck`, `CI=true pnpm --filter @vault/core test`, `CI=true pnpm --filter @vault/platform-extension test`. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core-rust/src/lib.rs packages/platform-desktop/src-tauri/src/crypto.rs packages/platform-desktop/src/adapters/crypto.ts packages/platform-mobile packages/core/src/adapters/crypto.ts packages/core/src/wasm.ts packages/platform-extension/src/offscreen-core.ts packages/platform-extension/src/crypto.ts packages/platform-extension/src/offscreen-decrypt-batch.test.ts packages/core/src/hooks/useVault.tsx
git commit -m "feat(crypto): report undecryptable entries per entry in batch decrypt" -m "One call per vault as before, but an entry that fails returns null instead of failing the whole batch, so a single stray entry no longer makes a vault unopenable. Only a locked vault rejects the call."
```

---

### Task 3: A per-vault quarantine store on every platform

**Files:**
- Modify: `packages/core/src/adapters/storage.ts` (StorageAdapter)
- Modify: `packages/core/src/hooks/useVaultRegistry.tsx:193-210` (`makeVaultScopedStorage`)
- Test: `packages/core/src/hooks/useVaultRegistry.test.tsx`
- Modify: `packages/platform-extension/src/storage.ts` (key helpers ~line 23, the two key-removal lists ~lines 116-121 and 169-174)
- Test: `packages/platform-extension/src/storage.test.ts`
- Modify: `packages/platform-desktop/src-tauri/src/storage.rs` (`ops` module: paths, read/write, `delete_vault`; commands), `packages/platform-desktop/src-tauri/src/lib.rs:252-262` (handler list), `packages/platform-desktop/src/adapters/storage.ts`
- Modify: `packages/platform-mobile/src/adapters/storage.ts` (file helpers ~line 27, `deleteVaultBlob` ~line 227)

**Interfaces:**
- Produces on `StorageAdapter`:

```ts
	/** Entries this vault couldn't decrypt, kept sealed as JSON; never synced or shown. Null when none. */
	readQuarantine?(vaultId?: string): Promise<string | null>;
	/** Replace the vault's quarantine JSON. Removed with the vault by deleteVaultBlob. */
	writeQuarantine?(json: string, vaultId?: string): Promise<void>;
```

- [ ] **Step 1: Write the failing tests.** `useVaultRegistry.test.tsx` (the `readVaultBackup` lesson: a scoped adapter that drops a method silently disables the feature):

```ts
it("passes the quarantine store through, scoped to the active vault", async () => {
	const calls: unknown[][] = [];
	const base = {
		readQuarantine: async (id?: string) => (calls.push(["read", id]), null),
		writeQuarantine: async (json: string, id?: string) => void calls.push(["write", json, id]),
	} as unknown as StorageAdapter;
	const scoped = makeVaultScopedStorage(base, "v1");
	await scoped.readQuarantine?.();
	await scoped.writeQuarantine?.("[]");
	expect(calls).toEqual([["read", "v1"], ["write", "[]", "v1"]]);
});
```

`storage.test.ts` (extension), using the file's existing chrome stub:

```ts
it("stores a vault's quarantine beside it and deletes it with the vault", async () => {
	await extensionStorage.writeQuarantine?.('[{"id":"x"}]', "v1");
	expect(await extensionStorage.readQuarantine?.("v1")).toBe('[{"id":"x"}]');
	expect(await extensionStorage.readQuarantine?.("v2")).toBeNull();
	await extensionStorage.deleteVaultBlob("v1");
	expect(await extensionStorage.readQuarantine?.("v1")).toBeNull();
});

it("doesn't treat a quarantine key as a vault blob", () => {
	expect(isVaultBlobKey("vault-quarantine:abc")).toBe(false);
});
```

Desktop Rust (`storage.rs` tests module, mirroring `reading_the_backup_does_not_restore_it` and `deleting_removes_the_blob_and_its_backup`):

```rust
    #[test]
    fn a_vaults_quarantine_round_trips_and_goes_with_the_vault() {
        let dir = tempdir();
        ops::write_vault(dir.path(), b"blob", Some("v1")).unwrap();
        ops::write_quarantine(dir.path(), "[]", Some("v1")).unwrap();
        assert_eq!(ops::read_quarantine(dir.path(), Some("v1")).unwrap(), Some("[]".into()));
        assert_eq!(ops::read_quarantine(dir.path(), Some("v2")).unwrap(), None);
        ops::delete_vault(dir.path(), "v1").unwrap();
        assert_eq!(ops::read_quarantine(dir.path(), Some("v1")).unwrap(), None);
    }
```

Use whatever temp-dir helper the existing tests use instead of `tempdir()`. Also add a test that a lone quarantine file doesn't count as a vault, mirroring `a_lone_backup_does_not_count_as_a_vault`. Run the three suites; expect FAIL.

- [ ] **Step 2: Core.** Add the two optional members above to `StorageAdapter`. In `makeVaultScopedStorage`:

```ts
		readQuarantine: storage.readQuarantine && ((id) => storage.readQuarantine!(id ?? vaultId)),
		writeQuarantine: storage.writeQuarantine && ((json, id) => storage.writeQuarantine!(json, id ?? vaultId)),
```

- [ ] **Step 3: Extension** (`storage.ts`):

```ts
function quarantineKeyFor(id: string): string {
	return `vault-quarantine:${id}`;
}
```

```ts
	async readQuarantine(vaultId) {
		if (!vaultId) throw new Error("readQuarantine needs a vault id");
		const v = (await api.storage.local.get(quarantineKeyFor(vaultId)))[quarantineKeyFor(vaultId)];
		return typeof v === "string" ? v : null;
	},
	async writeQuarantine(json, vaultId) {
		if (!vaultId) throw new Error("writeQuarantine needs a vault id");
		await api.storage.local.set({ [quarantineKeyFor(vaultId)]: json });
	},
```

Add `quarantineKeyFor(id)` to both key-removal lists that already hold `blobKeyFor(id), backupKeyFor(id)`.

- [ ] **Step 4: Desktop.** In `storage.rs` `ops`:

```rust
    /// `<id>.quarantine.json`: its temp file is `<id>.quarantine.tmp`, never the vault's `<id>.tmp`.
    fn quarantine_path(root: &Path, vault_id: Option<&str>) -> CmdResult<PathBuf> {
        let (path, _) = vault_paths(root, vault_id)?;
        Ok(path.with_extension("quarantine.json"))
    }

    pub fn read_quarantine(root: &Path, vault_id: Option<&str>) -> CmdResult<Option<String>> {
        let path = quarantine_path(root, vault_id)?;
        if !path.exists() {
            return Ok(None);
        }
        io(fs::read_to_string(&path), "read quarantine").map(Some)
    }

    pub fn write_quarantine(root: &Path, json: &str, vault_id: Option<&str>) -> CmdResult<()> {
        write_atomic(&quarantine_path(root, vault_id)?, json.as_bytes())
    }
```

In `delete_vault`, include `quarantine_path(root, Some(vault_id))?` in the files removed. Commands, registered in `lib.rs` next to `storage_read_vault_backup`:

```rust
#[tauri::command]
pub fn storage_read_quarantine(app: AppHandle, vault_id: Option<String>) -> CmdResult<Option<String>> {
    ops::read_quarantine(&data_dir(&app)?, vault_id.as_deref())
}

#[tauri::command]
pub fn storage_write_quarantine(app: AppHandle, json: String, vault_id: Option<String>) -> CmdResult<()> {
    ops::write_quarantine(&data_dir(&app)?, &json, vault_id.as_deref())
}
```

If any code lists the vaults dir to find vaults, make sure it ignores `*.quarantine.json`. TS adapter (`src/adapters/storage.ts`):

```ts
	readQuarantine: (vaultId) => invoke<string | null>("storage_read_quarantine", { vaultId }),
	writeQuarantine: (json, vaultId) => invoke<void>("storage_write_quarantine", { json, vaultId }),
```

- [ ] **Step 5: Mobile** (`src/adapters/storage.ts`; import `Encoding` from `@capacitor/filesystem`):

```ts
function quarantineFileFor(id: string): string {
	return `vault-${id}.quarantine.json`;
}
```

```ts
	async readQuarantine(vaultId) {
		await ensureMigrated();
		if (!vaultId) throw new Error("readQuarantine needs a vault id");
		const path = quarantineFileFor(vaultId);
		if (!(await fileExists(path))) return null;
		const r = await Filesystem.readFile({ path, directory: DIR, encoding: Encoding.UTF8 });
		return r.data as string;
	},
	async writeQuarantine(json, vaultId) {
		await ensureMigrated();
		if (!vaultId) throw new Error("writeQuarantine needs a vault id");
		await Filesystem.writeFile({ path: quarantineFileFor(vaultId), directory: DIR, data: json, encoding: Encoding.UTF8 });
	},
```

In `deleteVaultBlob`, also delete `quarantineFileFor(vaultId)` when it exists.

- [ ] **Step 6: Run the tests**

Run: `CI=true pnpm --filter @vault/core test`, `CI=true pnpm --filter @vault/platform-extension test`, `pnpm test:desktop`, `CI=true pnpm --filter @vault/platform-mobile test`, `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/adapters/storage.ts packages/core/src/hooks/useVaultRegistry.tsx packages/core/src/hooks/useVaultRegistry.test.tsx packages/platform-extension/src/storage.ts packages/platform-extension/src/storage.test.ts packages/platform-desktop/src-tauri/src/storage.rs packages/platform-desktop/src-tauri/src/lib.rs packages/platform-desktop/src/adapters/storage.ts packages/platform-mobile/src/adapters/storage.ts
git commit -m "feat(storage): give each vault a quarantine store beside its file" -m "Entries a vault can't decrypt need somewhere durable to go that is not the vault itself and not settings storage, which desktop rewrites whole and resets when corrupt. Each platform now keeps one quarantine store per vault next to the vault's file, removed with the vault."
```

---

### Task 4: Silently quarantine entries a vault can't open

**Files:**
- Create: `packages/core/src/sync/entry-version.ts`
- Create: `packages/core/src/vault/quarantine.ts`
- Test: `packages/core/src/vault/quarantine.test.ts`
- Modify: `packages/core/src/hooks/useVault.tsx:557-625` (loadEntries)
- Test: `packages/core/src/hooks/useVault.quarantine.test.tsx`
- Modify: `docs/multiple-vaults.md` (one short "Entries a vault can't open" paragraph)

**Interfaces:**
- Consumes: tolerant `CryptoAdapter.decryptEntries` (Task 2); `StorageAdapter.readQuarantine` / `writeQuarantine` (Task 3).
- Produces: `entryVersionKey(e: { id: string; hlc: Hlc }): string`; `type QuarantinedEntry = EncryptedEntry & { quarantinedAt: number }`; `type QuarantineStore = Required<Pick<StorageAdapter, "readQuarantine" | "writeQuarantine">>`; `quarantineEntries(deps: { storage: QuarantineStore; store: EntriesBlobStore; vaultId: string; now?: number }, unreadable: EncryptedEntry[]): Promise<void>`.

- [ ] **Step 1: Write the failing unit tests** (`quarantine.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import type { EntriesPayload } from "../sync/entries-payload";
import type { Hlc } from "../sync/hlc";
import type { EncryptedEntry } from "../vault-format";
import type { EntriesBlobStore } from "./entries-blob";
import { type QuarantinedEntry, quarantineEntries } from "./quarantine";

const hlc = (wall: number, node = "n"): Hlc => ({ wall, counter: 0, node });
const env = (id: string, wall = 1): EncryptedEntry => ({ id, wrappedDek: "w", dekIv: "d", ciphertext: id, iv: "i", hlc: hlc(wall) });

function fakes(initial: EntriesPayload) {
	let quarantine: string | null = null;
	let disk = initial;
	const storage = {
		readQuarantine: async () => quarantine,
		writeQuarantine: async (json: string) => void (quarantine = json),
	};
	const store = {
		readEntriesPayload: async () => disk,
		writeEntriesBlob: async (p: EntriesPayload) => void (disk = p),
	} as EntriesBlobStore;
	return {
		storage,
		store,
		disk: () => disk,
		setDisk: (p: EntriesPayload) => void (disk = p),
		kept: () => (quarantine === null ? [] : (JSON.parse(quarantine) as QuarantinedEntry[])),
		setRaw: (raw: string) => void (quarantine = raw),
	};
}

describe("quarantineEntries", () => {
	it("moves unreadable entries out of the vault and keeps them sealed", async () => {
		const f = fakes({ entries: [env("mine"), env("stray")], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1000 }, [env("stray")]);
		expect(f.disk().entries.map((e) => e.id)).toEqual(["mine"]);
		expect(f.kept()).toEqual([{ ...env("stray"), quarantinedAt: 1000 }]);
	});

	it("can empty a vault that held only stray entries", async () => {
		const f = fakes({ entries: [env("stray")], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1 }, [env("stray")]);
		expect(f.disk().entries).toEqual([]);
		expect(f.kept()).toHaveLength(1);
	});

	it("keeps entries a merge added since the load", async () => {
		const f = fakes({ entries: [env("mine"), env("stray")], tombstones: [] });
		f.setDisk({ entries: [env("mine"), env("stray"), env("fromPeer")], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1 }, [env("stray")]);
		expect(f.disk().entries.map((e) => e.id)).toEqual(["mine", "fromPeer"]);
	});

	it("only removes the exact version it found unreadable", async () => {
		const f = fakes({ entries: [env("x", 2)], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1 }, [env("x", 1)]);
		expect(f.disk().entries.map((e) => e.id)).toEqual(["x"]);
	});

	it("does not store the same version twice, and never drops what it kept", async () => {
		const f = fakes({ entries: [env("a"), env("b")], tombstones: [] });
		const deps = { storage: f.storage, store: f.store, vaultId: "v", now: 1 };
		await quarantineEntries(deps, [env("a")]);
		await quarantineEntries(deps, [env("a"), env("b")]);
		expect(f.kept().map((q) => q.id)).toEqual(["a", "b"]);
	});

	it("stores before rewriting, so a failed rewrite loses nothing", async () => {
		const f = fakes({ entries: [env("stray")], tombstones: [] });
		const store = { ...f.store, writeEntriesBlob: async () => { throw new Error("disk full"); } } as EntriesBlobStore;
		await expect(quarantineEntries({ storage: f.storage, store, vaultId: "v", now: 1 }, [env("stray")])).rejects.toThrow();
		expect(f.kept()).toHaveLength(1);
	});

	it("refuses to overwrite a quarantine it can't read", async () => {
		const f = fakes({ entries: [env("stray")], tombstones: [] });
		f.setRaw("{not json");
		await expect(quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1 }, [env("stray")])).rejects.toThrow();
		expect(f.disk().entries).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `CI=true pnpm --filter @vault/core exec vitest run src/vault/quarantine.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** `sync/entry-version.ts`:

```ts
import type { Hlc } from "./hlc";

/** Identifies one version of an entry: its id plus the stamp it was written with. */
export const entryVersionKey = (e: { id: string; hlc: Hlc }): string =>
	`${e.id}|${e.hlc.wall}|${e.hlc.counter}|${e.hlc.node}`;
```

`vault/quarantine.ts`:

```ts
import type { StorageAdapter } from "../adapters/storage";
import { entryVersionKey } from "../sync/entry-version";
import type { EncryptedEntry } from "../vault-format";
import type { EntriesBlobStore } from "./entries-blob";

export type QuarantinedEntry = EncryptedEntry & { quarantinedAt: number };
export type QuarantineStore = Required<Pick<StorageAdapter, "readQuarantine" | "writeQuarantine">>;

/** Set aside entries this vault can't open (sealed as they are, unsynced, hidden, kept until the vault is deleted), then rewrite the vault without them. */
export async function quarantineEntries(
	deps: { storage: QuarantineStore; store: EntriesBlobStore; vaultId: string; now?: number },
	unreadable: EncryptedEntry[],
): Promise<void> {
	const now = deps.now ?? Date.now();
	const raw = await deps.storage.readQuarantine(deps.vaultId);
	// Throws on a damaged store rather than overwriting what it holds.
	const kept: QuarantinedEntry[] = raw === null ? [] : JSON.parse(raw);
	const known = new Set(kept.map(entryVersionKey));
	const added = unreadable.filter((e) => !known.has(entryVersionKey(e))).map((e) => ({ ...e, quarantinedAt: now }));
	// Store first: a failed rewrite then leaves a copy in both places, never in neither.
	if (added.length > 0) await deps.storage.writeQuarantine(JSON.stringify([...kept, ...added]), deps.vaultId);
	const drop = new Set(unreadable.map(entryVersionKey));
	// Re-read so a merge that landed since the load survives the rewrite.
	const current = await deps.store.readEntriesPayload();
	await deps.store.writeEntriesBlob({ ...current, entries: current.entries.filter((e) => !drop.has(entryVersionKey(e))) });
}
```

- [ ] **Step 4: Run the unit tests**

Run: `CI=true pnpm --filter @vault/core exec vitest run src/vault/quarantine.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing hook tests** (`useVault.quarantine.test.tsx`). Copy the header of `useVault.unlockIndexRace.test.tsx` (the `@vitest-environment happy-dom` pragma, the `vi.mock("../vault-format", ...)` password-slot stub, `mountVault` from `../test/vault-harness`) and change the stub's `entriesCiphertext` to `new Uint8Array([1])` so the vault is non-empty. Then:

```ts
const VAULT_ID = "vault-1";
const hlc = { wall: 1, counter: 0, node: "n" };
const sealed = (id: string) => ({ id, wrappedDek: "w", dekIv: "d", ciphertext: id, iv: "i", hlc });
const PROBE = "probe";

/** Decrypts by ciphertext: `opens` lists the entry ciphertexts that open; the probe opens unless `deviceBroken`. */
const decryptBy = (opens: Record<string, string>, deviceBroken = false) => async (ps: { ciphertext: string }[]) =>
	ps.map((p) => (p.ciphertext === PROBE ? (deviceBroken ? null : "{}") : (opens[p.ciphertext] ?? null)));

function makePlatform(
	entryIds: string[],
	cryptoOver: Record<string, unknown>,
	shellOver: Record<string, unknown> = {},
) {
	const meta = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: VAULT_ID, label: "", createdAt: 1 }] }],
	]);
	const writes: Uint8Array[] = [];
	let quarantine: string | null = null;
	let disk = JSON.stringify({ entries: entryIds.map(sealed), tombstones: [] });
	const platform = {
		target: "chromium",
		storage: {
			getMeta: async (k: string) => meta.get(k),
			setMeta: async (k: string, v: unknown) => void meta.set(k, v),
			removeMeta: async (k: string) => void meta.delete(k),
			hasVault: async () => true,
			readVaultBlob: async () => new Uint8Array([1]),
			writeVaultBlob: async (b: Uint8Array) => void writes.push(b),
			restoreVaultFromBackup: async () => false,
			readQuarantine: async () => quarantine,
			writeQuarantine: async (json: string) => void (quarantine = json),
		},
		crypto: {
			isLocked: async () => false,
			onExternalLock: () => () => {},
			onExternalChange: () => () => {},
			unwrapVekPassword: async () => true,
			decryptWithVek: async () => disk,
			encryptWithVek: async (plaintext: string) => ((disk = plaintext), { iv: "AA==", ciphertext: "AA==" }),
			encryptEntry: async () => ({ ciphertext: PROBE, iv: "i", wrappedDek: "w", dekIv: "d" }),
			lock: async () => {},
			...cryptoOver,
		},
		autofill: { clearIndex: async () => {}, setIndex: async () => {} },
		shell: {
			setActiveVault: async () => {},
			onSyncStatus: () => () => {},
			flushPendingCornerCapture: async () => false,
			...shellOver,
		},
		clipboard: {},
	} as unknown as Platform;
	return { platform, writes, quarantined: () => (quarantine === null ? [] : JSON.parse(quarantine)) };
}

async function unlocked(platform: Platform) {
	const { actions, state } = mountVault(platform);
	await waitFor(() => expect(actions().unlock).toBeTypeOf("function"));
	return { actions, state };
}

it("opens a vault holding an entry it can't decrypt, and sets that entry aside", async () => {
	const { platform, quarantined } = makePlatform(["mine", "stray"], {
		decryptEntries: decryptBy({ mine: '{"type":"login","name":"Mine"}' }),
	});
	const { actions, state } = await unlocked(platform);
	await actions().unlock("pw");
	await waitFor(() => expect(state().isLocked).toBe(false));
	expect(state().entries.map((e) => e.name)).toEqual(["Mine"]);
	expect(quarantined()).toHaveLength(1);
});

it("opens a vault that held only stray entries, empty", async () => {
	const { platform, quarantined } = makePlatform(["stray"], { decryptEntries: decryptBy({}) });
	const { actions, state } = await unlocked(platform);
	await actions().unlock("pw");
	await waitFor(() => expect(state().isLocked).toBe(false));
	expect(state().entries).toEqual([]);
	expect(quarantined()).toHaveLength(1);
});

it("changes nothing when this device can't decrypt entries at all", async () => {
	const { platform, writes, quarantined } = makePlatform(["mine"], { decryptEntries: decryptBy({}, true) });
	const { actions } = await unlocked(platform);
	await expect(actions().unlock("pw")).rejects.toThrow();
	expect(writes).toHaveLength(0);
	expect(quarantined()).toEqual([]);
});

it("changes nothing when a readable entry fails to parse", async () => {
	const { platform, writes, quarantined } = makePlatform(["bad", "stray"], {
		decryptEntries: decryptBy({ bad: "{not json" }),
	});
	const { actions } = await unlocked(platform);
	await expect(actions().unlock("pw")).rejects.toThrow();
	expect(writes).toHaveLength(0);
	expect(quarantined()).toEqual([]);
});
```

Compare the stub's members with `useVault.unlockIndexRace.test.tsx` and add any the provider needs that this list misses. Task 5 tightens the two `rejects.toThrow()` to `VAULT_OPEN_FAILED`. Run it and confirm it fails.

- [ ] **Step 6: Use it in `loadEntries`.** Replace the block from `const plaintexts = await crypto.decryptEntries(` through `setEntries(decrypted)`, and move the `stampsRef` assignment after it:

```ts
		const plaintexts = await crypto.decryptEntries(
			payload.entries.map((enc) => ({ ciphertext: enc.ciphertext, iv: enc.iv, wrappedDek: enc.wrappedDek, dekIv: enc.dekIv })),
		);
		// Decode everything readable BEFORE any write: a failed open must leave the vault as it was.
		const readable: EncryptedEntry[] = [];
		const unreadable: EncryptedEntry[] = [];
		const decrypted: Entry[] = [];
		payload.entries.forEach((enc, i) => {
			const plaintext = plaintexts[i];
			if (plaintext == null) {
				unreadable.push(enc);
				return;
			}
			readable.push(enc);
			decrypted.push({ id: enc.id, ...normalizeEntryData(JSON.parse(plaintext)) });
		});
		if (unreadable.length > 0) {
			// The outer layer opened under this key, so failures are stray entries unless this device can't decrypt at all.
			const probe = await crypto.encryptEntry("{}");
			const [probed] = await crypto.decryptEntries([probe]);
			if (probed == null) throw new Error("entry decryption is failing on this device");
			if (!activeId || !storage.readQuarantine || !storage.writeQuarantine) {
				throw new Error("no quarantine store for this vault");
			}
			console.warn(`[vault] setting aside ${unreadable.length} entries this vault can't decrypt`);
			const store = createEntriesBlobStore({ crypto, storage, readDecodedBlob, verifyVekBeforeWrite: true });
			await quarantineEntries(
				{ storage: { readQuarantine: storage.readQuarantine, writeQuarantine: storage.writeQuarantine }, store, vaultId: activeId },
				unreadable,
			);
		}
		stampsRef.current = new Map(readable.map((e) => [e.id, e.hlc]));
		setEntries(decrypted);
		await publishIndex(toAutofillIndex(decrypted), indexLease);
```

Add `activeId` to the `useCallback` deps and the needed imports (`createEntriesBlobStore`, `quarantineEntries`, `EncryptedEntry`). No change to `deleteVault`: Task 3 removes the quarantine with the vault's files.

- [ ] **Step 7: Run the tests**

Run: `CI=true pnpm --filter @vault/core test` and `pnpm --filter @vault/core typecheck`
Expected: PASS.

- [ ] **Step 8: Docs and commit.** Add to `docs/multiple-vaults.md`: entries a vault can't decrypt are moved, still sealed, to that vault's quarantine store when it opens; they are never synced or shown and are kept until the vault is deleted; a probe entry distinguishes stray entries from a device that can't decrypt, and in that case nothing is touched.

```bash
git add packages/core/src/sync/entry-version.ts packages/core/src/vault/quarantine.ts packages/core/src/vault/quarantine.test.ts packages/core/src/hooks/useVault.tsx packages/core/src/hooks/useVault.quarantine.test.tsx docs/multiple-vaults.md
git commit -m "fix(vault): set aside entries a vault can't decrypt instead of refusing to open" -m "A single entry sealed under another key used to make the whole vault unopenable. Such entries now move, still sealed, to the vault's quarantine store, kept until the vault is deleted, and the vault opens with the rest. A fresh probe entry tells stray entries apart from a device that can't decrypt at all, and readable entries are decoded before anything is written."
```

---

### Task 5: An unlock either opens the vault or locks it again; sync waits for the open

**Files:**
- Modify: `packages/core/src/adapters/crypto.ts` (next to `CRYPTO_SESSION_CHANGED`)
- Modify: `packages/core/src/adapters/shell.ts` (next to `setActiveVault`)
- Modify: `packages/core/src/hooks/useVault.tsx` (the unlock paths at `~769`, `~817`, `~1349`, the biometric unlock, and the mount path at `~658`)
- Modify: `packages/platform-extension/src/shell.ts`, `packages/platform-extension/src/session-keys.ts`
- Modify: `packages/platform-extension/src/background/session.ts:240-265,342-366`, `packages/platform-extension/src/background/sync.ts` (maybeStartSync)
- Test: `packages/core/src/hooks/useVault.quarantine.test.tsx`, `packages/platform-extension/src/background/session.test.ts`

**Interfaces:**
- Produces: `export const VAULT_OPEN_FAILED = "VAULT_OPEN_FAILED";`; `ShellAdapter.notifyVaultOpened?(vaultId: string): void | Promise<void>`; background message `VAULT_OPENED {vaultId}`; session key `OPENED_VAULT_KEY = "sync.openedVault"` holding the vault id whose entries loaded since the last unlock.

- [ ] **Step 1: Write the failing tests.** In `useVault.quarantine.test.tsx`, tighten the two "changes nothing" tests to `.rejects.toThrow(VAULT_OPEN_FAILED)` and add:

```ts
it("locks again when the vault fails to open, and reports only a vault that opened", async () => {
	const lock = vi.fn(async () => {});
	const notifyVaultOpened = vi.fn();
	const { platform } = makePlatform(["mine"], { decryptEntries: decryptBy({}, true), lock }, { notifyVaultOpened });
	const { actions } = await unlocked(platform);
	await expect(actions().unlock("pw")).rejects.toThrow(VAULT_OPEN_FAILED);
	expect(lock).toHaveBeenCalled();
	expect(notifyVaultOpened).not.toHaveBeenCalled();
});

it("reports the vault that opened, by id", async () => {
	const notifyVaultOpened = vi.fn();
	const { platform } = makePlatform(
		["mine"],
		{ decryptEntries: decryptBy({ mine: '{"type":"login","name":"Mine"}' }) },
		{ notifyVaultOpened },
	);
	const { actions } = await unlocked(platform);
	await actions().unlock("pw");
	await waitFor(() => expect(notifyVaultOpened).toHaveBeenCalledWith(VAULT_ID));
});
```

In `session.test.ts`, using its `loadBackground` harness (the active vault is `TEST_ACTIVE_VAULT`, `"v1"`):

```ts
const syncSeed = {
	"vault.registry": { vaults: [{ id: TEST_ACTIVE_VAULT, label: "", createdAt: 1 }] },
	[`sync.group:${TEST_ACTIVE_VAULT}`]: { groupKey: "Zw==", roster: { devices: [], revoked: [] } },
	[`sync.deviceKeypair:${TEST_ACTIVE_VAULT}`]: { privateKey: "cHJpdg==", publicKey: "cHVi" },
};

it("starts sync after the vault opens, not when the key unwraps", async () => {
	const bg = await loadBackground({ localSeed: syncSeed });
	await bg.send({ type: "CRYPTO_UNWRAP_PASSWORD_SLOT" });
	const types = () => bg.state.offscreenCalls.map((m) => m.type);
	expect(types()).not.toContain("SYNC_ROSTER_SYNC");
	await bg.send({ type: "VAULT_OPENED", payload: { vaultId: TEST_ACTIVE_VAULT } });
	await vi.waitFor(() => expect(types()).toContain("SYNC_ROSTER_SYNC"));
});

it("ignores an open reported for a vault that isn't active", async () => {
	const bg = await loadBackground({ localSeed: syncSeed });
	await bg.send({ type: "CRYPTO_UNWRAP_PASSWORD_SLOT" });
	const { resp } = await bg.send({ type: "VAULT_OPENED", payload: { vaultId: "someone-else" } });
	expect(resp.ok).toBe(false);
	expect(bg.state.offscreenCalls.map((m) => m.type)).not.toContain("SYNC_ROSTER_SYNC");
});
```

If the harness already seeds a registry or session differently, follow its seeds (read `makeChrome` in `test/test-harness.ts`). Run both files and confirm they fail.

- [ ] **Step 2: Core.** `adapters/crypto.ts`:

```ts
/** A vault's key unwrapped but its entries did not load; the vault was locked again. */
export const VAULT_OPEN_FAILED = "VAULT_OPEN_FAILED";
```

`adapters/shell.ts` (optional member):

```ts
	/** This vault's entries loaded after an unlock. Hosts start sync here, not at unwrap. */
	notifyVaultOpened?(vaultId: string): void | Promise<void>;
```

`useVault.tsx`, defined after `loadEntries`:

```ts
	// After a successful unwrap: load, or lock again so nothing syncs a vault that didn't open.
	const openUnlocked = useCallback(
		async (vaultId: string | null) => {
			try {
				await loadEntries();
			} catch (e) {
				console.error("[vault] vault failed to open after unlock:", e);
				await crypto.lock().catch(() => {});
				throw new Error(VAULT_OPEN_FAILED);
			}
			if (vaultId) void shell.notifyVaultOpened?.(vaultId);
		},
		[loadEntries, crypto, shell],
	);
```

Replace `await loadEntries();` with `await openUnlocked(<the id this path unlocked>);` in the password (`target`), security-key, recovery and biometric unlock paths (pass `activeId ?? null` where no explicit id exists). Leave the `.catch(() => {})` refresh at `~1283` alone. In the reopened-popup mount path at `~658`, call `if (activeId) void shell.notifyVaultOpened?.(activeId)` after its successful `loadEntries()`.

- [ ] **Step 3: Extension.** `session-keys.ts`: `export const OPENED_VAULT_KEY = "sync.openedVault";` (session storage; the vault whose entries loaded since the last unlock).

`shell.ts`:

```ts
	async notifyVaultOpened(vaultId) {
		await api.runtime.sendMessage({ type: "VAULT_OPENED", payload: { vaultId } }).catch(() => {});
	},
```

`session.ts`: in the unwrap-success branch delete only `void maybeStartSync(vekEpoch);` (keep `runDueBackups`, `scheduleAutoLock`, `broadcastLockState`, `closeUnlockPopout`; backups skip identical bytes and already cover every registered vault). Add:

```ts
// The UI loaded this vault's entries; only now may it sync.
on(
	"VAULT_OPENED",
	extensionOnly(async (message) => {
		const { vaultId } = SyncVaultMsgSchema.parse(message.payload); // same { vaultId } shape, from ../sync/messages
		if ((await refreshActiveVaultId()) !== vaultId || vaultLocked()) return { ok: false, error: "not the open vault" };
		await api.storage.session.set({ [OPENED_VAULT_KEY]: vaultId });
		void maybeStartSync(vekStore.vekMutationSnapshot());
		return { ok: true };
	}),
);
```

In `clearSession`, also remove `OPENED_VAULT_KEY` from session storage (add it to the list `removeHandoffKeys` removes). In `maybeStartSync` (`sync.ts`, importing `OPENED_VAULT_KEY` from `../session-keys`), right after resolving `ctx`:

```ts
	const opened = (await api.storage.session.get(OPENED_VAULT_KEY))[OPENED_VAULT_KEY];
	if (opened !== ctx.vaultId) return; // not loaded since unlock: never sync a vault that may not open
```

- [ ] **Step 4: Run the tests**

Run: `CI=true pnpm --filter @vault/core test`, `CI=true pnpm --filter @vault/platform-extension test`, `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/crypto.ts packages/core/src/adapters/shell.ts packages/core/src/hooks/useVault.tsx packages/core/src/hooks/useVault.quarantine.test.tsx packages/platform-extension/src/shell.ts packages/platform-extension/src/session-keys.ts packages/platform-extension/src/background/session.ts packages/platform-extension/src/background/session.test.ts packages/platform-extension/src/background/sync.ts
git commit -m "fix(vault): sync a vault only once it has opened, and relock one that didn't" -m "The extension started sync the moment the key unwrapped, so a damaged vault reached its sync group before the open could clean it. Sync now waits for the UI to report which vault's entries loaded, and a vault whose entries fail to load is locked again."
```

---

### Task 6: Calm, translated copy instead of the raw crypto error

**Files:**
- Modify: `packages/core/src/hooks/useCryptoErrorMessage.tsx`
- Test: `packages/core/src/hooks/useCryptoErrorMessage.test.tsx`
- Modify: `packages/core/src/locales/*/messages.po` and compiled `messages.ts` (generated)

**Interfaces:**
- Consumes: `VAULT_OPEN_FAILED` (Task 5), thrown only by unlock paths.

- [ ] **Step 1: Write the failing test** (`useCryptoErrorMessage.test.tsx`, with the Lingui setup `test/vault-harness.tsx` uses):

```tsx
/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { VAULT_OPEN_FAILED } from "../adapters/crypto";
import { useCryptoErrorMessage } from "./useCryptoErrorMessage";

i18n.load("en", {});
i18n.activate("en");
const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>;
const message = (e: unknown) => renderHook(() => useCryptoErrorMessage(), { wrapper }).result.current(e);

describe("useCryptoErrorMessage", () => {
	it("explains a vault that didn't open in calm words", () => {
		expect(message(new Error(VAULT_OPEN_FAILED))).toBe(
			"Bramble couldn't open this vault right now. Nothing in it was changed. Please try again.",
		);
	});

	it.each(["Error: aes decrypt: aead::Error", "aes encrypt: aead::Error"])(
		"never shows a raw crypto failure (%s)",
		(raw) => {
			expect(message(new Error(raw))).toBe("Something went wrong. Please try again.");
		},
	);

	it("leaves copy that is already written for users alone", () => {
		expect(message(new Error("Incorrect master password"))).toBe("Incorrect master password");
	});
});
```

Run: `CI=true pnpm --filter @vault/core exec vitest run src/hooks/useCryptoErrorMessage.test.tsx`. Expected: FAIL.

- [ ] **Step 2: Implement** (inside the callback, after the two existing checks):

```ts
			// Only unlock throws this, so this copy only ever shows on the unlock screen.
			if (message.startsWith(VAULT_OPEN_FAILED)) {
				return t`Bramble couldn't open this vault right now. Nothing in it was changed. Please try again.`;
			}
			// Setup and password changes share this hook: keep raw crypto internals out of every screen.
			if (RAW_CRYPTO_ERROR.test(message)) {
				return t`Something went wrong. Please try again.`;
			}
```

with, at module level: `const RAW_CRYPTO_ERROR = /aead::Error|\baes (?:en|de)crypt\b/;` Update the doc comment: unknown messages still pass through; a failed open and raw crypto internals map to calm copy.

Both strings are drafts for the user's sign-off before release. "Nothing in it was changed" must stay true: every path that throws `VAULT_OPEN_FAILED` fails before the vault file is written (the probe and the parse run first; a failed quarantine rewrite leaves the vault file as it was). If `readVaultBackup` is ever wired into the unlock path (it can restore a snapshot over the live file), revisit this sentence.

- [ ] **Step 3: Run the test.** Expected: PASS.

- [ ] **Step 4: Catalogs.** Run `pnpm i18n:extract`, `pnpm i18n:translate`, `pnpm i18n:compile`, `pnpm i18n:check`. If `i18n:translate` has no API key configured (`.env.local`), stop and tell the user rather than shipping English in other locales.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/hooks/useCryptoErrorMessage.tsx packages/core/src/hooks/useCryptoErrorMessage.test.tsx packages/core/src/locales
git commit -m "fix(ui): show calm, translated copy instead of raw crypto errors" -m "A correct password on a damaged vault showed 'aes decrypt: aead::Error', which reads as data loss. A vault that fails to open now says so calmly, and raw AES failures on any screen map to a generic translated message."
```

---

### Task 7: Merges refuse entries that don't decrypt under the receiving vault's key

**Files:**
- Modify: `packages/core/src/sync/apply-remote.ts`
- Test: `packages/core/src/sync/apply-remote.test.ts`
- Modify: `packages/platform-extension/src/background/sync.ts` (makeVaultSyncPort, applyRemoteNow), `packages/platform-extension/src/offscreen-core.ts` (new op), `packages/platform-extension/src/background/offscreen-client.ts:99-110` (`USE_VEK`)
- Modify: `packages/platform-desktop/src/sync/roster.ts:155-220`
- Modify: `packages/platform-mobile/src/sync/sync-manager.ts:~400-445`

**Interfaces:**
- Consumes: `entryVersionKey` (Task 4), tolerant `decryptEntries` / wasm `decrypt_entries` (Task 2), the per-vault apply queue (Task 1).
- Produces: `VaultSyncPort.openable(entries: EncryptedEntry[]): Promise<boolean[]>`; `applyRemotePayload(port, remote, opts?: { rejected?: Set<string> })`; `createVaultSyncPort` deps gain `crypto: Pick<CryptoAdapter, "decryptEntries">`; extension op `CRYPTO_CHECK_ENTRIES` (payload `{ entries: EncryptedPayload[] }`, data `boolean[]`).

- [ ] **Step 1: Write the failing tests** in `apply-remote.test.ts`. Change `fakePort(local)` to `fakePort(local, { unopenable = [] }: { unopenable?: string[] } = {})`, add `const checked: string[][] = [];` and an `openable` member that records and answers:

```ts
		openable: (es) => {
			checked.push(es.map((e) => e.id));
			return Promise.resolve(es.map((e) => !unopenable.includes(e.id)));
		},
```

returned alongside the existing fields as `checked`. Then:

```ts
	it("does not merge a remote entry that doesn't decrypt under this vault's key", async () => {
		const { port, writes } = fakePort(payload([env("a", "a", hlc(100, "x"))]), { unopenable: ["stray"] });
		const res = await applyRemotePayload(port, payload([env("stray", "s", hlc(200, "y"))]));
		expect(res.changed).toBe(false);
		expect(writes).toHaveLength(0);
	});

	it("merges the entries that decrypt and drops the rest", async () => {
		const { port, writes } = fakePort(payload([]), { unopenable: ["stray"] });
		await applyRemotePayload(port, payload([env("ok", "o", hlc(1, "y")), env("stray", "s", hlc(1, "y"))]));
		expect(live(writes[0]!)).toEqual(["ok"]);
	});

	it("only checks entries that would win the merge", async () => {
		const { port, checked } = fakePort(payload([env("a", "a", hlc(300, "x"))]));
		await applyRemotePayload(port, payload([env("a", "old", hlc(100, "y"))]));
		expect(checked).toEqual([]);
	});

	it("does not re-check a version it already refused", async () => {
		const rejected = new Set<string>();
		const { port, checked } = fakePort(payload([]), { unopenable: ["stray"] });
		const remote = payload([env("stray", "s", hlc(1, "y"))]);
		await applyRemotePayload(port, remote, { rejected });
		await applyRemotePayload(port, remote, { rejected });
		expect(checked).toEqual([["stray"]]);
	});

	it("checks a newer version of an id it refused before", async () => {
		const rejected = new Set<string>();
		const { port, checked } = fakePort(payload([]), { unopenable: ["stray"] });
		await applyRemotePayload(port, payload([env("stray", "s", hlc(1, "y"))]), { rejected });
		await applyRemotePayload(port, payload([env("stray", "s2", hlc(2, "y"))]), { rejected });
		expect(checked).toEqual([["stray"], ["stray"]]);
	});
```

Run: `CI=true pnpm --filter @vault/core exec vitest run src/sync/apply-remote.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement in `apply-remote.ts`:**

```ts
export interface VaultSyncPort {
	// ...existing members...
	/** Whether each entry decrypts under this vault's key; only the verdict leaves the crypto host. */
	openable(entries: EncryptedEntry[]): Promise<boolean[]>;
}

/** Drop incoming entries that would win the merge but don't decrypt here: a peer can't plant another vault's entries. */
async function admit(
	port: VaultSyncPort,
	local: EntriesPayload,
	remote: EntriesPayload,
	rejected: Set<string>,
): Promise<EntriesPayload> {
	const mine = new Map(local.entries.map((e) => [e.id, e.hlc]));
	const candidates = remote.entries.filter((e) => {
		if (rejected.has(entryVersionKey(e))) return false;
		const have = mine.get(e.id);
		return have === undefined || compareHlc(e.hlc, have) > 0;
	});
	if (candidates.length > 0) {
		const verdicts = await port.openable(candidates);
		const refused = candidates.filter((_, i) => !verdicts[i]);
		for (const e of refused) rejected.add(entryVersionKey(e));
		if (refused.length > 0) console.warn(`[sync] refused ${refused.length} entries that don't decrypt in this vault`);
	}
	return { ...remote, entries: remote.entries.filter((e) => !rejected.has(entryVersionKey(e))) };
}

export async function applyRemotePayload(
	port: VaultSyncPort,
	remote: EntriesPayload,
	{ rejected = new Set<string>() }: { rejected?: Set<string> } = {},
): Promise<ApplyResult> {
	const safe = sanitizeRemoteEntriesPayload(remote);
	const local = await port.readLocal();
	const admitted = await admit(port, local, safe, rejected);
	const merged = mergeEntriesPayload(local, admitted);
	const changed = !payloadsEquivalent(local, merged);
	if (changed) {
		await port.witnessRemote(remoteStamps(admitted));
		await port.writeMerged(merged);
	}
	return { payload: merged, changed };
}

export function createVaultSyncPort(deps: {
	store: EntriesBlobStore;
	crypto: Pick<CryptoAdapter, "decryptEntries">;
	witnessRemote: (stamps: Hlc[]) => Promise<void>;
	onChanged?: () => void | Promise<void>;
}): VaultSyncPort {
	return {
		// ...existing members...
		openable: async (entries) =>
			(await deps.crypto.decryptEntries(
				entries.map(({ ciphertext, iv, wrappedDek, dekIv }) => ({ ciphertext, iv, wrappedDek, dekIv })),
			)).map((p) => p != null),
	};
}
```

Witness only `admitted` stamps, so a refused entry can't advance this device's clock. Add `import type { CryptoAdapter } from "../adapters/crypto";` and `import { entryVersionKey } from "./entry-version";` (`compareHlc` is already imported).

- [ ] **Step 3: Run the core tests.** Expected: PASS.

- [ ] **Step 4: Extension port.** Add `"CRYPTO_CHECK_ENTRIES"` to `USE_VEK` in `offscreen-client.ts`. In `offscreen-core.ts`:

```ts
		case "CRYPTO_CHECK_ENTRIES": {
			// Verdicts only: plaintext never leaves this document for an admission check.
			const p = CryptoDecryptBatchSchema.parse(payload);
			const w = (await getWasm()) as unknown as SyncVek;
			return withVek(w, p.vekB64, (w) =>
				w.decrypt_entries(p.entries.map(({ ciphertext, iv, wrappedDek, dekIv }) => ({ ciphertext, iv, wrappedDek, dekIv })))
					.map((pt) => pt != null),
			);
		}
```

In `background/sync.ts`, add to `makeVaultSyncPort`:

```ts
		async openable(entries) {
			const res = await sendToOffscreen({
				type: "CRYPTO_CHECK_ENTRIES",
				vaultId: ctx.vaultId,
				payload: { entries: entries.map(({ ciphertext, iv, wrappedDek, dekIv }) => ({ ciphertext, iv, wrappedDek, dekIv })) },
			});
			if (!res.ok || !Array.isArray(res.data)) throw new Error(res.error ?? "entry check failed");
			return res.data as boolean[];
		},
```

and keep refusals per vault for the worker's lifetime: `const refusedByVault = new Map<string, Set<string>>();`, and in `applyRemoteNow`: `const rejected = refusedByVault.get(ctx.vaultId) ?? new Set<string>(); refusedByVault.set(ctx.vaultId, rejected); await applyRemotePayload(makeVaultSyncPort(ctx), remote, { rejected });`. Add an `offscreen-decrypt-batch.test.ts` case: `CRYPTO_CHECK_ENTRIES` with `[entry("a"), entry("broken")]` returns `{ ok: true, data: [true, false] }`.

- [ ] **Step 5: Desktop and mobile ports.** In `platform-desktop/src/sync/roster.ts` `startRoster`, create `const rejected = new Set<string>();` next to `const gen = sessionGen;`, pass `crypto: desktopCrypto` to `createVaultSyncPort`, and call `applyRemotePayload(port, decodeEntriesPayload(json), { rejected })`. Same in `platform-mobile/src/sync/sync-manager.ts` with `crypto: mobileCrypto`, the set created per session next to its `gen`. A per-session set means a transient wrong-key state can't make a refusal outlive the session.

- [ ] **Step 6: Run everything touched.**

Run: `CI=true pnpm --filter @vault/core test`, `CI=true pnpm --filter @vault/platform-extension test`, `CI=true pnpm --filter @vault/platform-desktop test`, `CI=true pnpm --filter @vault/platform-mobile test`, `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/sync/apply-remote.ts packages/core/src/sync/apply-remote.test.ts packages/platform-extension/src/background/sync.ts packages/platform-extension/src/offscreen-core.ts packages/platform-extension/src/background/offscreen-client.ts packages/platform-extension/src/offscreen-decrypt-batch.test.ts packages/platform-desktop/src/sync/roster.ts packages/platform-mobile/src/sync/sync-manager.ts
git commit -m "fix(sync): refuse incoming entries that don't decrypt under the vault's key" -m "Every member of a sync group shares the vault key, so an entry that doesn't decrypt can only be another vault's or damaged. Merges now check the entries that would win and drop the rest, remembering refusals so a peer's rebroadcast isn't re-checked every few seconds. Protects devices from a peer that is still broken."
```

---

### Task 8: End-to-end regressions

**Files:**
- Modify: `e2e/sync/vault-switch-sync.spec.ts` (remove the `// TEMP-DIAG` block, lines 194-199)
- Create: `e2e/extension/stray-entry.spec.ts`
- Modify: `e2e/extension/helpers.ts` (add `addLogin`)

- [ ] **Step 1: Remove the TEMP-DIAG block** from `vault-switch-sync.spec.ts` (it imports `node:fs` and reads `/tmp`). Keep both variants.

- [ ] **Step 2: Move `addLogin`** from `e2e/sync/vault-switch-sync.spec.ts` into `e2e/extension/helpers.ts` (exported) and import it in the sync spec.

- [ ] **Step 3: Write the stray-entry e2e.** It plants an entry sealed under vault 1's key into vault 2 the way the bug did, then unlocks vault 2 through the UI. One case keeps vault 2's own entry; the other leaves vault 2 holding only the stray one.

```ts
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addLogin, backgroundWorker, createVault, lock, openPopup, unlock } from "./helpers";

/** Byte offset where the entries section starts: after the 6-byte header and every slot. */
const ENTRIES_OFFSET = `(b) => { let off = 6; for (let i = 0; i < b[5]; i++) off += 3 + ((b[off + 1] << 8) | b[off + 2]); return off; }`;

/** A vault's decrypted outer payload, read through the extension's own crypto messages (its key must be loaded). */
async function readPayload(page: Page, vaultId: string): Promise<{ entries: unknown[]; tombstones: unknown[] }> {
	return page.evaluate(
		async ({ id, offsetSrc }) => {
			const offset = eval(offsetSrc) as (b: Uint8Array) => number;
			const key = `vault-blob-b64:${id}`;
			const b = Uint8Array.from(atob((await chrome.storage.local.get(key))[key] as string), (c) => c.charCodeAt(0));
			const off = offset(b);
			const enc = (u: Uint8Array) => btoa(String.fromCharCode(...u));
			const r = await chrome.runtime.sendMessage({
				type: "CRYPTO_DECRYPT_OUTER",
				vaultId: id,
				payload: { iv: enc(b.subarray(off, off + 12)), ciphertext: enc(b.subarray(off + 12)) },
			});
			return JSON.parse(r.data);
		},
		{ id: vaultId, offsetSrc: ENTRIES_OFFSET },
	);
}

/** Re-seal a payload under the vault's loaded key and write it back, keeping the slot header. */
async function writePayload(page: Page, vaultId: string, payload: unknown): Promise<void> {
	await page.evaluate(
		async ({ id, json, offsetSrc }) => {
			const offset = eval(offsetSrc) as (b: Uint8Array) => number;
			const key = `vault-blob-b64:${id}`;
			const b = Uint8Array.from(atob((await chrome.storage.local.get(key))[key] as string), (c) => c.charCodeAt(0));
			const r = await chrome.runtime.sendMessage({ type: "CRYPTO_ENCRYPT_OUTER", vaultId: id, payload: { plaintext: json } });
			const dec = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
			const out = new Uint8Array([...b.subarray(0, offset(b)), ...dec(r.data.iv), ...dec(r.data.ciphertext)]);
			await chrome.storage.local.set({ [key]: btoa(String.fromCharCode(...out)) });
		},
		{ id: vaultId, json: JSON.stringify(payload), offsetSrc: ENTRIES_OFFSET },
	);
}

async function vaultIds(context: BrowserContext): Promise<string[]> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(async () =>
		((await chrome.storage.local.get("vault.registry"))["vault.registry"] as { vaults: { id: string }[] }).vaults.map((v) => v.id),
	);
}

/** Vault 1 with one login "Stray"; vault 2 created after it. Returns the stray envelope and vault 2's id. */
async function twoVaults(context: BrowserContext, page: Page, extensionId: string) {
	await createVault(page, extensionId);
	await openPopup(page, extensionId);
	await addLogin(page, "Stray");
	const [first] = await vaultIds(context);
	const stray = (await readPayload(page, first!)).entries[0];
	await createVault(await context.newPage(), extensionId); // vault 2, now active and unlocked
	const second = (await vaultIds(context)).find((id) => id !== first)!;
	await openPopup(page, extensionId);
	return { stray, second };
}

async function quarantined(context: BrowserContext, vaultId: string): Promise<string | undefined> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k] as string | undefined, `vault-quarantine:${vaultId}`);
}

test("a vault holding another vault's entry opens without an error and sets it aside", async ({ context, extensionId, page }) => {
	const { stray, second } = await twoVaults(context, page, extensionId);
	await addLogin(page, "Mine");
	const payload = await readPayload(page, second);
	await writePayload(page, second, { ...payload, entries: [...payload.entries, stray] });

	await lock(page);
	await unlock(page);
	await expect(page.getByText("Mine")).toBeVisible();
	await expect(page.getByText("Stray")).toHaveCount(0);
	await expect(page.getByText(/aead::Error|aes decrypt/)).toHaveCount(0);
	expect(JSON.parse((await quarantined(context, second))!)).toHaveLength(1);
});

test("a vault holding only another vault's entries opens, empty", async ({ context, extensionId, page }) => {
	const { stray, second } = await twoVaults(context, page, extensionId);
	const payload = await readPayload(page, second);
	await writePayload(page, second, { ...payload, entries: [stray] });

	await lock(page);
	await unlock(page);
	await expect(page.getByText("Stray")).toHaveCount(0);
	await expect(page.getByText(/aead::Error|aes decrypt/)).toHaveCount(0);
	expect(JSON.parse((await quarantined(context, second))!)).toHaveLength(1);
});
```

Adapt fixture names to `e2e/extension/fixtures` (check what it exports). If `eval` of the offset helper is awkward under the extension's CSP in `page.evaluate`, inline the offset loop in both functions instead.

- [ ] **Step 4: Build and run.**

Run: `pnpm --filter @vault/platform-extension run build:chromium`, then `CI=true pnpm exec playwright test e2e/extension/stray-entry.spec.ts` and `CI=true pnpm exec playwright test --config playwright.sync.config.ts e2e/sync/vault-switch-sync.spec.ts`
Expected: PASS, including both vault-switch variants.

- [ ] **Step 5: Commit**

```bash
git add e2e/sync/vault-switch-sync.spec.ts e2e/extension/stray-entry.spec.ts e2e/extension/helpers.ts
git commit -m "test(e2e): cover cross-vault sync and vaults holding another vault's entries" -m "The shared-devices variant reproduces the field report: two groups listing the same device key, with the second vault opened while the first still syncs. The stray-entry specs plant entries sealed under another vault's key, alongside the vault's own and on their own, and expect a normal unlock with those entries set aside."
```

---

## Future: using the quarantine

Not part of this plan; recorded so it isn't lost. Quarantined entries are kept until their vault is deleted precisely so this can be built later. Each record keeps the sealed envelope (`ciphertext`, `iv`, `wrappedDek`, `dekIv`), its `id` and `hlc` (which name the device and time that wrote it), and `quarantinedAt`. Directions to weigh when it comes up:

- Rescue with the right key: when another vault is unlocked, try its key on other vaults' quarantined entries. An entry whose id that vault already holds is a stray copy and can be dropped; one it doesn't hold is likely a vault's own entry sealed under the wrong key (the issue #27 case) and should be re-sealed into the vault it was quarantined from. That needs both keys at once, which the extension only has transiently today.
- A support path: let the read-only diagnostic report quarantine counts per vault, and offer an advanced action to export a vault's quarantine as a file for assisted recovery.
- Retention: if storage ever matters, purge only entries a rescue has proven to be duplicates; never purge on a timer.

## Deliberately out of scope

- Cleaning crossed device lists. There is no reliable way to tell which roster entries crossed; affected users revoke manually in Settings, Sync.
- Wiring `readVaultBackup` through `makeVaultScopedStorage` (`useVaultRegistry.tsx:193-210`; the extension also never implements it). It only matters when the OUTER layer fails, not for stray entries, auto-restoring a snapshot rolls back legitimate changes, and it would make Task 6's "Nothing in it was changed" untrue.
- Desktop and mobile still start sync at unwrap. Task 5's relock on a failed open stops them, Task 4 makes a failed open rare, and Task 7 stops the spread at every receiver; gating their start on "opened" is a follow-up.
- Tombstones from a crossed group: they can't be checked cryptographically and only name ids this vault never had.
- A decrypted entry that fails to parse (a newer format) still fails the open; with Task 6 it shows the calm copy and nothing is written.
- Mobile's single global VEK (per-vault VEK port).
