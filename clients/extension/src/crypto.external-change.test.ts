import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	listeners: new Set<(message: unknown) => void>(),
	sent: [] as unknown[],
	rejects: false,
}));

vi.mock("./platform-api", () => ({
	api: {
		runtime: {
			onMessage: {
				addListener: (fn: (message: unknown) => void) => h.listeners.add(fn),
				removeListener: (fn: (message: unknown) => void) => h.listeners.delete(fn),
			},
			sendMessage: async (message: unknown) => {
				h.sent.push(message);
				if (h.rejects) throw new Error("Receiving end does not exist.");
			},
		},
		storage: { session: { onChanged: { addListener: () => {}, removeListener: () => {} } } },
	},
}));

const { extensionCrypto } = await import("./crypto");

const hear = (message: unknown) => {
	for (const fn of h.listeners) fn(message);
};
const VAULT_A = extensionCrypto.withVault?.("a");

describe("windows telling each other a vault changed", () => {
	beforeEach(() => {
		h.listeners.clear();
		h.sent = [];
		h.rejects = false;
	});

	it("names the vault it saved", () => {
		VAULT_A?.notifyExternalChange?.();
		expect(h.sent).toEqual([{ type: "VAULT_CHANGED_EXTERNAL", vaultId: "a" }]);
	});

	it("doesn't mind no other window being open to hear", async () => {
		h.rejects = true;
		VAULT_A?.notifyExternalChange?.();
		await new Promise((r) => setTimeout(r, 0));
		expect(h.sent).toHaveLength(1);
	});

	it("reloads for its own vault, and for a background write, which names none", () => {
		const reload = vi.fn();
		VAULT_A?.onExternalChange(reload);
		hear({ type: "VAULT_CHANGED_EXTERNAL", vaultId: "a" });
		hear({ type: "VAULT_CHANGED_EXTERNAL" });
		expect(reload).toHaveBeenCalledTimes(2);
	});

	it("doesn't reload for another vault's save", () => {
		const reload = vi.fn();
		VAULT_A?.onExternalChange(reload);
		hear({ type: "VAULT_CHANGED_EXTERNAL", vaultId: "b" });
		hear({ type: "SOMETHING_ELSE", vaultId: "a" });
		expect(reload).not.toHaveBeenCalled();
	});

	it("reloads for any vault where it isn't bound to one", () => {
		const reload = vi.fn();
		extensionCrypto.onExternalChange(reload);
		hear({ type: "VAULT_CHANGED_EXTERNAL", vaultId: "b" });
		expect(reload).toHaveBeenCalledOnce();
	});
});
