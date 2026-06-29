// Pure decision logic for the passkey provider (authenticator role): which stored
// passkey satisfies a get(), and where a freshly minted passkey should live. Kept
// pure and platform-agnostic so the extension and (eventually) the mobile providers
// share one canonical placement rule, and so it is unit-tested without any IO.
// See docs/passkey-provider.md.

import type { Entry, LoginEntryData, PasskeyCredential } from "../hooks/useVault";

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

/**
 * How to persist a newly minted passkey: append it to the login that already covers
 * `rpId` (so it rides the existing site credential), or fabricate a standalone login
 * to hold it. The caller applies the result through the normal encrypt + write path,
 * so id generation and encryption stay in the mutation layer.
 */
export type PasskeyPlacement =
	| { kind: "attach"; entryId: string; passkeys: PasskeyCredential[] }
	| { kind: "create"; data: LoginEntryData };

export function planPasskeyPlacement(
	entries: Entry[],
	rpId: string,
	rpName: string | undefined,
	passkey: PasskeyCredential,
): PasskeyPlacement {
	const host = entries.find(
		(e): e is Extract<Entry, { type: "login" }> =>
			e.type === "login" && loginCoversRpId(e.urls, rpId),
	);
	if (host) {
		return { kind: "attach", entryId: host.id, passkeys: [...(host.passkeys ?? []), passkey] };
	}
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
