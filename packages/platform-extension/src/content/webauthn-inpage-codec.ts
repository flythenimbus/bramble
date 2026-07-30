// Pure codec for the Firefox passkey provider's MAIN-world override. Two directions:
//  - options -> JSON: serialize the live PublicKeyCredential{Creation,Request}Options into
//    the base64url JSON shape the background's parseCreationOptions/parseRequestOptions read
//    (the same shape Chrome's proxy hands us as requestDetailsJson).
//  - JSON -> credential: rebuild a synthetic PublicKeyCredential from the background's
//    RegistrationResponseJSON / AuthenticationResponseJSON, materializing real ArrayBuffers
//    in the page's realm (the page's WebAuthn glue expects ArrayBuffers, not typed arrays).
//
// Transporting base64url STRINGS (never buffers) over postMessage sidesteps the
// structured-clone-copies-typed-arrays gotcha entirely: buffers are only ever built here,
// in the page realm. Kept import-free (self-contained base64url) so the content bundle
// stays flat. See docs/firefox-port.md.

// ---- base64url <-> bytes (self-contained: no @core import, to keep the bundle flat) ----

function bufToB64Url(src: ArrayBuffer | ArrayBufferView): string {
	const bytes =
		src instanceof ArrayBuffer
			? new Uint8Array(src)
			: new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToBuf(b64url: string): ArrayBuffer {
	const pad = b64url.length % 4;
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + (pad ? "=".repeat(4 - pad) : "");
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out.buffer;
}

// ---- options -> JSON (only the fields the background reads; extras are harmless) ----

function mapCredDescriptors(list: readonly PublicKeyCredentialDescriptor[] | undefined) {
	return (list ?? []).map((c) => ({
		type: c.type,
		id: bufToB64Url(c.id),
		transports: c.transports,
	}));
}

export function serializeCreateOptions(pk: PublicKeyCredentialCreationOptions): unknown {
	return {
		rp: { id: pk.rp?.id, name: pk.rp?.name },
		user: {
			id: bufToB64Url(pk.user.id),
			name: pk.user.name,
			displayName: pk.user.displayName,
		},
		challenge: bufToB64Url(pk.challenge),
		pubKeyCredParams: (pk.pubKeyCredParams ?? []).map((p) => ({ type: p.type, alg: p.alg })),
		excludeCredentials: mapCredDescriptors(pk.excludeCredentials),
		authenticatorSelection: pk.authenticatorSelection,
		attestation: pk.attestation,
		timeout: pk.timeout,
	};
}

export function serializeGetOptions(pk: PublicKeyCredentialRequestOptions): unknown {
	return {
		challenge: bufToB64Url(pk.challenge),
		rpId: pk.rpId,
		allowCredentials: mapCredDescriptors(pk.allowCredentials),
		userVerification: pk.userVerification,
		timeout: pk.timeout,
	};
}

// ---- JSON -> synthetic PublicKeyCredential ----

interface RegistrationResponseJSON {
	id: string;
	rawId: string;
	type: string;
	authenticatorAttachment?: string;
	response: {
		clientDataJSON: string;
		attestationObject: string;
		authenticatorData: string;
		transports?: string[];
		publicKeyAlgorithm: number;
		publicKey?: string;
	};
	clientExtensionResults?: Record<string, unknown>;
}

interface AuthenticationResponseJSON {
	id: string;
	rawId: string;
	type: string;
	authenticatorAttachment?: string;
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle: string | null;
	};
	clientExtensionResults?: Record<string, unknown>;
}

// Adopt the real WebAuthn prototype so `instanceof PublicKeyCredential` (and the response
// subtypes) pass in RP libraries. Own data properties/methods shadow the prototype's
// accessors (which would throw on a synthetic instance). No-op when the ctor is absent
// (e.g. jsdom under vitest), where the plain shape is still correct.
function adoptPrototype(obj: object, ctorName: string): void {
	const ctor = (globalThis as Record<string, unknown>)[ctorName];
	const proto = typeof ctor === "function" ? (ctor as { prototype?: object }).prototype : undefined;
	if (proto) {
		try {
			Object.setPrototypeOf(obj, proto);
		} catch {}
	}
}

export function buildCreateCredential(json: RegistrationResponseJSON): PublicKeyCredential {
	const r = json.response;
	const response = {
		clientDataJSON: b64UrlToBuf(r.clientDataJSON),
		attestationObject: b64UrlToBuf(r.attestationObject),
		getAuthenticatorData: () => b64UrlToBuf(r.authenticatorData),
		getPublicKey: () => (r.publicKey ? b64UrlToBuf(r.publicKey) : null),
		getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
		getTransports: () => r.transports ?? [],
	};
	adoptPrototype(response, "AuthenticatorAttestationResponse");
	const cred = {
		id: json.id,
		rawId: b64UrlToBuf(json.rawId),
		type: json.type,
		authenticatorAttachment: json.authenticatorAttachment ?? "platform",
		response,
		getClientExtensionResults: () => json.clientExtensionResults ?? {},
		toJSON: () => json,
	};
	adoptPrototype(cred, "PublicKeyCredential");
	return cred as unknown as PublicKeyCredential;
}

export function buildGetCredential(json: AuthenticationResponseJSON): PublicKeyCredential {
	const r = json.response;
	const response = {
		clientDataJSON: b64UrlToBuf(r.clientDataJSON),
		authenticatorData: b64UrlToBuf(r.authenticatorData),
		signature: b64UrlToBuf(r.signature),
		userHandle: r.userHandle ? b64UrlToBuf(r.userHandle) : null,
	};
	adoptPrototype(response, "AuthenticatorAssertionResponse");
	const cred = {
		id: json.id,
		rawId: b64UrlToBuf(json.rawId),
		type: json.type,
		authenticatorAttachment: json.authenticatorAttachment ?? "platform",
		response,
		getClientExtensionResults: () => json.clientExtensionResults ?? {},
		toJSON: () => json,
	};
	adoptPrototype(cred, "PublicKeyCredential");
	return cred as unknown as PublicKeyCredential;
}
