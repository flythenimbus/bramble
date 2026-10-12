import { decodeRoster, emptyEntriesPayload, encodeRoster } from "@core/sync";
import {
	addVault,
	EMPTY_REGISTRY,
	VAULT_REGISTRY_KEY,
	type VaultRegistry,
} from "@core/vault/vault-registry";
import { encodeVaultBlob, SLOT_KIND_PASSWORD } from "@core/vault-format";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_VAULT_SESSION_KEY } from "../session-keys";
import { memoryStorageArea } from "../test/test-harness";

// Capture what the background hands the offscreen host. The rest of the background wiring is
// stubbed so importing ./sync doesn't drag in the router/offscreen machinery.
const { sendToOffscreen } = vi.hoisted(() => ({
	// Typed with the message param so `.mock.calls[i][0]` is the sent message, not an empty tuple.
	sendToOffscreen: vi.fn((_message: { type?: string; payload?: Record<string, unknown> }) =>
		Promise.resolve({ ok: true }),
	),
}));
vi.mock("./offscreen-client", () => ({
	sendToOffscreen,
	setInProcessSyncBridge: vi.fn(),
	useOffscreenDoc: false,
	ensureOffscreen: vi.fn(async () => {}),
	markOffscreenKey: vi.fn(),
}));
vi.mock("./router", () => ({
	on: vi.fn(),
	onPrefix: vi.fn(),
	extensionOnly: (fn: unknown) => fn,
	setReady: vi.fn(),
}));
vi.mock("../offscreen-core", () => ({ setSyncBridge: vi.fn() }));
vi.mock("./sync-clock", () => ({ witnessStamp: vi.fn(async () => {}), witnessStamps: vi.fn() }));

// chrome stub with local + session storage, alarms, and runtime (./sync adds a status listener at
// import). No `offscreen` key -> the code treats the host as suspend-y and arms the keepalive alarm.
//
// `runtime` also has to carry getURL, id and onConnect: ./sync imports ./desktop-link, which
// registers a port listener at import and resolves the extension origin through ../sender. An
// https stand-in for getURL, because Node gives chrome-extension:// an opaque origin.
function stubChrome(
	localSeed: Record<string, unknown> = {},
	sessionSeed: Record<string, unknown> = {},
) {
	const local = { ...localSeed };
	const session = { ...sessionSeed };
	vi.stubGlobal("chrome", {
		storage: { local: memoryStorageArea(local), session: memoryStorageArea(session) },
		alarms: { create: vi.fn(), clear: vi.fn(async () => {}) },
		runtime: {
			onMessage: { addListener: vi.fn() },
			onConnect: { addListener: vi.fn() },
			id: "bramble-test",
			getURL: (p: string) => `https://bramble-test.example/${p}`,
		},
	});
}

async function loadSync() {
	vi.resetModules();
	return import("./sync");
}

const roster = (label: string) => ({
	devices: [
		{ id: label, publicKey: label, label, addedAt: 0, hlc: { wall: 0, counter: 0, node: label } },
	],
	revoked: [],
});
const two: VaultRegistry = addVault(
	addVault(EMPTY_REGISTRY, { id: "a", label: "", createdAt: 1 }),
	{
		id: "b",
		label: "",
		createdAt: 2,
	},
);

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("maybeStartSync (per-vault)", () => {
	it("syncs the active vault's group, not the primary's", async () => {
		// Primary "a" (flat keys) and active "b" (namespaced) each have their own group + keypair.
		stubChrome(
			{
				[VAULT_REGISTRY_KEY]: two,
				"sync.group": { groupKey: "GROUP_A", roster: roster("a") },
				"sync.deviceKeypair": { privateKey: "apriv", publicKey: "apub" },
				"sync.group:b": { groupKey: "GROUP_B", roster: roster("b") },
				"sync.deviceKeypair:b": { privateKey: "bpriv", publicKey: "bpub" },
			},
			{ [ACTIVE_VAULT_SESSION_KEY]: "b", "sync.openedVault": "b" },
		);
		const { maybeStartSync } = await loadSync();
		await maybeStartSync();

		const rosterSync = sendToOffscreen.mock.calls
			.map((c) => c[0])
			.find((m) => m.type === "SYNC_ROSTER_SYNC");
		expect(rosterSync).toBeDefined();
		expect(rosterSync?.payload?.groupKeyB64).toBe("GROUP_B");
		expect(rosterSync?.payload?.devicePrivB64).toBe("bpriv");
		expect(rosterSync?.payload?.devicePubB64).toBe("bpub");
	});

	it("does not start sync when the active vault has no group (even if the primary does)", async () => {
		stubChrome(
			{
				[VAULT_REGISTRY_KEY]: two,
				"sync.group": { groupKey: "GROUP_A", roster: roster("a") },
				"sync.deviceKeypair": { privateKey: "apriv", publicKey: "apub" },
			},
			{ [ACTIVE_VAULT_SESSION_KEY]: "b", "sync.openedVault": "b" },
		);
		const { maybeStartSync } = await loadSync();
		await maybeStartSync();

		const started = sendToOffscreen.mock.calls.some((c) => c[0].type === "SYNC_ROSTER_SYNC");
		expect(started).toBe(false);
	});

	it("does not resume a held sync start after stopSync wins", async () => {
		stubChrome(
			{
				[VAULT_REGISTRY_KEY]: two,
				"sync.group:b": { groupKey: "GROUP_B", roster: roster("b") },
				"sync.deviceKeypair:b": { privateKey: "bpriv", publicKey: "bpub" },
			},
			{ [ACTIVE_VAULT_SESSION_KEY]: "b", "sync.openedVault": "b" },
		);
		const chrome = globalThis.chrome as any;
		const originalGet = chrome.storage.local.get;
		let releaseGroup: ((value: unknown) => void) | undefined;
		chrome.storage.local.get = vi.fn((key: string) => {
			if (key === "sync.group:b") {
				return new Promise((resolve) => {
					releaseGroup = resolve;
				});
			}
			return originalGet(key);
		});
		const { maybeStartSync, stopSync } = await loadSync();
		const starting = maybeStartSync();
		await vi.waitFor(() => expect(releaseGroup).toBeTypeOf("function"));
		await stopSync();
		releaseGroup?.({ "sync.group:b": { groupKey: "GROUP_B", roster: roster("b") } });
		await starting;
		expect(sendToOffscreen.mock.calls.some((c) => c[0].type === "SYNC_ROSTER_SYNC")).toBe(false);
	});
});

/** Two vaults, each in its own sync group with its own device keypair. */
const seedTwoVaults = () => ({
	[VAULT_REGISTRY_KEY]: two,
	"sync.group:a": { groupKey: "GROUP_A", roster: roster("a") },
	"sync.deviceKeypair:a": { privateKey: "apriv", publicKey: "apub" },
	"sync.group:b": { groupKey: "GROUP_B", roster: roster("b") },
	"sync.deviceKeypair:b": { privateKey: "bpriv", publicKey: "bpub" },
});

const types = () => sendToOffscreen.mock.calls.map((c) => c[0].type);

describe("sync is pinned to one vault", () => {
	it("hands the host the vault id it starts for", async () => {
		stubChrome(seedTwoVaults(), { [ACTIVE_VAULT_SESSION_KEY]: "a", "sync.openedVault": "a" });
		const sync = await loadSync();
		await sync.maybeStartSync();
		const start = sendToOffscreen.mock.calls.find((c) => c[0].type === "SYNC_ROSTER_SYNC");
		expect(start?.[0].payload?.vaultId).toBe("a");
	});

	it("a session for a vault that isn't active does nothing", async () => {
		stubChrome(seedTwoVaults(), { [ACTIVE_VAULT_SESSION_KEY]: "b" });
		const sync = await loadSync();
		expect(await sync.syncApplyRemote("a", JSON.stringify(emptyEntriesPayload()))).toBe(false);
		expect(types()).not.toContain("CRYPTO_DECRYPT_OUTER");
		// An empty device list, not "", so the host's gate can't fall back to its start-time list.
		expect(decodeRoster(await sync.syncLocalRoster("a")).devices).toEqual([]);
	});

	it("restarts for the new vault when running for another", async () => {
		stubChrome(seedTwoVaults(), { [ACTIVE_VAULT_SESSION_KEY]: "a", "sync.openedVault": "a" });
		const sync = await loadSync();
		await sync.maybeStartSync();
		await chrome.storage.session.set({ [ACTIVE_VAULT_SESSION_KEY]: "b", "sync.openedVault": "b" });
		await sync.maybeStartSync();
		const stop = sendToOffscreen.mock.calls.find((c) => c[0].type === "SYNC_ROSTER_STOP");
		expect(stop?.[0].payload).toEqual({ keepVaultId: "b" });
		const starts = sendToOffscreen.mock.calls.filter((c) => c[0].type === "SYNC_ROSTER_SYNC");
		expect(starts.at(-1)?.[0].payload?.vaultId).toBe("b");
	});

	it("a vault switch sends a roster stop, never a full disconnect", async () => {
		stubChrome(seedTwoVaults(), { [ACTIVE_VAULT_SESSION_KEY]: "a", "sync.openedVault": "a" });
		const sync = await loadSync();
		await sync.maybeStartSync();
		sync.retargetSync("b");
		await vi.waitFor(() => expect(types()).toContain("SYNC_ROSTER_STOP"));
		expect(types()).not.toContain("SYNC_DISCONNECT");
	});

	it("runs one vault's merges one at a time", async () => {
		const blob = encodeVaultBlob({
			slots: [
				{
					kind: SLOT_KIND_PASSWORD,
					slotId: new Uint8Array(16),
					salt: new Uint8Array(16),
					verifier: new Uint8Array(32),
					wrapIv: new Uint8Array(12),
					wrappedVek: new Uint8Array(48),
				},
			],
			entriesIv: new Uint8Array(12),
			entriesCiphertext: new Uint8Array([1]),
		});
		stubChrome(
			{ ...seedTwoVaults(), "vault-blob-b64:a": btoa(String.fromCharCode(...blob)) },
			{ [ACTIVE_VAULT_SESSION_KEY]: "a" },
		);
		let releaseFirst!: () => void;
		const firstRead = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let reads = 0;
		sendToOffscreen.mockImplementation(async (m) => {
			if (m.type === "CRYPTO_DECRYPT_OUTER") {
				if (reads++ === 0) await firstRead;
				return { ok: true, data: JSON.stringify(emptyEntriesPayload()) } as never;
			}
			if (m.type === "CRYPTO_ENCRYPT_OUTER") {
				return { ok: true, data: { iv: "AAAAAAAAAAAAAAAA", ciphertext: "AA==" } } as never;
			}
			// The merge's admission check: every entry opens here.
			if (m.type === "CRYPTO_CHECK_ENTRIES") {
				return {
					ok: true,
					data: ((m.payload?.entries ?? []) as unknown[]).map(() => true),
				} as never;
			}
			return { ok: true };
		});
		const sync = await loadSync();
		const remote = JSON.stringify({
			entries: [
				{
					id: "n",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 1, counter: 0, node: "p" },
				},
			],
			tombstones: [],
		});
		const first = sync.syncApplyRemote("a", remote);
		const second = sync.syncApplyRemote("a", remote);
		await vi.waitFor(() => expect(reads).toBe(1));
		releaseFirst();
		await Promise.all([first, second]);
		const outer = types().filter((t) => t?.endsWith("_OUTER"));
		expect(outer.slice(0, 3)).toEqual([
			"CRYPTO_DECRYPT_OUTER",
			"CRYPTO_ENCRYPT_OUTER",
			"CRYPTO_DECRYPT_OUTER",
		]);
	});

	it("does not merge a peer's entry that doesn't decrypt in this vault", async () => {
		const blob = encodeVaultBlob({
			slots: [
				{
					kind: SLOT_KIND_PASSWORD,
					slotId: new Uint8Array(16),
					salt: new Uint8Array(16),
					verifier: new Uint8Array(32),
					wrapIv: new Uint8Array(12),
					wrappedVek: new Uint8Array(48),
				},
			],
			entriesIv: new Uint8Array(12),
			entriesCiphertext: new Uint8Array([1]),
		});
		stubChrome(
			{ ...seedTwoVaults(), "vault-blob-b64:a": btoa(String.fromCharCode(...blob)) },
			{ [ACTIVE_VAULT_SESSION_KEY]: "a" },
		);
		sendToOffscreen.mockImplementation(async (m) => {
			if (m.type === "CRYPTO_DECRYPT_OUTER") {
				return { ok: true, data: JSON.stringify(emptyEntriesPayload()) } as never;
			}
			if (m.type === "CRYPTO_CHECK_ENTRIES") {
				return {
					ok: true,
					data: ((m.payload?.entries ?? []) as unknown[]).map(() => false),
				} as never;
			}
			return { ok: true };
		});
		const sync = await loadSync();
		const stray = JSON.stringify({
			entries: [
				{
					id: "stray",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 1, counter: 0, node: "p" },
				},
			],
			tombstones: [],
		});
		expect(await sync.syncApplyRemote("a", stray)).toBe(false);
		expect(types()).not.toContain("CRYPTO_ENCRYPT_OUTER");
	});

	// The one cross-vault leak the merge's admission check can't stop: device lists.
	it("a stale session's roster gossip never touches either vault's device list", async () => {
		stubChrome(seedTwoVaults(), { [ACTIVE_VAULT_SESSION_KEY]: "b" });
		await loadSync();
		const { on } = await import("./router");
		const applyRoster = vi
			.mocked(on)
			.mock.calls.find(([type]) => type === "SYNC_APPLY_ROSTER")?.[1] as
			| ((message: unknown) => Promise<unknown>)
			| undefined;
		const groups = () => chrome.storage.local.get(["sync.group:a", "sync.group:b"]);
		const before = JSON.stringify(await groups());
		await applyRoster?.({
			type: "SYNC_APPLY_ROSTER",
			payload: { vaultId: "a", rosterJson: encodeRoster(roster("intruder")) },
		});
		expect(applyRoster).toBeDefined();
		expect(JSON.stringify(await groups())).toBe(before);
	});

	it("does not sync when no vault is active", async () => {
		stubChrome(seedTwoVaults(), {});
		const sync = await loadSync();
		await sync.maybeStartSync();
		expect(types()).not.toContain("SYNC_ROSTER_SYNC");
	});
});
