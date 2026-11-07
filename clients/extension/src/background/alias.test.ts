import { aliasConfiguredHintKeyFor } from "@core/aliases";
import { VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const meta = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../storage", () => ({
	extensionStorage: { getMeta: async (key: string) => meta.get(key) },
}));
vi.mock("./offscreen-client", () => ({ sendToOffscreen: vi.fn() }));
vi.mock("./session", () => ({ getActiveVaultId: vi.fn() }));
vi.mock("./vault-io", () => ({ bytesToBase64: vi.fn(), readAndDecodeVault: vi.fn() }));

const { aliasConfiguredAnywhere } = await import("./alias");

describe("whether a locked browser offers an alias unlock row", () => {
	beforeEach(() => meta.clear());

	const vaults = (...list: { id: string; hiddenAt?: number }[]) =>
		meta.set(VAULT_REGISTRY_KEY, {
			vaults: list.map((v) => ({ label: "", createdAt: 1, ...v })),
		});

	it("offers one when a listed vault has a provider", async () => {
		vaults({ id: "a" }, { id: "b" });
		meta.set(aliasConfiguredHintKeyFor("b"), true);
		expect(await aliasConfiguredAnywhere()).toBe(true);
	});

	it("does not for a provider only a hidden vault has: unlocking can't reach it", async () => {
		vaults({ id: "old", hiddenAt: 5 }, { id: "new" });
		meta.set(aliasConfiguredHintKeyFor("old"), true);
		expect(await aliasConfiguredAnywhere()).toBe(false);
	});
});
