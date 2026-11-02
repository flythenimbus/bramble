import { registerPlugin } from "@capacitor/core";
import type { PasskeyCredential } from "@core/hooks/useVault";
import { drainHandoff, type EncryptedRecord } from "./encrypted-handoff";

interface PendingPasskeysPlugin {
	consumePendingPasskeys(): Promise<{ pending: EncryptedRecord[] }>;
	restorePendingPasskeys(o: { keep: EncryptedRecord[] }): Promise<void>;
}
const Bridge = registerPlugin<PendingPasskeysPlugin>("AutofillBridge");

export function consumePendingPasskeys(): Promise<PasskeyCredential[]> {
	return drainHandoff(
		{
			consume: () => Bridge.consumePendingPasskeys(),
			restore: (o) => Bridge.restorePendingPasskeys(o),
		},
		(json) => json as PasskeyCredential,
	);
}
