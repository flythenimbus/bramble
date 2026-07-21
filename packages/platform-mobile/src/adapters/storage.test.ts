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
