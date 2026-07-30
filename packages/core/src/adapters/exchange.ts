// Credential exchange (FIDO CXP), the OS-driven app-to-app transfer of passwords and
// passkeys. Only the platform knows how to reach it; the payload on both sides is CXF JSON
// built and parsed by src/exchange. iOS 26+ today, undefined everywhere else.
// See docs/credential-exchange.md.

export interface ExchangeAvailability {
	/** The OS supports credential exchange and the native plugin is present. */
	available: boolean;
	/** We are switched on as a credential provider, which is what makes the OS list us. */
	providerEnabled: boolean;
	/** OS version string, so an unavailable device can say why rather than hiding the feature. */
	osVersion?: string;
	/** Set when the native call itself failed, which is a different problem from an old OS. */
	error?: string;
}

export interface CredentialExchangeAdapter {
	/** Identifier we present to the importer as the source of the export. */
	exporterId: string;
	availability(): Promise<ExchangeAvailability>;
	/**
	 * Run an export. The OS picks the destination first and passes back the CXF version it
	 * negotiated; `buildPayload` is only called once a destination exists, so the vault is
	 * never read speculatively.
	 */
	exportToApp(buildPayload: (formatVersion: string) => Promise<string> | string): Promise<void>;
	/**
	 * Take the token for an inbound transfer, or null when none is waiting. Safe while
	 * locked: a token carries no credentials. Destructive, so it can't be redeemed twice.
	 */
	claimImportToken(): Promise<string | null>;
	/** Redeem a claimed token for the exporter's CXF payload. Only once unlocked. */
	redeemImportToken(token: string): Promise<string>;
}
