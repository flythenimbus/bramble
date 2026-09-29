import { beforeEach, describe, expect, it, vi } from "vitest";

const { stat, readFile, deleteFile, platform, bridgeConsume } = vi.hoisted(() => ({
	stat: vi.fn(),
	readFile: vi.fn(),
	deleteFile: vi.fn().mockResolvedValue(undefined),
	platform: vi.fn(),
	bridgeConsume: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
	Capacitor: { getPlatform: () => platform() },
	registerPlugin: () => ({ consumePendingAssociations: (...a: unknown[]) => bridgeConsume(...a) }),
}));

vi.mock("@capacitor/filesystem", () => ({
	Directory: { Data: "DATA" },
	Encoding: { UTF8: "utf8" },
	Filesystem: { stat, readFile, deleteFile },
}));

const decryptWithVek = vi.fn();
vi.mock("./adapters/crypto", () => ({ mobileCrypto: { decryptWithVek } }));

const { consumePendingAssociations } = await import("./autofill-pending-assoc");

const REC = (o: object) => JSON.stringify(o);
const enc = (i: number, payload: string) => ({ iv: `iv${i}`, ciphertext: btoa(payload) });

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

	it("drains, decrypts and deletes the file", async () => {
		stat.mockResolvedValue(undefined);
		const payload = JSON.stringify([
			enc(1, REC({ entryId: "e1", url: "androidapp://com.example", vaultId: "v1", at: 5 })),
		]);
		readFile.mockResolvedValue({ data: payload });
		decryptWithVek.mockResolvedValue(
			REC({ entryId: "e1", url: "androidapp://com.example", vaultId: "v1", at: 5 }),
		);

		await expect(consumePendingAssociations()).resolves.toEqual([
			{ entryId: "e1", url: "androidapp://com.example", vaultId: "v1", at: 5 },
		]);
		expect(deleteFile).toHaveBeenCalled();
	});

	it("skips records it cannot decrypt (another vault's VEK) without wedging the drain", async () => {
		stat.mockResolvedValue(undefined);
		readFile.mockResolvedValue({
			data: JSON.stringify([
				enc(1, "from vault A"),
				enc(2, REC({ entryId: "e2", url: "https://b.se", vaultId: "v2", at: 6 })),
			]),
		});
		decryptWithVek.mockImplementation(async (_iv: string, ct: string) => {
			const s = atob(ct);
			if (s.includes("vault A")) throw new Error("aead failure");
			return s;
		});

		await expect(consumePendingAssociations()).resolves.toEqual([
			{ entryId: "e2", url: "https://b.se", vaultId: "v2", at: 6 },
		]);
	});

	it("skips records with missing fields and drops a corrupt file entirely", async () => {
		stat.mockResolvedValue(undefined);
		readFile.mockResolvedValue({
			data: JSON.stringify([enc(1, REC({ entryId: "e1" }))]),
		});
		decryptWithVek.mockResolvedValue(REC({ entryId: "e1" }));
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

	it("drains via the AutofillBridge plugin and leaves no file access", async () => {
		bridgeConsume.mockResolvedValue({
			pending: [enc(1, REC({ entryId: "e1", url: "https://x.se", vaultId: "v1", at: 9 }))],
		});
		decryptWithVek.mockResolvedValue(
			REC({ entryId: "e1", url: "https://x.se", vaultId: "v1", at: 9 }),
		);

		await expect(consumePendingAssociations()).resolves.toEqual([
			{ entryId: "e1", url: "https://x.se", vaultId: "v1", at: 9 },
		]);
		expect(bridgeConsume).toHaveBeenCalledOnce();
		expect(stat).not.toHaveBeenCalled();
	});

	it("resolves [] when the bridge method is absent (old build)", async () => {
		bridgeConsume.mockRejectedValue(new Error("not implemented"));
		await expect(consumePendingAssociations()).resolves.toEqual([]);
	});
});
