import { registerPlugin } from "@capacitor/core";
import type { PendingAssociation } from "@core/index";
import { drainHandoff, type EncryptedRecord } from "./encrypted-handoff";

interface PendingAssociationsPlugin {
	consumePendingAssociations(): Promise<{ pending: EncryptedRecord[] }>;
	restorePendingAssociations(o: { keep: EncryptedRecord[] }): Promise<void>;
}
const Bridge = registerPlugin<PendingAssociationsPlugin>("AutofillBridge");

export function consumePendingAssociations(): Promise<PendingAssociation[]> {
	return drainHandoff(
		{
			consume: () => Bridge.consumePendingAssociations(),
			restore: (o) => Bridge.restorePendingAssociations(o),
		},
		(json) => {
			const d = json as Record<string, unknown> | null;
			if (
				typeof d?.entryId !== "string" ||
				typeof d?.url !== "string" ||
				typeof d?.vaultId !== "string"
			) {
				return null;
			}
			return {
				entryId: d.entryId,
				url: d.url,
				label: typeof d.label === "string" && d.label ? d.label : undefined,
				vaultId: d.vaultId,
			};
		},
	);
}
