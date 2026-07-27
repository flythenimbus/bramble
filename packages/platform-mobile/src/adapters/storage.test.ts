import { bytesToBase64 } from "@core/util/bytes";
import { VAULT_REGISTRY_KEY, type VaultRegistry } from "@core/vault/vault-registry";
import { afterEach, describe, expect, it, vi } from "vitest";

// In-memory native filesystem (path -> base64 data) and Preferences (key -> string), so the
// migration can be exercised without a device. Persist across resetModules so a test can drive the
// migration then re-load (a fresh service-worker context) over the same store.
const { files, prefs } = vi.hoisted(() => ({
	files: new Map<string, string>(),
	prefs: new Map<string, string>(),
}));

vi.mock("@capacitor/filesystem", () => ({
	Directory: { Data: "DATA" },
	Filesystem: {
		stat: async ({ path }: { path: string }) => {
			if (!files.has(path)) throw new Error("not found");
			return { type: "file" };
		},
		readFile: async ({ path }: { path: string }) => ({ data: files.get(path) }),
		writeFile: async ({ path, data }: { path: string; data: string }) => {
			files.set(path, data);
		},
		deleteFile: async ({ path }: { path: string }) => {
			files.delete(path);
		},
	},
}));
vi.mock("@capacitor/preferences", () => ({
	Preferences: {
		get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
		set: async ({ key, value }: { key: string; value: string }) => {
			prefs.set(key, value);
		},
		remove: async ({ key }: { key: string }) => {
			prefs.delete(key);
		},
	},
}));

const VAULT_FILE = "vault.vlt1";
const REG_KEY = `meta:${VAULT_REGISTRY_KEY}`;
const nf = (id: string) => `vault-${id}.vlt1`; // namespaced blob file

async function loadStorage() {
	vi.resetModules();
	return (await import("./storage")).mobileStorage;
}
const reg = (): VaultRegistry => JSON.parse(prefs.get(REG_KEY)!) as VaultRegistry;
const firstId = () => reg().vaults[0]!.id;

afterEach(() => {
	files.clear();
	prefs.clear();
	vi.clearAllMocks();
});

describe("mobile one-time namespacing migration", () => {
	it("fresh install: writes an empty registry, no vault", async () => {
		const storage = await loadStorage();
		await storage.hasVaultHandle();
		expect(reg().vaults).toEqual([]);
	});

	it("copies the blob file + Preferences sync keys to `:<id>`, but leaves the secure-store device keys alone", async () => {
		const blob = bytesToBase64(new Uint8Array([7, 7, 7]));
		files.set(VAULT_FILE, blob);
		prefs.set("meta:sync.group", JSON.stringify({ groupKey: "gk" }));
		prefs.set("meta:sync.deviceId", JSON.stringify("dev-1"));
		prefs.set("meta:sync.lastSyncedAt", JSON.stringify(1_700_000_000_000));
		// A legacy plaintext keypair copy: the migration must NOT touch it (sync-manager migrates it
		// into secure storage on next read; deleting it would lose the device identity).
		prefs.set("meta:sync.deviceKeypair", JSON.stringify({ privateKey: "p", publicKey: "P" }));

		const storage = await loadStorage();
		await storage.hasVaultHandle();

		const id = firstId();
		expect(files.get(nf(id))).toBe(blob);
		expect(prefs.get(`meta:sync.group:${id}`)).toBe(JSON.stringify({ groupKey: "gk" }));
		expect(prefs.get(`meta:sync.deviceId:${id}`)).toBe(JSON.stringify("dev-1"));
		expect(prefs.get(`meta:sync.lastSyncedAt:${id}`)).toBe(JSON.stringify(1_700_000_000_000));
		// Flat blob + migrated Preferences keys removed.
		expect(files.has(VAULT_FILE)).toBe(false);
		expect(prefs.has("meta:sync.group")).toBe(false);
		expect(prefs.has("meta:sync.deviceId")).toBe(false);
		expect(prefs.has("meta:sync.lastSyncedAt")).toBe(false);
		// The device keypair is left exactly where it was - not namespaced, not deleted.
		expect(prefs.get("meta:sync.deviceKeypair")).toBe(
			JSON.stringify({ privateKey: "p", publicKey: "P" }),
		);
		expect(prefs.has(`meta:sync.deviceKeypair:${id}`)).toBe(false);
		expect("legacyBlobVaultId" in reg()).toBe(false);
		expect(bytesToBase64(await storage.readVaultBlob())).toBe(blob);
	});

	it("raw-reads a stored legacyBlobVaultId to finish an existing multi-vault install", async () => {
		const blob = bytesToBase64(new Uint8Array([4, 2]));
		files.set(VAULT_FILE, blob);
		prefs.set("meta:sync.group", JSON.stringify({ groupKey: "gk" }));
		prefs.set(
			REG_KEY,
			JSON.stringify({
				vaults: [{ id: "v", label: "Personal", createdAt: 1 }],
				legacyBlobVaultId: "v",
			}),
		);

		const storage = await loadStorage();
		await storage.hasVaultHandle();

		expect(files.get(nf("v"))).toBe(blob);
		expect(prefs.get("meta:sync.group:v")).toBe(JSON.stringify({ groupKey: "gk" }));
		expect(files.has(VAULT_FILE)).toBe(false);
		expect("legacyBlobVaultId" in reg()).toBe(false);
		expect(reg().vaults.map((v) => v.id)).toEqual(["v"]);
	});

	it("is idempotent on the already-namespaced registry", async () => {
		files.set(VAULT_FILE, bytesToBase64(new Uint8Array([1, 2])));
		prefs.set("meta:sync.group", JSON.stringify({ groupKey: "gk" }));
		let storage = await loadStorage();
		await storage.hasVaultHandle();
		const filesSnap = new Map(files);
		const prefsSnap = new Map(prefs);

		storage = await loadStorage(); // a second context re-runs over the same store
		await storage.hasVaultHandle();
		expect(files).toEqual(filesSnap);
		expect(prefs).toEqual(prefsSnap);
	});

	it("reaps a record with no blob and no sync group, keeping the ones that have either", async () => {
		files.set(nf("real"), bytesToBase64(new Uint8Array([9])));
		prefs.set("meta:sync.group:joining", JSON.stringify({ groupKey: "gk" }));
		prefs.set(
			REG_KEY,
			JSON.stringify({
				vaults: [
					{ id: "ghost", label: "", createdAt: 1 }, // orphan: no blob, never enrolled
					{ id: "real", label: "", createdAt: 2 }, // has a blob
					{ id: "joining", label: "", createdAt: 3 }, // enrolled, blob not landed yet
				],
			}),
		);

		const storage = await loadStorage();
		await storage.hasVaultHandle();

		expect(reg().vaults.map((v) => v.id)).toEqual(["real", "joining"]);
	});

	it("leaves an intact registry untouched (no needless rewrite)", async () => {
		files.set(nf("v"), bytesToBase64(new Uint8Array([1])));
		const stored = JSON.stringify({ vaults: [{ id: "v", label: "", createdAt: 0 }] });
		prefs.set(REG_KEY, stored);

		const storage = await loadStorage();
		await storage.hasVaultHandle();

		expect(prefs.get(REG_KEY)).toBe(stored);
	});

	// Minting a record from a blind write is what produced unopenable "ghost" vaults: the picker
	// offered them, but they had no blob, so they dead-ended on the first-run screen.
	it("refuses a blind blob write when no vault is registered, rather than minting one", async () => {
		const storage = await loadStorage();
		await expect(storage.writeVaultBlob(new Uint8Array([1, 2, 3]))).rejects.toThrow(/no vault id/);
		expect(reg().vaults).toEqual([]);
		expect(files.size).toBe(0);
	});

	// Issue #27: with several vaults registered, an id-less write used to resolve to vaults[0] —
	// a guess that could drop one vault's bytes onto another's file. The overwritten vault's slots
	// then wrapped a key its entries were no longer sealed under, which no password can undo.
	it("refuses a blind blob write when several vaults are registered, rather than guessing", async () => {
		// Both need a sync group, else the migration reaps them as orphans (no blob, never enrolled).
		prefs.set("meta:sync.group:a", JSON.stringify({ groupKey: "gk" }));
		prefs.set("meta:sync.group:b", JSON.stringify({ groupKey: "gk" }));
		prefs.set(
			REG_KEY,
			JSON.stringify({
				vaults: [
					{ id: "a", label: "", createdAt: 0 },
					{ id: "b", label: "", createdAt: 0 },
				],
			}),
		);
		const storage = await loadStorage();

		await expect(storage.writeVaultBlob(new Uint8Array([1, 2, 3]))).rejects.toThrow(
			/several vaults are registered/,
		);
		expect(files.size).toBe(0); // nothing written to either vault
	});

	it("still resolves a blind write when there is exactly one vault (pre-id-threading installs)", async () => {
		prefs.set("meta:sync.group:solo", JSON.stringify({ groupKey: "gk" }));
		prefs.set(REG_KEY, JSON.stringify({ vaults: [{ id: "solo", label: "", createdAt: 0 }] }));
		const storage = await loadStorage();

		await storage.writeVaultBlob(new Uint8Array([7, 7, 7]));

		expect(files.get(nf("solo"))).toBe(bytesToBase64(new Uint8Array([7, 7, 7])));
	});

	it("never clobbers a namespaced blob when the flat file is already gone (race guard)", async () => {
		const good = bytesToBase64(new Uint8Array([1, 1, 1]));
		files.set(nf("v"), good); // another context already copied + deleted the flat file
		prefs.set(
			REG_KEY,
			JSON.stringify({ vaults: [{ id: "v", label: "", createdAt: 0 }], legacyBlobVaultId: "v" }),
		);

		const storage = await loadStorage();
		await storage.hasVaultHandle();

		expect(files.get(nf("v"))).toBe(good);
		expect("legacyBlobVaultId" in reg()).toBe(false);
	});
});
