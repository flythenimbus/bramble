import type { AliasProviderId } from "./types";

// Where an alias provider's configuration and API key live. See docs/email-aliases.md.

/**
 * Where the configuration used to live, per vault, before it became a synced pref.
 *
 * Kept only so an existing value can be migrated once and the key removed. Nothing reads it as a
 * live setting; see `pref.aliasProvider` in usePrefs and docs/synced-settings.md.
 */
export const ALIAS_CONFIG_KEY = "alias.config";

export function aliasConfigKeyFor(vaultId: string): string {
	return `${ALIAS_CONFIG_KEY}:${vaultId}`;
}

/** True for any vault's alias-config key, for watchers that cannot name the id. */
export function isAliasConfigKey(key: string): boolean {
	return key.startsWith(`${ALIAS_CONFIG_KEY}:`);
}

/**
 * A device-local hint that this vault has an alias provider, so a LOCKED vault can still decide
 * whether to offer the unlock row on a signup form's email field.
 *
 * The configuration itself is synced, which means it lives inside the vault's encrypted payload
 * and cannot be read before unlock. This boolean is the one thing that must be answerable then,
 * so it is kept beside the vault rather than inside it. It holds no secret and no provider name:
 * only whether this device has ever seen one configured here. Being a cache it can go stale (a
 * provider added on another device is not known here until this one unlocks and syncs), and the
 * cost of being wrong is one unlock row too many or too few. See docs/synced-settings.md.
 */
export const ALIAS_CONFIGURED_HINT_KEY = "alias.configured";

export function aliasConfiguredHintKeyFor(vaultId: string): string {
	return `${ALIAS_CONFIGURED_HINT_KEY}:${vaultId}`;
}

/**
 * What the hint should be set to, or null to leave it alone.
 *
 * Two rules, both learned the hard way. Never write while locked: locking resets every synced
 * pref to its default, so the config reads as absent the moment the vault closes, and writing
 * from that erases the hint at exactly the point it becomes the only thing that can answer.
 * And the answer is whatever the vault's settings map says, including when it arrived by SYNC,
 * which is why this is decided where the vault is rather than where the settings screen is.
 */
export function aliasHintValue(
	settings: Record<string, { value?: unknown }> | undefined,
	isLocked: boolean,
	prefKey: string,
): boolean | null {
	if (isLocked) return null;
	return isAliasConfig(settings?.[prefKey]?.value);
}

/** One vault's alias provider. At most one: the feature is "generate an alias", not "choose a
 * provider each time", and a second configured provider would make every generate a question. */
export interface AliasConfig {
	provider: AliasProviderId;
	/** Set only when self-hosting; absent means the provider's own default. */
	baseUrl?: string;
	/** The provider's own settings, keyed by `AliasField.key` (domain, format, mode). */
	options: Record<string, string>;
	/**
	 * The provider's API key, in the clear.
	 *
	 * Not wrapped by hand any more: this config is a synced pref, so it rides inside the vault's
	 * VEK-encrypted payload and is protected by the vault key exactly as every entry is. Wrapping
	 * it again would be a second encryption under the same key, which buys nothing and was only
	 * ever there because the config used to sit in plaintext meta storage.
	 */
	apiKey: string;
}

/** Whether a stored value is still shaped like a config. Storage is not a trusted input: this
 * may have been written by another build or hand-edited. */
export function isAliasConfig(v: unknown): v is AliasConfig {
	if (!v || typeof v !== "object") return false;
	const c = v as Partial<AliasConfig>;
	if (c.provider !== "addy" && c.provider !== "simplelogin") return false;
	if (c.baseUrl !== undefined && typeof c.baseUrl !== "string") return false;
	if (!c.options || typeof c.options !== "object") return false;
	return typeof c.apiKey === "string" && c.apiKey.length > 0;
}
