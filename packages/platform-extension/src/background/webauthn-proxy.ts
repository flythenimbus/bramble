/// <reference types="chrome" />

// Passkey provider via chrome.webAuthenticationProxy: Bramble acts as the WebAuthn
// authenticator for other sites. The crypto is the shared Rust core (Phase 0); this
// module orchestrates the proxy events around it. The orchestration (handleCreate /
// handleGet) takes injected deps so origin validation, the ES256 check, and response
// assembly are unit-tested; the chrome event/attach wiring stays thin. See
// docs/passkey-provider.md.
//
// STATUS: orchestration + read path implemented and tested. The ceremony UI window and
// the create-time vault write (`savePlacement`) are injected seams, wired in a later
// step; initWebauthnProxy is not yet called from background.ts, so the proxy is dormant
// until a Settings toggle + the ceremony UI land. End-to-end needs a real Chrome.

import type { CryptoAdapter } from "@core/adapters/crypto";
import type { Entry, PasskeyCredential } from "@core/hooks/useVault";
import { base64UrlToBase64 } from "@core/util/bytes";
import { findPasskeys, type PasskeyPlacement, planPasskeyPlacement } from "@core/vault/passkey";
import {
	authenticationResponseJSON,
	buildClientData,
	COSE_ES256,
	defaultRpId,
	isRegistrableSuffix,
	originHostname,
	parseCreationOptions,
	parseRequestOptions,
	registrationResponseJSON,
} from "./webauthn-json";

/** A WebAuthn-shaped failure; surfaced to the page as a DOMException of this name. */
export class WebAuthnError extends Error {
	constructor(
		readonly domName: string,
		message: string,
	) {
		super(message);
		this.name = domName;
	}
}

export interface CeremonyCreateRequest {
	kind: "create";
	rpId: string;
	rpName?: string;
	userName?: string;
	origin: string;
}
export interface CeremonyGetRequest {
	kind: "get";
	rpId: string;
	origin: string;
}
export type CeremonyRequest = CeremonyCreateRequest | CeremonyGetRequest;

/**
 * User-facing ceremony: confirm intent, ensure the vault is unlocked, perform user
 * verification when required, and (for get) let the user pick among matching passkeys.
 * Returns `approved: false` to abort (mapped to NotAllowedError). `credentialId` is the
 * chosen credential (STANDARD base64) for get.
 */
export type CeremonyFn = (
	req: CeremonyRequest,
) => Promise<
	{ approved: false } | { approved: true; userVerified: boolean; credentialId?: string }
>;

export interface PasskeyProxyDeps {
	crypto: Pick<CryptoAdapter, "passkeyMakeCredential" | "passkeyGetAssertion">;
	/** Decrypt and return all vault entries. Caller guarantees the vault is unlocked first. */
	loadEntries: () => Promise<Entry[]>;
	/** Persist a freshly minted passkey (attach to / create a login). */
	savePlacement: (plan: PasskeyPlacement) => Promise<void>;
	ceremony: CeremonyFn;
	/** SHA-256(bytes) -> STANDARD base64. WebCrypto in the service worker. */
	sha256: (bytes: Uint8Array) => Promise<string>;
	/** Wall clock; injected for deterministic tests. */
	now: () => number;
}

/** Resolve the effective rpId and reject cross-origin / public-suffix rpIds. */
function resolveRpId(
	origin: string,
	requested: string | undefined,
): { rpId: string; host: string } {
	if (!origin) throw new WebAuthnError("NotAllowedError", "request has no origin");
	const host = originHostname(origin);
	const rpId = requested ?? defaultRpId(host);
	if (!isRegistrableSuffix(host, rpId)) {
		throw new WebAuthnError("SecurityError", `rpId ${rpId} is not valid for origin ${origin}`);
	}
	return { rpId, host };
}

/** Orchestrate navigator.credentials.create(). Returns the details for completeCreateRequest. */
export async function handleCreate(
	deps: PasskeyProxyDeps,
	requestId: number,
	requestDetailsJson: string,
): Promise<chrome.webAuthenticationProxy.CreateResponseDetails> {
	try {
		const opts = parseCreationOptions(requestDetailsJson);
		const { rpId } = resolveRpId(opts.origin, opts.rpId);
		if (!opts.algs.includes(COSE_ES256)) {
			throw new WebAuthnError("NotSupportedError", "only ES256 (-7) is supported");
		}

		const decision = await deps.ceremony({
			kind: "create",
			rpId,
			rpName: opts.rpName,
			userName: opts.userName,
			origin: opts.origin,
		});
		if (!decision.approved) throw new WebAuthnError("NotAllowedError", "user declined");

		const reg = await deps.crypto.passkeyMakeCredential(rpId, decision.userVerified);
		const credential: PasskeyCredential = {
			credentialId: reg.credentialId,
			rpId,
			rpName: opts.rpName,
			userHandle: base64UrlToBase64(opts.userHandleB64Url),
			userName: opts.userName,
			userDisplayName: opts.userDisplayName,
			alg: COSE_ES256,
			publicKeyCose: reg.publicKeyCose,
			privateKey: reg.privateKey,
			signCount: 0,
			createdAt: deps.now(),
		};
		await deps.savePlacement(
			planPasskeyPlacement(await deps.loadEntries(), rpId, opts.rpName, credential),
		);

		const clientData = buildClientData("webauthn.create", opts.challenge, opts.origin);
		return {
			requestId,
			responseJson: registrationResponseJSON({
				credentialIdStdB64: reg.credentialId,
				attestationObjectStdB64: reg.attestationObject,
				clientDataB64Url: clientData.b64Url,
			}),
		};
	} catch (e) {
		return { requestId, error: toDomException(e) };
	}
}

/** Orchestrate navigator.credentials.get(). Returns the details for completeGetRequest. */
export async function handleGet(
	deps: PasskeyProxyDeps,
	requestId: number,
	requestDetailsJson: string,
): Promise<chrome.webAuthenticationProxy.GetResponseDetails> {
	try {
		const opts = parseRequestOptions(requestDetailsJson);
		const { rpId } = resolveRpId(opts.origin, opts.rpId);

		const decision = await deps.ceremony({ kind: "get", rpId, origin: opts.origin });
		if (!decision.approved) throw new WebAuthnError("NotAllowedError", "user declined");

		const allowStd = opts.allowCredentialsB64Url.map(base64UrlToBase64);
		const allow = decision.credentialId
			? [decision.credentialId]
			: allowStd.length
				? allowStd
				: undefined;
		const matches = findPasskeys(await deps.loadEntries(), rpId, allow);
		const chosen =
			matches.find((m) => m.passkey.credentialId === decision.credentialId) ?? matches[0];
		if (!chosen) throw new WebAuthnError("NotAllowedError", "no matching passkey");

		const clientData = buildClientData("webauthn.get", opts.challenge, opts.origin);
		const clientDataHash = await deps.sha256(clientData.bytes);
		const assertion = await deps.crypto.passkeyGetAssertion(
			rpId,
			chosen.passkey.privateKey,
			clientDataHash,
			decision.userVerified,
		);
		return {
			requestId,
			responseJson: authenticationResponseJSON({
				credentialIdStdB64: chosen.passkey.credentialId,
				authenticatorDataStdB64: assertion.authenticatorData,
				signatureStdB64: assertion.signature,
				clientDataB64Url: clientData.b64Url,
				userHandleStdB64: chosen.passkey.userHandle || undefined,
			}),
		};
	} catch (e) {
		return { requestId, error: toDomException(e) };
	}
}

function toDomException(e: unknown): chrome.webAuthenticationProxy.DOMExceptionDetails {
	if (e instanceof WebAuthnError) return { name: e.domName, message: e.message };
	// Unknown failure: NotAllowedError is the spec's catch-all so we never leak internals.
	return { name: "NotAllowedError", message: e instanceof Error ? e.message : String(e) };
}

/**
 * Register the proxy event listeners and attach. Thin chrome glue over the tested
 * handlers above. Call once from the background once a Settings toggle enables the
 * provider; detach() when disabled. onIsUvpaa is always true (we can verify via the
 * vault unlock / biometric in the ceremony).
 */
export async function initWebauthnProxy(deps: PasskeyProxyDeps): Promise<void> {
	chrome.webAuthenticationProxy.onIsUvpaaRequest.addListener((req) => {
		chrome.webAuthenticationProxy.completeIsUvpaaRequest({
			requestId: req.requestId,
			isUvpaa: true,
		});
	});
	chrome.webAuthenticationProxy.onCreateRequest.addListener((req) => {
		void handleCreate(deps, req.requestId, req.requestDetailsJson).then((details) =>
			chrome.webAuthenticationProxy.completeCreateRequest(details),
		);
	});
	chrome.webAuthenticationProxy.onGetRequest.addListener((req) => {
		void handleGet(deps, req.requestId, req.requestDetailsJson).then((details) =>
			chrome.webAuthenticationProxy.completeGetRequest(details),
		);
	});
	const err = await chrome.webAuthenticationProxy.attach();
	if (err) throw new Error(`webAuthenticationProxy.attach failed: ${err}`);
}

export function detachWebauthnProxy(): Promise<string | undefined> {
	return chrome.webAuthenticationProxy.detach();
}
