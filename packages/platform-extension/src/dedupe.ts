import type { IndexEntry, LoginIndexEntry } from "@core/adapters/autofill";
import { getDomain } from "tldts";

// Pure helpers for the corner-prompt and autofill paths. Extracted from
// background.ts so they can be unit-tested without mocking the service
// worker globals. Both functions are referentially transparent — given the
// same index + hostname they always return the same outcome.

export function registrableDomain(hostname: string): string {
	// `getDomain` returns the eTLD+1 for any valid hostname, or null for
	// IPs and unknown TLDs. Fall back to the raw hostname so the matcher
	// degrades to "exact-string compare" rather than blowing up.
	return getDomain(hostname) ?? hostname;
}

// Per-entry hostname matching against a page's hostname. The default
// "etld1" policy collapses sibling subdomains so a login for
// `accounts.google.com` matches `mail.google.com`. "exact" requires a
// byte-for-byte match. "subdomain" matches the entry's host or any
// descendant (so an entry for `example.com` matches `m.example.com` but
// not `example.org`).
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

export type DedupeOutcome =
	| { kind: "exact" }
	| { kind: "save" }
	| { kind: "update"; candidates: LoginIndexEntry[] };

// Decide what corner-prompt variant to show for a freshly-captured login
// against the in-memory autofill index. Same-username AND same-password is
// `exact` (no prompt). Any hostname match with a credential difference is
// `update` (the card lists candidates so the user picks which to overwrite).
// No hostname match is `save` (offer a fresh entry). When `index` is null,
// callers haven't hydrated yet — degrade to `save` because we have nothing
// to compare against.
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
	// Same-username candidates first — when the user is rotating a known
	// account the card defaults to that entry; "I have multiple accounts"
	// candidates sit below the obvious match.
	candidates.sort((a, b) => {
		const aMatch = a.username === username ? 0 : 1;
		const bMatch = b.username === username ? 0 : 1;
		return aMatch - bMatch;
	});
	return { kind: "update", candidates };
}
