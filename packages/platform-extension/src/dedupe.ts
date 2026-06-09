import type { IndexEntry, LoginIndexEntry } from "@core/adapters/autofill";
import { getDomain } from "tldts";

/** eTLD+1 of a hostname; falls back to the raw input for IPs / unknown TLDs. */
export function registrableDomain(hostname: string): string {
	return getDomain(hostname) ?? hostname;
}

/** Whether a login entry matches a page host under its subdomainMatch policy (default eTLD+1). */
export function hostnameMatches(entry: LoginIndexEntry, pageHostname: string): boolean {
	const pageHost = pageHostname.toLowerCase();
	const policy = entry.subdomainMatch ?? "etld1";
	for (const raw of entry.hostnames) {
		const entryHost = raw.toLowerCase();
		switch (policy) {
			case "exact":
				if (entryHost === pageHost) return true;
				break;
			case "subdomain":
				if (pageHost === entryHost || pageHost.endsWith(`.${entryHost}`)) return true;
				break;
			default:
				if (registrableDomain(entryHost) === registrableDomain(pageHost)) return true;
		}
	}
	return false;
}

/** Result of matching a captured credential against the index: identical, new, or update-an-existing. */
export type DedupeOutcome =
	| { kind: "exact" }
	| { kind: "save" }
	| { kind: "update"; candidates: LoginIndexEntry[] };

/** Classify a captured credential vs the vault index. Null index (locked) degrades to save. */
export function dedupeCapture(
	index: Map<string, IndexEntry> | null,
	hostname: string,
	username: string,
	password: string,
): DedupeOutcome {
	if (!index) return { kind: "save" };
	const candidates: LoginIndexEntry[] = [];
	for (const entry of index.values()) {
		if (entry.type !== "login") continue;
		if (!hostnameMatches(entry, hostname)) continue;
		if (entry.username === username && entry.password === password) {
			return { kind: "exact" };
		}
		candidates.push(entry);
	}
	if (candidates.length === 0) return { kind: "save" };
	// Same-username matches float to the top.
	candidates.sort((a, b) => {
		const aMatch = a.username === username ? 0 : 1;
		const bMatch = b.username === username ? 0 : 1;
		return aMatch - bMatch;
	});
	return { kind: "update", candidates };
}
