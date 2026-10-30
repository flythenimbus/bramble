import { VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A device in a sync group must never mint a new identity: the Keychain reports any read error as
// "absent", and a fresh key would make this device a stranger to every peer, with no way back short
// of re-pairing.

const h = vi.hoisted(() => ({
	meta: new Map<string, unknown>(),
	secure: new Map<string, unknown>(),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor/preferences", () => ({
	Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} },
}));
vi.mock("../adapters/files", () => ({ mobileFiles: { forVault: () => ({ blobs: {} }) } }));
vi.mock("../adapters/storage", () => ({
	mobileStorage: {
		getMeta: async (k: string) => h.meta.get(k),
		setMeta: async (k: string, v: unknown) => {
			h.meta.set(k, v);
		},
		removeMeta: async (k: string) => {
			h.meta.delete(k);
		},
	},
}));
vi.mock("../adapters/crypto", () => ({ mobileCrypto: {} }));
vi.mock("../adapters/vault-session", () => ({
	notifyExternalChange: () => {},
	onVaultStateChange: () => () => {},
}));
vi.mock("../native-crypto", () => ({
	nativeSyncCrypto: {
		handshake_generate_keypair: async () => ({ privateKey: "new-priv", publicKey: "NEW" }),
		roster_sig_generate_key: async () => ({ secretKey: "new-seed", publicKey: "NEWSIG" }),
	},
}));
vi.mock("../secure-storage", () => ({
	secureStorage: {
		get: async (k: string) => h.secure.get(k) ?? null,
		set: async (k: string, v: unknown) => {
			h.secure.set(k, v);
		},
		remove: async (k: string) => {
			h.secure.delete(k);
		},
	},
}));
vi.mock("../wasm-loader", () => ({ loadWasm: async () => ({}) }));

const { syncDevicePublicKey, syncSigningPublicKey } = await import("./sync-manager");

const entry = (publicKey: string, sigKey?: string) => ({
	id: `id-${publicKey}`,
	publicKey,
	label: "phone",
	addedAt: 1,
	hlc: { wall: 1, counter: 0, node: `id-${publicKey}` },
	...(sigKey ? { sigKey, sig: "s" } : {}),
});

function vaults(...ids: string[]) {
	h.meta.set(VAULT_REGISTRY_KEY, { vaults: ids.map((id) => ({ id, label: "", createdAt: 1 })) });
}

function enrol(vaultId: string, devices: ReturnType<typeof entry>[] = []) {
	h.meta.set(`sync.group:${vaultId}`, { groupKey: "k", roster: { devices, revoked: [] } });
}

beforeEach(() => {
	h.meta.clear();
	h.secure.clear();
});

describe("the Noise keypair", () => {
	it("is created for a device in no group", async () => {
		vaults("a");
		expect(await syncDevicePublicKey()).toBe("NEW");
		expect(h.secure.get("sync.deviceKeypair")).toEqual({
			privateKey: "new-priv",
			publicKey: "NEW",
		});
	});

	it("is never replaced on a device in a group", async () => {
		vaults("a");
		enrol("a", [entry("OLD")]);
		await expect(syncDevicePublicKey()).rejects.toThrow("sync key can't be read");
		expect(h.secure.has("sync.deviceKeypair")).toBe(false);
	});

	it("counts a group on any vault, since the key is shared by all of them", async () => {
		vaults("a", "b");
		enrol("b");
		await expect(syncDevicePublicKey()).rejects.toThrow("sync key can't be read");
	});

	it("still moves an old plaintext keypair across on an enrolled device", async () => {
		vaults("a");
		enrol("a", [entry("LEGACY")]);
		h.meta.set("sync.deviceKeypair", { privateKey: "legacy-priv", publicKey: "LEGACY" });
		expect(await syncDevicePublicKey()).toBe("LEGACY");
	});
});

describe("the signing keypair", () => {
	beforeEach(() => {
		h.secure.set("sync.deviceKeypair", { privateKey: "priv", publicKey: "ME" });
	});

	it("is created for a device in no group", async () => {
		vaults("a");
		expect(await syncSigningPublicKey()).toBe("NEWSIG");
	});

	it("is created for an enrolled device whose entry predates signing, so it can be backfilled", async () => {
		vaults("a");
		enrol("a", [entry("ME"), entry("PEER", "peer-sig")]);
		expect(await syncSigningPublicKey()).toBe("NEWSIG");
	});

	it("is never replaced once this device's entry is signed", async () => {
		vaults("a");
		enrol("a", [entry("ME", "my-sig")]);
		await expect(syncSigningPublicKey()).rejects.toThrow("signing key can't be read");
		expect(h.secure.has("sync.signingKey")).toBe(false);
	});
});
