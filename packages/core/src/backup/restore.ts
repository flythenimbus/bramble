// Restoring a backup file: the decisions the Restore screen makes, kept here so they can be
// tested without rendering it. See docs/cloud-storage-backups.md (Restore).
//
// Reason codes only, no messages: this is a .ts file, which the Lingui macro transform does not
// cover, so the screen maps each code to translated copy.

import type { FileAdapter } from "../adapters/files";
import { decodeVaultBlob, findPasswordSlot, type PasswordSlot } from "../vault-format";
import {
	type ArchivedAttachment,
	BackupArchiveError,
	openBackup,
	restoreAttachments,
} from "./archive";
import type { RandomAccessSource } from "./zip";

/** A picked backup file, checked and ready to restore once its password is verified. */
export interface PickedBackup {
	/** The vault's own VLT1 bytes: the whole file for a plain backup, the inner vault of an
	 * archive. This, not the file, is what gets written as the restored vault. */
	vault: Uint8Array;
	slot: PasswordSlot;
	/** Where the file is, for reading its attachments at restore time rather than now. */
	source: RandomAccessSource;
	/** An archive's attachments, located but not read. Empty for a plain backup. */
	attachments: ArchivedAttachment[];
}

export type PickFailure = "not-a-backup" | "damaged" | "no-password";

/** A picked file as a random-access source: read a slice at a time, never whole. */
export function fileSource(file: Blob): RandomAccessSource {
	return {
		size: file.size,
		read: async (offset, length) =>
			new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
	};
}

/**
 * Read a picked backup file: a plain vault, or an archive of a vault and its attachments. Of
 * any size: only the vault and the archive's directory are read now.
 */
export async function readPickedBackup(
	source: RandomAccessSource,
): Promise<{ ok: true; picked: PickedBackup } | { ok: false; reason: PickFailure }> {
	let vault: Uint8Array;
	let attachments: ArchivedAttachment[] = [];
	try {
		const file = await openBackup(source);
		vault = file.vault;
		if (file.kind === "archive") attachments = file.attachments;
	} catch (e) {
		return { ok: false, reason: e instanceof BackupArchiveError ? "damaged" : "not-a-backup" };
	}
	let slot: PasswordSlot | null;
	try {
		slot = findPasswordSlot(decodeVaultBlob(vault));
	} catch {
		return { ok: false, reason: "not-a-backup" };
	}
	if (!slot) return { ok: false, reason: "no-password" };
	return { ok: true, picked: { vault, slot, source, attachments } };
}

export interface RestoreDeps {
	/** Whether a vault already exists here. If so the backup becomes a NEW vault, left locked,
	 * and nothing existing is touched; if not, it fills the first vault and is unlocked. */
	hasVault: boolean;
	createRecord(label?: string): Promise<string>;
	writeVaultBlob(bytes: Uint8Array, vaultId: string): Promise<void>;
	/** Absent where the platform cannot store attachments. */
	files?: FileAdapter;
	resetSyncState?(): Promise<void>;
	unlock(password: string, vaultId: string): Promise<void>;
}

export interface RestoreOutcome {
	addedNew: boolean;
	/** Attachments written into the restored vault. */
	restored: number;
	/** Attachments whose bytes did not match their name, and so were not written. */
	rejected: number;
	/** Attachments this platform has nowhere to put. The vault still lists them. */
	unstorable: number;
}

/**
 * Restore a picked backup whose password has ALREADY been verified. The order is the point:
 * the record and the vault first, then its attachments into that vault's own store, and only
 * then the unlock, so the first thing the restored vault sees is a complete set of files.
 *
 * Attachments need no vault key: each is checked against its own name as it is stored. That
 * matters on mobile, where the one loaded key is not this vault's until the unlock at the end.
 */
export async function commitRestore(
	deps: RestoreDeps,
	picked: PickedBackup,
	password: string,
	label = "",
): Promise<RestoreOutcome> {
	const newId = deps.hasVault ? await deps.createRecord(label.trim()) : await deps.createRecord();
	await deps.writeVaultBlob(picked.vault, newId);

	let restored = 0;
	let rejected = 0;
	let unstorable = 0;
	if (picked.attachments.length > 0) {
		if (deps.files) {
			({ restored, rejected } = await restoreAttachments(
				deps.files.forVault(newId).blobs,
				picked.source,
				picked.attachments,
			));
		} else {
			unstorable = picked.attachments.length;
		}
	}

	if (!deps.hasVault) {
		await deps.resetSyncState?.(); // fresh sync identity; the restored vault isn't enrolled
		await deps.unlock(password, newId);
	}
	return { addedNew: deps.hasVault, restored, rejected, unstorable };
}
