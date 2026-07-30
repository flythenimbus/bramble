import { registerPlugin } from "@capacitor/core";
import { armFilePickGrace } from "./auto-lock";

// Credential exchange (FIDO CXP/CXF), iOS 26+. Thin wrapper over the native plugin in
// ios/App/App/CredentialExchange.swift; the payload itself is built and parsed by the
// shared mapper in @vault/core/exchange. See docs/credential-exchange.md.
//
// Both directions hand control to an out-of-process system sheet, which backgrounds the
// app. Without arming the auto-lock grace first, "Immediately" locks the vault mid-transfer
// and the payload is lost, the same trap the native file picker has.
interface CredentialExchangePlugin {
	isAvailable(): Promise<{ available: boolean; providerEnabled: boolean }>;
	requestExport(options: { importerBundleId?: string }): Promise<{ formatVersion: string }>;
	exportCredentials(options: { cxfJson: string }): Promise<void>;
	consumeImportToken(): Promise<{ token?: string }>;
	importCredentials(options: { token: string }): Promise<{ cxfJson: string }>;
}

const Native = registerPlugin<CredentialExchangePlugin>("CredentialExchange");

export interface ExchangeAvailability {
	/** The OS supports credential exchange (iOS 26+) and the plugin is present. */
	available: boolean;
	/** Bramble is switched on as an AutoFill provider, which is what makes the OS list us. */
	providerEnabled: boolean;
}

/** Swallows errors so a build without the native plugin (the browser dev build) hides the feature. */
export async function exchangeAvailability(): Promise<ExchangeAvailability> {
	try {
		return await Native.isAvailable();
	} catch {
		return { available: false, providerEnabled: false };
	}
}

/**
 * Export to another app. The OS picks the destination first and tells us which CXF version
 * it negotiated; only then do we build the payload, so the vault is read for a destination
 * the user has actually chosen rather than speculatively.
 */
export async function exportToApp(
	buildPayload: (formatVersion: string) => Promise<string> | string,
): Promise<void> {
	armFilePickGrace();
	const { formatVersion } = await Native.requestExport({});
	// Re-armed: building the payload can take a moment on a large vault, and the grace
	// window is measured from the last arm.
	armFilePickGrace();
	await Native.exportCredentials({ cxfJson: await buildPayload(formatVersion) });
}

/**
 * Take the import token the OS delivered, if any. Safe to call while locked: the token is
 * one-shot and carries no credentials, so it can wait in memory until the user unlocks.
 * Destructive, so a token can't be replayed into a second vault.
 */
export async function claimImportToken(): Promise<string | null> {
	try {
		return (await Native.consumeImportToken()).token ?? null;
	} catch {
		return null;
	}
}

/**
 * Redeem a claimed token for the exporter's CXF payload. Call only once the vault is
 * unlocked and ready to write: this is the point at which plaintext credentials exist in
 * memory, so there is no reason to hold them any longer than the import itself.
 */
export async function redeemImportToken(token: string): Promise<string> {
	armFilePickGrace();
	return (await Native.importCredentials({ token })).cxfJson;
}
