import { beforeEach, describe, expect, it, vi } from "vitest";

const { consume, restore } = vi.hoisted(() => ({
	consume: vi.fn(),
	restore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@capacitor/core", () => ({
	registerPlugin: () => ({
		consumePendingAssociations: consume,
		restorePendingAssociations: restore,
	}),
}));

const decryptWithVek = vi.fn();
vi.mock("./adapters/crypto", () => ({ mobileCrypto: { decryptWithVek } }));

const { consumePendingAssociations } = await import("./autofill-pending-assoc");

const enc = (payload: string) => ({ iv: "iv", ciphertext: btoa(payload) });

beforeEach(() => {
	vi.clearAllMocks();
	consume.mockResolvedValue({ pending: [] });
	decryptWithVek.mockImplementation(async (_iv: string, ct: string) => {
		const s = atob(ct);
		if (s.includes("vault A")) throw new Error("aead failure");
		return s;
	});
});

// The native AutofillBridge drains under the provider's lock on both platforms (EncryptedHandoff on
// Android, the App Group on iOS); this side decrypts and hands back what it can't.
describe("consumePendingAssociations", () => {
	it("resolves [] when nothing is pending", async () => {
		await expect(consumePendingAssociations()).resolves.toEqual([]);
		expect(restore).not.toHaveBeenCalled();
	});

	it("decrypts each record, keeping its label", async () => {
		const payload = {
			entryId: "e1",
			url: "androidapp://com.example",
			label: "Example",
			vaultId: "v1",
		};
		consume.mockResolvedValue({ pending: [enc(JSON.stringify(payload))] });
		await expect(consumePendingAssociations()).resolves.toEqual([payload]);
		expect(restore).not.toHaveBeenCalled();
	});

	it("hands back the records another vault sealed", async () => {
		const foreign = enc("from vault A");
		consume.mockResolvedValue({
			pending: [
				enc(JSON.stringify({ entryId: "e1", url: "https://x.se", vaultId: "v1" })),
				foreign,
			],
		});
		await expect(consumePendingAssociations()).resolves.toEqual([
			{ entryId: "e1", url: "https://x.se", label: undefined, vaultId: "v1" },
		]);
		expect(restore).toHaveBeenCalledWith({ keep: [foreign] });
	});

	it("drops records with missing fields or unreadable contents, without handing them back", async () => {
		consume.mockResolvedValue({
			pending: [enc(JSON.stringify({ entryId: "e1" })), enc("not json")],
		});
		await expect(consumePendingAssociations()).resolves.toEqual([]);
		expect(restore).not.toHaveBeenCalled();
	});

	it("resolves [] when the bridge method is absent (old build)", async () => {
		consume.mockRejectedValue(new Error("not implemented"));
		await expect(consumePendingAssociations()).resolves.toEqual([]);
	});
});
