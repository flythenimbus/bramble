import { describe, expect, it, vi } from "vitest";

// Control the NativeCrypto plugin that registerPlugin() returns at import time.
const native = vi.hoisted(() => ({
	mailboxId: vi.fn(async () => ({ value: "id" })),
	mailboxSeal: vi.fn(async () => ({ value: "sealed" })),
	mailboxOpen: vi.fn(async () => ({ value: "opened" })),
}));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));

const { loadNativeCrypto } = await import("./native-crypto");

describe("native crypto: mailbox", () => {
	it("sends the mailbox calls to the native plugin by name and returns their value", async () => {
		const m = await loadNativeCrypto();
		expect(await m.mailbox_id("G")).toBe("id");
		expect(await m.mailbox_seal("G", "A", "P")).toBe("sealed");
		expect(await m.mailbox_open("G", "A", "S")).toBe("opened");
		expect(native.mailboxId).toHaveBeenCalledWith({ groupKeyB64: "G" });
		expect(native.mailboxSeal).toHaveBeenCalledWith({ groupKeyB64: "G", aad: "A", plaintext: "P" });
		expect(native.mailboxOpen).toHaveBeenCalledWith({ groupKeyB64: "G", aad: "A", sealedB64: "S" });
	});
});
