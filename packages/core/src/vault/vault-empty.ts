// Whether a vault holds anything anyone could miss. Linking removes a vault only when this is
// true, so it errs towards "not empty". See docs/desktop-link-onboarding.md "What linking does".

export interface VaultContents {
	/** Live entries. */
	entryCount: number;
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
