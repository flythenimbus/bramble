import type { VaultRegistry } from "@core/vault/vault-registry";
import { VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #27: on mobile every crypto op runs against ONE process-global VEK, so a merge that
// resolves its target vault at write time can seal entries under vault B's key into vault A's
// file — slots and entries then disagree and NEITHER the master password nor the recovery code
// opens it. These tests pin the routing half of the fix: a session is bound to one vault id for
// its lifetime, and a merge belonging to a torn-down session must not write at all.

const h = vi.hoisted(() => ({
	meta: new Map<string, unknown>(),
	blobWrites: [] as { vaultId: string | undefined }[],
	rosterOpts: null as Record<string, (...a: never[]) => unknown> | null,
	rosterStarts: 0,
	sessionStops: 0,
	/** The file session's options, and what was done to it. */
	blobStarts: [] as Record<string, unknown>[],
	blobStops: 0,
	blobPokes: 0,
	stateListener: null as ((locked: boolean) => void) | null,
	// Swapped per test to drive what a "merge" does.
	applyRemote: async (_port: unknown, _payload: unknown, _opts?: unknown): Promise<void> => {},
	/** The enroll host's options, from the last invite. */
	enrollOpts: null as Record<string, (...a: never[]) => unknown> | null,
	/** What the native side answers to "is the vault locked?". */
	locked: false,
	/** The native crypto bridge, as far as an invite and an admission use it. */
	syncCrypto: {
		export_vek: async () => "vek",
		roster_admission_sign: async () => "admission-sig",
	},
}));

vi.mock("@core/sync/transport/enroll-host", () => ({
	startEnroll: async (_role: string, opts: Record<string, (...a: never[]) => unknown>) => {
		h.enrollOpts = opts;
		return { stop() {} };
	},
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
		applyRemotePayload: (port: unknown, payload: unknown, opts?: unknown) =>
			h.applyRemote(port, payload, opts),
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
		h.rosterStarts++;
		return {
			stop: () => {
				h.sessionStops++;
			},
		};
	},
}));

vi.mock("@core/sync/transport/blob-sync", () => ({
	startBlobSync: async (opts: Record<string, unknown>) => {
		h.blobStarts.push(opts);
		return {
			stop: () => {
				h.blobStops++;
			},
			poke: () => {
				h.blobPokes++;
			},
		};
	},
	wantedFromPayload: () => [],
}));

// Which store the file session is handed is the assertion, so each vault's is just its id.
vi.mock("../adapters/files", () => ({
	mobileFiles: { forVault: (vaultId: string) => ({ blobs: { vaultId } }) },
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
		isLocked: async () => h.locked,
	},
}));

vi.mock("../adapters/vault-session", () => ({
	notifyExternalChange: () => {},
	onVaultStateChange: (cb: (locked: boolean) => void) => {
		h.stateListener = cb;
		return () => {};
	},
}));

vi.mock("../native-crypto", () => ({ nativeSyncCrypto: h.syncCrypto }));
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

// Pay the module graph's transform + import cost once, in a hook, rather than letting it land on
// whichever test happens to call loadManager() first. `vi.resetModules()` clears the module
// registry but not the transform cache, so that first call was ~15x slower than its siblings
// (~900ms locally) and was charged against its own 5s timeout — which a loaded CI runner blew
// through. Safe to warm: the module's top level only declares state, and beforeEach wipes
// everything this touches in `h` before any test runs.
beforeAll(async () => {
	await import("./sync-manager");
});

beforeEach(() => {
	h.meta.clear();
	h.blobWrites.length = 0;
	h.rosterOpts = null;
	h.rosterStarts = 0;
	h.sessionStops = 0;
	h.blobStarts.length = 0;
	h.blobStops = 0;
	h.blobPokes = 0;
	h.stateListener = null;
	h.applyRemote = async () => {};
	h.enrollOpts = null;
	h.locked = false;
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

	it("checks incoming entries with the vault's crypto and remembers refusals for the session", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadManager();
		await startSession(mod);
		const seen: { crypto: unknown; rejected: unknown }[] = [];
		h.applyRemote = async (port, _payload, mergeOpts) => {
			seen.push({
				crypto: (port as { crypto?: unknown }).crypto,
				rejected: (mergeOpts as { rejected?: unknown } | undefined)?.rejected,
			});
		};
		await opts().pushRemotePayload(PAYLOAD);
		await opts().pushRemotePayload(PAYLOAD);
		expect(seen[0]?.crypto).toBeDefined();
		expect(seen[0]?.rejected).toBeInstanceOf(Set);
		expect(seen[1]?.rejected).toBe(seen[0]?.rejected);
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

describe("the relay", () => {
	it("uses the hosted one when the saved setting is blank", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		h.meta.set("sync.relay", "");
		await startSession(await loadManager());

		expect(h.rosterOpts?.relayUrl).toBe("wss://bramble-relay.flythenimbus.workers.dev");
	});
});

describe("the file session", () => {
	it("holds the session's own vault's files, over direct connections, and stops with sync", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadManager();
		await startSession(mod);
		await vi.waitFor(() => expect(h.blobStarts).toHaveLength(1));

		expect(h.blobStarts[0]?.blobs).toEqual({ vaultId: VAULT_A });
		expect(h.blobStarts[0]?.localSources).toBeUndefined();

		await mod.retargetActiveVault(VAULT_B);
		expect(h.blobStops).toBe(1);
	});

	it("looks again for attachments after every merge", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadManager();
		await startSession(mod);
		await vi.waitFor(() => expect(h.blobStarts).toHaveLength(1));

		await opts().pushRemotePayload(PAYLOAD);
		expect(h.blobPokes).toBe(1);
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

// Issue #230: what an unlock does, without having to lock first.
describe("sync now", () => {
	async function running() {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadManager();
		await startSession(mod);
		await vi.waitFor(() => expect(h.blobStarts).toHaveLength(1));
		return mod;
	}

	it("drops every session and starts a fresh set", async () => {
		const mod = await running();
		await mod.restartSync();

		expect(h.sessionStops).toBe(1);
		expect(h.blobStops).toBe(1);
		expect(h.rosterStarts).toBe(2);
		expect(h.blobStarts).toHaveLength(2);
	});

	it("touches nothing while the vault is locked", async () => {
		const mod = await running();
		h.locked = true;

		await expect(mod.restartSync()).rejects.toThrow("the vault is locked");
		expect(h.sessionStops).toBe(0);
		expect(h.rosterStarts).toBe(1);
	});

	it("restarts a start that is still under way, rather than leaving it be", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadManager();
		mod.initRosterSync();
		h.stateListener?.(false);
		await mod.restartSync();
		await new Promise((r) => setTimeout(r, 50));

		// One session replaced by one more, not two running with the first orphaned.
		expect(h.rosterStarts).toBe(2);
		expect(h.sessionStops).toBe(1);
		expect(h.blobStarts).toHaveLength(2);
		expect(h.blobStops).toBe(1);
	});
});

// Issue #230: the Settings panel usually opens long after sync started, so a replayed line must
// keep the time it was logged, not the replay's.
describe("sync status", () => {
	it("hands over each line with the time it was logged, also to a late subscriber", async () => {
		const mod = await loadManager();
		vi.useFakeTimers({ toFake: ["Date"], now: 1_000 });
		try {
			await mod.stopSync();
			vi.setSystemTime(5_000);
			const seen: [string, number][] = [];
			mod.onSyncStatus((status, at) => seen.push([status, at]));

			expect(seen).toEqual([["disconnected", 1_000]]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the first device to join", () => {
	const hlc = (node: string) => ({ wall: 1000, counter: 0, node });
	const INVITER = {
		id: "inviter-id",
		publicKey: "P",
		label: "Inviter",
		addedAt: 0,
		hlc: hlc("inviter-id"),
	};
	const JOINER = {
		id: "joiner-id",
		publicKey: "joinerPub",
		label: "Joiner",
		addedAt: 0,
		hlc: hlc("joiner-id"),
	};

	it("is rostered and syncing at once, not after the next unlock", async () => {
		// Sync starts on unlock, and only for a vault already in a group. A first pairing makes the
		// group, so without this a phone that invited its first device synced nothing until it was
		// locked and unlocked again (the desktop's version of this was e74e6e6e).
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		h.meta.set(`sync.group:${VAULT_A}`, {
			groupKey: "k",
			roster: { devices: [INVITER], revoked: [] },
		});
		const mod = await loadManager();
		mod.initRosterSync();
		await mod.startEnrollInvite({
			relayUrl: "ws://localhost:7400",
			groupKeyB64: "k",
			psk: "psk",
			roster: { devices: [INVITER], revoked: [] },
			entries: { entries: [], tombstones: [] },
			admission: { password: "pw", saltB64: "salt", adminId: "inviter-id" },
		});
		expect(h.rosterOpts).toBeNull();

		h.enrollOpts?.onEnrolled?.(JSON.stringify(JOINER) as never);

		await vi.waitFor(() => expect(h.rosterOpts).not.toBeNull());
		const group = h.meta.get(`sync.group:${VAULT_A}`) as {
			roster: { devices: { id: string; admission?: { by: string; sig: string } }[] };
		};
		const joiner = group.roster.devices.find((d) => d.id === "joiner-id");
		expect(joiner?.admission).toEqual({ by: "inviter-id", sig: "admission-sig" });
	});
});
