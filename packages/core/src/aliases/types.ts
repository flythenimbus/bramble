// Per-site email aliases from a provider the user already has an account with.
// See docs/email-aliases.md.

export type AliasProviderId = "addy" | "simplelogin";

/** What a create needs from the caller. Everything is optional: a provider can always mint an
 * address with no context, and the context only makes it identifiable later. */
export interface AliasRequest {
	/**
	 * The site the alias is being made for, as a hostname.
	 *
	 * Passed through as given rather than reduced to a registrable domain here, because the
	 * providers do their own reduction: SimpleLogin turned `bramble-spike.example.com` into an
	 * `example.` prefix server-side. Reducing it first would need a public-suffix list in `core`
	 * to arrive at the same answer.
	 */
	site?: string;
	/** Free text stored alongside the alias at the provider, so it is identifiable in their UI. */
	description?: string;
}

export interface AliasResult {
	/** The address the provider created. The only thing a caller actually needs. */
	address: string;
}

/** What `verify` learned about the account, for the settings screen to show. */
export interface AliasAccount {
	/** Something identifying, when the provider says: an account email, a plan name. */
	label?: string;
	/** Aliases used against the allowance, when the provider reports both. Addy does. */
	quota?: { used: number; limit: number };
}

/**
 * Why a call failed, in terms a UI can act on.
 *
 * Split out from the message because the remedies differ and nothing else distinguishes them:
 * measured, one provider answers a valid key on an unverified account with `401`, and another
 * answers a valid key on a free plan with `402`. A client that folds every non-2xx into "could
 * not create an alias" sends both users to re-check a key that was never the problem.
 */
export type AliasErrorKind =
	/** The key was rejected, or the account is not in a state that can use it. */
	| "auth"
	/** The provider's plan does not include this. Not a quota, and not fixable by waiting. */
	| "payment"
	/** The account's alias allowance is spent. */
	| "quota"
	/** Too many requests; the same call may work later. */
	| "rate-limit"
	/** The request never got an answer: offline, DNS, TLS, or a CORS refusal. */
	| "network"
	/** The provider answered, unhappily, and none of the above fits. */
	| "provider"
	/** We cannot even form the request: no domain chosen, no key stored. */
	| "config";

export class AliasError extends Error {
	readonly kind: AliasErrorKind;
	readonly status?: number;
	/**
	 * The provider's own explanation, verbatim, or undefined when it did not give one.
	 *
	 * Kept apart from `message` so the UI can render it as plain text and nothing else. It is
	 * remote-controlled string data: the one measured `402` arrived carrying an upgrade URL, and
	 * auto-linking a URL chosen by a remote server, on the screen where a user has just been
	 * asked for a credential, builds a phishing surface out of an error path.
	 */
	readonly providerMessage?: string;

	constructor(
		kind: AliasErrorKind,
		message: string,
		opts: { status?: number; providerMessage?: string } = {},
	) {
		super(message);
		this.name = "AliasError";
		this.kind = kind;
		this.status = opts.status;
		this.providerMessage = opts.providerMessage;
	}
}

/** One domain an account may create aliases under. */
export interface AliasDomainOption {
	domain: string;
	/**
	 * A domain the provider owns and shares with everyone, rather than one of the user's own.
	 *
	 * Worth distinguishing because an allowance is usually counted over shared domains only:
	 * Addy's limit is literally `active_shared_domain_alias_limit`, and aliases on a domain or
	 * subdomain the user owns do not touch it. A UI that shows one number for both would tell
	 * someone with a custom domain they are nearly out when they have no limit at all.
	 */
	shared: boolean;
}

export interface AliasDomains {
	options: AliasDomainOption[];
	/** The account's own default, so the settings screen can preselect rather than ask. */
	default?: string;
}

/**
 * One provider's API, as the rest of the app sees it.
 *
 * `domains` is optional because a provider may have nothing to choose; the descriptor says
 * whether to ask (see descriptors.ts) so no caller switches on provider id.
 */
export interface AliasClient {
	/** Check the stored key and report what the account allows. Read-only: never creates. */
	verify(): Promise<AliasAccount>;
	/** Create one alias. The call that costs quota, so callers make it on an explicit gesture. */
	create(req: AliasRequest): Promise<AliasResult>;
	/** The domains this account may create under, including any the user brought themselves. */
	domains?(): Promise<AliasDomains>;
}
