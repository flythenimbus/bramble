import type { FileRecord } from "../sync/entries-payload";
import type { FileTransferStatus } from "../sync/transport/blob-sync";
import type { BlobStore } from "../vault/blob-store";
import type { FileSealer, FileSource } from "../vault/file-mutations";

/** One vault's attachments: the store holding its sealed files, and the sealer that fills it. */
export interface VaultFiles {
	blobs: BlobStore;
	sealer: FileSealer;
	/**
	 * Decrypt one attachment and hand it to the OS to open, share or save. Absent where the
	 * platform has no way to give a file to another app, and the UI then offers no Open.
	 *
	 * The decrypted copy is plaintext on disk for as long as the receiving app needs it, which
	 * Bramble cannot know, so a platform deletes it when the vault locks rather than at once.
	 */
	present?(record: FileRecord): Promise<void>;
	/**
	 * Pick a file with the platform's own dialog, where it can hand back something better than
	 * the Blob an `<input type=file>` yields: on desktop, a path the native side seals from
	 * directly, so the file's bytes never cross into the webview. Null when the user cancels.
	 * Absent where `<input type=file>` is the only picker.
	 */
	pick?(): Promise<PickedAttachment | null>;
	/**
	 * Why each of these files, which this device lacks, hasn't arrived, from the running file
	 * session. A file it holds, or has no word on, is left out. Absent where there is no session to
	 * ask, and the row then says only that the file is not here yet.
	 */
	transferStatus?(hashes: string[]): Promise<Record<string, FileTransferStatus>>;
}

/** A file chosen through `VaultFiles.pick`, ready to attach. */
export interface PickedAttachment {
	source: FileSource;
	name: string;
	mime: string;
}

/**
 * File attachments. Optional on `Platform`: where it is absent the feature is off and the UI
 * hides attachments, since a platform with no blob store has nowhere to put the bytes.
 *
 * Scoped per vault, like `CryptoAdapter.withVault`, and for a reason that is not cosmetic. A
 * store shared by every vault cannot tell which files are whose, so a sweep driven by one
 * vault's manifest would delete every other vault's attachments, and a backup of one vault could
 * not know which files to pack. See CONTEXT.md (vault scoping) and docs/file-attachments.md.
 */
export interface FileAdapter {
	forVault(vaultId: string): VaultFiles;
	/** Erase every attachment file a vault holds, for when the vault itself is deleted. */
	deleteVault(vaultId: string): Promise<void>;
}
