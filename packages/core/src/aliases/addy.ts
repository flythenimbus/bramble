import { z } from "zod";
import { request } from "./http";
import {
	type AliasAccount,
	type AliasClient,
	type AliasDomains,
	AliasError,
	type AliasRequest,
	type AliasResult,
} from "./types";

// Addy.io (formerly AnonAddy). Self-hostable, so the base URL is configuration.
// See docs/email-aliases.md.

export const ADDY_DEFAULT_BASE_URL = "https://app.addy.io";

/** The formats Addy will generate a local part in. `custom` needs a `local_part` and so is not
 * offered: this feature exists to avoid choosing a name per site. */
export const ADDY_FORMATS = [
	"random_characters",
	"uuid",
	"random_words",
	"random_male_name",
	"random_female_name",
	"random_noun",
] as const;

export type AddyFormat = (typeof ADDY_FORMATS)[number];

export interface AddyConfig {
	baseUrl?: string;
	/** Required before a create can be made: Addy needs to be told which domain to use. */
	domain?: string;
	/** Omitted by default, which lets the account's own default apply (measured). */
	format?: AddyFormat;
}

const CreateSchema = z.object({ data: z.object({ email: z.string() }) });
// More than `data` comes back, and the rest is what makes a custom domain legible: which of the
// listed domains Addy owns and shares, and which domain the account already prefers.
const DomainsSchema = z.object({
	data: z.array(z.string()),
	sharedDomains: z.array(z.string()).optional(),
	defaultAliasDomain: z.string().optional(),
});
const AccountSchema = z.object({
	data: z.object({
		username: z.string().optional(),
		active_shared_domain_alias_count: z.number().optional(),
		active_shared_domain_alias_limit: z.number().optional(),
	}),
});

/**
 * Addy is a Laravel app and decides between a JSON error and a redirect to its web login by
 * whether the request looks like an API call. Either of these two is enough on its own; both are
 * sent because the failure mode is a redirect to an HTML page with no CORS, which reaches the
 * browser as an opaque error rather than "bad key".
 */
function headers(key: string): Record<string, string> {
	return {
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
		Accept: "application/json",
		"X-Requested-With": "XMLHttpRequest",
	};
}

const trimBase = (url: string) => url.replace(/\/+$/, "");

export function createAddyClient(cfg: AddyConfig, apiKey: string): AliasClient {
	const base = trimBase(cfg.baseUrl || ADDY_DEFAULT_BASE_URL);
	const h = headers(apiKey);

	return {
		async verify(): Promise<AliasAccount> {
			const res = await request(`${base}/api/v1/account-details`, { headers: h }, AccountSchema);
			const d = res.data;
			// Both halves or neither: a used count with no limit cannot be rendered as an allowance,
			// and inventing one would misreport how much room is left.
			const quota =
				d.active_shared_domain_alias_count !== undefined &&
				d.active_shared_domain_alias_limit !== undefined
					? {
							used: d.active_shared_domain_alias_count,
							limit: d.active_shared_domain_alias_limit,
						}
					: undefined;
			return { label: d.username, quota };
		},

		async domains(): Promise<AliasDomains> {
			const res = await request(`${base}/api/v1/domain-options`, { headers: h }, DomainsSchema);
			// `data` is every domain this account may use: Addy's shared ones, the user's own
			// subdomains, and any custom domain they have added. `sharedDomains` is the subset the
			// allowance is counted over, so anything absent from it is the user's own and unlimited.
			const shared = new Set(res.sharedDomains ?? res.data);
			return {
				options: res.data.map((domain) => ({ domain, shared: shared.has(domain) })),
				default: res.defaultAliasDomain,
			};
		},

		async create(req: AliasRequest): Promise<AliasResult> {
			// Addy cannot generate without being told a domain, so an unconfigured provider fails
			// here rather than sending a request that can only be rejected.
			if (!cfg.domain) {
				throw new AliasError("config", "Choose an Addy domain before generating an alias.");
			}
			const res = await request(
				`${base}/api/v1/aliases`,
				{
					method: "POST",
					headers: h,
					// `format` is only sent when the user picked one: omitted, Addy applies the
					// account's own default, which is the better answer than any we could impose.
					body: {
						domain: cfg.domain,
						...(cfg.format ? { format: cfg.format } : {}),
						...(req.description ? { description: req.description } : {}),
					},
				},
				CreateSchema,
			);
			return { address: res.data.email };
		},
	};
}
