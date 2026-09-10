import { ADDY_DEFAULT_BASE_URL, ADDY_FORMATS } from "./addy";
import { CATCHALL_STYLES } from "./catchall";
import { SIMPLELOGIN_DEFAULT_BASE_URL, SIMPLELOGIN_MODES } from "./simplelogin";
import type { AliasProviderId } from "./types";

// What the settings screen needs to know about a provider, declared rather than switched on:
// which extra settings it has, which are required, and where their choices come from. Adding a
// provider should be a descriptor plus a client, with no `if (id === ...)` deciding structure.
//
// Deliberately no copy. Labels and hints live in the UI, where Lingui can extract them; a
// descriptor holding English strings would be a second place for translated text to go missing.
// See docs/email-aliases.md.

/**
 * One provider-specific setting.
 *
 * `options: "domains"` means the choices are not known until the account is asked, so the screen
 * calls `client.domains()` after the key verifies. Addy is the reason this exists: it cannot
 * create anything until a domain is chosen, and only the account knows which are available.
 */
export interface AliasField {
	key: string;
	/** Fixed choices, "domains" to fetch them from the account, or "text" for free entry. */
	options: readonly string[] | "domains" | "text";
	/** A create cannot be attempted until this has a value. */
	required: boolean;
}

export interface AliasProviderDescriptor {
	id: AliasProviderId;
	label: string;
	defaultBaseUrl: string;
	/** Whether this provider authenticates with an API key at all. False hides the key field,
	 * the link to create one, and the check button, because none of them mean anything. */
	needsApiKey: boolean;
	/** Whether to offer a base-URL field at all. Both current providers self-host. */
	selfHostable: boolean;
	/** Where the user creates an API key. Ours, fixed, and never provider-supplied text. */
	keyUrl: string;
	fields: readonly AliasField[];
}

export const ALIAS_PROVIDERS: readonly AliasProviderDescriptor[] = [
	{
		id: "addy",
		label: "Addy.io",
		defaultBaseUrl: ADDY_DEFAULT_BASE_URL,
		needsApiKey: true,
		selfHostable: true,
		keyUrl: "https://app.addy.io/settings/api",
		fields: [
			{ key: "domain", options: "domains", required: true },
			{ key: "format", options: ADDY_FORMATS, required: false },
		],
	},
	{
		id: "simplelogin",
		label: "SimpleLogin",
		defaultBaseUrl: SIMPLELOGIN_DEFAULT_BASE_URL,
		needsApiKey: true,
		selfHostable: true,
		keyUrl: "https://app.simplelogin.io/dashboard/api_key",
		fields: [
			// Optional: unset means the account's default domain via the random endpoint. Set, it
			// reaches a domain the user owns, which is the only route to a custom domain here.
			{ key: "domain", options: "domains", required: false },
			{ key: "mode", options: SIMPLELOGIN_MODES, required: false },
		],
	},
	{
		id: "catchall",
		label: "Your own domain",
		defaultBaseUrl: "",
		// Nobody to authenticate to: the address is made here and the user's own mail host
		// delivers it. This is why the settings screen shows no key field and no check button.
		needsApiKey: false,
		selfHostable: false,
		keyUrl: "",
		fields: [
			{ key: "domain", options: "text", required: true },
			{ key: "style", options: CATCHALL_STYLES, required: false },
		],
	},
];

export function describeProvider(id: AliasProviderId): AliasProviderDescriptor {
	const found = ALIAS_PROVIDERS.find((p) => p.id === id);
	if (!found) throw new Error(`unknown alias provider: ${id}`);
	return found;
}

/** Which of a provider's required fields have no value yet, so the UI can say what is missing
 * before a click spends a network call and, on some providers, an alias. */
export function missingRequiredFields(
	id: AliasProviderId,
	options: Record<string, string | undefined>,
): string[] {
	return describeProvider(id)
		.fields.filter((f) => f.required && !options[f.key])
		.map((f) => f.key);
}
