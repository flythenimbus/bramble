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

// SimpleLogin. Self-hostable, so the base URL is configuration.
// See docs/email-aliases.md.

export const SIMPLELOGIN_DEFAULT_BASE_URL = "https://app.simplelogin.io";

/**
 * How the local part is built, on SimpleLogin's own shared domains.
 *
 * Not a cosmetic choice. Measured, `word` lifts the site name into the address: a create for
 * `bramble-spike.example.com` returned `example.reentry351@simplelogin.com`. That is legible in
 * your own inbox and it also tells anyone who sees the address where it is used, which is a real
 * loss for a feature whose purpose is compartmentalization. `uuid` reveals nothing.
 */
export const SIMPLELOGIN_MODES = ["word", "uuid"] as const;

export type SimpleLoginMode = (typeof SIMPLELOGIN_MODES)[number];

export interface SimpleLoginConfig {
	baseUrl?: string;
	/** Omitted by default, which lets the account's own setting apply. Shared domains only. */
	mode?: SimpleLoginMode;
	/**
	 * A specific domain to create under, including a custom one the user owns.
	 *
	 * Unset means the random endpoint and whatever domain the account defaults to, which is the
	 * cheapest path and the one most people want. Set, creation moves to the custom endpoint,
	 * which is the only way to reach a domain of the user's own.
	 */
	domain?: string;
}

const RandomSchema = z.object({ email: z.string() });
const UserSchema = z.object({
	email: z.string().optional(),
	is_premium: z.boolean().optional(),
});
const OptionsSchema = z.object({
	can_create: z.boolean().optional(),
	prefix_suggestion: z.string().optional(),
	suffixes: z.array(
		z.object({
			suffix: z.string(),
			signed_suffix: z.string(),
			is_custom: z.boolean().optional(),
		}),
	),
});
const MailboxesSchema = z.object({
	mailboxes: z.array(z.object({ id: z.number(), default: z.boolean().optional() })),
});

/** `Authentication`, not `Authorization`, and the bare key with no `Bearer` prefix. Getting this
 * wrong fails as a 401 that looks exactly like a bad key. */
function headers(key: string): Record<string, string> {
	return { Authentication: key, "Content-Type": "application/json" };
}

const trimBase = (url: string) => url.replace(/\/+$/, "");

/** The domain half of a suffix: `.angriness537@simplelogin.com` -> `simplelogin.com`. */
function domainOf(suffix: string): string {
	const at = suffix.lastIndexOf("@");
	return at === -1 ? suffix : suffix.slice(at + 1);
}

/** A short random token, for the cases where the prefix has to supply the uniqueness itself. */
function randomToken(): string {
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SimpleLogin accepts a limited alias prefix, so a hostname-derived suggestion is reduced to
 * what it will take rather than sent as-is and rejected. */
function sanitizePrefix(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

export function createSimpleLoginClient(cfg: SimpleLoginConfig, apiKey: string): AliasClient {
	const base = trimBase(cfg.baseUrl || SIMPLELOGIN_DEFAULT_BASE_URL);
	const h = headers(apiKey);

	const optionsUrl = (site?: string) =>
		`${base}/api/v5/alias/options${site ? `?hostname=${encodeURIComponent(site)}` : ""}`;

	/** The random endpoint: one call, the account's default domain, no naming decisions. */
	async function createRandom(req: AliasRequest): Promise<AliasResult> {
		const params = new URLSearchParams();
		// A query parameter, not a body field. It annotates the alias in the user's dashboard and,
		// in `word` mode, shapes the visible local part.
		if (req.site) params.set("hostname", req.site);
		if (cfg.mode) params.set("mode", cfg.mode);
		const query = params.toString();
		const res = await request(
			`${base}/api/alias/random/new${query ? `?${query}` : ""}`,
			{
				method: "POST",
				headers: h,
				body: { ...(req.description ? { note: req.description } : {}) },
			},
			RandomSchema,
		);
		return { address: res.email };
	}

	/**
	 * The custom endpoint, which is the only route to a domain the user owns.
	 *
	 * Three calls where the random path takes one: the suffix must be fetched signed (the
	 * signature is what stops a client naming an arbitrary domain), and a mailbox id is required
	 * and only knowable from the account. Acceptable because this is a click-only action, but it
	 * is why the random path stays the default rather than being replaced by this one.
	 */
	async function createOnDomain(req: AliasRequest, domain: string): Promise<AliasResult> {
		const [opts, boxes] = await Promise.all([
			request(optionsUrl(req.site), { headers: h }, OptionsSchema),
			request(`${base}/api/v2/mailboxes`, { headers: h }, MailboxesSchema),
		]);
		if (opts.can_create === false) {
			throw new AliasError("quota", "This SimpleLogin account cannot create more aliases.");
		}
		const match = opts.suffixes.find((s) => domainOf(s.suffix) === domain);
		if (!match) {
			// The domain was configured and has since gone away, or belongs to another account.
			// Saying which is not something we can know, so the remedy is named instead.
			throw new AliasError(
				"config",
				`SimpleLogin no longer offers ${domain}. Choose another in Settings.`,
			);
		}
		const mailbox = boxes.mailboxes.find((m) => m.default) ?? boxes.mailboxes[0];
		if (!mailbox) throw new AliasError("config", "This SimpleLogin account has no mailbox.");

		// A shared suffix already carries its own random word (`.angriness537@simplelogin.com`), so
		// the site name alone is unique enough. A custom domain's suffix is bare (`@example.com`),
		// so the prefix has to supply the uniqueness or the second alias for a site collides.
		const stem = sanitizePrefix(opts.prefix_suggestion || req.site || "");
		const needsEntropy = match.is_custom === true;
		const prefix = needsEntropy
			? `${stem ? `${stem}-` : ""}${randomToken()}`
			: stem || randomToken();

		const res = await request(
			`${base}/api/v3/alias/custom/new${req.site ? `?hostname=${encodeURIComponent(req.site)}` : ""}`,
			{
				method: "POST",
				headers: h,
				body: {
					alias_prefix: prefix,
					signed_suffix: match.signed_suffix,
					mailbox_ids: [mailbox.id],
					...(req.description ? { note: req.description } : {}),
				},
			},
			RandomSchema,
		);
		return { address: res.email };
	}

	return {
		async verify(): Promise<AliasAccount> {
			// No allowance is reported anywhere in this API, so `quota` stays undefined rather than
			// being inferred from the premium flag, which is not the same question.
			const res = await request(`${base}/api/user_info`, { headers: h }, UserSchema);
			return { label: res.email };
		},

		async domains(): Promise<AliasDomains> {
			const opts = await request(optionsUrl(), { headers: h }, OptionsSchema);
			const seen = new Set<string>();
			const options = [];
			for (const s of opts.suffixes) {
				const domain = domainOf(s.suffix);
				// The same domain can appear under several suffixes; the first wins, and a domain is
				// the user's own if any of its suffixes says so.
				if (seen.has(domain)) continue;
				seen.add(domain);
				options.push({ domain, shared: s.is_custom !== true });
			}
			return { options };
		},

		create: (req) => (cfg.domain ? createOnDomain(req, cfg.domain) : createRandom(req)),
	};
}
