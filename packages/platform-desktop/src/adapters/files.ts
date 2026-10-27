// Desktop file attachments: one blob store per vault on the native filesystem, driven by the
// Rust shell. See docs/file-attachments.md and src-tauri/src/files.rs.
//
// A picked file is sealed from its PATH in the shell, with the VEK that process holds, and a
// copy to open is decrypted there straight to disk: the attachment's bytes never enter this
// webview. Only backup and restore move blob bytes across, and those as raw IPC bytes, never the
// JSON number arrays the rest of this IPC uses, which would turn a 90 MB file into several
// hundred megabytes of JSON.

import {
	type BlobBackend,
	createBlobHasher,
	createBlobStore,
	decodeFileMeta,
	encodeFileMeta,
	type FileAdapter,
	type FileRecord,
	type FileSealer,
	type PickedAttachment,
	type SealedFile,
	type VaultFiles,
} from "@core/index";
import { askBlobStatus } from "@core/sync/blob-status";
import { mimeFor } from "@core/vault/mime";
import { invoke } from "@tauri-apps/api/core";
import { onVaultStateChange } from "./vault-session";

/** The shell's command results arrive as raw bytes (an ArrayBuffer), not a number array. */
export async function rawBytes(
	command: string,
	args: Record<string, unknown>,
): Promise<Uint8Array> {
	return new Uint8Array(await invoke<ArrayBuffer>(command, args));
}

function createDesktopBlobBackend(vaultId: string): BlobBackend {
	return {
		appendStaged: (hash, bytes) =>
			// Raw body, so the vault and key ride in headers.
			invoke<void>("files_append_staged", bytes, {
				headers: { "x-vault-id": vaultId, "x-key": hash },
			}),
		stagedSize: (hash) => invoke<number>("files_staged_size", { vaultId, key: hash }),
		readStaged: (hash, offset, length) =>
			rawBytes("files_read_staged", { vaultId, key: hash, offset, length }),
		publishStaged: (hash) => invoke<void>("files_publish_staged", { vaultId, hash }),
		discardStaged: (hash) => invoke<void>("files_discard_staged", { vaultId, key: hash }),
		has: (hash) => invoke<boolean>("files_has", { vaultId, hash }),
		size: (hash) => invoke<number | null>("files_size", { vaultId, hash }),
		read: (hash, offset, length) => rawBytes("files_read", { vaultId, hash, offset, length }),
		remove: (hash) => invoke<void>("files_remove", { vaultId, hash }),
		list: () => invoke<{ hash: string; size: number }[]>("files_list", { vaultId }),
	};
}

function createDesktopSealer(vaultId: string): FileSealer {
	return {
		async seal(source, meta): Promise<SealedFile> {
			// Desktop picks through the native dialog, which yields a path. A Blob would mean the
			// file's bytes had already crossed into the webview, which is what this avoids.
			if (source.kind !== "path") throw new Error(`desktop seals from a path, got ${source.kind}`);
			return invoke<SealedFile>("files_seal", {
				vaultId,
				token: globalThis.crypto.randomUUID(),
				srcPath: source.path,
				metaJson: encodeFileMeta(meta),
			});
		},
		async resealMeta(record, meta) {
			const out = await invoke<{ iv: string; ciphertext: string }>("files_reseal_meta", {
				wrappedFek: record.wrappedFek,
				fekIv: record.fekIv,
				metaJson: encodeFileMeta(meta),
			});
			return { metaBlob: out.ciphertext, metaIv: out.iv };
		},
		async describe(record) {
			return decodeFileMeta(
				await invoke<string>("files_open_meta", {
					wrappedFek: record.wrappedFek,
					fekIv: record.fekIv,
					metaBlob: record.metaBlob,
					metaIv: record.metaIv,
				}),
			);
		},
	};
}

async function pick(): Promise<PickedAttachment | null> {
	const picked = await invoke<{ path: string; name: string; size: number } | null>("files_pick");
	if (!picked) return null;
	return {
		source: { kind: "path", path: picked.path, size: picked.size },
		name: picked.name,
		mime: mimeFor(picked.name),
	};
}

const byVault = new Map<string, VaultFiles>();

export const desktopFiles: FileAdapter = {
	forVault(vaultId) {
		let files = byVault.get(vaultId);
		if (!files) {
			const sealer = createDesktopSealer(vaultId);
			files = {
				blobs: createBlobStore({
					backend: createDesktopBlobBackend(vaultId),
					createHasher: createBlobHasher,
				}),
				sealer,
				transferStatus: (hashes) => askBlobStatus(vaultId, hashes),
				// Decrypted by the shell into its cache and opened with the OS default app. The
				// copy is deleted on lock, not here: the other app reads it after this returns.
				present: async (record: FileRecord) => {
					const meta = await sealer.describe(record);
					await invoke<void>("files_open", {
						vaultId,
						hash: record.hash,
						token: globalThis.crypto.randomUUID(),
						name: meta.name,
						wrappedFek: record.wrappedFek,
						fekIv: record.fekIv,
						noncePrefix: record.noncePrefix,
					});
				},
				pick,
			};
			byVault.set(vaultId, files);
		}
		return files;
	},

	async deleteVault(vaultId) {
		byVault.delete(vaultId);
		await invoke<void>("files_delete_vault", { vaultId });
	},
};

/** Sweep decrypted copies now, and on every lock: none may outlive the session it was opened
 * in. Returns an unsubscribe. */
export function startOpenedCopySweeps(): () => void {
	const sweep = () => void invoke<void>("files_sweep_opened").catch(() => {});
	sweep();
	return onVaultStateChange((locked) => {
		if (locked) sweep();
	});
}
