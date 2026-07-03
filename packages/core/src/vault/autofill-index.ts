// Projects decrypted entries into the autofill IndexEntry shape. Only logins and
// cards reach the index; notes and SSH keys are never autofilled. Lives here (not
// in useVault) because both useVault (on load) and the entry-mutations module (on
// every persist) project the same way and must not drift.

import type { IndexEntry } from "../adapters/autofill";
import type { CardEntry, CustomField, Entry, LoginEntry } from "../hooks/useVault";

/** Hostname of a URL; the raw string for a bare hostname stored without a scheme. */
export function extractHostname(url: string): string {
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
