// Pure WebAuthn JSON helpers for the passkey provider (chrome.webAuthenticationProxy).
// The proxy hands us PublicKeyCredential{Creation,Request}OptionsJSON and wants back a
// PublicKeyCredential.toJSON() string. The Rust crypto core works in STANDARD base64;
// the WebAuthn wire format is base64url. This module owns every conversion and the
// security-critical origin -> rpId check, so the background handler stays thin and the
// error-prone encoding is unit-tested. See docs/passkey-provider.md.

import { base64ToBase64Url, bytesToBase64Url } from "@core/util/bytes";
import { getDomain } from "tldts";

// base64 <-> base64url conversions live in @core/util/bytes (the single home for byte
// encoding). This module is WebAuthn-specific: clientData, response assembly, rpId.

// ---- request parsing ----

export type UserVerification = "required" | "preferred" | "discouraged";

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
}

export interface ParsedRequestOptions {
	rpId?: string;
	challenge: string;
	allowCredentialsB64Url: string[];
	userVerification: UserVerification;
}

// Chrome's requestDetailsJson is the W3C options object (no origin: that is not part of
// the W3C type, and the proxy events carry no tab). The caller supplies the origin from
// the active tab instead. Tolerate the options at the root or nested under `publicKey`.
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
	};
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
	return getDomain(id) !== null;
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
	origin: string,
): ClientData {
	const json = JSON.stringify({ type, challenge: challengeB64Url, origin, crossOrigin: false });
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
		clientExtensionResults: {},
	});
}

/** Build the AuthenticationResponseJSON for completeGetRequest. */
export function authenticationResponseJSON(p: {
	credentialIdStdB64: string;
	authenticatorDataStdB64: string;
	signatureStdB64: string;
	clientDataB64Url: string;
	userHandleStdB64?: string;
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
		clientExtensionResults: {},
	});
}

/** COSE algorithm id for ES256, the only algorithm the core mints today. */
export const COSE_ES256 = -7;
