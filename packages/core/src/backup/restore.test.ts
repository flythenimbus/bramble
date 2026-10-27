import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { FileAdapter } from "../adapters/files";
import { memoryBlobStore, sha256Hex } from "../test/memory-blob-store";
import { fill, testVaultBytes } from "../test/vault-fixtures";
import {
	encodeVaultBlob,
	LEN_HMAC_SECRET_SALT,
	LEN_IV,
	LEN_SLOT_ID,
	LEN_VERIFIER,
	LEN_WRAP_IV,
	LEN_WRAPPED_VEK,
	SLOT_KIND_WEBAUTHN,
} from "../vault-format";
import { isBackupArchive, VAULT_ENTRY } from "./archive";
import { commitRestore, fileSource, readPickedBackup as readSource } from "./restore";
import { bytesSource } from "./zip";

const readPickedBackup = (bytes: Uint8Array) => readSource(bytesSource(bytes));

const stored = (bytes: Uint8Array) => [bytes, { level: 0 as const }] as [Uint8Array, { level: 0 }];

const passwordVault = () => testVaultBytes(fill(20, 7));

async function archiveWith(attachments: Uint8Array[]) {
	const vault = passwordVault();
	const files: Record<string, [Uint8Array, { level: 0 }]> = { [VAULT_ENTRY]: stored(vault) };
	const hashes: string[] = [];
	for (const a of attachments) {
		const hash = await sha256Hex(a);
		hashes.push(hash);
		files[`blobs/${hash}`] = stored(a);
	}
	return { vault, hashes, bytes: zipSync(files) };
}

describe("readPickedBackup", () => {
	it("takes a plain vault backup as it always has", async () => {
		const vault = passwordVault();
		const read = await readPickedBackup(vault);
		if (!read.ok) throw new Error(read.reason);
		expect(read.picked.vault).toEqual(vault);
		expect(read.picked.attachments).toEqual([]);
	});

	// The restored vault is the archive's INNER vault, never the archive's own bytes.
	it("takes an archive, keeping its vault and its attachments apart", async () => {
		const { vault, hashes, bytes } = await archiveWith([fill(30, 1), fill(40, 2)]);
		const read = await readPickedBackup(bytes);
		if (!read.ok) throw new Error(read.reason);
		expect(read.picked.vault).toEqual(vault);
		expect(read.picked.attachments.map((a) => a.hash).sort()).toEqual([...hashes].sort());
	});

	it("names each way a file can fail to be a restorable backup", async () => {
		expect(await readPickedBackup(new Uint8Array([1, 2, 3]))).toEqual({
			ok: false,
			reason: "not-a-backup",
		});
		expect(await readPickedBackup(zipSync({ "notes.txt": stored(fill(4, 1)) }))).toEqual({
			ok: false,
			reason: "damaged",
		});
		const keyOnly = encodeVaultBlob({
			slots: [
				{
					kind: SLOT_KIND_WEBAUTHN,
					slotId: fill(LEN_SLOT_ID, 1),
					credentialId: fill(8, 2),
					salt: fill(LEN_HMAC_SECRET_SALT, 3),
					verifier: fill(LEN_VERIFIER, 4),
					wrapIv: fill(LEN_WRAP_IV, 5),
					wrappedVek: fill(LEN_WRAPPED_VEK, 6),
				},
			],
			entriesIv: fill(LEN_IV, 6),
			entriesCiphertext: fill(20, 7),
		});
		expect(await readPickedBackup(keyOnly)).toEqual({ ok: false, reason: "no-password" });
	});

	// No size limit: a picked file is read a slice at a time, the attachments only at restore.
	it("reads a picked file in slices, never whole", async () => {
		const { vault, bytes } = await archiveWith([fill(30, 1), fill(2 * 1024 * 1024, 2)]);
		const file = new Blob([bytes as BlobPart]);
		const slice = vi.spyOn(file, "slice");
		const read = await readSource(fileSource(file));
		if (!read.ok) throw new Error(read.reason);
		expect(read.picked.vault).toEqual(vault);
		for (const call of slice.mock.calls) {
			expect((call[1] as number) - (call[0] as number)).toBeLessThan(bytes.length);
		}
	});
});

describe("commitRestore", () => {
	function deps(opts: { hasVault: boolean; files?: FileAdapter }) {
		const calls: string[] = [];
		const { store } = memoryBlobStore();
		const files: FileAdapter = opts.files ?? {
			forVault: (id) => {
				calls.push(`files:${id}`);
				return {
					blobs: {
						...store,
						receive: async (hash) => {
							calls.push("receive");
							return store.receive(hash);
						},
					},
					sealer: {} as never,
				};
			},
			deleteVault: async () => {},
		};
		return {
			calls,
			store,
			deps: {
				hasVault: opts.hasVault,
				createRecord: vi.fn(async (label?: string) => {
					calls.push(`record:${label ?? ""}`);
					return "new-id";
				}),
				writeVaultBlob: vi.fn(async (_b: Uint8Array, id: string) => {
					calls.push(`write:${id}`);
				}),
				files,
				resetSyncState: vi.fn(async () => {
					calls.push("reset");
				}),
				unlock: vi.fn(async (_pw: string, id: string) => {
					calls.push(`unlock:${id}`);
				}),
			},
		};
	}

	// The order is the point: the vault is written and its attachments stored BEFORE the unlock,
	// so the restored vault never opens with its files missing.
	it("fills the first vault: record, vault, attachments, then the unlock", async () => {
		const { bytes } = await archiveWith([fill(30, 1)]);
		const read = await readPickedBackup(bytes);
		if (!read.ok) throw new Error(read.reason);
		const h = deps({ hasVault: false });

		const outcome = await commitRestore(h.deps, read.picked, "pw");
		expect(h.calls).toEqual([
			"record:",
			"write:new-id",
			"files:new-id",
			"receive",
			"reset",
			"unlock:new-id",
		]);
		expect(outcome).toEqual({ addedNew: false, restored: 1, rejected: 0, unstorable: 0 });
	});

	it("adds a new vault, left locked, when one already exists", async () => {
		const { bytes } = await archiveWith([fill(30, 1)]);
		const read = await readPickedBackup(bytes);
		if (!read.ok) throw new Error(read.reason);
		const h = deps({ hasVault: true });

		const outcome = await commitRestore(h.deps, read.picked, "pw", "  From backup  ");
		expect(h.calls).toEqual(["record:From backup", "write:new-id", "files:new-id", "receive"]);
		expect(h.deps.unlock).not.toHaveBeenCalled();
		expect(outcome.addedNew).toBe(true);
	});

	// The vault is written from the archive's inner vault, not the archive file.
	it("writes the inner vault, byte for byte", async () => {
		const { vault, bytes } = await archiveWith([fill(30, 1)]);
		const read = await readPickedBackup(bytes);
		if (!read.ok) throw new Error(read.reason);
		const h = deps({ hasVault: true });
		await commitRestore(h.deps, read.picked, "pw");
		expect(h.deps.writeVaultBlob).toHaveBeenCalledWith(vault, "new-id");
	});

	it("counts attachments it cannot store on a platform without attachment storage", async () => {
		const { bytes } = await archiveWith([fill(30, 1), fill(40, 2)]);
		const read = await readPickedBackup(bytes);
		if (!read.ok) throw new Error(read.reason);
		const h = deps({ hasVault: true });
		const outcome = await commitRestore({ ...h.deps, files: undefined }, read.picked, "pw");
		expect(outcome).toEqual({ addedNew: true, restored: 0, rejected: 0, unstorable: 2 });
	});

	it("does nothing with attachments for a plain vault backup", async () => {
		const read = await readPickedBackup(passwordVault());
		if (!read.ok) throw new Error(read.reason);
		const h = deps({ hasVault: true });
		const outcome = await commitRestore(h.deps, read.picked, "pw");
		expect(h.calls).not.toContain("receive");
		expect(outcome).toEqual({ addedNew: true, restored: 0, rejected: 0, unstorable: 0 });
	});
});

describe("isBackupArchive", () => {
	it("is true for a Bramble archive and false for anything else", async () => {
		expect(await isBackupArchive((await archiveWith([fill(30, 1)])).bytes)).toBe(true);
		expect(await isBackupArchive(passwordVault())).toBe(false);
		// An unrelated ZIP is not mistaken for one just because of its magic bytes.
		expect(await isBackupArchive(zipSync({ "photo.jpg": stored(fill(10, 1)) }))).toBe(false);
	});
});
