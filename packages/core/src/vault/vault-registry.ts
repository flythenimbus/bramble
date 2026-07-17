// Device-local registry of the vaults on this device. Not synced, and never inside a
// vault blob: a vault's label is a local preference, and the readable blob header would
// leak vault names if it lived there. See docs/multiple-vaults.md.

import { z } from "zod";

/** Device-global metadata key the registry is persisted under (via the storage adapter's meta store). */
export const VAULT_REGISTRY_KEY = "vault.registry";

export const VaultRecordSchema = z.object({
	id: z.string().min(1),
	/** User-facing label. May be blank; a blank label renders as "Vault N" by position. */
	label: z.string(),
	createdAt: z.number(),
});
export type VaultRecord = z.infer<typeof VaultRecordSchema>;

export const VaultRegistrySchema = z.object({
	vaults: z.array(VaultRecordSchema),
	// The vault whose blob lives at the un-suffixed (legacy) storage location, and the fallback
	// "default vault" when a caller omits an id or no active vault is selected (single-vault callers,
	// a woken background before the UI set the session, and mobile's out-of-process autofill /
	// biometric). Transitional: the first vault stays put so no bytes move during the multi-vault
	// migration, while later vaults are namespaced by id; a future phase moves it into the uniform
	// namespace and clears this. (An older `primaryId` field is Zod-stripped on parse - no migration.)
	legacyBlobVaultId: z.string().nullable(),
});
export type VaultRegistry = z.infer<typeof VaultRegistrySchema>;

export const EMPTY_REGISTRY: VaultRegistry = {
	vaults: [],
	legacyBlobVaultId: null,
};

/** Parse a stored registry, falling back to an empty one when absent or corrupt. */
export function parseRegistry(raw: unknown): VaultRegistry {
	if (raw == null) return EMPTY_REGISTRY;
	const parsed = VaultRegistrySchema.safeParse(raw);
	return parsed.success ? parsed.data : EMPTY_REGISTRY;
}

/** Add a vault. The first vault added takes the legacy (un-suffixed) blob slot. */
export function addVault(reg: VaultRegistry, record: VaultRecord): VaultRegistry {
	if (reg.vaults.some((v) => v.id === record.id)) {
		throw new Error(`vault id already registered: ${record.id}`);
	}
	const first = reg.vaults.length === 0;
	return {
		vaults: [...reg.vaults, record],
		legacyBlobVaultId: reg.legacyBlobVaultId ?? (first ? record.id : null),
	};
}

/** Remove a vault. Clears the legacy-blob pointer if it was the one removed. */
export function removeVault(reg: VaultRegistry, id: string): VaultRegistry {
	return {
		vaults: reg.vaults.filter((v) => v.id !== id),
		legacyBlobVaultId: reg.legacyBlobVaultId === id ? null : reg.legacyBlobVaultId,
	};
}

/** Rename a vault. A blank label falls back to "Vault N" at display time (see displayLabel). */
export function renameVault(reg: VaultRegistry, id: string, label: string): VaultRegistry {
	return { ...reg, vaults: reg.vaults.map((v) => (v.id === id ? { ...v, label } : v)) };
}

/** Look up a vault record by id. */
export function findVault(reg: VaultRegistry, id: string): VaultRecord | undefined {
	return reg.vaults.find((v) => v.id === id);
}

/** The label to show for a vault: its own label, or "Vault N" by 1-based position when blank. */
export function displayLabel(label: string, index: number): string {
	const trimmed = label.trim();
	return trimmed.length > 0 ? trimmed : `Vault ${index + 1}`;
}
