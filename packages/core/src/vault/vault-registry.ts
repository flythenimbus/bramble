// Device-local registry of the vaults on this device, never inside a vault blob: the readable
// blob header would leak vault names. The label here is a cached copy of the vault's synced
// name (app/hooks/useVaultName.ts), kept for the screens that show it while the vault is locked.
// See docs/multiple-vaults.md.

import { z } from "zod";

/** Device-global metadata key the registry is persisted under (via the storage adapter's meta store). */
export const VAULT_REGISTRY_KEY = "vault.registry";

const VaultRecordSchema = z.object({
	id: z.string().min(1),
	/** User-facing label. May be blank; a blank label renders as "Vault N" by position. */
	label: z.string(),
	createdAt: z.number(),
	/** Set while a vault combined into the desktop app's waits for the user to delete or keep it.
	 * Off every list. Local to this device. */
	hidden: z
		.object({
			at: z.number(),
			/** Its bytes when the copy was made: anything saved into it since is not in the copy. */
			blobHash: z.string(),
			/** The vault holding the copy. With that gone, this is the only copy again. */
			into: z.string(),
		})
		.optional(),
});
export type VaultRecord = z.infer<typeof VaultRecordSchema>;

// Every vault is addressed by id: its blob is at `<base>:<id>` and its sync keys at `<key>:<id>`.
// (Older `primaryId` / `legacyBlobVaultId` fields are Zod-stripped on parse; the storage adapter's
// one-time migration copies a pre-namespacing vault's flat data to its `:<id>` keys. See storage.ts
// and docs/multiple-vaults.md.)
const VaultRegistrySchema = z.object({
	vaults: z.array(VaultRecordSchema),
});
export type VaultRegistry = z.infer<typeof VaultRegistrySchema>;

export const EMPTY_REGISTRY: VaultRegistry = { vaults: [] };

/** Parse a stored registry, falling back to an empty one when absent or corrupt. */
export function parseRegistry(raw: unknown): VaultRegistry {
	if (raw == null) return EMPTY_REGISTRY;
	const parsed = VaultRegistrySchema.safeParse(raw);
	return parsed.success ? parsed.data : EMPTY_REGISTRY;
}

/** Add a vault. */
export function addVault(reg: VaultRegistry, record: VaultRecord): VaultRegistry {
	if (reg.vaults.some((v) => v.id === record.id)) {
		throw new Error(`vault id already registered: ${record.id}`);
	}
	return { vaults: [...reg.vaults, record] };
}

/** Remove a vault. One hidden for holding a copy in it is an ordinary vault again. */
export function removeVault(reg: VaultRegistry, id: string): VaultRegistry {
	return {
		vaults: reg.vaults
			.filter((v) => v.id !== id)
			.map((v) => (v.hidden?.into === id ? shown(v) : v)),
	};
}

function shown(record: VaultRecord): VaultRecord {
	const { hidden: _hidden, ...rest } = record;
	return rest;
}

/** Rename a vault. A blank label falls back to "Vault N" at display time (see displayLabel). */
export function renameVault(reg: VaultRegistry, id: string, label: string): VaultRegistry {
	return { ...reg, vaults: reg.vaults.map((v) => (v.id === id ? { ...v, label } : v)) };
}

/** Take a vault a combine copied out off the lists. It stays on disk: nothing deletes it. */
export function hideVault(
	reg: VaultRegistry,
	id: string,
	hidden: NonNullable<VaultRecord["hidden"]>,
): VaultRegistry {
	return { ...reg, vaults: reg.vaults.map((v) => (v.id === id ? { ...v, hidden } : v)) };
}

/** The vaults to show. A hidden one is listed if nothing else is, rather than stranded. */
export function listedVaults(reg: VaultRegistry): VaultRecord[] {
	const listed = reg.vaults.filter((v) => v.hidden === undefined);
	return listed.length > 0 ? listed : reg.vaults;
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
