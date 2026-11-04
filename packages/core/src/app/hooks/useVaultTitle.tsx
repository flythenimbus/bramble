import { useLingui } from "@lingui/react/macro";
import { useCallback } from "react";
import { displayLabel, type VaultRecord } from "../../vault/vault-registry";

/** A vault's name as shown, marked when linking set it aside. */
export function useVaultTitle(): (record: VaultRecord, index: number) => string {
	const { t } = useLingui();
	return useCallback(
		(record, index) => {
			const name = displayLabel(record.label, index);
			return record.setAsideAt === undefined ? name : t`${name} (before linking)`;
		},
		[t],
	);
}
