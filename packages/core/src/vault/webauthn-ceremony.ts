// The WebAuthn PRF dance, shared by adding a key (registerWebauthnKey) and joining a group
// with one (enrollment). Chromium honours only the `prf` extension (not raw hmacGetSecret),
// so the option objects are cast. See docs/security-keys.md, docs/p2p-sync.md.

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

// Platform authenticators register under a SHARED explicit rpID on both browsers, so a key made
// in Chrome unlocks in Firefox: Apple Passwords syncs the credential and Windows Hello is an OS
// store both browsers reach, so a matching rpID is all that is missing. Chrome M122+ and Firefox
// 150+ both let an extension claim an rpID that a host_permissions origin could claim, so this
// is supported on both, not a trick.
//
// Security keys deliberately do NOT move: they keep Chromium's implicit extension-id rpID,
// because changing it would invalidate every already-registered key, and there is no roaming
// benefit to win (Firefox has no PRF for external keys anyway). The platform installs the value,
// the same way it installs the pauser above. See docs/security-keys.md.
let platformRpId: string | undefined;
// Whether the implicit rpID (the extension's own origin) can be used at all. Firefox rejects a
// moz-extension:// origin as an RP outright - it does not miss, it throws SecurityError - so
// offering it there is not a cheap wrong guess but a hard failure. Chromium's implicit rpID is
// what every existing security key is registered under, so it stays.
let implicitRpIdUsable = true;
export function setWebauthnRpId(
	rpId: string | undefined,
	opts: { implicitUsable?: boolean } = {},
): void {
	platformRpId = rpId;
	implicitRpIdUsable = opts.implicitUsable ?? true;
}

/** The rpID a given kind registers under; undefined means the implicit extension origin. */
export function rpIdFor(kind: WebauthnKeyKind): string | undefined {
	return kind === "platform" ? platformRpId : undefined;
}

/**
 * Unlock cannot tell which rpID a slot belongs to (the vault file does not record it), so it may
 * have to try both. Ordered by what this device knows it registered, so the common single-kind
 * vault still costs one prompt; a vault holding both kinds costs two when the first guess is
 * wrong. See docs/security-keys.md.
 */
export function unlockRpIdOrder(hasPlatformKey: boolean): (string | undefined)[] {
	const order = hasPlatformKey ? [platformRpId, undefined] : [undefined, platformRpId];
	const deduped = order.filter((v, i) => order.indexOf(v) === i);
	const usable = deduped.filter((v) => v !== undefined || implicitRpIdUsable);
	// Never return nothing: a platform with no explicit rpID installed has only the implicit one,
	// whatever we think of it.
	return usable.length > 0 ? usable : [undefined];
}

/**
 * Which authenticator mints the slot. Both produce the same webauthn slot; only the
 * ceremony options differ, and incompatibly so, which is why the caller has to choose up
 * front rather than letting the OS dialog decide:
 *
 * - `platform` (Touch ID / Windows Hello) REQUIRES a discoverable credential; Apple
 *   Passwords will not answer otherwise. UV is required because a secret released without
 *   the biometric defeats the point.
 * - `securityKey` (YubiKey) must stay non-discoverable: the unlock handle lives in the
 *   vault file, and resident slots on a key are few, need a PIN, and cannot be deleted
 *   from here.
 *
 * `residentKey: "preferred"` is not a middle ground - a YubiKey would happily burn a
 * resident slot. See docs/security-keys.md.
 */
export type WebauthnKeyKind = "securityKey" | "platform";

export interface CeremonyOptions {
	kind: WebauthnKeyKind;
	/**
	 * Explicit rpID. Chromium leaves this undefined and uses the implicit extension origin,
	 * which must never change or every registered key stops unlocking. Firefox rejects its
	 * own `moz-extension://` origin as an RP and needs a domain from `host_permissions`
	 * instead. See docs/firefox-port.md.
	 */
	rpId?: string;
}

/** A registered credential: its id, the PRF salt, and the derived hmac-secret (KEK material). */
export interface WebauthnCredential {
	credentialId: Uint8Array;
	salt: Uint8Array;
	hmacSecret: Uint8Array;
	/**
	 * The credential is backed up by its provider, so it is NOT bound to this machine.
	 * Apple Passwords syncs across the account (every Mac unlocks); Windows Hello does not.
	 * Read off authData rather than guessed from the OS, and only used for UI copy.
	 */
	synced: boolean;
}

function selectionFor(kind: WebauthnKeyKind): AuthenticatorSelectionCriteria {
	return kind === "platform"
		? {
				authenticatorAttachment: "platform",
				residentKey: "required",
				userVerification: "required",
			}
		: { residentKey: "discouraged", userVerification: "preferred" };
}

/** Backup-state bit of authData's flags: set when the provider syncs this credential. */
function readSyncedFlag(response: AuthenticatorAttestationResponse): boolean {
	const authData = response.getAuthenticatorData?.();
	if (!authData) return false;
	const bytes = new Uint8Array(authData);
	// 32 bytes rpIdHash, then flags. BS (0x10) means "currently backed up".
	return bytes.length > 32 && (bytes[32]! & 0x10) !== 0;
}

/**
 * A ceremony completed but the authenticator gave us nothing to derive a KEK from, so the
 * slot cannot be minted. On the platform path this is the common failure and it is a user
 * choice, not a hardware limit: the browsers' own passkey stores create a perfectly good
 * user-verified credential and then decline PRF.
 */
function noPrfError(kind: WebauthnKeyKind): Error {
	return new Error(
		kind === "platform"
			? "That passkey provider can't unlock your vault. Try again and choose iCloud Keychain or Windows Hello rather than saving the passkey to your browser."
			: "This authenticator didn't return a PRF secret. Try a YubiKey 5+ or Windows Hello.",
	);
}

/**
 * A key registered in one browser cannot unlock in the other, because the two use different
 * rpIDs: Chromium the implicit extension id, Firefox an explicit domain. Both browsers can
 * therefore hold slots the local authenticator will not match, and nothing in the vault file
 * says which is which. Local labels do not help either - they live in per-browser extension
 * storage, so a foreign slot is simply absent rather than marked, and a filter would never
 * fire.
 *
 * WebAuthn also refuses to distinguish "user cancelled" from "nothing matched" (both are a
 * bare NotAllowedError, deliberately, so a site cannot probe which credentials you hold). So
 * the honest message names both possibilities rather than guessing.
 */
const UNLOCK_FAILED =
	"No key was used to unlock. If you dismissed the prompt, try again. Keys are registered per browser, so one added in a different browser won't work here - add a key in this browser, or use your master password.";

/** get() with a salt against the allowed credentials; returns the tapped rawId + PRF secret. */
export async function getPrfSecret(
	allow: { credentialId: Uint8Array }[],
	salt: Uint8Array,
	opts: { rpId?: string; forUnlock?: boolean } = {},
): Promise<{ rawId: Uint8Array; hmacSecret: Uint8Array }> {
	const challenge = new Uint8Array(32);
	globalThis.crypto.getRandomValues(challenge);
	const rpId = opts.rpId;
	const publicKey = {
		challenge: challenge as BufferSource,
		...(rpId ? { rpId } : {}),
		allowCredentials: allow.map((s) => ({
			type: "public-key",
			id: s.credentialId as BufferSource,
		})),
		userVerification: "preferred",
		extensions: { prf: { eval: { first: salt as BufferSource } } },
	} as unknown as PublicKeyCredentialRequestOptions;
	let credential: PublicKeyCredential | null;
	try {
		credential = (await pauseHostInterception(() =>
			navigator.credentials.get({ publicKey }),
		)) as PublicKeyCredential | null;
	} catch (e) {
		// Only on the unlock path: during registration the credential was just created, so a
		// refusal there means something else and should surface as itself.
		if (opts.forUnlock && (e as { name?: string })?.name === "NotAllowedError") {
			throw new Error(UNLOCK_FAILED);
		}
		throw e;
	}
	if (!credential)
		throw new Error(opts.forUnlock ? UNLOCK_FAILED : "Authenticator returned no credential.");
	const ext = credential.getClientExtensionResults() as {
		prf?: { results?: { first?: ArrayBuffer } };
	};
	const first = ext.prf?.results?.first;
	if (!first) throw noPrfError("securityKey");
	return { rawId: new Uint8Array(credential.rawId), hmacSecret: new Uint8Array(first) };
}

/**
 * Unlock across both rpIDs. A vault can hold platform slots (shared rpID) and security-key slots
 * (implicit rpID) at once, and the vault file does not record which is which, so the wrong guess
 * has to be survivable rather than fatal.
 *
 * Only the LAST candidate may report failure. An earlier one failing means "no credential for
 * this rpID", which is not something to tell the user about when another prompt is coming. Any
 * error that is not NotAllowedError is a real fault (the passkey proxy, a dead authenticator) and
 * is rethrown immediately rather than burning the user's second prompt on it.
 */
export async function getPrfSecretAcrossRpIds(
	allow: { credentialId: Uint8Array }[],
	salt: Uint8Array,
	candidates: (string | undefined)[],
): Promise<{ rawId: Uint8Array; hmacSecret: Uint8Array; rpId: string | undefined }> {
	let lastError: unknown;
	for (let i = 0; i < candidates.length; i++) {
		const rpId = candidates[i];
		const isLast = i === candidates.length - 1;
		try {
			const got = await getPrfSecret(allow, salt, { rpId, forUnlock: isLast });
			return { ...got, rpId };
		} catch (e) {
			if (isLast) throw e;
			// NotAllowedError is "nothing matched"; SecurityError is "this origin may not claim
			// that rpID at all". Both mean try the next one. Anything else is a real fault worth
			// surfacing now rather than after a second doomed prompt.
			const name = (e as { name?: string })?.name;
			if (name !== "NotAllowedError" && name !== "SecurityError") throw e;
			lastError = e;
		}
	}
	throw lastError ?? new Error("No rpID to try.");
}

/**
 * create() a fresh PRF credential and obtain its secret. Platform authenticators evaluate
 * PRF during create, so registering Touch ID / Windows Hello is one tap. Most security keys
 * lack that capability (`hmac-secret-mc`) and need a second get() to read the secret; PRF is
 * deterministic, so the value matches and the persisted slot unlocks identically.
 */
export async function createPrfCredential(
	label: string,
	opts: CeremonyOptions = { kind: "securityKey" },
): Promise<WebauthnCredential> {
	const challenge = new Uint8Array(32);
	globalThis.crypto.getRandomValues(challenge);
	const userId = new Uint8Array(16);
	globalThis.crypto.getRandomValues(userId);
	const salt = new Uint8Array(LEN_HMAC_SECRET_SALT);
	globalThis.crypto.getRandomValues(salt);
	const rpId = opts.rpId ?? rpIdFor(opts.kind);
	try {
		const created = (await pauseHostInterception(() =>
			navigator.credentials.create({
				publicKey: {
					challenge: challenge as BufferSource,
					rp: rpId ? { name: "Vault", id: rpId } : { name: "Vault" },
					user: { id: userId as BufferSource, name: "vault@local", displayName: label || "Vault" },
					pubKeyCredParams: [
						{ type: "public-key", alg: -7 }, // ES256
						{ type: "public-key", alg: -257 }, // RS256
					],
					authenticatorSelection: selectionFor(opts.kind),
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
			prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
		};
		const evaluated = createdExt.prf?.results?.first;
		// `enabled: false` is the provider saying it has no PRF for this credential, so a
		// second tap would only fail. Bail now rather than asking for one.
		if (!evaluated && createdExt.prf?.enabled === false) throw noPrfError(opts.kind);
		const hmacSecret = evaluated
			? new Uint8Array(evaluated)
			: (await getPrfSecret([{ credentialId }], salt, { rpId })).hmacSecret;
		return {
			credentialId,
			salt,
			hmacSecret,
			synced: readSyncedFlag(created.response as AuthenticatorAttestationResponse),
		};
	} catch (e) {
		// Claiming an rpID from a host_permissions domain needs Chrome M122+ or Firefox 150+.
		// Older builds refuse the ceremony outright, as does any browser where the domain is not
		// in host_permissions. Now that BOTH browsers use the shared rpID for platform keys, this
		// message cannot name just one of them.
		if (rpId && (e as { name?: string })?.name === "SecurityError") {
			throw new Error(
				"This browser is too old to register a key for Bramble. Chrome 122 or Firefox 150 and newer are supported.",
			);
		}
		if ((e as { name?: string })?.name === "NotAllowedError") {
			throw new Error(
				opts.kind === "platform"
					? "Registration was cancelled or timed out. Please try again."
					: "Registration was cancelled or timed out. Adding a security key takes two taps: one to create the key, then a second to unlock its secret. Please try again and complete both prompts.",
			);
		}
		throw e;
	}
}
