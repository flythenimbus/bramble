import { beforeEach, describe, expect, it, vi } from "vitest";

const { stat, readFile, writeFile, deleteFile, platform, consume, restore } = vi.hoisted(() => ({
	stat: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn().mockResolvedValue(undefined),
	deleteFile: vi.fn().mockResolvedValue(undefined),
	platform: vi.fn(),
	consume: vi.fn(),
	restore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@capacitor/core", () => ({
	Capacitor: { getPlatform: () => platform() },
	registerPlugin: () => ({
		consumePendingAssociations: consume,
		restorePendingAssociations: restore,
	}),
}));

vi.mock("@capacitor/filesystem", () => ({
	Directory: { Data: "DATA" },
	Encoding: { UTF8: "utf8" },
	Filesystem: { stat, readFile, writeFile, deleteFile },
}));

const decryptWithVek = vi.fn();
vi.mock("./adapters/crypto", () => ({ mobileCrypto: { decryptWithVek } }));

const { consumePendingAssociations } = await import("./autofill-pending-assoc");

const enc = (payload: string) => ({ iv: "iv", ciphertext: btoa(payload) });

beforeEach(() => {
	vi.clearAllMocks();
	platform.mockReturnValue("android");
	stat.mockRejectedValue(new Error("not found"));
});

describe("consumePendingAssociations (android)", () => {
	it("resolves [] when no handoff file exists", async () => {
		await expect(consumePendingAssociations()).resolves.toEqual([]);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("drains, decrypts (with label) and deletes the file", async () => {
		stat.mockResolvedValue(undefined);
		const payload = JSON.stringify({
			entryId: "e1",
			url: "androidapp://com.example",
			label: "Example",
			vaultId: "v1",
			at: 5,
		});
		readFile.mockResolvedValue({ data: JSON.stringify([enc(payload)]) });
		decryptWithVek.mockResolvedValue(payload);

		await expect(consumePendingAssociations()).resolves.toEqual([
			{ entryId: "e1", url: "androidapp://com.example", label: "Example", vaultId: "v1", at: 5 },
		]);
		expect(deleteFile).toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("re-stashes records another vault sealed, without losing new ones", async () => {
		stat.mockResolvedValue(undefined);
		const ok = enc(
			JSON.stringify({ entryId: "e2", url: "https://b.se", label: "B", vaultId: "v2", at: 6 }),
		);
		const foreign = enc("from vault A");
		readFile.mockResolvedValueOnce({ data: JSON.stringify([foreign, ok]) }).mockResolvedValueOnce({
			data: JSON.stringify([
				enc(JSON.stringify({ entryId: "new", url: "https://n.se", vaultId: "v2", at: 7 })),
			]),
		});
		writeFile.mockResolvedValue(undefined);
		decryptWithVek.mockImplementation(async (_iv: string, ct: string) => {
			const s = atob(ct);
			if (s.includes("vault A")) throw new Error("aead failure");
			return s;
		});

		await expect(consumePendingAssociations()).resolves.toEqual([
			{ entryId: "e2", url: "https://b.se", label: "B", vaultId: "v2", at: 6 },
		]);
		const wrote = JSON.parse(String(writeFile.mock.calls[0]![0]!.data));
		expect(wrote).toHaveLength(2);
		expect(wrote[0]).toEqual(foreign);
		expect(JSON.parse(atob(wrote[1].ciphertext)).entryId).toBe("new");
	});

	it("skips records with missing fields and drops a corrupt file entirely", async () => {
		stat.mockResolvedValue(undefined);
		readFile.mockResolvedValue({
			data: JSON.stringify([enc(JSON.stringify({ entryId: "e1" }))]),
		});
		decryptWithVek.mockResolvedValue(JSON.stringify({ entryId: "e1" }));
		await expect(consumePendingAssociations()).resolves.toEqual([]);

		readFile.mockRejectedValue(new Error("corrupt"));
		await expect(consumePendingAssociations()).resolves.toEqual([]);
		expect(deleteFile).toHaveBeenCalled();
	});
});

describe("consumePendingAssociations (ios)", () => {
	beforeEach(() => {
		platform.mockReturnValue("ios");
	});

	it("drains via the bridge and restores the undecryptable", async () => {
		const foreign = enc("vault A");
		consume.mockResolvedValue({
			pending: [
				enc(JSON.stringify({ entryId: "e1", url: "https://x.se", vaultId: "v1", at: 9 })),
				foreign,
			],
		});
		decryptWithVek.mockImplementation(async (_iv: string, ct: string) => {
			const s = atob(ct);
			if (s.includes("vault A")) throw new Error("aead failure");
			return s;
		});

		await expect(consumePendingAssociations()).resolves.toEqual([
			{ entryId: "e1", url: "https://x.se", label: undefined, vaultId: "v1", at: 9 },
		]);
		expect(restore).toHaveBeenCalledWith({ keep: [foreign] });
	});

	it("resolves [] when the bridge method is absent (old build)", async () => {
		consume.mockRejectedValue(new Error("not implemented"));
		await expect(consumePendingAssociations()).resolves.toEqual([]);
	});
});
