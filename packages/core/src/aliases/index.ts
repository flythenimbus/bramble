import { type AddyFormat, createAddyClient } from "./addy";
import type { AliasConfig } from "./config";
import { createSimpleLoginClient, type SimpleLoginMode } from "./simplelogin";
import type { AliasClient, AliasProviderId } from "./types";

export {
	ADDY_DEFAULT_BASE_URL,
	ADDY_FORMATS,
	type AddyConfig,
	type AddyFormat,
	createAddyClient,
} from "./addy";
export {
	ALIAS_CONFIG_KEY,
	ALIAS_CONFIGURED_HINT_KEY,
	type AliasConfig,
	aliasConfigKeyFor,
	aliasConfiguredHintKeyFor,
	isAliasConfig,
	isAliasConfigKey,
} from "./config";
export {
	ALIAS_PROVIDERS,
	type AliasField,
	type AliasProviderDescriptor,
	describeProvider,
	missingRequiredFields,
} from "./descriptors";
export {
	createSimpleLoginClient,
	SIMPLELOGIN_DEFAULT_BASE_URL,
	SIMPLELOGIN_MODES,
	type SimpleLoginConfig,
	type SimpleLoginMode,
} from "./simplelogin";
export {
	type AliasAccount,
	type AliasClient,
	type AliasDomainOption,
	type AliasDomains,
	AliasError,
	type AliasErrorKind,
	type AliasProviderId,
	type AliasRequest,
	type AliasResult,
} from "./types";

/**
 * Build a client for a configured provider, given its already-unwrapped API key.
 *
 * The plaintext key is a parameter rather than something this reads, so unwrapping stays with
 * the caller that holds the crypto adapter and the key's lifetime stays as short as the call.
 */
export function createAliasClient(
	provider: AliasProviderId,
	options: Record<string, string>,
	baseUrl: string | undefined,
	apiKey: string,
): AliasClient {
	switch (provider) {
		case "addy":
			return createAddyClient(
				{ baseUrl, domain: options.domain, format: options.format as AddyFormat | undefined },
				apiKey,
			);
		case "simplelogin":
			return createSimpleLoginClient(
				{ baseUrl, mode: options.mode as SimpleLoginMode | undefined, domain: options.domain },
				apiKey,
			);
	}
}

/** The same, from a stored config. Sugar for the common call, so callers do not unpack it. */
export function clientForConfig(cfg: AliasConfig, apiKey: string): AliasClient {
	return createAliasClient(cfg.provider, cfg.options, cfg.baseUrl, apiKey);
}
