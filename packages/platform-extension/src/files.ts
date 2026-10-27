// Extension file attachments: one IndexedDB store per vault (files/idb.ts), sealed and opened by
// the crypto host (files/host.ts). See docs/file-attachments.md.
//
// A picked file is parked in IndexedDB and only its key is messaged, so the host reads the bytes
// where they already are instead of receiving hundreds of base64 messages. Opening is the same in
// reverse, ending in a download: an extension has no other way to give a file to another app.

import type { FileAdapter, VaultFiles } from "@core/adapters/files";
import type { FileRecord } from "@core/sync";
import type { FileTransferStatus } from "@core/sync/transport/blob-sync";
import {
	decodeFileMeta,
	encodeFileMeta,
	type FileSealer,
	type SealedFile,
} from "@core/vault/file-mutations";
import { dispatch, FILE_OP_TIMEOUT_MS } from "./crypto";
import { deleteVaultFiles, dropHandoff, idbBlobStore, putHandoff, readHandoff } from "./files/idb";

function createExtensionSealer(vaultId: string): FileSealer {
	return {
		async seal(source, meta): Promise<SealedFile> {
			const blob =
				source.kind === "blob"
					? source.blob
					: source.kind === "bytes"
						? new Blob([source.bytes as BlobPart])
						: null;
			if (!blob) throw new Error(`the extension seals a picked file, got ${source.kind}`);
			const handoff = await putHandoff(blob);
			try {
				return await dispatch<SealedFile>(
					"CRYPTO_FILE_SEAL",
					{ handoff, metaJson: encodeFileMeta(meta) },
					vaultId,
					FILE_OP_TIMEOUT_MS,
				);
			} finally {
				await dropHandoff(handoff).catch(() => {});
			}
		},
		async resealMeta(record, meta) {
			const out = await dispatch<{ iv: string; ciphertext: string }>(
				"CRYPTO_FILE_RESEAL_META",
				{ wrappedFek: record.wrappedFek, fekIv: record.fekIv, metaJson: encodeFileMeta(meta) },
				vaultId,
			);
			return { metaBlob: out.ciphertext, metaIv: out.iv };
		},
		async describe(record) {
			return decodeFileMeta(
				await dispatch<string>(
					"CRYPTO_FILE_META",
					{
						wrappedFek: record.wrappedFek,
						fekIv: record.fekIv,
						metaBlob: record.metaBlob,
						metaIv: record.metaIv,
					},
					vaultId,
				),
			);
		},
	};
}

/** Save as a download, under the attachment's own name. */
function download(name: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}

const byVault = new Map<string, VaultFiles>();

export const extensionFiles: FileAdapter = {
	forVault(vaultId) {
		let files = byVault.get(vaultId);
		if (!files) {
			const sealer = createExtensionSealer(vaultId);
			files = {
				blobs: idbBlobStore(vaultId),
				sealer,
				// The file session runs in the crypto host; the background passes the question on.
				transferStatus: async (hashes) =>
					(await dispatch<Record<string, FileTransferStatus> | null>(
						"BLOB_STATUS",
						{ hashes },
						vaultId,
					)) ?? {},
				present: async (record: FileRecord) => {
					const meta = await sealer.describe(record);
					const handoff = await dispatch<string>(
						"CRYPTO_FILE_OPEN",
						{
							hash: record.hash,
							wrappedFek: record.wrappedFek,
							fekIv: record.fekIv,
							noncePrefix: record.noncePrefix,
						},
						vaultId,
						FILE_OP_TIMEOUT_MS,
					);
					try {
						const blob = await readHandoff(handoff);
						if (!blob) throw new Error("the opened file went missing before it could be saved");
						download(meta.name, blob);
					} finally {
						await dropHandoff(handoff).catch(() => {});
					}
				},
			};
			byVault.set(vaultId, files);
		}
		return files;
	},

	async deleteVault(vaultId) {
		byVault.delete(vaultId);
		await deleteVaultFiles(vaultId);
	},
};
