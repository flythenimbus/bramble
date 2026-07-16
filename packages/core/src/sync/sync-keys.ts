// Per-vault sync metadata keys. Five of the seven `sync.*` keys belong to one vault's sync
// identity (its group + this device's roster membership); `sync.relay` / `sync.iceUrl` are
// device-global endpoints and are NOT namespaced. To avoid moving any existing pairing, the
// vault at the legacy blob slot keeps the flat `sync.<base>` keys; every other vault is
// namespaced by id (mirroring the blob's `legacyBlobVaultId`). See docs/multiple-vaults.md.

/** The flat sync keys that are per-vault (grandfathered for the legacy vault, namespaced otherwise). */
export const PER_VAULT_SYNC_KEYS = [
	"sync.group",
	"sync.lastSyncedAt",
	"sync.deviceId",
	"sync.deviceKeypair",
	"sync.signingKey",
] as const;

/**
 * The storage key for a per-vault sync value. The vault at the legacy blob slot
 * (`legacyBlobVaultId`) keeps the flat key so its pairing survives with no migration; every
 * other vault gets `<flatKey>:<vaultId>`. `flatKey` is one of the existing constants (e.g.
 * `"sync.group"`), so call sites keep their current key names.
 */
export function syncKeyFor(
	flatKey: string,
	vaultId: string,
	legacyBlobVaultId: string | null,
): string {
	return vaultId === legacyBlobVaultId ? flatKey : `${flatKey}:${vaultId}`;
}
