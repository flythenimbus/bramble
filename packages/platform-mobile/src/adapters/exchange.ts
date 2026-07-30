import { Capacitor } from "@capacitor/core";
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
 * The adapter, or undefined where the platform has no exchange plugin at all (Android, the
 * dev browser). Presence means "this build can ask", NOT "this device can do it": the UI
 * calls `availability()` and reports WHY when the answer is no.
 *
 * That distinction is deliberate. An earlier cut resolved availability here and dropped the
 * adapter when the OS was too old, which hid the feature with no way to tell an old OS from a
 * plugin that failed to load. It also put an unbounded native call on the pre-render path,
 * where a hung callback would have blocked first paint.
 */
export function resolveExchange(): CredentialExchangeAdapter | undefined {
	return Capacitor.getPlatform() === "ios" ? mobileExchange : undefined;
}
