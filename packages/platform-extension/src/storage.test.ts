import type { StorageAdapter } from "@core/adapters/storage";
import { bytesToBase64 } from "@core/util/bytes";
import { addVault, VAULT_REGISTRY_KEY, type VaultRegistry } from "@core/vault/vault-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
// Pure helper (no chrome access): safe to import statically alongside the dynamic loadStorage().
import { isVaultBlobKey } from "./storage";

// The IndexedDB handle glue is mocked so the migration can be tested without a real
// IndexedDB (a mock FileSystemFileHandle can't be structure-cloned into one anyway).
const { getLegacyHandle, clearLegacyHandle } = vi.hoisted(() => ({
	getLegacyHandle: vi.fn<() => Promise<unknown>>(async () => null),
	clearLegacyHandle: vi.fn(async () => {}),
}));
vi.mock("./storage-legacy", () => ({ getLegacyHandle, clearLegacyHandle }));

const VAULT_KEY = "vault-blob-b64";
const BACKUP_KEY = "vault-blob-backup-b64";
const nk = (id: string) => `${VAULT_KEY}:${id}`; // namespaced blob key

// In-memory chrome.storage.local (array- and string-keyed), stubbed as the `chrome` global that
// platform-api reads. `local` is used by reference so a test can re-stub the SAME store on reload
// (simulating a second service-worker context) via `stubChrome(local)`.
function stubChrome(local: Record<string, unknown> = {}) {
	const pick = (keys: string | string[]) => {
		const out: Record<string, unknown> = {};
		for (const k of Array.isArray(keys) ? keys : [keys]) if (k in local) out[k] = local[k];
		return out;
	};
	vi.stubGlobal("chrome", {
		storage: {
			local: {
				get: async (keys: string | string[]) => pick(keys),
				set: async (obj: Record<string, unknown>) => Object.assign(local, obj),
				remove: async (keys: string | string[]) => {
					for (const k of Array.isArray(keys) ? keys : [keys]) delete local[k];
				},
			},
		},
	});
	return local;
}

/** A fake FSA handle whose file holds `bytes`; permission starts at `perm`. */
function fakeHandle(bytes: Uint8Array, perm: PermissionState = "granted") {
	const requestPermission = vi.fn(async () => "granted" as PermissionState);
	return {
		handle: {
			queryPermission: vi.fn(async () => perm),
			requestPermission,
			getFile: vi.fn(async () => ({ arrayBuffer: async () => bytes.buffer })),
		},
		requestPermission,
	};
}

// Import after the mocks/globals are in place; reset the module so each test's chrome stub sticks
// and the migration memo is fresh (a fresh module = a fresh service-worker context).
async function loadStorage() {
	vi.resetModules();
	return (await import("./storage")).extensionStorage;
}

const reg = (local: Record<string, unknown>) => local[VAULT_REGISTRY_KEY] as VaultRegistry;
const firstId = (local: Record<string, unknown>) => reg(local).vaults[0]!.id;

/** Register vault ids the way the app does: the record is persisted before its blob is written. */
async function register(storage: { setMeta: StorageAdapter["setMeta"] }, ...ids: string[]) {
	await storage.setMeta(VAULT_REGISTRY_KEY, {
		vaults: ids.map((id, i) => ({ id, label: "", createdAt: i })),
	} satisfies VaultRegistry);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	getLegacyHandle.mockResolvedValue(null);
});

describe("extensionStorage.readVaultBlob", () => {
	it("migrates the pre-namespacing blob to its namespaced key and returns it", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const local = stubChrome({ [VAULT_KEY]: bytesToBase64(bytes) });
		const storage = await loadStorage();

		expect(await storage.readVaultBlob()).toEqual(bytes);
		expect(getLegacyHandle).not.toHaveBeenCalled();
		// Copied to `<base>:<id>` and the flat key removed.
		expect(local[nk(firstId(local))]).toBe(bytesToBase64(bytes));
		expect(local[VAULT_KEY]).toBeUndefined();
	});

	it("throws when there is no blob and no legacy handle", async () => {
		stubChrome();
		getLegacyHandle.mockResolvedValue(null);
		const storage = await loadStorage();
		await expect(storage.readVaultBlob()).rejects.toThrow(/no vault stored/);
	});
});

describe("legacy FSA -> local materialisation", () => {
	it("materialises the file at the vault's namespaced key, drops the handle, returns the bytes", async () => {
		const bytes = new Uint8Array([9, 8, 7, 6]);
		const local = stubChrome(); // no local vault yet
		const { handle } = fakeHandle(bytes);
		getLegacyHandle.mockResolvedValue(handle);
		const storage = await loadStorage();

		const out = await storage.readVaultBlob();

		expect(out).toEqual(bytes);
		// Written under the vault's namespaced key (never the flat key), handle dropped after.
		expect(local[nk(firstId(local))]).toBe(bytesToBase64(bytes));
		expect(local[VAULT_KEY]).toBeUndefined();
		expect(clearLegacyHandle).toHaveBeenCalledTimes(1);
		expect(handle.getFile).toHaveBeenCalledTimes(1);
	});

	it("requests permission when it isn't already granted", async () => {
		stubChrome();
		const { handle, requestPermission } = fakeHandle(new Uint8Array([5]), "prompt");
		getLegacyHandle.mockResolvedValue(handle);
		const storage = await loadStorage();

		await storage.readVaultBlob();
		expect(requestPermission).toHaveBeenCalledOnce();
	});

	it("throws and writes nothing when permission is denied", async () => {
		const local = stubChrome();
		const { handle, requestPermission } = fakeHandle(new Uint8Array([5]), "prompt");
		requestPermission.mockResolvedValue("denied");
		getLegacyHandle.mockResolvedValue(handle);
		const storage = await loadStorage();

		await expect(storage.readVaultBlob()).rejects.toThrow(/permission denied/);
		expect(local[nk(firstId(local))]).toBeUndefined();
		expect(clearLegacyHandle).not.toHaveBeenCalled();
	});

	it("hasVaultHandle is true when only a legacy handle exists", async () => {
		stubChrome();
		getLegacyHandle.mockResolvedValue(fakeHandle(new Uint8Array([1])).handle);
		const storage = await loadStorage();
		expect(await storage.hasVaultHandle()).toBe(true);
	});
});

describe("extensionStorage.writeVaultBlob + restore", () => {
	it("snapshots the previous bytes to the namespaced backup key before overwriting", async () => {
		const prev = new Uint8Array([1, 1]);
		const local = stubChrome({ [VAULT_KEY]: bytesToBase64(prev) });
		const storage = await loadStorage();
		await storage.readVaultBlob(); // migrate the pre-namespacing vault
		const id = firstId(local);

		await storage.writeVaultBlob(new Uint8Array([2, 2]));
		expect(local[`${BACKUP_KEY}:${id}`]).toBe(bytesToBase64(prev));
		expect(local[nk(id)]).toBe(bytesToBase64(new Uint8Array([2, 2])));

		expect(await storage.restoreVaultFromBackup()).toBe(true);
		expect(local[nk(id)]).toBe(bytesToBase64(prev));
	});

	it("clears any stale backup on the first write (nothing to recover)", async () => {
		const local = stubChrome();
		const storage = await loadStorage();
		await register(storage, "v1");
		await storage.writeVaultBlob(new Uint8Array([2]), "v1");
		expect(local[`${BACKUP_KEY}:v1`]).toBeUndefined();
		expect(await storage.restoreVaultFromBackup()).toBe(false);
	});

	// Minting a record from a blind write is what produced unopenable "ghost" vaults: the picker
	// offered them, but they had no blob, so they dead-ended on the first-run screen.
	it("refuses a blind write when no vault is registered, rather than minting one", async () => {
		const local = stubChrome();
		const storage = await loadStorage();
		await expect(storage.writeVaultBlob(new Uint8Array([1]))).rejects.toThrow(/no vault id/);
		expect(reg(local).vaults).toEqual([]);
		expect(Object.keys(local).some((k) => k.startsWith(`${VAULT_KEY}:`))).toBe(false);
	});
});

describe("one-time namespacing migration", () => {
	it("fresh install: writes an empty registry, no vault", async () => {
		const local = stubChrome();
		const storage = await loadStorage();
		await storage.hasVaultHandle();
		expect(reg(local).vaults).toEqual([]);
	});

	it("copies a pre-namespacing vault's blob AND sync keys to `:<id>`, then deletes the flat keys", async () => {
		const blob = bytesToBase64(new Uint8Array([7, 7, 7]));
		const group = { groupKey: "gk", roster: { devices: [], revoked: [] } };
		const keypair = { privateKey: "priv", publicKey: "pub" };
		const signingKey = { secretKey: "sec", publicKey: "vpub" };
		const local = stubChrome({
			[VAULT_KEY]: blob,
			"sync.group": group,
			"sync.deviceKeypair": keypair,
			"sync.signingKey": signingKey,
			"sync.deviceId": "dev-1",
			"sync.lastSyncedAt": 1_700_000_000_000,
		});
		const storage = await loadStorage();
		await storage.hasVaultHandle(); // trigger the migration

		const id = firstId(local);
		expect(reg(local).vaults).toHaveLength(1);
		// Blob + every sync key copied byte-for-byte (preserved values => the device stays paired).
		expect(local[nk(id)]).toBe(blob);
		expect(local[`sync.group:${id}`]).toEqual(group);
		expect(local[`sync.deviceKeypair:${id}`]).toEqual(keypair);
		expect(local[`sync.signingKey:${id}`]).toEqual(signingKey);
		expect(local[`sync.deviceId:${id}`]).toBe("dev-1");
		expect(local[`sync.lastSyncedAt:${id}`]).toBe(1_700_000_000_000);
		// Flat keys deleted; the retired pointer is not written.
		expect(local[VAULT_KEY]).toBeUndefined();
		expect(local["sync.group"]).toBeUndefined();
		expect(local["sync.deviceKeypair"]).toBeUndefined();
		expect(local["sync.signingKey"]).toBeUndefined();
		expect(local["sync.lastSyncedAt"]).toBeUndefined();
		expect("legacyBlobVaultId" in reg(local)).toBe(false);
	});

	it("raw-reads a stored legacyBlobVaultId to finish namespacing an existing multi-vault install", async () => {
		const blob = bytesToBase64(new Uint8Array([4, 2]));
		const group = { groupKey: "gk" };
		const local = stubChrome({
			// A registry from the grandfather era: names the flat vault via legacyBlobVaultId.
			[VAULT_REGISTRY_KEY]: {
				vaults: [{ id: "vault-legacy", label: "Personal", createdAt: 1 }],
				legacyBlobVaultId: "vault-legacy",
			},
			[VAULT_KEY]: blob,
			"sync.group": group,
		});
		const storage = await loadStorage();
		await storage.hasVaultHandle();

		expect(local[nk("vault-legacy")]).toBe(blob);
		expect(local[`sync.group:vault-legacy`]).toEqual(group);
		expect(local[VAULT_KEY]).toBeUndefined();
		expect(local["sync.group"]).toBeUndefined();
		expect("legacyBlobVaultId" in reg(local)).toBe(false);
		expect(reg(local).vaults.map((v) => v.id)).toEqual(["vault-legacy"]);
	});

	it("is idempotent: re-running on the already-namespaced registry changes nothing", async () => {
		const blob = bytesToBase64(new Uint8Array([1, 2]));
		const local = stubChrome({ [VAULT_KEY]: blob, "sync.group": { groupKey: "gk" } });
		let storage = await loadStorage();
		await storage.hasVaultHandle();
		const snapshot = structuredClone(local);

		// A second service-worker context re-runs the migration over the same store.
		stubChrome(local);
		storage = await loadStorage();
		await storage.hasVaultHandle();
		expect(local).toEqual(snapshot);
	});

	it("crash before cutover (blob copied, registry still points flat): re-run completes cleanly", async () => {
		const blob = bytesToBase64(new Uint8Array([5, 5]));
		const local = stubChrome({
			[VAULT_REGISTRY_KEY]: {
				vaults: [{ id: "v", label: "", createdAt: 0 }],
				legacyBlobVaultId: "v",
			},
			[VAULT_KEY]: blob, // flat still present (delete never ran)
			[nk("v")]: blob, // namespaced already copied (copy ran)
			"sync.group": { groupKey: "gk" },
		});
		const storage = await loadStorage();
		await storage.hasVaultHandle();

		expect(local[nk("v")]).toBe(blob);
		expect(local[`sync.group:v`]).toEqual({ groupKey: "gk" });
		expect(local[VAULT_KEY]).toBeUndefined();
		expect("legacyBlobVaultId" in reg(local)).toBe(false);
	});

	// Two UI documents (popup + options/pop-out) can each run the no-registry migration with their
	// own memo. The gated stub freezes context B on a chosen storage read while context A migrates
	// to completion, pinning the convergence guard: B must adopt A's published registry, never
	// clobber it (with EMPTY or with its own differently-id'd registry).
	function stubChromeGated(local: Record<string, unknown>, gateKey: string, gateCall: number) {
		const counts = new Map<string, number>();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let onReached!: () => void;
		const reached = new Promise<void>((r) => (onReached = r));
		const pick = (keys: string | string[]) => {
			const out: Record<string, unknown> = {};
			for (const k of Array.isArray(keys) ? keys : [keys]) if (k in local) out[k] = local[k];
			return out;
		};
		vi.stubGlobal("chrome", {
			storage: {
				local: {
					get: async (keys: string | string[]) => {
						const label = Array.isArray(keys) ? keys.join() : keys;
						const n = (counts.get(label) ?? 0) + 1;
						counts.set(label, n);
						if (label === gateKey && n === gateCall) {
							onReached();
							await gate;
						}
						return pick(keys);
					},
					set: async (obj: Record<string, unknown>) => Object.assign(local, obj),
					remove: async (keys: string | string[]) => {
						for (const k of Array.isArray(keys) ? keys : [keys]) delete local[k];
					},
				},
			},
		});
		return { release, reached };
	}

	it("no-registry race: a loser that finds the flat data already migrated adopts the winner's registry", async () => {
		const blob = bytesToBase64(new Uint8Array([3, 3]));
		const local: Record<string, unknown> = { [VAULT_KEY]: blob, "sync.group": { groupKey: "gk" } };
		// Context B saw "no registry", then freezes on its flat-blob read.
		const { release, reached } = stubChromeGated(local, VAULT_KEY, 1);
		const contextB = await loadStorage();
		const bRun = contextB.hasVaultHandle();
		await reached;

		// Context A runs the whole migration while B is frozen.
		const contextA = await loadStorage();
		await contextA.hasVaultHandle();
		const winnerId = firstId(local);
		expect(local[nk(winnerId)]).toBe(blob);

		release();
		await bRun;

		// B resumed into "no flat blob, no FSA" but must NOT write EMPTY over A's registry.
		expect(reg(local).vaults.map((v) => v.id)).toEqual([winnerId]);
		expect(local[nk(winnerId)]).toBe(blob);
		expect(local[`sync.group:${winnerId}`]).toEqual({ groupKey: "gk" });
	});

	it("no-registry race: a loser that already copied under its own id drops those copies", async () => {
		const blob = bytesToBase64(new Uint8Array([4, 4]));
		const local: Record<string, unknown> = { [VAULT_KEY]: blob, "sync.group": { groupKey: "gk" } };
		// Context B copies under its own uuid, then freezes on the pre-cutover registry re-check
		// (its 2nd registry read: the 1st returned "no registry").
		const { release, reached } = stubChromeGated(local, VAULT_REGISTRY_KEY, 2);
		const contextB = await loadStorage();
		const bRun = contextB.hasVaultHandle();
		await reached;
		const loserId = Object.keys(local)
			.find((k) => k.startsWith(`${VAULT_KEY}:`))!
			.slice(VAULT_KEY.length + 1);

		const contextA = await loadStorage();
		await contextA.hasVaultHandle();
		const winnerId = firstId(local);
		expect(winnerId).not.toBe(loserId);

		release();
		await bRun;

		// One vault, the winner's; the loser's unpublished copies are cleaned up, not orphaned.
		expect(reg(local).vaults.map((v) => v.id)).toEqual([winnerId]);
		expect(local[nk(winnerId)]).toBe(blob);
		expect(local[`sync.group:${winnerId}`]).toEqual({ groupKey: "gk" });
		expect(local[nk(loserId)]).toBeUndefined();
		expect(local[`sync.group:${loserId}`]).toBeUndefined();
	});

	it("never clobbers a namespaced blob with null when the flat data is already gone (race guard)", async () => {
		const good = bytesToBase64(new Uint8Array([1, 1, 1]));
		const local = stubChrome({
			// Another context already migrated + deleted the flat blob, but this context still sees the
			// old pointer (its registry read raced ahead of the cutover).
			[VAULT_REGISTRY_KEY]: {
				vaults: [{ id: "v", label: "", createdAt: 0 }],
				legacyBlobVaultId: "v",
			},
			[nk("v")]: good, // the good namespaced blob the other context wrote
			// no flat VAULT_KEY
		});
		const storage = await loadStorage();
		await storage.hasVaultHandle();

		// The namespaced blob is untouched (not overwritten with an empty flat value).
		expect(local[nk("v")]).toBe(good);
		expect("legacyBlobVaultId" in reg(local)).toBe(false);
	});
});

describe("multi-vault registry", () => {
	it("stores the first vault at its namespaced key, never the un-suffixed one", async () => {
		const local = stubChrome();
		const storage = await loadStorage();
		await register(storage, "v1");

		await storage.writeVaultBlob(new Uint8Array([1]), "v1");

		expect(reg(local).vaults).toHaveLength(1);
		expect(local[nk("v1")]).toBe(bytesToBase64(new Uint8Array([1])));
		expect(local[VAULT_KEY]).toBeUndefined();
		expect(await storage.readVaultBlob()).toEqual(new Uint8Array([1]));
	});

	it("stores a second vault under its own namespaced key, isolated from the first", async () => {
		const firstBytes = new Uint8Array([1, 1]);
		const local = stubChrome({ [VAULT_KEY]: bytesToBase64(firstBytes) });
		const storage = await loadStorage();

		await storage.readVaultBlob(); // migrate + register the first vault (namespaced)
		const id1 = firstId(local);
		const withSecond = addVault(reg(local), { id: "vault-b", label: "Work", createdAt: 0 });
		await storage.setMeta(VAULT_REGISTRY_KEY, withSecond);

		const secondBytes = new Uint8Array([2, 2]);
		await storage.writeVaultBlob(secondBytes, "vault-b");

		expect(local[nk("vault-b")]).toBe(bytesToBase64(secondBytes));
		expect(local[nk(id1)]).toBe(bytesToBase64(firstBytes));
		// Reads route to the right vault: no id -> the first vault, explicit id -> that vault.
		expect(await storage.readVaultBlob()).toEqual(firstBytes);
		expect(await storage.readVaultBlob("vault-b")).toEqual(secondBytes);
	});

	it("deleteVaultBlob removes a vault's blob without touching the first", async () => {
		const local = stubChrome({ [VAULT_KEY]: bytesToBase64(new Uint8Array([1])) });
		const storage = await loadStorage();
		await storage.readVaultBlob();
		const id1 = firstId(local);
		await storage.setMeta(
			VAULT_REGISTRY_KEY,
			addVault(reg(local), { id: "vault-b", label: "", createdAt: 0 }),
		);
		await storage.writeVaultBlob(new Uint8Array([2]), "vault-b");
		expect(local[nk("vault-b")]).toBeDefined();

		await storage.deleteVaultBlob("vault-b");
		expect(local[nk("vault-b")]).toBeUndefined();
		expect(local[nk(id1)]).toBeDefined();
	});

	it("reports vault existence for a specific id and for any vault", async () => {
		stubChrome();
		const storage = await loadStorage();
		expect(await storage.hasVaultHandle()).toBe(false);

		await register(storage, "v1");
		await storage.writeVaultBlob(new Uint8Array([9]), "v1");
		expect(await storage.hasVaultHandle()).toBe(true);
		expect(await storage.hasVaultHandle("v1")).toBe(true);
		expect(await storage.hasVaultHandle("nonexistent")).toBe(false);
	});
});

// A record with nothing behind it is an orphan from a create/join that registered the vault but
// never wrote it: offered by the picker, dead-ends on the first-run screen, undeletable from the UI.
describe("ghost-record reaping", () => {
	it("drops a record with no blob, no snapshot and no sync group, keeping the rest", async () => {
		const local = stubChrome({
			[VAULT_REGISTRY_KEY]: {
				vaults: [
					{ id: "ghost", label: "", createdAt: 1 },
					{ id: "real", label: "", createdAt: 2 },
					{ id: "joining", label: "", createdAt: 3 },
					{ id: "crashed", label: "", createdAt: 4 },
				],
			},
			[nk("real")]: bytesToBase64(new Uint8Array([1])),
			"sync.group:joining": { groupKey: "gk" }, // enrolled, blob not landed yet
			[`${BACKUP_KEY}:crashed`]: bytesToBase64(new Uint8Array([2])), // recoverable via restore
		});
		const storage = await loadStorage();
		await storage.hasVaultHandle();

		expect(reg(local).vaults.map((v) => v.id)).toEqual(["real", "joining", "crashed"]);
	});

	it("leaves an intact registry alone", async () => {
		const local = stubChrome({
			[VAULT_REGISTRY_KEY]: { vaults: [{ id: "v", label: "", createdAt: 0 }] },
			[nk("v")]: bytesToBase64(new Uint8Array([1])),
		});
		const storage = await loadStorage();
		await storage.hasVaultHandle();

		expect(reg(local).vaults.map((v) => v.id)).toEqual(["v"]);
	});

	// A file-backed vault's record legitimately has no blob until the first unlock materialises it.
	it("reaps nothing while a legacy FSA handle exists", async () => {
		const local = stubChrome({
			[VAULT_REGISTRY_KEY]: { vaults: [{ id: "fsa", label: "", createdAt: 0 }] },
		});
		getLegacyHandle.mockResolvedValue(fakeHandle(new Uint8Array([5])).handle);
		const storage = await loadStorage();
		await storage.hasVaultHandle();

		expect(reg(local).vaults.map((v) => v.id)).toEqual(["fsa"]);
	});
});

describe("isVaultBlobKey", () => {
	it("matches the un-suffixed key (transient during migration) and any namespaced vault blob key", () => {
		expect(isVaultBlobKey("vault-blob-b64")).toBe(true);
		expect(isVaultBlobKey("vault-blob-b64:abc-123")).toBe(true);
	});

	it("does not match the backup key or unrelated keys", () => {
		expect(isVaultBlobKey("vault-blob-backup-b64")).toBe(false);
		expect(isVaultBlobKey("vault-blob-backup-b64:abc")).toBe(false);
		expect(isVaultBlobKey("sync.group")).toBe(false);
		expect(isVaultBlobKey("vault.registry")).toBe(false);
	});
});
