// Projects decrypted entries into the autofill IndexEntry shape. Only logins and
// cards reach the index; notes and SSH keys are never autofilled. Lives here (not
// in useVault) because both useVault (on load) and the entry-mutations module (on
// every persist) project the same way and must not drift.

import type { IndexEntry } from "../adapters/autofill";
import type { CardEntry, CustomField, Entry, LoginEntry } from "../hooks/useVault";

// Schemes that identify a mobile app, not a website. Bramble never writes these,
// but importers carry them straight through: `androidapp://` is Bitwarden's
// convention and `android://<cert-hash>@<package>` is Google Password Manager's.
// Their "hostname" is a reverse-DNS package name, so treating one as a web host
// puts a string like `se.skanetrafiken.washington` into the match index and the
// known-hostname registry, where it can never match a page but is persisted and
// counted forever. Deriving a domain from a package name is deliberately NOT
// done here; see docs/autofill.md and StructureParser.kt for why.
const APP_URI_SCHEMES = new Set(["androidapp:", "android:", "iosapp:", "ios:", "appid:"]);

/** True if `url` identifies an installed app rather than a website. */
export function isAppUri(url: string): boolean {
	try {
		return APP_URI_SCHEMES.has(new URL(url).protocol.toLowerCase());
	} catch {
		return false;
	}
}

/**
 * The app identifier in an app URI (`androidapp://com.example` -> `com.example`),
 * or null. Not used for matching; exposed so the UI can offer to link an
 * imported app entry to a website. See docs/autofill.md.
 */
export function appIdFromUri(url: string): string | null {
	if (!isAppUri(url)) return null;
	// android:// carries the signing-cert hash as the userinfo part; the package
	// is the host either way.
	const host = new URL(url).hostname;
	return host.length > 0 ? host : null;
}

/**
 * Hostname of a web URL; the raw string for a bare hostname stored without a
 * scheme. Empty for app URIs, so they stay out of the web match index.
 */
export function extractHostname(url: string): string {
	if (isAppUri(url)) return "";
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

function autofillCustomFields(fields: CustomField[] | undefined) {
	if (!fields) return undefined;
	const out = fields.filter((f) => f.value).map((f) => ({ key: f.key, value: f.value }));
	return out.length > 0 ? out : undefined;
}

function loginIndexEntry(entry: LoginEntry): IndexEntry {
	const hostnames = entry.urls.map(extractHostname).filter((h): h is string => h.length > 0);
	return {
		type: "login",
		id: entry.id,
		hostnames,
		name: entry.name,
		username: entry.username,
		password: entry.password,
		totp: entry.totp,
		customFields: autofillCustomFields(entry.customFields),
		autofillEnabled: entry.autofillEnabled,
		autoSubmit: entry.autoSubmit,
		subdomainMatch: entry.subdomainMatch,
		passkeys: entry.passkeys?.length ? entry.passkeys : undefined,
	};
}

function cardIndexEntry(entry: CardEntry): IndexEntry {
	return {
		type: "card",
		id: entry.id,
		name: entry.name,
		brand: entry.brand,
		cardholderName: entry.cardholderName,
		number: entry.number,
		expMonth: entry.expMonth,
		expYear: entry.expYear,
		cvv: entry.cvv,
		customFields: autofillCustomFields(entry.customFields),
	};
}

/** Project logins and cards into the autofill index (notes/ssh keys excluded). */
export function toAutofillIndex(entries: Entry[]): IndexEntry[] {
	const out: IndexEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "login") out.push(loginIndexEntry(entry));
		else if (entry.type === "card") out.push(cardIndexEntry(entry));
	}
	return out;
}
