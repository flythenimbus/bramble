/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { backupFingerprint, openBackup, restoreAttachments } from "../backup/archive";
import { type BackupTargetConfig, backupTargetsKeyFor } from "../backup/config";
import type { Platform } from "../context/PlatformContext";
import { memoryBlobStore, sha256Hex } from "../test/memory-blob-store";
import { fileRecord, fill, testVaultBytes } from "../test/vault-fixtures";
import { mountBackup } from "../test/vault-harness";
import { bytesToBase64 } from "../util/bytes";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

// "Back up now" packs a vault the same way the scheduler does, and records the same
// fingerprint. If it recorded the uploaded body's hash instead, the scheduler's comparison
// would never match it and every manual backup of a vault with attachments would be redone.

type Body = { size: number; read(offset: number, length: number): Promise<Uint8Array> };
const uploaded = vi.hoisted(() => [] as Body[]);
vi.mock("../backup", async (importOriginal) => ({
	...(await importOriginal<typeof import("../backup")>()),
	runBackup: vi.fn(async (_target: unknown, body: Body) => {
		uploaded.push(body);
		return { key: "k", hash: "h", uploaded: body.size, prunedKeys: [] };
	}),
}));

afterEach(() => {
	cleanup();
	uploaded.length = 0;
});

const VAULT = "11111111-2222-4333-8444-555555555555";

const TARGET: BackupTargetConfig = {
	id: "t1",
	providerId: "s3",
	provider: "s3",
	endpoint: "https://s3.example.com",
	bucket: "backups",
	frequency: "daily",
	keep: 30,
	creds: { iv: "IV", ciphertext: "CREDS" },
};

async function makePlatform() {
	const attachment = fill(90, 4);
	const hash = await sha256Hex(attachment);
	const payloadCt = fill(32, 8);
	const blob = testVaultBytes(payloadCt);
	const payload = JSON.stringify({
		entries: [],
		tombstones: [],
		files: [fileRecord({ hash, size: attachment.length })],
	});
	const { store: blobs } = memoryBlobStore();
	await blobs.put(hash, attachment);

	const store = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: VAULT, label: "", createdAt: 1 }] }],
		[backupTargetsKeyFor(VAULT), [TARGET]],
	]);
	const platform = {
		storage: {
			getMeta: vi.fn(async (k: string) => store.get(k)),
			setMeta: vi.fn(async (k: string, v: unknown) => {
				store.set(k, v);
			}),
			removeMeta: vi.fn(async (k: string) => {
				store.delete(k);
			}),
			readVaultBlob: vi.fn(async () => blob),
		},
		crypto: {
			// The vault's payload opens to its attachment list; anything else is the credential.
			decryptWithVek: vi.fn(async (_iv: string, ct: string) =>
				ct === bytesToBase64(payloadCt)
					? payload
					: JSON.stringify({ accessKeyId: "k", secretAccessKey: "s" }),
			),
			encryptWithVek: vi.fn(async () => ({ iv: "IV2", ciphertext: "CT2" })),
		},
		shell: {},
		files: { forVault: () => ({ blobs }), deleteVault: async () => {} },
	} as unknown as Platform;
	return { platform, store, blob, attachment, hash };
}

it("uploads one archive with the vault and its attachments, and records the fingerprint", async () => {
	const { platform, store, blob, attachment, hash } = await makePlatform();
	const hook = mountBackup(platform);
	await act(async () => {});

	await act(async () => {
		await hook.current?.backupNow();
	});

	const body = uploaded[0] as Body;
	const read = await openBackup(body);
	if (read.kind !== "archive") throw new Error("expected an archive");
	expect(read.vault).toEqual(blob);
	const back = memoryBlobStore().store;
	await restoreAttachments(back, body, read.attachments);
	expect(await back.read(hash)).toEqual(attachment);

	const saved = (store.get(backupTargetsKeyFor(VAULT)) as BackupTargetConfig[])[0];
	expect(saved?.lastError).toBeUndefined();
	// The scheduler's value, not the uploaded body's hash, so the two never disagree.
	expect(saved?.lastVaultHash).toBe(await backupFingerprint(blob, [hash]));
	expect(saved?.waiting).toBeUndefined();
});
