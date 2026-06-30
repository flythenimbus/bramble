/// <reference types="chrome" />

// Passkey provider via chrome.webAuthenticationProxy: Bramble acts as the WebAuthn
// authenticator for other sites. The crypto is the shared Rust core (Phase 0); this
// module orchestrates the proxy events around it. The orchestration (handleCreate /
// handleGet) takes injected deps so origin validation, the ES256 check, and response
// assembly are unit-tested; the chrome event/attach wiring stays thin. See
// docs/passkey-provider.md.
//
// This module stays import-safe (no chrome at import) so it is unit-testable; the
// chrome wiring (corner-card ceremony, vault IO, attach) lives in ./webauthn-proxy-init,
// which injects the deps below. The proxy is gated behind a pref (default off) because
// attach() intercepts all browser WebAuthn. End-to-end needs a real Chrome.

import type { CryptoAdapter } from "@core/adapters/crypto";
import type { Entry, PasskeyCredential } from "@core/hooks/useVault";
import { base64UrlToBase64 } from "@core/util/bytes";
import {
	attachPasskeyTo,
	findPasskeys,
	loginsCoveringRpId,
	newPasskeyLogin,
	type PasskeyPlacement,
	passkeyAttachTarget,
	planPasskeyPlacement,
} from "@core/vault/passkey";
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
 * verification when required, and let the user pick (create: which login to attach to,
 * with "create new" as an option; get: which matching passkey). Returns `approved: false`
 * to abort (mapped to NotAllowedError).
 * - `credentialId` (get): the chosen credential, STANDARD base64.
 * - `placement` (create): "new" to force a fresh login, `{ entryId }` to attach to a
 *   specific login, or omitted to let automatic placement decide.
 */
export type CeremonyDecision =
	| { approved: false }
	| {
			approved: true;
			userVerified: boolean;
			credentialId?: string;
			placement?: "new" | { entryId: string };
	  };
export type CeremonyFn = (req: CeremonyRequest) => Promise<CeremonyDecision>;

/** A shown card's reply: approved, and (for the create picker) the chosen login id or "new". */
export interface CardReply {
	approved: boolean;
	choice?: string;
}

/**
 * The platform side a ceremony drives: show a card (the variant is chosen by which fields
 * are passed), report/await unlock, and read the vault. Injected so the create/get
 * ceremony flow below is unit-tested without chrome. `webauthn-proxy-init` supplies the
 * real one (corner card + popup unlock + offscreen decrypt).
 */
export interface CeremonyHost {
	showCard: (opts: {
		existingLoginName?: string;
		candidates?: { id: string; name: string; username: string }[];
	}) => Promise<CardReply>;
	isLocked: () => boolean;
	ensureUnlocked: () => Promise<boolean>;
	loadEntries: () => Promise<Entry[]>;
}

/** get(): confirm, then ensure unlocked. Unlock is the user verification. */
export async function runGetCeremony(host: CeremonyHost): Promise<CeremonyDecision> {
	if (!(await host.showCard({})).approved) return { approved: false };
	if (!(await host.ensureUnlocked())) return { approved: false };
	return { approved: true, userVerified: true };
}

/**
 * create(): confirm + unlock, then resolve which login the passkey attaches to. When
 * locked we confirm generically first (the vault can't be read yet); once unlocked we
 * attach to the unambiguous account, create a new login when the domain has none, or
 * show a picker (candidates + "create new") when several accounts are ambiguous.
 */
export async function runCreateCeremony(
	req: CeremonyCreateRequest,
	host: CeremonyHost,
): Promise<CeremonyDecision> {
	const startedLocked = host.isLocked();
	if (startedLocked) {
		if (!(await host.showCard({})).approved) return { approved: false };
		if (!(await host.ensureUnlocked())) return { approved: false };
	}

	let entries: Entry[] = [];
	try {
		entries = await host.loadEntries();
	} catch {}

	const target = passkeyAttachTarget(entries, req.rpId, req.userName);
	if (target) {
		// Confident account. The locked path already confirmed; otherwise confirm "Add to X".
		if (!startedLocked && !(await host.showCard({ existingLoginName: target.name })).approved) {
			return { approved: false };
		}
		return { approved: true, userVerified: true, placement: { entryId: target.id } };
	}

	const candidates = loginsCoveringRpId(entries, req.rpId);
	if (candidates.length === 0) {
		if (!startedLocked && !(await host.showCard({})).approved) return { approved: false };
		return { approved: true, userVerified: true, placement: "new" };
	}

	// Several accounts on this domain and no clear match: let the user pick one or create new.
	const reply = await host.showCard({
		candidates: candidates.map((c) => ({ id: c.id, name: c.name, username: c.username })),
	});
	if (!reply.approved) return { approved: false };
	return {
		approved: true,
		userVerified: true,
		placement: reply.choice && reply.choice !== "new" ? { entryId: reply.choice } : "new",
	};
}

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

/** Apply the ceremony's create placement choice ("new" / a chosen login), else auto. */
function resolveCreatePlan(
	decision: Extract<CeremonyDecision, { approved: true }>,
	entries: Entry[],
	rpId: string,
	rpName: string | undefined,
	credential: PasskeyCredential,
): PasskeyPlacement {
	const placement = decision.placement;
	if (placement === "new") return newPasskeyLogin(rpId, rpName, credential);
	if (placement) {
		const target = entries.find(
			(e): e is Extract<Entry, { type: "login" }> =>
				e.type === "login" && e.id === placement.entryId,
		);
		if (target) return attachPasskeyTo(target, credential);
	}
	return planPasskeyPlacement(entries, rpId, rpName, credential);
}

/**
 * Orchestrate navigator.credentials.create(). `origin` is the calling page's origin,
 * resolved by the caller from the active tab (the proxy request carries no origin).
 */
export async function handleCreate(
	deps: PasskeyProxyDeps,
	requestId: number,
	requestDetailsJson: string,
	origin: string,
): Promise<chrome.webAuthenticationProxy.CreateResponseDetails> {
	try {
		const opts = parseCreationOptions(requestDetailsJson);
		const { rpId } = resolveRpId(origin, opts.rpId);
		if (!opts.algs.includes(COSE_ES256)) {
			throw new WebAuthnError("NotSupportedError", "only ES256 (-7) is supported");
		}

		const decision = await deps.ceremony({
			kind: "create",
			rpId,
			rpName: opts.rpName,
			userName: opts.userName,
			origin,
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
		const entries = await deps.loadEntries();
		await deps.savePlacement(resolveCreatePlan(decision, entries, rpId, opts.rpName, credential));

		const clientData = buildClientData("webauthn.create", opts.challenge, origin);
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

/**
 * Orchestrate navigator.credentials.get(). `origin` is the calling page's origin,
 * resolved by the caller from the active tab (the proxy request carries no origin).
 */
export async function handleGet(
	deps: PasskeyProxyDeps,
	requestId: number,
	requestDetailsJson: string,
	origin: string,
): Promise<chrome.webAuthenticationProxy.GetResponseDetails> {
	try {
		const opts = parseRequestOptions(requestDetailsJson);
		const { rpId } = resolveRpId(origin, opts.rpId);

		const decision = await deps.ceremony({ kind: "get", rpId, origin });
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

		const clientData = buildClientData("webauthn.get", opts.challenge, origin);
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
