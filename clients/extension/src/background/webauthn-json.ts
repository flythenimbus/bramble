// Pure WebAuthn JSON helpers for the passkey provider (chrome.webAuthenticationProxy).
// The proxy hands us PublicKeyCredential{Creation,Request}OptionsJSON and wants back a
// PublicKeyCredential.toJSON() string. The Rust crypto core works in STANDARD base64;
// the WebAuthn wire format is base64url. This module owns every conversion and the
// security-critical origin -> rpId check, so the background handler stays thin and the
// error-prone encoding is unit-tested. See docs/passkey-provider.md.

import { base64ToBase64Url, base64UrlToBytes, bytesToBase64Url } from "@core/util/bytes";
import { etld1 } from "../etld1";

// base64 <-> base64url conversions live in @core/util/bytes (the single home for byte
// encoding). This module is WebAuthn-specific: clientData, response assembly, rpId.

// ---- request parsing ----

type UserVerification = "required" | "preferred" | "discouraged";

/** WebAuthn PRF inputs or results, base64url as on the wire. See docs/passkey-prf.md. */
export interface PrfValues {
	first: string;
	second?: string;
}

export interface ParsedCreationOptions {
	rpId?: string;
	rpName?: string;
	userHandleB64Url: string;
	userName?: string;
	userDisplayName?: string;
	/** base64url challenge, reused verbatim in clientData. */
	challenge: string;
	algs: number[];
	excludeCredentialsB64Url: string[];
	userVerification: UserVerification;
	/** Present when the site asked for PRF. */
	prf?: { eval?: PrfValues };
}

export interface ParsedRequestOptions {
	rpId?: string;
	challenge: string;
	allowCredentialsB64Url: string[];
	userVerification: UserVerification;
	/** `evalByCredential` keys are base64url credential ids. */
	prf?: { eval?: PrfValues; evalByCredential?: Record<string, PrfValues> };
}

/** The page that made a request: Chrome's stamp on a proxied one, or Firefox's message sender. */
export interface RequestCaller {
	origin: string;
	/** A cross-origin iframe; WebAuthn records that in clientData. */
	crossOrigin: boolean;
}

/**
 * The real requester of a proxied request. Chrome stamps every request it hands the proxy with
 * `extensions.remoteDesktopClientOverride` (authenticator_common_impl.cc) and refuses to proxy one
 * a page stamped itself, so a page can't forge it. Null when absent or not a web origin.
 */
export function proxyCaller(json: string): RequestCaller | null {
	try {
		const ext = options(json).extensions;
		const stamp = isRecord(ext) ? ext.remoteDesktopClientOverride : undefined;
		if (!isRecord(stamp) || typeof stamp.origin !== "string") return null;
		const url = new URL(stamp.origin);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return { origin: url.origin, crossOrigin: stamp.sameOriginWithAncestors === false };
	} catch {
		return null;
	}
}

// Chrome's requestDetailsJson is the W3C options object; tolerate it at the root or nested
// under `publicKey`.
function options(json: string): Record<string, unknown> {
	const root = JSON.parse(json) as Record<string, unknown>;
	return (root.publicKey as Record<string, unknown>) ?? root;
}

export function parseCreationOptions(json: string): ParsedCreationOptions {
	const opts = options(json);
	const rp = (opts.rp as { id?: string; name?: string }) ?? {};
	const user = (opts.user as { id?: string; name?: string; displayName?: string }) ?? {};
	const params = (opts.pubKeyCredParams as { alg?: number }[]) ?? [];
	const sel = (opts.authenticatorSelection as { userVerification?: UserVerification }) ?? {};
	const exclude = (opts.excludeCredentials as { id?: string }[]) ?? [];
	return {
		rpId: rp.id,
		rpName: rp.name,
		userHandleB64Url: user.id ?? "",
		userName: user.name,
		userDisplayName: user.displayName,
		challenge: (opts.challenge as string) ?? "",
		algs: params.map((p) => p.alg).filter((a): a is number => typeof a === "number"),
		excludeCredentialsB64Url: exclude.map((c) => c.id).filter((id): id is string => !!id),
		userVerification: sel.userVerification ?? "preferred",
		prf: creationPrf(opts),
	};
}

export function parseRequestOptions(json: string): ParsedRequestOptions {
	const opts = options(json);
	const allow = (opts.allowCredentials as { id?: string }[]) ?? [];
	return {
		rpId: opts.rpId as string | undefined,
		challenge: (opts.challenge as string) ?? "",
		allowCredentialsB64Url: allow.map((c) => c.id).filter((id): id is string => !!id),
		userVerification: (opts.userVerification as UserVerification) ?? "preferred",
		prf: requestPrf(opts),
	};
}

// ---- PRF (page-supplied, so anything malformed is treated as absent rather than thrown) ----

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** `s` decoded leniently (padding, the + / alphabet) and re-encoded canonically; null if not base64. */
function canonicalB64Url(s: string): string | null {
	try {
		const url = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		return bytesToBase64Url(base64UrlToBytes(url));
	} catch {
		return null;
	}
}

// A salt must already be canonical: every platform then decodes it to the same bytes, where a
// lenient decoder on one and a strict one on another would derive different keys (or none).
const isCanonicalSalt = (v: unknown): v is string =>
	typeof v === "string" && canonicalB64Url(v) === v;

function prfValues(v: unknown): PrfValues | undefined {
	if (!isRecord(v) || !isCanonicalSalt(v.first)) return undefined;
	if (v.second === undefined) return { first: v.first };
	return isCanonicalSalt(v.second) ? { first: v.first, second: v.second } : undefined;
}

function prfExtension(opts: Record<string, unknown>): Record<string, unknown> | undefined {
	const ext = opts.extensions;
	return isRecord(ext) && isRecord(ext.prf) ? ext.prf : undefined;
}

function creationPrf(opts: Record<string, unknown>): ParsedCreationOptions["prf"] {
	const prf = prfExtension(opts);
	if (!prf) return undefined;
	const first = prfValues(prf.eval);
	return first ? { eval: first } : {};
}

function requestPrf(opts: Record<string, unknown>): ParsedRequestOptions["prf"] {
	const prf = prfExtension(opts);
	if (!prf) return undefined;
	const out: NonNullable<ParsedRequestOptions["prf"]> = {};
	const fallback = prfValues(prf.eval);
	if (fallback) out.eval = fallback;
	if (isRecord(prf.evalByCredential)) {
		// Keyed by the id's canonical spelling, so a padded or + / key still matches its credential.
		// fromEntries defines own properties, so a "__proto__" key can't rewire the lookup table.
		const byCredential = Object.fromEntries(
			Object.entries(prf.evalByCredential).flatMap(([id, v]) => {
				const key = canonicalB64Url(id);
				const values = prfValues(v);
				return key && values ? [[key, values] as const] : [];
			}),
		);
		if (Object.keys(byCredential).length) out.evalByCredential = byCredential;
	}
	return out;
}

/** The inputs for one credential: its own `evalByCredential` entry, else `eval`. */
export function prfInputsFor(
	prf: ParsedRequestOptions["prf"],
	credentialIdB64Url: string,
): PrfValues | undefined {
	const byCredential = prf?.evalByCredential;
	if (byCredential && Object.hasOwn(byCredential, credentialIdB64Url)) {
		return byCredential[credentialIdB64Url];
	}
	return prf?.eval;
}

// ---- origin -> rpId (phishing resistance, the highest-risk check in the feature) ----

export function originHostname(origin: string): string {
	return new URL(origin).hostname.toLowerCase();
}

/** Default rpId per WebAuthn: the origin's full effective domain (not the eTLD+1). */
export function defaultRpId(originHost: string): string {
	return originHost.toLowerCase();
}

/**
 * Whether `rpId` is a "registrable domain suffix of, or equal to" the page host.
 * Blocks a page on evil.com from minting/using a passkey for google.com, and blocks
 * a bare public suffix (`com`, `co.uk`) as rpId via tldts. `localhost` allowed for dev.
 */
export function isRegistrableSuffix(originHost: string, rpId: string): boolean {
	if (!rpId) return false;
	const host = originHost.toLowerCase();
	const id = rpId.toLowerCase();
	if (host !== id && !host.endsWith(`.${id}`)) return false;
	if (id === "localhost") return true;
	return etld1(id) !== null;
}

// ---- clientData + responses ----

export interface ClientData {
	json: string;
	bytes: Uint8Array;
	b64Url: string;
}

export function buildClientData(
	type: "webauthn.create" | "webauthn.get",
	challengeB64Url: string,
	caller: RequestCaller,
): ClientData {
	const json = JSON.stringify({
		type,
		challenge: challengeB64Url,
		origin: caller.origin,
		crossOrigin: caller.crossOrigin,
	});
	const bytes = new TextEncoder().encode(json);
	return { json, bytes, b64Url: bytesToBase64Url(bytes) };
}

/**
 * Build the RegistrationResponseJSON (PublicKeyCredential.toJSON shape) for
 * completeCreateRequest. Chrome validates against the W3C dictionary, which requires
 * `authenticatorData` and `publicKeyAlgorithm` alongside attestationObject (publicKey is
 * optional and omitted).
 */
export function registrationResponseJSON(p: {
	credentialIdStdB64: string;
	attestationObjectStdB64: string;
	authenticatorDataStdB64: string;
	publicKeyStdB64: string;
	clientDataB64Url: string;
	transports?: string[];
	prf?: { enabled: boolean; results?: PrfValues };
}): string {
	const id = base64ToBase64Url(p.credentialIdStdB64);
	return JSON.stringify({
		id,
		rawId: id,
		type: "public-key",
		authenticatorAttachment: "platform",
		response: {
			clientDataJSON: p.clientDataB64Url,
			attestationObject: base64ToBase64Url(p.attestationObjectStdB64),
			authenticatorData: base64ToBase64Url(p.authenticatorDataStdB64),
			transports: p.transports ?? ["internal", "hybrid"],
			publicKeyAlgorithm: COSE_ES256,
			publicKey: base64ToBase64Url(p.publicKeyStdB64),
		},
		clientExtensionResults: p.prf ? { prf: p.prf } : {},
	});
}

/** Build the AuthenticationResponseJSON for completeGetRequest. */
export function authenticationResponseJSON(p: {
	credentialIdStdB64: string;
	authenticatorDataStdB64: string;
	signatureStdB64: string;
	clientDataB64Url: string;
	userHandleStdB64?: string;
	prf?: { results: PrfValues };
}): string {
	const id = base64ToBase64Url(p.credentialIdStdB64);
	return JSON.stringify({
		id,
		rawId: id,
		type: "public-key",
		authenticatorAttachment: "platform",
		response: {
			clientDataJSON: p.clientDataB64Url,
			authenticatorData: base64ToBase64Url(p.authenticatorDataStdB64),
			signature: base64ToBase64Url(p.signatureStdB64),
			userHandle: p.userHandleStdB64 ? base64ToBase64Url(p.userHandleStdB64) : null,
		},
		clientExtensionResults: p.prf ? { prf: p.prf } : {},
	});
}

/** COSE algorithm id for ES256, the only algorithm the core mints today. */
export const COSE_ES256 = -7;
