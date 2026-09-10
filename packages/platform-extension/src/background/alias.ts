import {
	AliasError,
	aliasConfiguredHintKeyFor,
	clientForConfig,
	isAliasConfig,
} from "@core/aliases";
import { decodeEntriesPayload } from "@core/sync";
import { parseRegistry, VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { extensionStorage } from "../storage";
import { sendToOffscreen } from "./offscreen-client";
import { getActiveVaultId } from "./session";
import { bytesToBase64, readAndDecodeVault } from "./vault-io";

// Creating an email alias for the in-page suggestion. The provider is reached from here rather
// than from the page: the configuration lives inside the vault's encrypted payload, and a content
// script is not a context that may hold either it or the key it carries.
// See docs/email-aliases.md and docs/synced-settings.md.

/** Where the configuration sits in the payload's settings map (the pref's own key). */
const ALIAS_PREF_KEY = "pref.aliasProvider";

/**
 * The active vault's alias configuration, read out of the decrypted payload.
 *
 * Requires an unlocked vault by construction: the configuration is a synced setting, so it lives
 * in the same ciphertext as the entries. Null for locked, absent, or malformed alike.
 */
async function activeConfig() {
	const vaultId = getActiveVaultId();
	if (!vaultId) return null;
	try {
		const blob = await readAndDecodeVault(vaultId);
		if (blob.entriesCiphertext.length === 0) return null;
		const outer = await sendToOffscreen({
			type: "CRYPTO_DECRYPT_OUTER",
			vaultId,
			payload: {
				iv: bytesToBase64(blob.entriesIv),
				ciphertext: bytesToBase64(blob.entriesCiphertext),
			},
		});
		if (!outer.ok || typeof outer.data !== "string") return null;
		const stored = decodeEntriesPayload(outer.data).settings?.[ALIAS_PREF_KEY]?.value;
		return isAliasConfig(stored) ? stored : null;
	} catch {
		return null;
	}
}

/**
 * Whether an alias row may be offered at all, for the autofill query to carry.
 *
 * No provider is contacted to answer this, so a page asking whether the row exists cannot make
 * Bramble talk to anyone.
 */
export async function aliasAvailable(): Promise<boolean> {
	return (await activeConfig()) !== null;
}

/**
 * Whether any vault on this device is known to have a provider, for the LOCKED case.
 *
 * A locked vault cannot be read at all now that the configuration is synced, so this consults the
 * device-local hint the app writes whenever the answer is known. It decides one thing: whether a
 * signup form's email field is worth offering an unlock row on. Being a cache it can be stale (a
 * provider added on another device is unknown here until this one unlocks and syncs), and the
 * cost of being wrong is one unlock row too many or too few.
 */
export async function aliasConfiguredAnywhere(): Promise<boolean> {
	const reg = parseRegistry(await extensionStorage.getMeta(VAULT_REGISTRY_KEY).catch(() => null));
	for (const v of reg.vaults) {
		const hint = await extensionStorage
			.getMeta<boolean>(aliasConfiguredHintKeyFor(v.id))
			.catch(() => undefined);
		if (hint === true) return true;
	}
	return false;
}

/** Create one alias for `site`, and return the address. */
export async function createAlias(site?: string): Promise<string> {
	const config = await activeConfig();
	if (!config) {
		// Locked and unconfigured are indistinguishable from here, and the remedy for the common
		// one is what saving a new item already asks for.
		throw new AliasError("auth", "Unlock Bramble to create an alias.");
	}
	// Empty for a provider with no account to authenticate against; its client ignores it.
	const client = clientForConfig(config, config.apiKey ?? "");
	const { address } = await client.create({
		site,
		description: site ? `Bramble (${site})` : "Bramble",
	});
	return address;
}
