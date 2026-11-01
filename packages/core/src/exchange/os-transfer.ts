// The two halves of an OS-driven transfer, kept out of the UI so they can be tested
// headlessly. The platform adapter does the talking; everything here is mapping.

import type { CredentialExchangeAdapter } from "../adapters/exchange";
import type { Entry } from "../hooks/useVault";
import type { ImportParserContext, ImportResult } from "../import/types";
import { parseCxf } from "./from-cxf";
import { toCxf } from "./to-cxf";

/**
 * Redeem an inbound transfer, if one is waiting. Returns null when there is no token, which
 * is the normal case: a transfer is started in the OTHER app and the OS then launches us.
 *
 * Call only once the vault is unlocked. Claiming a token while locked is safe, but redeeming
 * it materializes the exporter's plaintext credentials, so the two steps stay separate.
 */
export async function importFromOs(
	exchange: CredentialExchangeAdapter,
	context: ImportParserContext,
): Promise<ImportResult | null> {
	const token = await exchange.claimImportToken();
	if (!token) return null;
	const result = await parseCxf(await exchange.redeemImportToken(token), context);
	// The OS dropped any PRF secrets before we saw the payload; we can only say so.
	const carriesExtensions = (await exchange.availability()).passkeyExtensions !== false;
	if (!carriesExtensions && result.imported.some((e) => e.type === "login" && e.passkeys?.length)) {
		result.warnings.push(
			"This iOS version doesn't pass passkey PRF secrets between apps (iOS 26.4 and later do). If a site uses one of these passkeys to encrypt data, update iOS and transfer again.",
		);
	}
	return result;
}

/**
 * Send the vault to another app. Returns the lossy-mapping warnings, or null when the user
 * backed out of the destination picker, so the caller can tell "nothing happened" from
 * "it went, with caveats".
 */
export async function exportToOs(
	exchange: CredentialExchangeAdapter,
	entries: readonly Entry[],
	appName: string,
	now: number = Date.now(),
): Promise<string[]> {
	let warnings: string[] = [];
	const { passkeyExtensions } = await exchange.availability();
	await exchange.exportToApp(() => {
		const out = toCxf(entries, {
			exporterRpId: exchange.exporterId,
			exporterDisplayName: appName,
			now,
			passkeyExtensions,
		});
		warnings = out.warnings;
		return JSON.stringify(out.payload);
	});
	return warnings;
}
