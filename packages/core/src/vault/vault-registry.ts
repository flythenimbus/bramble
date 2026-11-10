// Device-local registry of the vaults on this device, never inside a vault blob: the readable
// blob header would leak vault names. The label here is a cached copy of the vault's synced
// name (app/hooks/useVaultName.ts), kept for the screens that show it while the vault is locked.
// See docs/multiple-vaults.md.

import { z } from "zod";

/** Device-global metadata key the registry is persisted under (via the storage adapter's meta store). */
export const VAULT_REGISTRY_KEY = "vault.registry";

const VaultRecordSchema = z.object({
	id: z.string().min(1),
	/** User-facing label. May be blank; a blank label renders as "Vault N" (see `number`). */
	label: z.string(),
	createdAt: z.number(),
	/** The N of the "Vault N" a blank label shows. Kept rather than taken from the vault's place,
	 * so a delete doesn't hand the deleted vault's name to the next one. Local to this device. */
	number: z.number().int().positive().optional(),
	/** Set on a vault combined into the desktop app's: off every list, still on disk. Local to this
	 * device. */
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
	return parsed.success ? numbered(parsed.data) : EMPTY_REGISTRY;
}

/** Number each record that has none at the "Vault N" it shows today: listed ones by place, then
 * hidden ones after them. */
function numbered(reg: VaultRegistry): VaultRegistry {
	if (reg.vaults.every((v) => v.number !== undefined)) return reg;
	const taken = new Set(reg.vaults.flatMap((v) => (v.number === undefined ? [] : [v.number])));
	const listed = listedVaults(reg);
	const order = [...listed, ...reg.vaults.filter((v) => !listed.includes(v))];
	const given = new Map<string, number>();
	order.forEach((v, i) => {
		if (v.number !== undefined) return;
		let n = i + 1;
		while (taken.has(n)) n++;
		taken.add(n);
		given.set(v.id, n);
	});
	return { vaults: reg.vaults.map((v) => ({ ...v, number: v.number ?? given.get(v.id) })) };
}

/** Add a vault, numbered after every vault already here. */
export function addVault(reg: VaultRegistry, record: VaultRecord): VaultRegistry {
	if (reg.vaults.some((v) => v.id === record.id)) {
		throw new Error(`vault id already registered: ${record.id}`);
	}
	const current = numbered(reg);
	const number = Math.max(0, ...current.vaults.map((v) => v.number ?? 0)) + 1;
	return { vaults: [...current.vaults, { ...record, number }] };
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

/** The name to show for a vault: its own label, or "Vault N" when blank. `index` stands in for a
 * record no parse or add has numbered. */
export function displayLabel(v: Pick<VaultRecord, "label" | "number">, index: number): string {
	const trimmed = v.label.trim();
	return trimmed.length > 0 ? trimmed : `Vault ${v.number ?? index + 1}`;
}
