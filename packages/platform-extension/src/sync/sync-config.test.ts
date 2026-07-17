import {
	addVault,
	EMPTY_REGISTRY,
	VAULT_REGISTRY_KEY,
	type VaultRegistry,
} from "@core/vault/vault-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_VAULT_SESSION_KEY } from "../session-keys";

// In-memory chrome.storage.local + .session, stubbed as the `chrome` global platform-api reads.
// `get` mirrors chrome's overloads: a string key, an array of keys, or null/undefined (all).
function stubChrome(
	localSeed: Record<string, unknown> = {},
	sessionSeed: Record<string, unknown> = {},
) {
	// Copy the seeds so a test's writes don't leak into the shared fixtures below.
	const local = { ...localSeed };
	const session = { ...sessionSeed };
	const area = (store: Record<string, unknown>) => ({
		get: async (keys?: string | string[] | null) => {
			if (keys == null) return { ...store };
			const list = Array.isArray(keys) ? keys : [keys];
			const out: Record<string, unknown> = {};
			for (const k of list) if (k in store) out[k] = store[k];
			return out;
		},
		set: async (obj: Record<string, unknown>) => Object.assign(store, obj),
		remove: async (key: string) => {
			delete store[key];
		},
	});
	vi.stubGlobal("chrome", { storage: { local: area(local), session: area(session) } });
	return { local, session };
}

// Import after the stub so platform-api binds to it; reset modules so each test's stub sticks.
async function loadConfig() {
	vi.resetModules();
	return import("./sync-config");
}

// Two vaults, both addressed by id; "a" is the first (fallback) vault.
const two: VaultRegistry = addVault(
	addVault(EMPTY_REGISTRY, { id: "a", label: "", createdAt: 1 }),
	{
		id: "b",
		label: "",
		createdAt: 2,
	},
);
const regSeed = { [VAULT_REGISTRY_KEY]: two };

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("isSyncGroupKey", () => {
	it("matches the flat and namespaced group keys, not the device keypair or relay", async () => {
		const { isSyncGroupKey } = await loadConfig();
		expect(isSyncGroupKey("sync.group")).toBe(true);
		expect(isSyncGroupKey("sync.group:abc-123")).toBe(true);
		expect(isSyncGroupKey("sync.deviceKeypair")).toBe(false);
		expect(isSyncGroupKey("sync.groupthing")).toBe(false);
		expect(isSyncGroupKey("sync.relay")).toBe(false);
	});
});

describe("resolveSyncVault", () => {
	it("targets the session-recorded active vault", async () => {
		stubChrome(regSeed, { [ACTIVE_VAULT_SESSION_KEY]: "b" });
		const { resolveSyncVault } = await loadConfig();
		expect(await resolveSyncVault()).toEqual({ vaultId: "b" });
	});

	it("falls back to the first vault when no active vault is recorded", async () => {
		stubChrome(regSeed, {});
		const { resolveSyncVault } = await loadConfig();
		expect(await resolveSyncVault()).toEqual({ vaultId: "a" });
	});

	it("returns null when no vault exists yet", async () => {
		stubChrome({ [VAULT_REGISTRY_KEY]: EMPTY_REGISTRY }, {});
		const { resolveSyncVault } = await loadConfig();
		expect(await resolveSyncVault()).toBeNull();
	});
});

describe("per-vault sync keys", () => {
	const ctxA = { vaultId: "a" };
	const ctxB = { vaultId: "b" };
	const group = { groupKey: "gk", roster: { devices: [], revoked: [] } };
	const kp = { privateKey: "priv", publicKey: "pub" };
	const sig = { secretKey: "sec", publicKey: "vpub" };

	it("stores a vault's group under its namespaced key", async () => {
		const { local } = stubChrome(regSeed);
		const { storeGroup, getStoredGroup } = await loadConfig();
		await storeGroup(group, ctxA);
		expect(local["sync.group:a"]).toEqual(group);
		expect(local["sync.group"]).toBeUndefined();
		expect(await getStoredGroup(ctxA)).toEqual(group);
	});

	it("namespaces another vault's group by id", async () => {
		const { local } = stubChrome(regSeed);
		const { storeGroup, getStoredGroup } = await loadConfig();
		await storeGroup(group, ctxB);
		expect(local["sync.group:b"]).toEqual(group);
		expect(await getStoredGroup(ctxB)).toEqual(group);
	});

	it("keeps two vaults' groups isolated (no cross-read)", async () => {
		stubChrome(regSeed);
		const { storeGroup, getStoredGroup } = await loadConfig();
		await storeGroup(group, ctxA);
		// Vault "b" has no group of its own even though vault "a" does.
		expect(await getStoredGroup(ctxB)).toBeNull();
	});

	it("namespaces the device keypair and signing key per vault", async () => {
		const { local } = stubChrome(regSeed);
		const { storeKeypair, getStoredKeypair, storeSigningKey, getStoredSigningKey } =
			await loadConfig();
		await storeKeypair(kp, ctxB);
		await storeSigningKey(sig, ctxB);
		expect(local["sync.deviceKeypair:b"]).toEqual(kp);
		expect(local["sync.signingKey:b"]).toEqual(sig);
		expect(await getStoredKeypair(ctxB)).toEqual(kp);
		expect(await getStoredSigningKey(ctxB)).toEqual(sig);
		// Vault "a" sees none of vault "b"'s keys.
		expect(await getStoredKeypair(ctxA)).toBeNull();
	});

	it("returns null for a malformed/partial stored value", async () => {
		stubChrome({ ...regSeed, "sync.group:b": { roster: { devices: [], revoked: [] } } });
		const { getStoredGroup } = await loadConfig();
		expect(await getStoredGroup(ctxB)).toBeNull(); // no groupKey
	});
});
