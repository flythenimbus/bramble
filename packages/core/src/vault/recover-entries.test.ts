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
import { decryptEntriesOrRecover } from "./recover-entries";

// Issue #27 recovery. Restoring is destructive — it overwrites the live file, the user's only
// other copy — so the snapshot has to prove it opens under the key we already hold. "Restore
// whatever .bak is there" would turn a recoverable vault into a lost one.

const LIVE = new Uint8Array([1, 1, 1, 1]);
const SNAPSHOT = new Uint8Array([2, 2, 2, 2]);
const PAYLOAD = JSON.stringify(emptyEntriesPayload());

const fill = (n: number, b: number) => Uint8Array.from({ length: n }, (_, i) => (b + i) & 0xff);
const slot = (): PasswordSlot => ({
	kind: SLOT_KIND_PASSWORD,
	slotId: fill(LEN_SLOT_ID, 0x10),
	salt: fill(LEN_SALT, 0x20),
	verifier: fill(LEN_VERIFIER, 0x30),
	wrapIv: fill(LEN_WRAP_IV, 0x40),
	wrappedVek: fill(LEN_WRAPPED_VEK, 0x50),
});
const blob = (entriesCiphertext: Uint8Array): VaultBlob => ({
	slots: [slot()],
	entriesIv: fill(LEN_IV, 0x70),
	entriesCiphertext,
});

/** `opens` is the set of ciphertexts the loaded key can decrypt; anything else throws like the
 * Rust core does, so live and snapshot can disagree — which is the whole point. */
function deps(opts: { opens: Uint8Array[]; backup?: Uint8Array | null; hasBackupApi?: boolean }) {
	const crypto = {
		decryptWithVek: vi.fn(async (_iv: string, ct: string) => {
			if (!opts.opens.some((c) => bytesToBase64(c) === ct)) {
				throw new Error("aes decrypt: aead::Error");
			}
			return PAYLOAD;
		}),
	};
	const storage = {
		restoreVaultFromBackup: vi.fn(async () => true),
		...(opts.hasBackupApi === false
			? {}
			: {
					readVaultBackup: vi.fn(async () =>
						opts.backup === undefined ? encodeVaultBlob(blob(SNAPSHOT)) : opts.backup,
					),
				}),
	};
	const onRestored = vi.fn();
	return { crypto, storage, onRestored };
}

describe("decryptEntriesOrRecover", () => {
	it("returns the live payload without touching the snapshot when it decrypts", async () => {
		const d = deps({ opens: [LIVE] });

		await expect(decryptEntriesOrRecover(d, blob(LIVE))).resolves.toBe(PAYLOAD);

		expect(d.storage.readVaultBackup).not.toHaveBeenCalled();
		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("restores the snapshot once it verifies under the loaded key", async () => {
		const d = deps({ opens: [SNAPSHOT] });

		await expect(decryptEntriesOrRecover(d, blob(LIVE))).resolves.toBe(PAYLOAD);

		expect(d.storage.restoreVaultFromBackup).toHaveBeenCalledTimes(1);
		expect(d.onRestored).toHaveBeenCalledTimes(1); // never a silent swap
	});

	it("verifies BEFORE restoring, so a bad snapshot can't clobber the live file", async () => {
		const d = deps({ opens: [SNAPSHOT] });
		const order: string[] = [];
		d.crypto.decryptWithVek.mockImplementation(async (_iv: string, ct: string) => {
			order.push("decrypt");
			if (ct !== bytesToBase64(SNAPSHOT)) throw new Error("aes decrypt: aead::Error");
			return PAYLOAD;
		});
		d.storage.restoreVaultFromBackup.mockImplementation(async () => {
			order.push("restore");
			return true;
		});

		await decryptEntriesOrRecover(d, blob(LIVE));

		expect(order).toEqual(["decrypt", "decrypt", "restore"]);
	});

	it("rethrows the original error when the snapshot is equally unopenable", async () => {
		const d = deps({ opens: [] });

		await expect(decryptEntriesOrRecover(d, blob(LIVE))).rejects.toThrow(/aead::Error/);

		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("rethrows when there is no snapshot at all", async () => {
		const d = deps({ opens: [], backup: null });

		await expect(decryptEntriesOrRecover(d, blob(LIVE))).rejects.toThrow(/aead::Error/);

		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("rethrows when the snapshot bytes don't even decode", async () => {
		const d = deps({ opens: [], backup: new Uint8Array([0, 1, 2]) });

		await expect(decryptEntriesOrRecover(d, blob(LIVE))).rejects.toThrow(/aead::Error/);

		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("refuses an empty snapshot rather than silently blanking the vault", async () => {
		// An empty entries blob "opens" trivially; restoring it would present a vault with
		// nothing in it as a successful recovery.
		const d = deps({ opens: [], backup: encodeVaultBlob(blob(new Uint8Array(0))) });

		await expect(decryptEntriesOrRecover(d, blob(LIVE))).rejects.toThrow(/aead::Error/);

		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});

	it("self-disables where the platform has no snapshot store", async () => {
		const d = deps({ opens: [], hasBackupApi: false });

		await expect(decryptEntriesOrRecover(d, blob(LIVE))).rejects.toThrow(/aead::Error/);

		expect(d.storage.restoreVaultFromBackup).not.toHaveBeenCalled();
	});
});
