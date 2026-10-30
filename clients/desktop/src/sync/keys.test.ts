import { VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A device in a sync group must never mint a new identity: a fresh key would make it a stranger to
// every peer, with no way back short of re-pairing.

const h = vi.hoisted(() => ({
	meta: new Map<string, unknown>(),
	secure: new Map<string, string>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (cmd: string, args: { key: string; value?: string }) => {
		if (cmd === "secure_get") return h.secure.get(args.key) ?? null;
		if (cmd === "secure_set") h.secure.set(args.key, args.value ?? "");
		if (cmd === "secure_delete") h.secure.delete(args.key);
	},
}));
vi.mock("../adapters/storage", () => ({
	desktopStorage: { getMeta: async (k: string) => h.meta.get(k) },
}));
vi.mock("../sync-crypto", () => ({
	desktopSyncCrypto: {
		handshake_generate_keypair: async () => ({ privateKey: "new-priv", publicKey: "NEW" }),
		roster_sig_generate_key: async () => ({ secretKey: "new-seed", publicKey: "NEWSIG" }),
	},
}));

const { syncDevicePublicKey, syncSigningPublicKey } = await import("./keys");

const entry = (publicKey: string, sigKey?: string) => ({
	id: `id-${publicKey}`,
	publicKey,
	label: "desktop",
	addedAt: 1,
	hlc: { wall: 1, counter: 0, node: `id-${publicKey}` },
	...(sigKey ? { sigKey, sig: "s" } : {}),
});

function enrol(devices: ReturnType<typeof entry>[] = []) {
	h.meta.set(VAULT_REGISTRY_KEY, { vaults: [{ id: "a", label: "", createdAt: 1 }] });
	h.meta.set("sync.group:a", { groupKey: "k", roster: { devices, revoked: [] } });
}

beforeEach(() => {
	h.meta.clear();
	h.secure.clear();
});

describe("the Noise keypair", () => {
	it("is created for a device in no group", async () => {
		expect(await syncDevicePublicKey()).toBe("NEW");
	});

	it("is never replaced on a device in a group", async () => {
		enrol([entry("OLD")]);
		await expect(syncDevicePublicKey()).rejects.toThrow("sync key is missing");
		expect(h.secure.has("sync.deviceKeypair")).toBe(false);
	});
});

describe("the signing keypair", () => {
	beforeEach(() => {
		h.secure.set("sync.deviceKeypair", JSON.stringify({ privateKey: "priv", publicKey: "ME" }));
	});

	it("is created for an enrolled device whose entry predates signing, so it can be backfilled", async () => {
		enrol([entry("ME")]);
		expect(await syncSigningPublicKey()).toBe("NEWSIG");
	});

	it("is never replaced once this device's entry is signed", async () => {
		enrol([entry("ME", "my-sig")]);
		await expect(syncSigningPublicKey()).rejects.toThrow("signing key is missing");
		expect(h.secure.has("sync.signingKey")).toBe(false);
	});
});
