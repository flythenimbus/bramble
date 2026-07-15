import { bytesToBase64 } from "@core/util/bytes";
import { addVault, VAULT_REGISTRY_KEY, type VaultRegistry } from "@core/vault/vault-registry";
import { afterEach, describe, expect, it, vi } from "vitest";

// The IndexedDB handle glue is mocked so the migration can be tested without a real
// IndexedDB (a mock FileSystemFileHandle can't be structure-cloned into one anyway).
const { getLegacyHandle, clearLegacyHandle } = vi.hoisted(() => ({
	getLegacyHandle: vi.fn<() => Promise<unknown>>(async () => null),
	clearLegacyHandle: vi.fn(async () => {}),
}));
vi.mock("./storage-legacy", () => ({ getLegacyHandle, clearLegacyHandle }));

const VAULT_KEY = "vault-blob-b64";
const BACKUP_KEY = "vault-blob-backup-b64";

// Minimal in-memory chrome.storage.local, stubbed as the `chrome` global that platform-api reads.
function stubChrome(seed: Record<string, unknown> = {}) {
	const local: Record<string, unknown> = { ...seed };
	vi.stubGlobal("chrome", {
		storage: {
			local: {
				get: async (key: string) => (key in local ? { [key]: local[key] } : {}),
				set: async (obj: Record<string, unknown>) => Object.assign(local, obj),
				remove: async (key: string) => {
					delete local[key];
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

// Import after the mocks/globals are in place; reset the module so each test's chrome stub sticks.
async function loadStorage() {
	vi.resetModules();
	return (await import("./storage")).extensionStorage;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	getLegacyHandle.mockResolvedValue(null);
});

describe("extensionStorage.readVaultBlob", () => {
	it("returns the local blob directly and never touches the legacy handle", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const b64 = bytesToBase64(bytes);
		stubChrome({ [VAULT_KEY]: b64 });
		const storage = await loadStorage();

		expect(await storage.readVaultBlob()).toEqual(bytes);
		expect(getLegacyHandle).not.toHaveBeenCalled();
	});

	it("throws when there is no local blob and no legacy handle", async () => {
		stubChrome();
		getLegacyHandle.mockResolvedValue(null);
		const storage = await loadStorage();
		await expect(storage.readVaultBlob()).rejects.toThrow(/no vault stored/);
	});
});

describe("legacy FSA -> local migration", () => {
	it("migrates the file into local storage, drops the handle, and returns the bytes", async () => {
		const bytes = new Uint8Array([9, 8, 7, 6]);
		const local = stubChrome(); // no local vault yet
		const { handle } = fakeHandle(bytes);
		getLegacyHandle.mockResolvedValue(handle);
		const storage = await loadStorage();

		const out = await storage.readVaultBlob();

		expect(out).toEqual(bytes);
		// Copied into local storage under the vault key.
		expect(local[VAULT_KEY]).toBe(bytesToBase64(bytes));
		// Handle dropped only after the local write, and the file is only read (never written).
		expect(clearLegacyHandle).toHaveBeenCalledTimes(1);
		expect(handle.getFile).toHaveBeenCalledTimes(1);
	});

	it("requests permission when it isn't already granted", async () => {
		const bytes = new Uint8Array([5]);
		stubChrome();
		const { handle, requestPermission } = fakeHandle(bytes, "prompt");
		getLegacyHandle.mockResolvedValue(handle);
		const storage = await loadStorage();

		await storage.readVaultBlob();
		expect(requestPermission).toHaveBeenCalledOnce();
	});

	it("throws and does not write local storage when permission is denied", async () => {
		const local = stubChrome();
		const { handle, requestPermission } = fakeHandle(new Uint8Array([5]), "prompt");
		requestPermission.mockResolvedValue("denied");
		getLegacyHandle.mockResolvedValue(handle);
		const storage = await loadStorage();

		await expect(storage.readVaultBlob()).rejects.toThrow(/permission denied/);
		expect(local[VAULT_KEY]).toBeUndefined();
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
	it("snapshots the previous bytes to the backup key before overwriting", async () => {
		const prev = new Uint8Array([1, 1]);
		const local = stubChrome({ [VAULT_KEY]: bytesToBase64(prev) });
		const storage = await loadStorage();

		await storage.writeVaultBlob(new Uint8Array([2, 2]));
		expect(local[BACKUP_KEY]).toBe(bytesToBase64(prev));
		expect(local[VAULT_KEY]).toBe(bytesToBase64(new Uint8Array([2, 2])));

		expect(await storage.restoreVaultFromBackup()).toBe(true);
		expect(local[VAULT_KEY]).toBe(bytesToBase64(prev));
	});

	it("clears any stale backup on the first write (nothing to recover)", async () => {
		const local = stubChrome({ [BACKUP_KEY]: "stale" });
		const storage = await loadStorage();
		await storage.writeVaultBlob(new Uint8Array([2]));
		expect(local[BACKUP_KEY]).toBeUndefined();
		expect(await storage.restoreVaultFromBackup()).toBe(false);
	});
});

describe("multi-vault registry", () => {
	it("registers an existing single vault on first access without moving its blob", async () => {
		const bytes = new Uint8Array([7, 7, 7]);
		const local = stubChrome({ [VAULT_KEY]: bytesToBase64(bytes) });
		const storage = await loadStorage();

		expect(await storage.readVaultBlob()).toEqual(bytes);

		const reg = local[VAULT_REGISTRY_KEY] as VaultRegistry;
		expect(reg.vaults).toHaveLength(1);
		expect(reg.primaryId).toBe(reg.vaults[0]!.id);
		// The one vault keeps the legacy blob key: no bytes moved.
		expect(reg.legacyBlobVaultId).toBe(reg.vaults[0]!.id);
		expect(local[VAULT_KEY]).toBe(bytesToBase64(bytes));
	});

	it("bootstraps the first vault at the legacy key on a fresh install write", async () => {
		const local = stubChrome();
		const storage = await loadStorage();

		await storage.writeVaultBlob(new Uint8Array([1]));

		const reg = local[VAULT_REGISTRY_KEY] as VaultRegistry;
		expect(reg.vaults).toHaveLength(1);
		expect(reg.legacyBlobVaultId).toBe(reg.primaryId);
		expect(local[VAULT_KEY]).toBe(bytesToBase64(new Uint8Array([1])));
		expect(await storage.readVaultBlob()).toEqual(new Uint8Array([1]));
	});

	it("stores a second vault under a namespaced key, isolated from the primary", async () => {
		const primaryBytes = new Uint8Array([1, 1]);
		const local = stubChrome({ [VAULT_KEY]: bytesToBase64(primaryBytes) });
		const storage = await loadStorage();

		// Trigger migration so the primary vault is registered, then register a second vault.
		await storage.readVaultBlob();
		const reg = (await storage.getMeta<VaultRegistry>(VAULT_REGISTRY_KEY))!;
		const withSecond = addVault(reg, { id: "vault-b", label: "Work", createdAt: 0 });
		await storage.setMeta(VAULT_REGISTRY_KEY, withSecond);

		const secondBytes = new Uint8Array([2, 2]);
		await storage.writeVaultBlob(secondBytes, "vault-b");

		// The second vault lands at a namespaced key; the primary blob is untouched.
		expect(local[`${VAULT_KEY}:vault-b`]).toBe(bytesToBase64(secondBytes));
		expect(local[VAULT_KEY]).toBe(bytesToBase64(primaryBytes));
		// Reads route to the right vault: no id -> primary, explicit id -> that vault.
		expect(await storage.readVaultBlob()).toEqual(primaryBytes);
		expect(await storage.readVaultBlob("vault-b")).toEqual(secondBytes);
	});

	it("deleteVaultBlob removes a vault's blob without touching the primary", async () => {
		const local = stubChrome({ [VAULT_KEY]: bytesToBase64(new Uint8Array([1])) });
		const storage = await loadStorage();
		await storage.readVaultBlob(); // migrate + register the primary
		const reg = (await storage.getMeta<VaultRegistry>(VAULT_REGISTRY_KEY))!;
		await storage.setMeta(
			VAULT_REGISTRY_KEY,
			addVault(reg, { id: "vault-b", label: "", createdAt: 0 }),
		);
		await storage.writeVaultBlob(new Uint8Array([2]), "vault-b");
		expect(local[`${VAULT_KEY}:vault-b`]).toBeDefined();

		await storage.deleteVaultBlob("vault-b");
		expect(local[`${VAULT_KEY}:vault-b`]).toBeUndefined();
		expect(local[VAULT_KEY]).toBeDefined();
	});

	it("reports vault existence for a specific id and for any vault", async () => {
		stubChrome();
		const storage = await loadStorage();
		expect(await storage.hasVaultHandle()).toBe(false);

		await storage.writeVaultBlob(new Uint8Array([9]));
		const reg = (await storage.getMeta<VaultRegistry>(VAULT_REGISTRY_KEY))!;
		expect(await storage.hasVaultHandle()).toBe(true);
		expect(await storage.hasVaultHandle(reg.primaryId!)).toBe(true);
		expect(await storage.hasVaultHandle("nonexistent")).toBe(false);
	});
});
