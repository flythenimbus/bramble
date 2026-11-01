import { type ZodType, z } from "zod";
import {
	fetchTransport,
	type HttpResponse,
	type HttpTransport,
	TRANSFER_INTERRUPTED,
} from "../adapters/http";
import { AliasError, type AliasErrorKind } from "./types";

// The one place an alias provider is spoken to. Every provider goes through `request` so the
// transport rules hold everywhere rather than per client. See docs/email-aliases.md.

/**
 * A provider's error body. Addy and SimpleLogin answer with `{ message }`, DuckDuckGo with
 * `{ error }`, and Firefox Relay with Django REST Framework's `{ detail }`, which is also where
 * its free-plan mask limit is explained, so dropping it would leave that user with no reason.
 */
const ErrorBodySchema = z.object({
	message: z.string().optional(),
	error: z.string().optional(),
	detail: z.string().optional(),
});

/** The provider's own words, when it gave any. Never assembled from the status. */
function providerMessage(body: unknown): string | undefined {
	const parsed = ErrorBodySchema.safeParse(body);
	if (!parsed.success) return undefined;
	const m = parsed.data.message?.trim() || parsed.data.error?.trim() || parsed.data.detail?.trim();
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

/** A failure the provider reported inside a 2xx, worded as `request` words the same kind. */
export function providerFailure(kind: AliasErrorKind, providerMessage?: string): AliasError {
	return new AliasError(kind, FALLBACK[kind], { providerMessage });
}

/** Not "could not reach": the request may have landed, so the user is told to check before retrying. */
const INTERRUPTED_MESSAGE =
	"Bramble was closed before the provider answered. Check your provider before trying again, in case the alias was made.";

export interface AliasRequestInit {
	method?: string;
	headers: Record<string, string>;
	body?: unknown;
}

/**
 * One request to a provider, validated into `schema`.
 *
 * `transport` decides how it reaches the network, and defaults to `fetch` for the platforms that
 * can. The desktop and mobile pass their own because their webviews cannot reach a provider that
 * sends no CORS headers. The two rules every provider shares (no ambient cookies, no redirect
 * following) are the transport's to keep, and every implementation keeps them: see adapters/http
 * for why each one is load-bearing.
 */
export async function request<T>(
	url: string,
	init: AliasRequestInit,
	schema: ZodType<T>,
	transport: HttpTransport = fetchTransport,
): Promise<T> {
	let res: HttpResponse;
	try {
		res = await transport.send({
			method: init.method ?? "GET",
			url,
			headers: init.headers,
			body:
				init.body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(init.body)),
		});
	} catch (e) {
		// Bramble was left before the provider answered; the provider may or may not have made it.
		if (e instanceof Error && e.message === TRANSFER_INTERRUPTED) {
			throw new AliasError("network", INTERRUPTED_MESSAGE);
		}
		// Offline, DNS, TLS, or a CORS refusal. All indistinguishable from here, and all mean the
		// same thing to a user: the provider was not reached, so nothing was created.
		throw new AliasError("network", FALLBACK.network, {
			providerMessage: e instanceof Error ? e.message : undefined,
		});
	}

	// A redirect is never followed, so one has to be recognised here. `fetch` reports it as an
	// opaque response with status 0; a native transport, having no opaque responses, returns the
	// real 3xx. Both mean the session was rejected.
	if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
		throw new AliasError("auth", FALLBACK.auth, { status: res.status });
	}

	const raw = new TextDecoder().decode(res.body);
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

/**
 * `request` bound to one transport, so a client names it once rather than at every call site.
 *
 * `undefined` is the ordinary case and means `fetch`, which keeps a client that never sees a
 * transport identical to one written before there was such a thing.
 */
export function requestVia(transport?: HttpTransport) {
	return <T>(url: string, init: AliasRequestInit, schema: ZodType<T>): Promise<T> =>
		request(url, init, schema, transport);
}
