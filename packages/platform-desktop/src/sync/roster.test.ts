import type { VaultRegistry } from "@core/vault/vault-registry";
import { VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #27, ported to the desktop: every crypto op runs against ONE process-global VEK in the
// Rust shell, so a merge that resolves its target vault at write time can seal entries under
// vault B's key into vault A's file. Slots and entries then disagree and NEITHER the master
// password nor the recovery code opens it. These tests pin the routing half of the fix: a session
// is bound to one vault id for its lifetime, and a merge belonging to a torn-down session must
// not write at all.
//
// Desktop has more room for this to happen than mobile does, not less: the process outlives the
// window, so a session can still be running with no UI on screen at all.

const h = vi.hoisted(() => ({
	meta: new Map<string, unknown>(),
	blobWrites: [] as { vaultId: string | undefined }[],
	rosterOpts: null as Record<string, (...a: never[]) => unknown> | null,
	/** Every session started, in order: one per transport. */
	starts: [] as Record<string, unknown>[],
	sessionStops: 0,
	stateListener: null as ((locked: boolean) => void) | null,
	// Swapped per test to drive what a "merge" does.
	applyRemote: async (_port: unknown, _payload: unknown): Promise<void> => {},
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
		h.starts.push(opts);
		// The relay session is started first; its callbacks are the ones these tests drive. Both
		// sessions share one apply chain, so either would do.
		h.rosterOpts ??= opts;
		return {
			stop: () => {
				h.sessionStops++;
			},
		};
	},
}));

vi.mock("../adapters/storage", () => ({
	desktopStorage: {
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
	desktopCrypto: {
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

// Both keypairs come from the OS credential store over Tauri IPC, which does not exist here.
// Returning a stored pair keeps startRoster off the generation path, which isn't what's under test.
vi.mock("./keys", () => ({
	deviceKeypair: async () => ({ privateKey: "p", publicKey: "P" }),
}));
vi.mock("../sync-crypto", () => ({ desktopSyncCrypto: {} }));

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

async function loadRoster() {
	vi.resetModules();
	return import("./roster");
}

/** Start a session for the active vault by reporting "unlocked". */
async function startSession(mod: Awaited<ReturnType<typeof loadRoster>>) {
	mod.initRosterSync();
	h.stateListener?.(false);
	await vi.waitFor(() => expect(h.rosterOpts).not.toBeNull());
}

// Pay the module graph's transform + import cost once, in a hook, rather than letting it land on
// whichever test happens to call loadRoster() first: `vi.resetModules()` clears the module
// registry but not the transform cache, so that first call is far slower than its siblings and is
// charged against its own timeout. Safe to warm: the module's top level only declares state, and
// beforeEach wipes everything this touches in `h` before any test runs.
beforeAll(async () => {
	await import("./roster");
});

beforeEach(() => {
	h.meta.clear();
	h.blobWrites.length = 0;
	h.rosterOpts = null;
	h.starts.length = 0;
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
		const mod = await loadRoster();
		await startSession(mod);

		// The merge flips the active vault under the session's feet, then writes: the shape of the
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
		const mod = await loadRoster();
		await startSession(mod);

		h.applyRemote = async (port) => {
			await (
				port as { store: { writeEntriesBlob: (p: unknown) => Promise<void> } }
			).store.writeEntriesBlob({ entries: [], tombstones: [] });
		};
		await opts().pushRemotePayload(PAYLOAD);

		// An id-less write lands in the shell's DEFAULT_VAULT_ID file, which is the other half of
		// the bug; the pinned store must always pass one explicitly.
		expect(h.blobWrites.every((w) => w.vaultId !== undefined)).toBe(true);
	});
});

describe("retargetActiveVault", () => {
	it("stops the session and drops a merge queued behind the switch", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);

		// Hold one merge open so a retarget lands while the next is queued.
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
		const mod = await loadRoster();
		await startSession(mod);

		await mod.retargetActiveVault(VAULT_A);

		expect(h.sessionStops).toBe(0);
	});
});

describe("transports", () => {
	it("runs one session over the relay and one over the browser link", async () => {
		// Two sessions rather than one: a phone is only reachable through the relay, and a browser
		// on this machine is reachable without it, including with no network at all.
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);

		expect(h.starts).toHaveLength(2);
		expect(h.starts.filter((o) => o.peerSource === undefined)).toHaveLength(1);
		expect(h.starts.filter((o) => o.peerSource !== undefined)).toHaveLength(1);
	});
});

describe("activeVaultId resolution", () => {
	it("starts no session when several vaults are registered and none is recorded active", async () => {
		// Guessing vaults[0] here points sync at a vault the user is not in.
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		enrol(VAULT_A);
		const mod = await loadRoster();
		mod.initRosterSync();
		h.stateListener?.(false);
		await new Promise((r) => setTimeout(r, 0));

		expect(h.rosterOpts).toBeNull();
	});

	it("falls back to the only vault there is", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);

		expect(h.rosterOpts).not.toBeNull();
	});
});

describe("lock state", () => {
	it("stops the session on lock and starts a fresh one on the next unlock", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);

		// While locked the VEK is gone from the Rust process, so a merge could not decrypt. Both
		// transports stop: a lock is about the key, not about how peers are reached.
		h.stateListener?.(true);
		expect(h.sessionStops).toBe(2);

		h.rosterOpts = null;
		h.stateListener?.(false);
		await vi.waitFor(() => expect(h.rosterOpts).not.toBeNull());
	});
});
