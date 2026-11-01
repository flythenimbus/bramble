import type { HttpTransport } from "../adapters/http";
import { type AddyFormat, createAddyClient } from "./addy";
import { type CatchAllStyle, createCatchAllClient } from "./catchall";
import type { AliasConfig } from "./config";
import { createDuckDuckGoClient } from "./duckduckgo";
import { createFastmailClient } from "./fastmail";
import { createRelayClient } from "./relay";
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
	CATCHALL_STYLES,
	type CatchAllConfig,
	type CatchAllStyle,
	createCatchAllClient,
	looksLikeDomain,
} from "./catchall";
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
	createDuckDuckGoClient,
	DUCKDUCKGO_DEFAULT_BASE_URL,
	type DuckDuckGoConfig,
} from "./duckduckgo";
export { createFastmailClient, FASTMAIL_DEFAULT_BASE_URL, type FastmailConfig } from "./fastmail";
export { createRelayClient, RELAY_DEFAULT_BASE_URL, type RelayConfig } from "./relay";
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
 *
 * `transport` is the platform's, and `undefined` means `fetch`. It is passed rather than reached
 * for because the extension speaks to a provider from its background worker, outside React and
 * therefore outside `usePlatform`.
 */
export function createAliasClient(
	provider: AliasProviderId,
	options: Record<string, string>,
	baseUrl: string | undefined,
	apiKey: string,
	transport?: HttpTransport,
): AliasClient {
	switch (provider) {
		case "addy":
			return createAddyClient(
				{ baseUrl, domain: options.domain, format: options.format as AddyFormat | undefined },
				apiKey,
				transport,
			);
		case "catchall":
			// No key and no transport: the address is generated locally and delivered by the user's
			// own mail host, so there is nobody to talk to.
			return createCatchAllClient({
				domain: options.domain,
				style: options.style as CatchAllStyle | undefined,
			});
		case "duckduckgo":
			// No options at all: the API takes no domain, no format, and no site.
			return createDuckDuckGoClient({ baseUrl }, apiKey, transport);
		case "fastmail":
			// No options: Fastmail picks the address domain from the account's Masked Email setting.
			return createFastmailClient({ baseUrl }, apiKey, transport);
		case "relay":
			return createRelayClient({ baseUrl }, apiKey, transport);
		case "simplelogin":
			return createSimpleLoginClient(
				{ baseUrl, mode: options.mode as SimpleLoginMode | undefined, domain: options.domain },
				apiKey,
				transport,
			);
	}
}

/** The same, from a stored config. Sugar for the common call, so callers do not unpack it. */
export function clientForConfig(
	cfg: AliasConfig,
	apiKey: string,
	transport?: HttpTransport,
): AliasClient {
	return createAliasClient(cfg.provider, cfg.options, cfg.baseUrl, apiKey, transport);
}
