// Mobile file attachments: one blob store per vault on the app-private filesystem, each with
// the native sealer that writes into it. See docs/file-attachments.md.
//
// A module rather than a constant in main.tsx because the backup runner needs the same stores:
// it packs a vault's attachments into that vault's backup, and must see exactly the files the UI
// wrote, not a second instance's view of them.

import { createBlobHasher, createBlobStore, type FileAdapter, type VaultFiles } from "@core/index";
import { askBlobStatus } from "@core/sync/blob-status";
import { createMobileBlobBackend, deleteMobileVaultBlobs } from "./blob-store";
import { createMobilePresenter } from "./file-presenter";
import { createMobileFileSealer } from "./file-sealer";

const byVault = new Map<string, VaultFiles>();

export const mobileFiles: FileAdapter = {
	forVault(vaultId) {
		let files = byVault.get(vaultId);
		if (!files) {
			const blobs = createBlobStore({
				backend: createMobileBlobBackend(vaultId),
				createHasher: createBlobHasher,
			});
			const sealer = createMobileFileSealer({ blobs });
			files = {
				blobs,
				sealer,
				present: createMobilePresenter(vaultId, sealer),
				transferStatus: (hashes) => askBlobStatus(vaultId, hashes),
			};
			byVault.set(vaultId, files);
		}
		return files;
	},

	async deleteVault(vaultId) {
		byVault.delete(vaultId);
		await deleteMobileVaultBlobs(vaultId);
	},
};
