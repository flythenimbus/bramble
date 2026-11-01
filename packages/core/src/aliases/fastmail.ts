import { z } from "zod";
import type { HttpTransport } from "../adapters/http";
import { providerFailure, requestVia } from "./http";
import {
	type AliasAccount,
	type AliasClient,
	AliasError,
	type AliasErrorKind,
	type AliasRequest,
	type AliasResult,
} from "./types";

// Fastmail Masked Email, over JMAP: a session request names the API URL and the account, then one
// method call does the work. Hosted only. See docs/email-aliases.md.

export const FASTMAIL_DEFAULT_BASE_URL = "https://api.fastmail.com";

const CORE = "urn:ietf:params:jmap:core";
const MASKED_EMAIL = "https://www.fastmail.com/dev/maskedemail";

/** The one create per request, named so its result can be found in the reply. */
const CREATION_ID = "bramble";

export interface FastmailConfig {
	/** Not offered in the UI: Fastmail is hosted only. Here so a test can point somewhere else. */
	baseUrl?: string;
}

const SessionSchema = z.object({
	apiUrl: z.string(),
	username: z.string().optional(),
	primaryAccounts: z.record(z.string(), z.string()),
});

/** One `[name, arguments, callId]` per method call sent. */
const ReplySchema = z.object({
	methodResponses: z.array(z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()])),
});

const ErrorSchema = z.object({ type: z.string(), description: z.string().optional() });

const SetSchema = z.object({
	created: z.record(z.string(), z.object({ email: z.string() })).nullish(),
	notCreated: z.record(z.string(), ErrorSchema).nullish(),
});

/** Method errors (RFC 8620 3.6.2) that mean this token cannot act on this account. */
const AUTH_METHOD_ERRORS = new Set([
	"forbidden",
	"accountNotFound",
	"accountNotSupportedByMethod",
	"accountReadOnly",
]);

/** SetErrors (RFC 8620 5.3) with a remedy of their own; anything else is the provider's. */
const SET_ERROR_KINDS: Record<string, AliasErrorKind> = {
	forbidden: "auth",
	overQuota: "quota",
	rateLimit: "rate-limit",
};

function headers(key: string): Record<string, string> {
	return {
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
		Accept: "application/json",
	};
}

const trimBase = (url: string) => url.replace(/\/+$/, "");

/**
 * The session names where the token goes next, so it is only followed to the session's own host
 * or a subdomain of it, over https. Measured, it is a per-datacentre host (phl.api.fastmail.com),
 * so same-origin would refuse every real account.
 */
function pinnedApiUrl(apiUrl: string, sessionUrl: string): string {
	const host = new URL(sessionUrl).hostname;
	let url: URL | undefined;
	try {
		url = new URL(apiUrl, sessionUrl);
	} catch {
		url = undefined;
	}
	if (url?.protocol !== "https:" || (url.hostname !== host && !url.hostname.endsWith(`.${host}`))) {
		throw new AliasError(
			"provider",
			"Fastmail named an API address outside its own servers, so Bramble did not send your token there.",
		);
	}
	return url.href;
}

export function createFastmailClient(
	cfg: FastmailConfig,
	apiKey: string,
	transport?: HttpTransport,
): AliasClient {
	const sessionUrl = `${trimBase(cfg.baseUrl || FASTMAIL_DEFAULT_BASE_URL)}/jmap/session`;
	const h = headers(apiKey);
	const call = requestVia(transport);

	async function session() {
		const s = await call(sessionUrl, { headers: h }, SessionSchema);
		const accountId = s.primaryAccounts[MASKED_EMAIL];
		if (!accountId) {
			throw new AliasError(
				"auth",
				"This Fastmail token has no Masked Email access. Create one with Masked Email ticked.",
			);
		}
		return { apiUrl: pinnedApiUrl(s.apiUrl, sessionUrl), accountId, username: s.username };
	}

	/** One method call. JMAP reports a failed method inside a 200, so the reply is read, not the status. */
	async function invoke(
		apiUrl: string,
		method: string,
		args: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const reply = await call(
			apiUrl,
			{
				method: "POST",
				headers: h,
				body: { using: [CORE, MASKED_EMAIL], methodCalls: [[method, args, "0"]] },
			},
			ReplySchema,
		);
		const [name, out] = reply.methodResponses[0] ?? [];
		if (name === "error") {
			const err = ErrorSchema.safeParse(out);
			const kind = err.success && AUTH_METHOD_ERRORS.has(err.data.type) ? "auth" : "provider";
			throw providerFailure(kind, err.success ? err.data.description : undefined);
		}
		if (name !== method || !out) {
			throw new AliasError("provider", "The provider returned an unexpected response.");
		}
		return out;
	}

	return {
		// An empty lookup proves the API host and the account answer, on the path a create takes,
		// without reading a single address.
		async verify(): Promise<AliasAccount> {
			const { apiUrl, accountId, username } = await session();
			await invoke(apiUrl, "MaskedEmail/get", { accountId, ids: [] });
			return { label: username };
		},

		async create(req: AliasRequest): Promise<AliasResult> {
			const { apiUrl, accountId } = await session();
			const out = await invoke(apiUrl, "MaskedEmail/set", {
				accountId,
				create: {
					[CREATION_ID]: {
						// Not the default `pending`, which Fastmail deletes after 24 hours unless mail arrives.
						state: "enabled",
						// An origin, as Fastmail asks. Empty when the site is unknown.
						forDomain: req.site ? `https://${req.site}` : "",
						// Fastmail asks integrators to leave this to the user: it tags incoming mail, and the
						// token's own name already shows as the creator. `req.description` is ours, not theirs.
						description: "",
					},
				},
			});
			const set = SetSchema.safeParse(out);
			const refused = set.success ? set.data.notCreated?.[CREATION_ID] : undefined;
			if (refused) {
				throw providerFailure(SET_ERROR_KINDS[refused.type] ?? "provider", refused.description);
			}
			const email = set.success ? set.data.created?.[CREATION_ID]?.email : undefined;
			if (!email) throw new AliasError("provider", "The provider returned an unexpected response.");
			return { address: email };
		},
	};
}
