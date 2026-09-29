import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { PendingAssociation } from "@core/index";
import { mobileCrypto } from "./adapters/crypto";

interface PendingAssociationsPlugin {
	consumePendingAssociations(): Promise<{ pending: { iv: string; ciphertext: string }[] }>;
}
const Bridge = registerPlugin<PendingAssociationsPlugin>("AutofillBridge");

const ANDROID_FILE = "autofill_pending_assoc.json";

interface EncryptedAssociation {
	iv: string;
	ciphertext: string;
}

async function drainEncrypted(): Promise<EncryptedAssociation[]> {
	if (Capacitor.getPlatform() === "ios") {
		try {
			return (await Bridge.consumePendingAssociations()).pending ?? [];
		} catch {
			return []; // method absent (old build)
		}
	}
	try {
		await Filesystem.stat({ path: ANDROID_FILE, directory: Directory.Data });
	} catch {
		return []; // nothing waiting
	}
	try {
		const r = await Filesystem.readFile({
			path: ANDROID_FILE,
			directory: Directory.Data,
			encoding: Encoding.UTF8,
		});
		await Filesystem.deleteFile({ path: ANDROID_FILE, directory: Directory.Data }).catch(() => {});
		const arr = JSON.parse(r.data as string);
		return Array.isArray(arr) ? (arr as EncryptedAssociation[]) : [];
	} catch {
		await Filesystem.deleteFile({ path: ANDROID_FILE, directory: Directory.Data }).catch(() => {});
		return [];
	}
}

export async function consumePendingAssociations(): Promise<PendingAssociation[]> {
	const out: PendingAssociation[] = [];
	for (const e of await drainEncrypted()) {
		try {
			const d = JSON.parse(await mobileCrypto.decryptWithVek(e.iv, e.ciphertext));
			if (
				typeof d?.entryId === "string" &&
				typeof d?.url === "string" &&
				typeof d?.vaultId === "string"
			) {
				out.push({
					entryId: d.entryId,
					url: d.url,
					vaultId: d.vaultId,
					at: typeof d.at === "number" ? d.at : 0,
				});
			}
		} catch {
			// Another vault's VEK.
		}
	}
	return out;
}
