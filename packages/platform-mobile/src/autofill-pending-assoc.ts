import { registerPlugin } from "@capacitor/core";
import type { PendingAssociation } from "@core/index";
import { mobileCrypto } from "./adapters/crypto";
import { drainHandoff, type EncryptedRecord } from "./encrypted-handoff";

interface PendingAssociationsPlugin {
	consumePendingAssociations(): Promise<{ pending: EncryptedRecord[] }>;
	restorePendingAssociations(o: { keep: EncryptedRecord[] }): Promise<void>;
}
const Bridge = registerPlugin<PendingAssociationsPlugin>("AutofillBridge");

const ANDROID_FILE = "autofill_pending_assoc.json";

export async function consumePendingAssociations(): Promise<PendingAssociation[]> {
	const { records, reclaim } = await drainHandoff(ANDROID_FILE, {
		consume: () => Bridge.consumePendingAssociations(),
		restore: (o) => Bridge.restorePendingAssociations(o),
	});
	const out: PendingAssociation[] = [];
	const failed: EncryptedRecord[] = [];
	for (const e of records) {
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
					label: typeof d.label === "string" && d.label ? d.label : undefined,
					vaultId: d.vaultId,
					at: typeof d.at === "number" ? d.at : 0,
				});
			}
		} catch {
			// Another vault's VEK: re-stash for the right vault.
			failed.push(e);
		}
	}
	await reclaim(failed);
	return out;
}
