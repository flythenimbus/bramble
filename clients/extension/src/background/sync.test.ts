import type { Entry } from "@core/hooks/useVault";
import {
	decodeEntriesPayload,
	decodeRoster,
	emptyEntriesPayload,
	encodeRoster,
	type Hlc,
	nextCausal,
} from "@core/sync";
import { withPartStamps } from "@core/vault/parts";
import {
	addVault,
	EMPTY_REGISTRY,
	VAULT_REGISTRY_KEY,
	type VaultRegistry,
} from "@core/vault/vault-registry";
import { type EncryptedEntry, encodeVaultBlob, SLOT_KIND_PASSWORD } from "@core/vault-format";
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
		// The first merge reads, re-reads just before writing, and writes; only then the second reads.
		expect(outer.slice(0, 4)).toEqual([
			"CRYPTO_DECRYPT_OUTER",
			"CRYPTO_DECRYPT_OUTER",
			"CRYPTO_ENCRYPT_OUTER",
			"CRYPTO_DECRYPT_OUTER",
		]);
	});

	// A corner-prompt or passkey save writes the same blob without waiting for a merge.
	it("a background write that lands during a merge is kept", async () => {
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
		const saved = {
			id: "bg",
			wrappedDek: "w",
			dekIv: "d",
			ciphertext: "c",
			iv: "i",
			hlc: { wall: 5, counter: 0, node: "me#bg" },
		};
		let reads = 0;
		let written: string | undefined;
		sendToOffscreen.mockImplementation(async (m) => {
			if (m.type === "CRYPTO_DECRYPT_OUTER") {
				const entries = reads++ === 0 ? [] : [saved];
				return { ok: true, data: JSON.stringify({ entries, tombstones: [] }) } as never;
			}
			if (m.type === "CRYPTO_CHECK_ENTRIES") {
				return {
					ok: true,
					data: ((m.payload?.entries ?? []) as unknown[]).map(() => true),
				} as never;
			}
			if (m.type === "CRYPTO_ENCRYPT_OUTER") {
				written = m.payload?.plaintext as string;
				return { ok: true, data: { iv: "AAAAAAAAAAAAAAAA", ciphertext: "AA==" } } as never;
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
		expect(await sync.syncApplyRemote("a", remote)).toBe(true);
		expect(
			decodeEntriesPayload(written!)
				.entries.map((e) => e.id)
				.sort(),
		).toEqual(["bg", "n"]);
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

describe("combining siblings in the background (release B2)", () => {
	const at = (wall: number, node: string): Hlc => ({ wall, counter: 0, node });
	/** A sealed version whose ciphertext is its plaintext, part-stamped like a real write. */
	function version(
		data: Record<string, unknown>,
		stamp: Hlc,
		prev?: { data: Record<string, unknown>; envelope: EncryptedEntry },
	) {
		const held = prev ? [prev.envelope] : [];
		const causal = nextCausal({ hlc: stamp, bases: held, held });
		const { id: _id, ...stamped } = withPartStamps(
			{ id: "e", ...data } as Entry,
			prev && { data: prev.data as never, version: prev.envelope },
			stamp,
		);
		const envelope: EncryptedEntry = {
			id: "e",
			wrappedDek: "w",
			dekIv: "d",
			ciphertext: `ct:${JSON.stringify(stamped)}`,
			iv: "i",
			hlc: stamp,
			...causal,
		};
		return { data: stamped as Record<string, unknown>, envelope };
	}

	it("the background port combines through the offscreen crypto", async () => {
		vi.doMock("@core/sync/combine", async (importOriginal) => ({
			...(await importOriginal<typeof import("@core/sync/combine")>()),
			COMBINE_CONCURRENT_EDITS: true,
		}));
		try {
			const base = version(
				{ type: "login", name: "A", urls: [], username: "u", password: "p", notes: "n0" },
				at(10, "laptop"),
			);
			const password = version({ ...base.data, password: "px" }, at(20, "laptop"), base);
			const notes = version({ ...base.data, notes: "ny" }, at(30, "phone"), base);
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
			let written: string | undefined;
			sendToOffscreen.mockImplementation(async (m) => {
				const p = m.payload ?? {};
				switch (m.type) {
					case "CRYPTO_DECRYPT_OUTER":
						return {
							ok: true,
							data: JSON.stringify({ entries: [notes.envelope], tombstones: [] }),
						} as never;
					case "CRYPTO_CHECK_ENTRIES":
						return { ok: true, data: (p.entries as unknown[]).map(() => true) } as never;
					case "CRYPTO_DECRYPT_BATCH":
						return {
							ok: true,
							data: (p.entries as { ciphertext: string }[]).map((e) => e.ciphertext.slice(3)),
						} as never;
					case "CRYPTO_ENCRYPT":
						return {
							ok: true,
							data: { ciphertext: `ct:${p.plaintextJson}`, iv: "i", wrappedDek: "w", dekIv: "d" },
						} as never;
					case "CRYPTO_ENCRYPT_OUTER":
						written = p.plaintext as string;
						return { ok: true, data: { iv: "AAAAAAAAAAAAAAAA", ciphertext: "AA==" } } as never;
				}
				return { ok: true };
			});
			const sync = await loadSync();
			const remote = JSON.stringify({ entries: [password.envelope], tombstones: [] });
			expect(await sync.syncApplyRemote("a", remote)).toBe(true);
			const merged = decodeEntriesPayload(written!);
			expect(merged.conflicts).toBeUndefined();
			expect(merged.entries[0]!.hlc.node.startsWith("~merge:")).toBe(true);
			expect(JSON.parse(merged.entries[0]!.ciphertext.slice(3))).toMatchObject({
				password: "px",
				notes: "ny",
			});
		} finally {
			vi.doUnmock("@core/sync/combine");
		}
	});
});
