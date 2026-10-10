import { registerPlugin } from "@capacitor/core";
import type { PasskeyCredential } from "@core/hooks/useVault";
import { mobileCrypto } from "./adapters/crypto";
import { drainHandoff, type EncryptedRecord } from "./encrypted-handoff";

interface PendingPasskeysPlugin {
	consumePendingPasskeys(): Promise<{ pending: EncryptedRecord[] }>;
	restorePendingPasskeys(o: { keep: EncryptedRecord[] }): Promise<void>;
}
const Bridge = registerPlugin<PendingPasskeysPlugin>("AutofillBridge");

const ANDROID_FILE = "autofill_pending_passkeys.json";

export async function consumePendingPasskeys(): Promise<PasskeyCredential[]> {
	const { records, reclaim } = await drainHandoff(ANDROID_FILE, {
		consume: () => Bridge.consumePendingPasskeys(),
		restore: (o) => Bridge.restorePendingPasskeys(o),
	});
	const out: PasskeyCredential[] = [];
	const failed: EncryptedRecord[] = [];
	for (const e of records) {
		try {
			out.push(
				JSON.parse(await mobileCrypto.decryptWithVek(e.iv, e.ciphertext)) as PasskeyCredential,
			);
		} catch {
			// Another vault's VEK: re-stash for the right vault.
			failed.push(e);
		}
	}
	await reclaim(failed);
	return out;
}
