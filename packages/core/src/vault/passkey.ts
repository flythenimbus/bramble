// Pure decision logic for the passkey provider (authenticator role): which stored
// passkey satisfies a get(), and where a freshly minted passkey should live. Kept
// pure and platform-agnostic so the extension and (eventually) the mobile providers
// share one canonical placement rule, and so it is unit-tested without any IO.
// See docs/passkey-provider.md.

import type { Entry, LoginEntryData, PasskeyCredential } from "../hooks/useVault";

/** COSE algorithm identifier for ES256, the only algorithm Bramble mints or imports. */
export const COSE_ES256 = -7;

export interface PasskeyMatch {
	/** The login entry that holds this passkey. */
	entryId: string;
	passkey: PasskeyCredential;
}

/**
 * Every stored passkey for `rpId`, optionally narrowed to an allow-list of
 * credential ids (the get() `allowCredentials`). Matches on the passkey's own
 * stored rpId, not on login hostnames; a credential carries its own rp binding.
 */
export function findPasskeys(
	entries: Entry[],
	rpId: string,
	allowCredentialIds?: string[],
): PasskeyMatch[] {
	const allow = allowCredentialIds?.length ? new Set(allowCredentialIds) : null;
	const matches: PasskeyMatch[] = [];
	for (const entry of entries) {
		if (entry.type !== "login" || !entry.passkeys) continue;
		for (const passkey of entry.passkeys) {
			if (passkey.rpId !== rpId) continue;
			if (allow && !allow.has(passkey.credentialId)) continue;
			matches.push({ entryId: entry.id, passkey });
		}
	}
	return matches;
}

/** Whether any of a login's URLs is the rpId host or a subdomain of it. */
function loginCoversRpId(urls: string[], rpId: string): boolean {
	const id = rpId.toLowerCase();
	for (const u of urls) {
		if (!u) continue;
		let host = u;
		try {
			host = new URL(u).hostname;
		} catch {
			// bare hostname stored without a scheme
		}
		host = host.toLowerCase();
		if (host === id || host.endsWith(`.${id}`)) return true;
	}
	return false;
}

export type LoginEntry = Extract<Entry, { type: "login" }>;

/** Every login whose URLs cover `rpId` (its host or a subdomain). */
export function loginsCoveringRpId(entries: Entry[], rpId: string): LoginEntry[] {
	return entries.filter(
		(e): e is LoginEntry => e.type === "login" && loginCoversRpId(e.urls, rpId),
	);
}

/**
 * Which login a passkey for `(rpId, userName)` should attach to, or undefined when it is
 * ambiguous (the caller then either prompts the user or creates a new login). A passkey
 * belongs to the specific account named by the request's `user.name`, so when a domain
 * has several logins we must not just grab the first:
 *  - no login covers the rpId -> undefined;
 *  - exactly one does -> that login (the domain's sole account; an RP-vs-stored username
 *    mismatch is tolerated, the RP just identifies the account differently);
 *  - several do -> the one whose username matches `userName`; if zero or more than one
 *    match, undefined (ambiguous).
 */
export function passkeyAttachTarget(
	entries: Entry[],
	rpId: string,
	userName: string | undefined,
): LoginEntry | undefined {
	const covering = loginsCoveringRpId(entries, rpId);
	if (covering.length <= 1) return covering[0];
	const uname = userName?.trim().toLowerCase();
	if (!uname) return undefined;
	const matches = covering.filter((l) => l.username.trim().toLowerCase() === uname);
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * How to persist a newly minted passkey: append it to a login (see passkeyAttachTarget),
 * or fabricate a standalone login to hold it. The caller applies the result through the
 * normal encrypt + write path, so id generation and encryption stay in the mutation layer.
 */
export type PasskeyPlacement =
	| { kind: "attach"; entryId: string; passkeys: PasskeyCredential[] }
	| { kind: "create"; data: LoginEntryData };

/** Attach a passkey to an existing login (returns its new passkeys[]). */
export function attachPasskeyTo(login: LoginEntry, passkey: PasskeyCredential): PasskeyPlacement {
	return { kind: "attach", entryId: login.id, passkeys: [...(login.passkeys ?? []), passkey] };
}

/** A fresh standalone login holding only this passkey. */
export function newPasskeyLogin(
	rpId: string,
	rpName: string | undefined,
	passkey: PasskeyCredential,
): PasskeyPlacement {
	return {
		kind: "create",
		data: {
			type: "login",
			name: rpName?.trim() || rpId,
			urls: [`https://${rpId}`],
			username: passkey.userName ?? passkey.userDisplayName ?? "",
			password: "",
			passkeys: [passkey],
		},
	};
}

/** Automatic placement: attach to the unambiguous target, else create a new login. */
export function planPasskeyPlacement(
	entries: Entry[],
	rpId: string,
	rpName: string | undefined,
	passkey: PasskeyCredential,
): PasskeyPlacement {
	const target = passkeyAttachTarget(entries, rpId, passkey.userName);
	return target ? attachPasskeyTo(target, passkey) : newPasskeyLogin(rpId, rpName, passkey);
}
