import { useCallback, useEffect, useRef } from "react";
import {
	ALIAS_CONFIG_KEY,
	type AliasAccount,
	type AliasConfig,
	type AliasDomains,
	AliasError,
	type AliasProviderId,
	createAliasClient,
	describeProvider,
	isAliasConfig,
	missingRequiredFields,
} from "../aliases";
import { usePlatform } from "../context/PlatformContext";
import { syncKeyFor } from "../sync/sync-keys";
import { usePrefs } from "./usePrefs";
import { useVaultState } from "./useVault";
import { useVaultRegistry } from "./useVaultRegistry";

/** What the settings screen saves. */
export interface SaveAliasInput {
	provider: AliasProviderId;
	baseUrl?: string;
	options: Record<string, string>;
	/** Omitted on edit, which keeps the stored key rather than re-asking for it. */
	apiKey?: string;
}

/** The pre-sync shape: the key was wrapped by hand because the config sat in plaintext meta. */
interface LegacyAliasConfig {
	provider: AliasProviderId;
	baseUrl?: string;
	options: Record<string, string>;
	key: { iv: string; ciphertext: string };
}

function isLegacyConfig(v: unknown): v is LegacyAliasConfig {
	if (!v || typeof v !== "object") return false;
	const c = v as Partial<LegacyAliasConfig>;
	return (
		(c.provider === "addy" || c.provider === "simplelogin") &&
		typeof c.key?.iv === "string" &&
		typeof c.key?.ciphertext === "string"
	);
}

/**
 * The active vault's email alias provider.
 *
 * A synced pref (`pref.aliasProvider`), so configuring it on one device reaches the others and
 * the API key is protected by the vault key like everything else in the payload. Nothing here
 * encrypts: `usePrefs` routes the read and the write, and the vault seals the payload they land
 * in. See docs/synced-settings.md and docs/email-aliases.md.
 */
export function useAliasProvider() {
	const { storage, crypto } = usePlatform();
	const { prefs, loaded, update } = usePrefs();
	const { activeId, vaults } = useVaultRegistry();
	const vaultId = activeId ?? vaults[0]?.id;
	const config = prefs.aliasProvider;
	const { entries } = useVaultState();

	/** Every address this vault already holds, so a locally generated one cannot repeat one. */
	const takenAddresses = useCallback(
		() =>
			entries
				.map((e) => (e.type === "login" ? e.username : ""))
				.filter((u): u is string => u.length > 0),
		[entries],
	);

	// Migrate a value written before the config was synced, once. Only when there is nothing
	// synced yet, so a device that never had one cannot overwrite what another device set.
	const migrated = useRef(false);
	useEffect(() => {
		if (!vaultId || !loaded || config !== null || migrated.current) return;
		migrated.current = true;
		void (async () => {
			const legacyKey = syncKeyFor(ALIAS_CONFIG_KEY, vaultId);
			const stored = await storage.getMeta<unknown>(legacyKey).catch(() => undefined);
			if (!isLegacyConfig(stored)) return;
			try {
				const apiKey = await crypto.decryptWithVek(stored.key.iv, stored.key.ciphertext);
				await update("aliasProvider", {
					provider: stored.provider,
					baseUrl: stored.baseUrl,
					options: stored.options ?? {},
					apiKey,
				});
			} catch {
				// Wrapped under a key this vault no longer has. Nothing to rescue, and the user can
				// paste the key again; dropping the dead value is better than retrying forever.
			}
			await storage.removeMeta(legacyKey).catch(() => {});
		})();
	}, [storage, crypto, vaultId, loaded, config, update]);

	/** The key to authenticate with: the one being typed, else the one already stored. Empty for
	 * a provider that authenticates to nobody. */
	const resolveKey = useCallback(
		(input: SaveAliasInput): string => {
			if (!describeProvider(input.provider).needsApiKey) return "";
			const stored = config?.provider === input.provider ? config.apiKey : undefined;
			const key = input.apiKey || stored;
			if (!key) throw new AliasError("config", "Enter your API key.");
			return key;
		},
		[config],
	);

	const clientFrom = useCallback(
		(input: SaveAliasInput) =>
			createAliasClient(input.provider, input.options, input.baseUrl, resolveKey(input)),
		[resolveKey],
	);

	const save = useCallback(
		async (input: SaveAliasInput): Promise<void> => {
			// An edit that does not restate the key keeps the stored one; the screen never holds it.
			// A provider with no account to authenticate against carries no key at all.
			const needsKey = describeProvider(input.provider).needsApiKey;
			// The stored key is only a fallback for the provider it belongs to. Reusing it across a
			// switch would authenticate to Addy with a SimpleLogin key, which fails in a way that
			// reads as "your key is wrong" rather than "that key is for something else".
			const storedKey = config?.provider === input.provider ? config.apiKey : undefined;
			const apiKey = needsKey ? input.apiKey || storedKey : undefined;
			if (needsKey && !apiKey) throw new AliasError("config", "Enter your API key.");
			const next: AliasConfig = {
				provider: input.provider,
				baseUrl: input.baseUrl || undefined,
				options: input.options,
				...(apiKey ? { apiKey } : {}),
			};
			await update("aliasProvider", next);
		},
		[update, config],
	);

	const disconnect = useCallback(async () => {
		await update("aliasProvider", null);
	}, [update]);

	/** Check a key and report what the account allows. Read-only on every provider. */
	const verify = useCallback(
		async (input: SaveAliasInput): Promise<AliasAccount> => clientFrom(input).verify(),
		[clientFrom],
	);

	/** The domains this account may create under, the user's own custom ones included. */
	const domains = useCallback(
		async (input: SaveAliasInput): Promise<AliasDomains> =>
			(await clientFrom(input).domains?.()) ?? { options: [] },
		[clientFrom],
	);

	/**
	 * Create one alias, for `site` when the caller knows it.
	 *
	 * The call that spends the user's allowance, so it is only ever reached from an explicit
	 * gesture. Missing required settings fail here without a request.
	 */
	const generate = useCallback(
		async (site?: string): Promise<string> => {
			if (!config) throw new AliasError("config", "No alias provider is set up.");
			if (missingRequiredFields(config.provider, config.options).length > 0) {
				throw new AliasError("config", "This provider needs more setup in Settings.");
			}
			const client = createAliasClient(
				config.provider,
				config.options,
				config.baseUrl,
				config.apiKey ?? "",
			);
			const { address } = await client.create({
				site,
				description: site ? `Bramble (${site})` : "Bramble",
				// Only the catch-all provider reads this: it has no server to reject a duplicate, so
				// the vault's own addresses are the only thing standing between two logins sharing one.
				taken: takenAddresses(),
			});
			return address;
		},
		[config, takenAddresses],
	);

	return {
		/** null when no provider is set up. Undefined is not a state any more: prefs always resolve. */
		config,
		/** Whether a generate button should appear at all. */
		enabled: config !== null,
		save,
		disconnect,
		verify,
		domains,
		generate,
	};
}

/** Re-exported so callers that only want the guard do not reach into aliases/config. */
export { isAliasConfig };
