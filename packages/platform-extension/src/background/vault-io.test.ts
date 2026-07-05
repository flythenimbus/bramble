import { describe, expect, it, vi } from "vitest";

// Shared, mutable mock handles so each test can steer canReadFromBackground.
const { canRead, readVaultBlob } = vi.hoisted(() => ({
	canRead: vi.fn(async () => true),
	readVaultBlob: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

// Keep the transitive graph light: readAndDecodeVault only needs the storage adapter
// and decodeVaultBlob. Stub the sync/offscreen/clock deps the other exports pull in.
vi.mock("../storage", () => ({
	PENDING_BLOB_KEY: "vault.pendingFlush",
	extensionStorage: {
		canReadFromBackground: canRead,
		readVaultBlob,
		canWriteFromBackground: async () => true,
		writeVaultBlob: async () => {},
	},
}));
vi.mock("./offscreen-client", () => ({ sendToOffscreen: vi.fn() }));
vi.mock("./sync-clock", () => ({ witnessStamp: vi.fn() }));
vi.mock("@core/sync", () => ({
	decodeEntriesPayload: vi.fn(),
	emptyEntriesPayload: vi.fn(),
	encodeEntriesPayload: vi.fn(),
}));
vi.mock("@core/vault-format", () => ({
	decodeVaultBlob: (b: Uint8Array) => ({ decoded: true, byteLength: b.length }),
}));

import { readAndDecodeVault, VaultAccessError } from "./vault-io";

describe("readAndDecodeVault: FSA background-read guard", () => {
	it("reads and decodes when the background can read the vault", async () => {
		canRead.mockResolvedValueOnce(true);
		readVaultBlob.mockClear();
		const blob = await readAndDecodeVault();
		expect(readVaultBlob).toHaveBeenCalledTimes(1);
		expect(blob).toMatchObject({ decoded: true });
	});

	it("throws VaultAccessError and never calls readVaultBlob when access is not granted", async () => {
		canRead.mockResolvedValueOnce(false);
		readVaultBlob.mockClear();
		await expect(readAndDecodeVault()).rejects.toBeInstanceOf(VaultAccessError);
		// The invariant: an ungranted FSA vault must not fall through to readVaultBlob, which
		// would requestPermission() (a gesture the background lacks) and throw the raw
		// "permission denied for vault file" that surfaced mid passkey ceremony.
		expect(readVaultBlob).not.toHaveBeenCalled();
	});
});
