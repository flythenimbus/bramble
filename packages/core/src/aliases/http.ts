import { type ZodType, z } from "zod";
import { AliasError, type AliasErrorKind } from "./types";

// The one place an alias provider is spoken to. Every provider goes through `request` so the
// transport rules hold everywhere rather than per client. See docs/email-aliases.md.

/** A provider's error body. All four measured providers answer with `{ message }`. */
const ErrorBodySchema = z.object({
	message: z.string().optional(),
	error: z.string().optional(),
});

/** The provider's own words, when it gave any. Never assembled from the status. */
function providerMessage(body: unknown): string | undefined {
	const parsed = ErrorBodySchema.safeParse(body);
	if (!parsed.success) return undefined;
	const m = parsed.data.message?.trim() || parsed.data.error?.trim();
	return m || undefined;
}

/**
 * What a status means, before the provider's own words are added.
 *
 * `402` is deliberately its own kind rather than folded into `auth`: it is what a valid key on a
 * free plan gets, and telling that user to check their key is a dead end. `403` joins `auth`
 * because a token without the right scope is an authorization problem the user fixes at the
 * provider, the same place a bad key is fixed.
 */
function kindForStatus(status: number): AliasErrorKind {
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "payment";
	if (status === 429) return "rate-limit";
	return "provider";
}

const FALLBACK: Record<AliasErrorKind, string> = {
	auth: "The provider rejected this API key.",
	payment: "This provider's plan does not include alias creation.",
	quota: "This account has no alias allowance left.",
	"rate-limit": "The provider is rate-limiting requests. Try again shortly.",
	network: "Could not reach the provider.",
	provider: "The provider could not create an alias.",
	config: "This provider needs more setup before it can create an alias.",
};

export interface AliasRequestInit {
	method?: string;
	headers: Record<string, string>;
	body?: unknown;
}

/**
 * One request to a provider, validated into `schema`.
 *
 * The two transport rules every provider shares are enforced here so no client can forget one.
 * Cookies are never sent: the token in a header is the only credential, and an ambient session
 * for the same host has already cost this repo a day once (1255ab7b). Redirects are never
 * followed: a redirect out of an API call means the session was rejected and its destination is
 * an HTML login page with no CORS, so chasing it turns a clean "bad key" into an opaque failure.
 */
export async function request<T>(
	url: string,
	init: AliasRequestInit,
	schema: ZodType<T>,
): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url, {
			method: init.method ?? "GET",
			headers: init.headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			credentials: "omit",
			redirect: "manual",
		});
	} catch (e) {
		// Offline, DNS, TLS, or a CORS refusal. All indistinguishable from here, and all mean the
		// same thing to a user: the provider was not reached, so nothing was created.
		throw new AliasError("network", FALLBACK.network, {
			providerMessage: e instanceof Error ? e.message : undefined,
		});
	}

	// `redirect: "manual"` surfaces as an opaque response with status 0, not as a 3xx.
	if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
		throw new AliasError("auth", FALLBACK.auth, { status: res.status });
	}

	const raw = await res.text();
	let body: unknown;
	try {
		body = raw ? JSON.parse(raw) : undefined;
	} catch {
		body = undefined;
	}

	if (!res.ok) {
		throw new AliasError(kindForStatus(res.status), FALLBACK[kindForStatus(res.status)], {
			status: res.status,
			providerMessage: providerMessage(body),
		});
	}

	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		// A 2xx whose shape we do not recognise. Treated as a provider failure rather than
		// guessed at, because the value on the other side of this is an address about to be
		// written into a vault entry and handed to a website.
		throw new AliasError("provider", "The provider returned an unexpected response.", {
			status: res.status,
		});
	}
	return parsed.data;
}
