import type { CredentialExchangeAdapter } from "@core/index";
import {
	claimImportToken,
	exchangeAvailability,
	exportToApp,
	redeemImportToken,
} from "../credential-exchange";

// Maps the native CredentialExchange plugin (ios/App/App/CredentialExchange.swift) to the
// core adapter. Present only where the OS can actually do a transfer, which the UI treats as
// the feature switch; see resolveExchange below. docs/credential-exchange.md.
export const mobileExchange: CredentialExchangeAdapter = {
	// The bundle id we present to the importer as the source of the export.
	exporterId: "app.bramble.mobile",
	availability: exchangeAvailability,
	exportToApp,
	claimImportToken,
	redeemImportToken,
};

/**
 * The adapter, or undefined when this device can't exchange (pre-iOS-26, Android, or the dev
 * browser). Resolved once before first render so the UI can gate on presence synchronously
 * rather than flashing a card that would fail when tapped.
 *
 * Deliberately keyed on OS support alone, not on whether Bramble is enabled as a credential
 * provider: a user who hasn't turned it on yet should still see the feature and be told what
 * to do, rather than have it silently missing.
 */
export async function resolveExchange(): Promise<CredentialExchangeAdapter | undefined> {
	const { available } = await mobileExchange.availability();
	return available ? mobileExchange : undefined;
}
