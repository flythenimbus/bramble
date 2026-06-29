// The WebAuthn PRF dance, shared by adding a security key (registerSecurityKey)
// and joining a group with one (security-key enrollment). Chromium honours only
// the `prf` extension (not raw hmacGetSecret), so the option objects are cast.
// See docs/security-keys.md, docs/p2p-sync.md.

import { LEN_HMAC_SECRET_SALT } from "../vault-format";

/** True where the platform can do WebAuthn at all (false in mobile webviews, etc.). */
export function isWebauthnAvailable(): boolean {
	return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";
}

// A platform may intercept all browser WebAuthn while active (the Chromium extension's
// passkey provider via chrome.webAuthenticationProxy), which would hijack our own PRF
// ceremony and fail unlock. The platform installs a pauser that detaches that
// interception around the navigator.credentials call; the default runs it unchanged.
// See docs/passkey-provider.md.
type WebauthnPauser = <T>(run: () => Promise<T>) => Promise<T>;
let pauseHostInterception: WebauthnPauser = (run) => run();
export function setWebauthnInterceptionPauser(pauser: WebauthnPauser): void {
	pauseHostInterception = pauser;
}

/** A registered credential: its id, the PRF salt, and the derived hmac-secret (KEK material). */
export interface WebauthnCredential {
	credentialId: Uint8Array;
	salt: Uint8Array;
	hmacSecret: Uint8Array;
}

/** get() with a salt against the allowed credentials; returns the tapped rawId + PRF secret. */
export async function getPrfSecret(
	allow: { credentialId: Uint8Array }[],
	salt: Uint8Array,
): Promise<{ rawId: Uint8Array; hmacSecret: Uint8Array }> {
	const challenge = new Uint8Array(32);
	globalThis.crypto.getRandomValues(challenge);
	const publicKey = {
		challenge: challenge as BufferSource,
		allowCredentials: allow.map((s) => ({
			type: "public-key",
			id: s.credentialId as BufferSource,
		})),
		userVerification: "preferred",
		extensions: { prf: { eval: { first: salt as BufferSource } } },
	} as unknown as PublicKeyCredentialRequestOptions;
	const credential = (await pauseHostInterception(() =>
		navigator.credentials.get({ publicKey }),
	)) as PublicKeyCredential | null;
	if (!credential) throw new Error("Authenticator returned no credential.");
	const ext = credential.getClientExtensionResults() as {
		prf?: { results?: { first?: ArrayBuffer } };
	};
	const first = ext.prf?.results?.first;
	if (!first) {
		throw new Error(
			"This authenticator didn't return a PRF secret. Try a YubiKey 5+ or Windows Hello.",
		);
	}
	return { rawId: new Uint8Array(credential.rawId), hmacSecret: new Uint8Array(first) };
}

/**
 * create() a fresh PRF credential and obtain its secret. Usually one tap; capable
 * keys return the secret from create(), otherwise a second get() reads it (PRF is
 * deterministic, so the value matches and the persisted slot unlocks).
 */
export async function createPrfCredential(label: string): Promise<WebauthnCredential> {
	const challenge = new Uint8Array(32);
	globalThis.crypto.getRandomValues(challenge);
	const userId = new Uint8Array(16);
	globalThis.crypto.getRandomValues(userId);
	const salt = new Uint8Array(LEN_HMAC_SECRET_SALT);
	globalThis.crypto.getRandomValues(salt);
	try {
		const created = (await pauseHostInterception(() =>
			navigator.credentials.create({
				publicKey: {
					challenge: challenge as BufferSource,
					rp: { name: "Vault" },
					user: { id: userId as BufferSource, name: "vault@local", displayName: label || "Vault" },
					pubKeyCredParams: [
						{ type: "public-key", alg: -7 }, // ES256
						{ type: "public-key", alg: -257 }, // RS256
					],
					// Non-discoverable: the unlock handle lives in our vault file.
					authenticatorSelection: { userVerification: "preferred", residentKey: "discouraged" },
					attestation: "none",
					extensions: {
						prf: { eval: { first: salt as BufferSource } },
					} as unknown as AuthenticationExtensionsClientInputs,
				},
			}),
		)) as PublicKeyCredential | null;
		if (!created) throw new Error("Authenticator returned no credential.");
		const credentialId = new Uint8Array(created.rawId);
		const createdExt = created.getClientExtensionResults() as {
			prf?: { results?: { first?: ArrayBuffer } };
		};
		const evaluated = createdExt.prf?.results?.first;
		const hmacSecret = evaluated
			? new Uint8Array(evaluated)
			: (await getPrfSecret([{ credentialId }], salt)).hmacSecret;
		return { credentialId, salt, hmacSecret };
	} catch (e) {
		if ((e as { name?: string })?.name === "NotAllowedError") {
			throw new Error(
				"Registration was cancelled or timed out. Adding a security key takes two taps: one to create the key, then a second to unlock its secret. Please try again and complete both prompts.",
			);
		}
		throw e;
	}
}
