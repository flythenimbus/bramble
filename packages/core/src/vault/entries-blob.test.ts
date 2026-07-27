import { describe, expect, it, vi } from "vitest";
import { emptyEntriesPayload } from "../sync/entries-payload";
import { bytesToBase64 } from "../util/bytes";
import {
	encodeVaultBlob,
	LEN_IV,
	LEN_SALT,
	LEN_SLOT_ID,
	LEN_VERIFIER,
	LEN_WRAP_IV,
	LEN_WRAPPED_VEK,
	type PasswordSlot,
	SLOT_KIND_PASSWORD,
	type VaultBlob,
} from "../vault-format";
import { createEntriesBlobStore } from "./entries-blob";

// Issue #27: this writer married a ciphertext sealed under the loaded VEK to a slot list read
// separately, with nothing checking the two belonged together. On mobile, where one process-global
// VEK serves every vault, that could leave a file whose slots wrap key A holding entries sealed
// under key B — unopenable by the master password AND the recovery code, since both wrap A.

const fill = (n: number, b: number) => Uint8Array.from({ length: n }, (_, i) => (b + i) & 0xff);
const slot = (): PasswordSlot => ({
	kind: SLOT_KIND_PASSWORD,
	slotId: fill(LEN_SLOT_ID, 0x10),
	salt: fill(LEN_SALT, 0x20),
	verifier: fill(LEN_VERIFIER, 0x30),
	wrapIv: fill(LEN_WRAP_IV, 0x40),
	wrappedVek: fill(LEN_WRAPPED_VEK, 0x50),
});

const blobWith = (entriesCiphertext: Uint8Array): VaultBlob => ({
	slots: [slot()],
	entriesIv: fill(LEN_IV, 0x70),
	entriesCiphertext,
});

function harness(opts: { existing: Uint8Array; verify?: boolean; canDecrypt?: boolean }) {
	const calls: string[] = [];
	const blob = blobWith(opts.existing);
	const crypto = {
		encryptWithVek: vi.fn(async () => {
			calls.push("encrypt");
			return { iv: bytesToBase64(fill(LEN_IV, 0x80)), ciphertext: bytesToBase64(fill(8, 0x90)) };
		}),
		decryptWithVek: vi.fn(async () => {
			calls.push("decrypt");
			if (opts.canDecrypt === false) throw new Error("aes decrypt: aead::Error");
			return JSON.stringify(emptyEntriesPayload());
		}),
	};
	const storage = {
		writeVaultBlob: vi.fn(async (_blob: Uint8Array) => {
			calls.push("write");
		}),
	};
	const store = createEntriesBlobStore({
		crypto,
		storage,
		readDecodedBlob: async () => {
			calls.push("read");
			return { blob };
		},
		verifyVekBeforeWrite: opts.verify,
	});
	return { store, crypto, storage, calls };
}

describe("writeEntriesBlob ordering", () => {
	it("reads the existing blob before sealing, not after", async () => {
		// Sealing first took the key at one instant and the slot list at another; the write then
		// pairs two snapshots that were never checked against each other.
		const { store, calls } = harness({ existing: fill(8, 0x01) });

		await store.writeEntriesBlob(emptyEntriesPayload());

		expect(calls).toEqual(["read", "encrypt", "write"]);
	});
});

describe("verifyVekBeforeWrite", () => {
	it("aborts without writing when the loaded key can't open the existing entries", async () => {
		const { store, crypto, storage } = harness({
			existing: fill(8, 0x01),
			verify: true,
			canDecrypt: false,
		});

		await expect(store.writeEntriesBlob(emptyEntriesPayload())).rejects.toThrow(
			/doesn't match this vault's existing entries/i,
		);

		// Nothing was sealed and nothing hit the disk: the point is that a bad write never happens.
		expect(storage.writeVaultBlob).not.toHaveBeenCalled();
		expect(crypto.encryptWithVek).not.toHaveBeenCalled();
	});

	it("verifies before sealing, then writes when the key matches", async () => {
		const { store, calls } = harness({ existing: fill(8, 0x01), verify: true });

		await store.writeEntriesBlob(emptyEntriesPayload());

		expect(calls).toEqual(["read", "decrypt", "encrypt", "write"]);
	});

	it("skips the check on a fresh vault, which has no ciphertext to verify against", async () => {
		// A first write has nothing to prove the key against; step 1's id pinning covers this case.
		const { store, crypto, storage } = harness({ existing: new Uint8Array(0), verify: true });

		await store.writeEntriesBlob(emptyEntriesPayload());

		expect(crypto.decryptWithVek).not.toHaveBeenCalled();
		expect(storage.writeVaultBlob).toHaveBeenCalledTimes(1);
	});

	it("stays off by default, so writers with no key ambiguity pay nothing", async () => {
		const { store, crypto, storage } = harness({ existing: fill(8, 0x01), canDecrypt: false });

		await store.writeEntriesBlob(emptyEntriesPayload());

		expect(crypto.decryptWithVek).not.toHaveBeenCalled();
		expect(storage.writeVaultBlob).toHaveBeenCalledTimes(1);
	});
});

describe("writeEntriesBlob output", () => {
	it("preserves the slot list from the file it read", async () => {
		const { store, storage } = harness({ existing: fill(8, 0x01) });

		await store.writeEntriesBlob(emptyEntriesPayload());

		const written = storage.writeVaultBlob.mock.calls[0]?.[0];
		// Round-trips through the real encoder, so the slots must have survived intact.
		expect(written).toEqual(
			encodeVaultBlob({
				slots: [slot()],
				entriesIv: fill(LEN_IV, 0x80),
				entriesCiphertext: fill(8, 0x90),
			}),
		);
	});
});
