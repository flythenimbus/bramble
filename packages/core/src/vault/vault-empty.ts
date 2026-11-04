// Whether a vault holds anything anyone could miss. Linking removes a vault only when this is
// true, so it errs towards "not empty". See docs/desktop-link-onboarding.md "What linking does".

import { aliasConfigKeyFor, aliasConfiguredHintKeyFor } from "../aliases/config";
import { syncKeyFor } from "../sync/sync-keys";

export interface VaultContents {
	/** Live entries. */
	entryCount: number;
	/** Attachment records, including any whose entry is gone. */
	fileCount: number;
	/** The raw quarantine store (see quarantine.ts): entries set aside are kept forever. */
	quarantineRaw: string | null;
	/** Devices in its sync roster, this one included. */
	rosterDevices: number;
	/** An email alias provider (and its API key) is configured. */
	hasAliasConfig: boolean;
}

/** Unlock methods and recovery codes are not inputs: on an empty vault they protect nothing. */
export function isVaultEmpty(v: VaultContents): boolean {
	return (
		v.entryCount === 0 &&
		v.fileCount === 0 &&
		!holdsQuarantine(v.quarantineRaw) &&
		v.rosterDevices <= 1 &&
		!v.hasAliasConfig
	);
}

/** Matches quarantine.ts's parseStore: anything but a missing or empty array counts. */
function holdsQuarantine(raw: string | null): boolean {
	if (raw === null || raw === "") return false;
	try {
		const parsed: unknown = JSON.parse(raw);
		return !Array.isArray(parsed) || parsed.length > 0;
	} catch {
		return true;
	}
}

/** The storage reads the empty check needs. */
export interface VaultContentsStorage {
	getMeta<T>(key: string): Promise<T | undefined | null>;
	readQuarantine?(vaultId?: string): Promise<string | null>;
}

/** Gather a vault's contents for isVaultEmpty. `entryCount` comes from the open vault. */
export async function readVaultContents(
	storage: VaultContentsStorage,
	vaultId: string,
	entryCount: number,
	fileCount: number,
): Promise<VaultContents> {
	const group = await storage.getMeta<{ roster?: { devices?: unknown[] } }>(
		syncKeyFor("sync.group", vaultId),
	);
	// The live config is synced inside the vault; the device-local hint is what is readable here.
	const hint = await storage.getMeta<boolean>(aliasConfiguredHintKeyFor(vaultId));
	const legacy = await storage.getMeta<unknown>(aliasConfigKeyFor(vaultId));
	return {
		entryCount,
		fileCount,
		quarantineRaw: (await storage.readQuarantine?.(vaultId)) ?? null,
		rosterDevices: Math.max(1, group?.roster?.devices?.length ?? 0),
		hasAliasConfig: hint === true || (legacy !== undefined && legacy !== null),
	};
}
