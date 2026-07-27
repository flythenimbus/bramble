import type { VaultRegistry } from "@core/vault/vault-registry";
import { VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #27: on mobile every crypto op runs against ONE process-global VEK, so a merge that
// resolves its target vault at write time can seal entries under vault B's key into vault A's
// file — slots and entries then disagree and NEITHER the master password nor the recovery code
// opens it. These tests pin the routing half of the fix: a session is bound to one vault id for
// its lifetime, and a merge belonging to a torn-down session must not write at all.

const h = vi.hoisted(() => ({
	meta: new Map<string, unknown>(),
	blobWrites: [] as { vaultId: string | undefined }[],
	rosterOpts: null as Record<string, (...a: never[]) => unknown> | null,
	sessionStops: 0,
	stateListener: null as ((locked: boolean) => void) | null,
	// Swapped per test to drive what a "merge" does.
	applyRemote: async (_port: unknown, _payload: unknown): Promise<void> => {},
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor/preferences", () => ({
	Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} },
}));

vi.mock("@core/index", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@core/index")>();
	return {
		...actual,
		// Pass the deps straight through so a test can reach the session's pinned store.
		createVaultSyncPort: (deps: unknown) => deps,
		applyRemotePayload: (port: unknown, payload: unknown) => h.applyRemote(port, payload),
	};
});

// The on-disk byte layout is not what's under test; routing is. Mocked at @core/vault-format
// because entries-blob.ts imports it relatively, so mocking @core/index would miss it.
vi.mock("@core/vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("@core/vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array(),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

vi.mock("@core/sync/transport/roster-sync", () => ({
	startRosterSync: async (opts: Record<string, (...a: never[]) => unknown>) => {
		h.rosterOpts = opts;
		return {
			stop: () => {
				h.sessionStops++;
			},
		};
	},
}));

vi.mock("../adapters/storage", () => ({
	mobileStorage: {
		getMeta: async (k: string) => h.meta.get(k),
		setMeta: async (k: string, v: unknown) => {
			h.meta.set(k, v);
		},
		removeMeta: async (k: string) => {
			h.meta.delete(k);
		},
		readVaultBlob: async () => new Uint8Array([9]),
		writeVaultBlob: async (_blob: Uint8Array, vaultId?: string) => {
			h.blobWrites.push({ vaultId });
		},
	},
}));

vi.mock("../adapters/crypto", () => ({
	mobileCrypto: {
		encryptWithVek: async () => ({ iv: "AAAA", ciphertext: "BBBB" }),
		decryptWithVek: async () => JSON.stringify({ entries: [], tombstones: [] }),
	},
}));

vi.mock("../adapters/vault-session", () => ({
	notifyExternalChange: () => {},
	onVaultStateChange: (cb: (locked: boolean) => void) => {
		h.stateListener = cb;
		return () => {};
	},
}));

vi.mock("../native-crypto", () => ({ nativeSyncCrypto: () => ({}) }));
// Both the Noise and the roster-signing keypair come from here; returning a stored pair keeps
// startRoster off the wasm generation path, which isn't what these tests are about.
vi.mock("../secure-storage", () => ({
	secureStorage: {
		get: async () => ({ privateKey: "p", publicKey: "P", secretKey: "s" }),
		set: async () => {},
		remove: async () => {},
	},
}));
vi.mock("../wasm-loader", () => ({ loadWasm: async () => ({}) }));

/** A schema-valid empty remote payload; decodeEntriesPayload is the real one. */
const PAYLOAD = JSON.stringify({ entries: [], tombstones: [] });

const VAULT_A = "vault-a";
const VAULT_B = "vault-b";
const registry = (...ids: string[]): VaultRegistry => ({
	vaults: ids.map((id) => ({ id, label: id, createdAt: 1 })),
});

/** Enrol `vaultId` in a group so startRoster gets past its guards. */
function enrol(vaultId: string) {
	h.meta.set(`sync.group:${vaultId}`, { groupKey: "k", roster: { entries: [] } });
}

/** The live session's callbacks, asserted present. */
function opts(): { pushRemotePayload: (json: string) => Promise<void> } {
	if (!h.rosterOpts) throw new Error("no roster session started");
	return h.rosterOpts as unknown as { pushRemotePayload: (json: string) => Promise<void> };
}

async function loadManager() {
	vi.resetModules();
	return import("./sync-manager");
}

/** Start a session for the active vault by reporting "unlocked". */
async function startSession(mod: Awaited<ReturnType<typeof loadManager>>) {
	mod.initRosterSync();
	h.stateListener?.(false);
	await vi.waitFor(() => expect(h.rosterOpts).not.toBeNull());
}

beforeEach(() => {
	h.meta.clear();
	h.blobWrites.length = 0;
	h.rosterOpts = null;
	h.sessionStops = 0;
	h.stateListener = null;
	h.applyRemote = async () => {};
	vi.stubGlobal("crypto", { randomUUID: () => "id", getRandomValues: (a: Uint8Array) => a });
});

describe("session vault binding", () => {
	it("writes a merge to the vault the session started on, even if the active vault flips mid-merge", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadManager();
		await startSession(mod);

		// The merge flips the active vault under the session's feet, then writes — the shape of the
		// original corruption. The write must still land in vault A.
		h.applyRemote = async (port) => {
			h.meta.set("active-vault", VAULT_B);
			await (
				port as { store: { writeEntriesBlob: (p: unknown) => Promise<void> } }
			).store.writeEntriesBlob({ entries: [], tombstones: [] });
		};
		await opts().pushRemotePayload(PAYLOAD);

		expect(h.blobWrites).toEqual([{ vaultId: VAULT_A }]);
	});

	it("never writes with an unresolved vault id", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadManager();
		await startSession(mod);

		h.applyRemote = async (port) => {
			await (
				port as { store: { writeEntriesBlob: (p: unknown) => Promise<void> } }
			).store.writeEntriesBlob({ entries: [], tombstones: [] });
		};
		await opts().pushRemotePayload(PAYLOAD);

		// An id-less write falls back to registry[0] in the storage adapter, which is the other
		// half of the bug; the pinned store must always pass one explicitly.
		expect(h.blobWrites.every((w) => w.vaultId !== undefined)).toBe(true);
	});
});

describe("retargetActiveVault", () => {
	it("stops the session and drops a merge queued behind the switch", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadManager();
		await startSession(mod);

		// Hold one merge open so a retarget lands while it is queued.
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let secondRan = false;
		h.applyRemote = async () => {
			await gate;
		};
		const first = opts().pushRemotePayload(PAYLOAD);

		h.applyRemote = async () => {
			secondRan = true;
		};
		const second = opts().pushRemotePayload(PAYLOAD);

		await mod.retargetActiveVault(VAULT_B);
		release();
		await Promise.all([first, second]);

		expect(h.sessionStops).toBeGreaterThan(0);
		// The queued merge belonged to the vault we left; it must be dropped, not applied.
		expect(secondRan).toBe(false);
	});

	it("is a no-op when the target is already the session's vault", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadManager();
		await startSession(mod);

		await mod.retargetActiveVault(VAULT_A);

		expect(h.sessionStops).toBe(0);
	});
});

describe("activeVaultId resolution", () => {
	it("starts no session when several vaults are registered and none is recorded active", async () => {
		// The old code guessed vaults[0] here, which pointed sync at a vault the user was not in.
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		enrol(VAULT_A);
		const mod = await loadManager();
		mod.initRosterSync();
		h.stateListener?.(false);
		await new Promise((r) => setTimeout(r, 0));

		expect(h.rosterOpts).toBeNull();
	});

	it("still falls back to the only vault (installs predating setActiveVault)", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		enrol(VAULT_A);
		const mod = await loadManager();
		await startSession(mod);

		expect(h.rosterOpts).not.toBeNull();
	});
});
