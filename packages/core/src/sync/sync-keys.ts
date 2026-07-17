// Per-vault sync metadata keys. Five of the seven `sync.*` keys belong to one vault's sync
// identity (its group + this device's roster membership); `sync.relay` / `sync.iceUrl` are
// device-global endpoints and are NOT namespaced. Every vault's sync value is stored under a
// key namespaced by its id (`<base>:<vaultId>`). See docs/multiple-vaults.md.

/** The base sync keys that are per-vault; each is stored at `<base>:<vaultId>`. */
export const PER_VAULT_SYNC_KEYS = [
	"sync.group",
	"sync.lastSyncedAt",
	"sync.deviceId",
	"sync.deviceKeypair",
	"sync.signingKey",
] as const;

/**
 * The storage key for a per-vault sync value: `<flatKey>:<vaultId>`. `flatKey` is one of the base
 * constants (e.g. `"sync.group"`), so call sites keep their current key names.
 */
export function syncKeyFor(flatKey: string, vaultId: string): string {
	return `${flatKey}:${vaultId}`;
}
