import { registerPlugin } from "@capacitor/core";
import type { ExchangeAvailability } from "@core/index";
import { armFilePickGrace } from "./auto-lock";

// Credential exchange (FIDO CXP/CXF), iOS 26+. Thin wrapper over the native plugin in
// ios/App/App/CredentialExchange.swift; the payload itself is built and parsed by the
// shared mapper in @vault/core/exchange. See docs/credential-exchange.md.
//
// Both directions hand control to an out-of-process system sheet, which backgrounds the
// app. Without arming the auto-lock grace first, "Immediately" locks the vault mid-transfer
// and the payload is lost, the same trap the native file picker has.
interface CredentialExchangePlugin {
	isAvailable(): Promise<{ available: boolean; providerEnabled: boolean; osVersion?: string }>;
	requestExport(options: { importerBundleId?: string }): Promise<{ formatVersion: string }>;
	exportCredentials(options: { cxfJson: string }): Promise<void>;
	consumeImportToken(): Promise<{ token?: string }>;
	importCredentials(options: { token: string }): Promise<{ cxfJson: string }>;
	addListener(event: "importAvailable", cb: () => void): Promise<{ remove: () => Promise<void> }>;
}

const Native = registerPlugin<CredentialExchangePlugin>("CredentialExchange");

/**
 * Never rejects: a missing plugin is reported as unavailable WITH the reason attached, so the
 * UI can distinguish "this OS can't" from "the call failed" instead of hiding the feature and
 * leaving nothing to diagnose.
 */
export async function exchangeAvailability(): Promise<ExchangeAvailability> {
	try {
		return await Native.isAvailable();
	} catch (err) {
		return {
			available: false,
			providerEnabled: false,
			error: err instanceof Error ? err.message : String(err),
		};
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
 * Fires when the OS hands us an inbound transfer, so the app can route to the import screen
 * (which owns the token). The activity can also arrive at a cold launch, before any listener
 * exists, which is why the token is parked natively rather than pushed. Returns an unsubscribe.
 */
export function onImportAvailable(cb: () => void): () => void {
	const handle = Native.addListener?.("importAvailable", cb);
	return () => {
		void handle?.then((h) => h.remove()).catch(() => {});
	};
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
