import { describe, expect, it } from "vitest";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import { syncKeyFor, vaultSyncGroups } from "./sync-keys";

describe("syncKeyFor", () => {
	it("namespaces every vault's sync key by id", () => {
		expect(syncKeyFor("sync.group", "a")).toBe("sync.group:a");
		expect(syncKeyFor("sync.deviceKeypair", "a")).toBe("sync.deviceKeypair:a");
		expect(syncKeyFor("sync.deviceId", "b")).toBe("sync.deviceId:b");
	});
});

describe("vaultSyncGroups", () => {
	const group = { groupKey: "g", roster: { devices: [], revoked: [] } };
	const meta = (m: Record<string, unknown>) => async (k: string) => m[k];

	it("returns the group of every registered vault that has one", async () => {
		const registry = {
			vaults: ["a", "b", "c"].map((id) => ({ id, label: "", createdAt: 1 })),
		};
		const read = meta({ [VAULT_REGISTRY_KEY]: registry, "sync.group:b": group });
		expect(await vaultSyncGroups(read)).toEqual([group]);
	});

	it("ignores a group left behind by a vault that is no longer registered", async () => {
		const read = meta({ [VAULT_REGISTRY_KEY]: { vaults: [] }, "sync.group:gone": group });
		expect(await vaultSyncGroups(read)).toEqual([]);
	});
});
