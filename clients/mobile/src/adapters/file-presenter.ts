// Opening an attachment on mobile: decrypt it to a temporary file and hand that to the OS share
// sheet, which offers every app that can open, save or send it. See docs/file-attachments.md.
//
// The decrypted copy is plaintext, and there is no telling when the receiving app has finished
// with it: a viewer reads the file after the share sheet has already closed. So it is not
// deleted when the share resolves, but when the vault locks (and at startup, for anything a
// crash left behind). Cache rather than Data: the OS may reclaim it, and it is never the only
// copy of anything.

import { registerPlugin } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { FileRecord, FileSealer } from "@core/index";
import { armFilePickGrace } from "../auto-lock";
import { nativeFileCrypto } from "../native-crypto";
import { blobDirFor } from "./blob-store";
import { pathFromUri, uriFromPath } from "./paths";
import { onVaultStateChange } from "./vault-session";

/** Decrypted copies live here, one folder per open, and only here. */
const OPEN_DIR = "open";

/** A name safe as one path segment: the sealed name is shown to the user, so it may hold a
 * slash, which would otherwise become a folder. */
function fileNameFor(name: string): string {
	return name.replace(/[/\\]/g, "_").trim() || "attachment";
}

/** Android's system save dialog, fed a file already on disk (FileSaverPlugin.kt). */
const FileSaver = registerPlugin<{
	saveAs(o: { srcPath: string; name: string; mime: string }): Promise<{ saved: boolean }>;
}>("FileSaver");

/** Decrypt an attachment to a fresh folder under OPEN_DIR. */
async function decryptCopy(vaultId: string, sealer: FileSealer, record: FileRecord) {
	const meta = await sealer.describe(record);
	const blob = await Filesystem.getUri({
		path: `${blobDirFor(vaultId)}/${record.hash}`,
		directory: Directory.Data,
	});
	// A folder per open, so two files with one name never collide and each copy is findable.
	const folder = `${OPEN_DIR}/${globalThis.crypto.randomUUID()}`;
	await Filesystem.mkdir({ path: folder, directory: Directory.Cache, recursive: true });
	const copy = await Filesystem.getUri({
		path: `${folder}/${fileNameFor(meta.name)}`,
		directory: Directory.Cache,
	});
	const dstPath = pathFromUri(copy.uri);
	// Decrypted on the native side, chunk by chunk, straight to the copy's path: the plaintext
	// never crosses the bridge, whatever the file's size.
	await nativeFileCrypto.openFileToPath({
		wrappedFekB64: record.wrappedFek,
		fekIvB64: record.fekIv,
		noncePrefixB64: record.noncePrefix,
		srcPath: pathFromUri(blob.uri),
		dstPath,
	});
	return { meta, folder, dstPath };
}

/** Present one vault's attachment. */
export function createMobilePresenter(vaultId: string, sealer: FileSealer) {
	return async (record: FileRecord): Promise<void> => {
		const { meta, dstPath } = await decryptCopy(vaultId, sealer, record);
		// The share sheet backgrounds the app. Without the grace an "Immediately" auto-lock
		// fires, and the lock's sweep deletes the copy before the chosen app can read it.
		armFilePickGrace();
		try {
			await Share.share({
				title: meta.name,
				dialogTitle: meta.name,
				files: [uriFromPath(dstPath)],
			});
		} catch (e) {
			// Dismissing the sheet is a choice, not a failure.
			if (/cancel/i.test((e as Error).message ?? "")) return;
			throw e;
		}
	};
}

/** Save one vault's attachment where the user picks (#217). Android only: on iOS the share
 * sheet already offers Save to Files. */
export function createMobileSaver(vaultId: string, sealer: FileSealer) {
	return async (record: FileRecord): Promise<boolean> => {
		const { meta, folder, dstPath } = await decryptCopy(vaultId, sealer, record);
		// The save dialog backgrounds the app, as the share sheet does.
		armFilePickGrace();
		try {
			const { saved } = await FileSaver.saveAs({
				srcPath: dstPath,
				name: meta.name,
				mime: meta.mime,
			});
			return saved;
		} finally {
			// Unlike Open, nothing reads the copy once the save resolves.
			await Filesystem.rmdir({ path: folder, directory: Directory.Cache, recursive: true }).catch(
				() => {},
			);
		}
	};
}

/** Delete every decrypted copy. Safe to call at any time; there may be none. */
async function sweepOpenedCopies(): Promise<void> {
	try {
		await Filesystem.rmdir({ path: OPEN_DIR, directory: Directory.Cache, recursive: true });
	} catch {
		// Nothing to sweep.
	}
}

/** Sweep now, for anything a crash left behind, and again whenever the vault locks: a
 * decrypted copy must not outlive the session it was opened in. Returns an unsubscribe. */
export function startOpenedCopySweeps(): () => void {
	void sweepOpenedCopies();
	return onVaultStateChange((locked) => {
		if (locked) void sweepOpenedCopies();
	});
}
