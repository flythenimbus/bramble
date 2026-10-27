import type { IndexEntry, LoginIndexEntry, SubdomainMatchMode } from "@core/adapters/autofill";
import { loginHosts } from "@core/vault/autofill-index";
import { describe, expect, it } from "vitest";
import {
	dedupeCapture,
	effectivePort,
	type HostnameMatchable,
	hostnameMatches,
	registrableDomain,
} from "./dedupe";

function login(over: Partial<LoginIndexEntry> & Pick<LoginIndexEntry, "id">): LoginIndexEntry {
	return {
		type: "login",
		hostnames: [],
		name: "Test",
		username: "alice",
		password: "hunter2",
		...over,
	};
}

function indexOf(...entries: IndexEntry[]): Map<string, IndexEntry> {
	return new Map(entries.map((e) => [e.id, e]));
}

describe("registrableDomain", () => {
	it("collapses subdomains to eTLD+1", () => {
		expect(registrableDomain("mail.google.com")).toBe("google.com");
		expect(registrableDomain("accounts.google.com")).toBe("google.com");
	});

	it("handles bare apex domains", () => {
		expect(registrableDomain("example.com")).toBe("example.com");
	});

	it("falls back to the raw input for unparseable hostnames", () => {
		// IP literals and localhost fall back to exact match.
		expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
		expect(registrableDomain("localhost")).toBe("localhost");
	});

	it("handles two-level public suffixes", () => {
		expect(registrableDomain("mail.example.co.uk")).toBe("example.co.uk");
		expect(registrableDomain("example.co.uk")).toBe("example.co.uk");
	});
});

describe("hostnameMatches", () => {
	it("matches sibling subdomains under default eTLD+1 policy", () => {
		const entry = login({ id: "1", hostnames: ["accounts.google.com"] });
		expect(hostnameMatches(entry, "mail.google.com")).toBe(true);
		expect(hostnameMatches(entry, "google.com")).toBe(true);
	});

	it("doesn't cross eTLD+1 boundaries", () => {
		const entry = login({ id: "1", hostnames: ["example.com"] });
		expect(hostnameMatches(entry, "example.org")).toBe(false);
		expect(hostnameMatches(entry, "evil-example.com")).toBe(false);
	});

	it("respects the 'exact' policy", () => {
		const entry = login({
			id: "1",
			hostnames: ["mail.google.com"],
			subdomainMatch: "exact",
		});
		expect(hostnameMatches(entry, "mail.google.com")).toBe(true);
		expect(hostnameMatches(entry, "accounts.google.com")).toBe(false);
		expect(hostnameMatches(entry, "google.com")).toBe(false);
	});

	it("respects the 'subdomain' policy", () => {
		const entry = login({
			id: "1",
			hostnames: ["example.com"],
			subdomainMatch: "subdomain",
		});
		expect(hostnameMatches(entry, "example.com")).toBe(true);
		expect(hostnameMatches(entry, "m.example.com")).toBe(true);
		expect(hostnameMatches(entry, "deep.sub.example.com")).toBe(true);
		// "subdomain" must not match a domain that merely ends with the host string.
		expect(hostnameMatches(entry, "notexample.com")).toBe(false);
	});

	it("matches against any of the entry's hostnames", () => {
		const entry = login({
			id: "1",
			hostnames: ["sso.acme.com", "products.acme.io"],
		});
		expect(hostnameMatches(entry, "sso.acme.com")).toBe(true);
		expect(hostnameMatches(entry, "products.acme.io")).toBe(true);
		expect(hostnameMatches(entry, "elsewhere.example.com")).toBe(false);
	});

	it("is case-insensitive", () => {
		const entry = login({ id: "1", hostnames: ["Example.com"] });
		expect(hostnameMatches(entry, "EXAMPLE.com")).toBe(true);
	});

	it("returns false when the entry has no hostnames", () => {
		// Empty hostnames (legacy/imported entries) must not match every site.
		const entry = login({ id: "1", hostnames: [] });
		expect(hostnameMatches(entry, "example.com")).toBe(false);
	});
});

describe("dedupeCapture", () => {
	it("returns save when the index is null (locked vault)", () => {
		const result = dedupeCapture(null, "example.com", "alice", "hunter2");
		expect(result.kind).toBe("save");
	});

	it("returns save when there are no hostname matches", () => {
		const index = indexOf(login({ id: "1", hostnames: ["other.com"], username: "alice" }));
		const result = dedupeCapture(index, "example.com", "alice", "hunter2");
		expect(result.kind).toBe("save");
	});

	it("returns exact when the same {username, password} is already stored", () => {
		const index = indexOf(
			login({
				id: "1",
				hostnames: ["example.com"],
				username: "alice",
				password: "hunter2",
			}),
		);
		const result = dedupeCapture(index, "example.com", "alice", "hunter2");
		expect(result.kind).toBe("exact");
	});

	it("returns update when the username matches but the password differs", () => {
		const index = indexOf(
			login({
				id: "1",
				hostnames: ["example.com"],
				username: "alice",
				password: "old",
			}),
		);
		const result = dedupeCapture(index, "example.com", "alice", "new");
		expect(result.kind).toBe("update");
		if (result.kind !== "update") throw new Error("unreachable");
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]!.id).toBe("1");
	});

	it("returns update when the password matches but the username differs", () => {
		// Same password, changed username counts as an update, not a new save.
		const index = indexOf(
			login({
				id: "1",
				hostnames: ["example.com"],
				username: "old@example.com",
				password: "shared",
			}),
		);
		const result = dedupeCapture(index, "example.com", "new@example.com", "shared");
		expect(result.kind).toBe("update");
	});

	it("returns update with multiple candidates when several entries match", () => {
		const index = indexOf(
			login({
				id: "personal",
				hostnames: ["example.com"],
				username: "alice@personal.com",
				password: "a",
			}),
			login({
				id: "work",
				hostnames: ["example.com"],
				username: "alice@work.com",
				password: "b",
			}),
		);
		const result = dedupeCapture(index, "example.com", "alice@personal.com", "c");
		expect(result.kind).toBe("update");
		if (result.kind !== "update") throw new Error("unreachable");
		expect(result.candidates).toHaveLength(2);
		// Same-username candidate floats to the top.
		expect(result.candidates[0]!.id).toBe("personal");
		expect(result.candidates[1]!.id).toBe("work");
	});

	it("ignores card entries when matching", () => {
		const cardEntry: IndexEntry = {
			type: "card",
			id: "card",
			name: "Visa",
			cardholderName: "Alice",
			number: "4111111111111111",
			expMonth: "12",
			expYear: "2030",
			cvv: "123",
		};
		const result = dedupeCapture(indexOf(cardEntry), "example.com", "alice", "hunter2");
		expect(result.kind).toBe("save");
	});

	it("respects per-entry subdomainMatch when filtering candidates", () => {
		// "exact" entry must not surface as a candidate on a sibling subdomain.
		const index = indexOf(
			login({
				id: "1",
				hostnames: ["mail.google.com"],
				subdomainMatch: "exact",
				username: "alice",
				password: "x",
			}),
		);
		const result = dedupeCapture(index, "accounts.google.com", "alice", "x");
		expect(result.kind).toBe("save");
	});
});

/** A login as the index projects it from its saved URLs. */
function saved(urls: string[], subdomainMatch?: SubdomainMatchMode): HostnameMatchable {
	return { ...loginHosts(urls), subdomainMatch };
}

/** A page's hostname and effective port, as the background reads them off its sender. */
function on(url: string): [string, string] {
	const u = new URL(url);
	return [u.hostname, effectivePort(u)];
}

describe("exact policy and ports (#131)", () => {
	it("offers a login saved with a port only on that port", () => {
		const dsm = saved(["http://nas.local:5000"], "exact");
		const portainer = saved(["http://nas.local:9000/#/home"], "exact");
		expect(hostnameMatches(dsm, ...on("http://nas.local:5000/login"))).toBe(true);
		expect(hostnameMatches(portainer, ...on("http://nas.local:5000/login"))).toBe(false);
		expect(hostnameMatches(dsm, ...on("http://nas.local:9000/"))).toBe(false);
		expect(hostnameMatches(portainer, ...on("http://nas.local:9000/"))).toBe(true);
		expect(hostnameMatches(dsm, ...on("http://nas.local/"))).toBe(false);
	});

	it("keeps matching every port of the host when the saved URL names none", () => {
		const nas = saved(["https://nas.local"], "exact");
		expect(hostnameMatches(nas, ...on("http://nas.local:5000/"))).toBe(true);
		expect(hostnameMatches(nas, ...on("https://nas.local:8443/"))).toBe(true);
		expect(hostnameMatches(nas, ...on("https://nas.local/"))).toBe(true);
		expect(hostnameMatches(nas, ...on("https://other.local/"))).toBe(false);
	});

	it("reads a scheme's own default port as no port", () => {
		expect(saved(["https://nas.local:443"], "exact")).toEqual(
			saved(["https://nas.local"], "exact"),
		);
		expect(saved(["http://nas.local:80"], "exact")).toEqual(saved(["http://nas.local"], "exact"));
		expect(
			hostnameMatches(saved(["https://nas.local:443"], "exact"), ...on("http://nas.local:8080")),
		).toBe(true);
	});

	it("compares a pinned port with the page's effective port", () => {
		// 443 named on http: is a real pin, and an https page with no port is served on 443.
		const pinned = saved(["http://nas.local:443"], "exact");
		expect(hostnameMatches(pinned, ...on("https://nas.local/"))).toBe(true);
		expect(hostnameMatches(pinned, ...on("http://nas.local/"))).toBe(false);
		const alt = saved(["https://nas.local:8443"], "exact");
		expect(hostnameMatches(alt, ...on("https://nas.local:8443/"))).toBe(true);
		expect(hostnameMatches(alt, ...on("https://nas.local/"))).toBe(false);
	});

	it("pins each of a login's URLs separately", () => {
		const twoPorts = saved(["http://nas.local:5000", "http://nas.local:5001"], "exact");
		expect(hostnameMatches(twoPorts, ...on("http://nas.local:5001/"))).toBe(true);
		expect(hostnameMatches(twoPorts, ...on("http://nas.local:8080/"))).toBe(false);
		const mixed = saved(
			["http://nas.local:5000", "androidapp://com.synology", "https://other.local"],
			"exact",
		);
		expect(hostnameMatches(mixed, ...on("http://nas.local:5000/"))).toBe(true);
		expect(hostnameMatches(mixed, ...on("http://nas.local:8080/"))).toBe(false);
		expect(hostnameMatches(mixed, ...on("http://other.local:8080/"))).toBe(true);
	});

	it.each([
		["http://192.168.1.10:8080", "http://192.168.1.10:8080/admin", "http://192.168.1.10:9000/"],
		["http://localhost:3000", "http://localhost:3000/", "http://localhost:5173/"],
		["http://[fe80::1]:8080", "http://[fe80::1]:8080/", "http://[fe80::1]:9000/"],
		[
			"https://bücher.example:8443",
			"https://xn--bcher-kva.example:8443/",
			"https://bücher.example/",
		],
	])("pins the port on %s", (url, samePort, otherPort) => {
		const entry = saved([url], "exact");
		expect(hostnameMatches(entry, ...on(samePort))).toBe(true);
		expect(hostnameMatches(entry, ...on(otherPort))).toBe(false);
	});

	it("offers no port-pinned URL when the page's port is unknown", () => {
		expect(hostnameMatches(saved(["http://nas.local:5000"], "exact"), "nas.local")).toBe(false);
		expect(hostnameMatches(saved(["http://nas.local"], "exact"), "nas.local")).toBe(true);
	});

	it("leaves the eTLD+1 and subdomain policies ignoring ports", () => {
		expect(hostnameMatches(saved(["http://nas.local:5000"]), ...on("http://nas.local:9000/"))).toBe(
			true,
		);
		expect(
			hostnameMatches(saved(["https://example.com:8443"]), ...on("https://www.example.com/")),
		).toBe(true);
		expect(
			hostnameMatches(
				saved(["https://example.com:8443"], "subdomain"),
				...on("https://app.example.com:9000/"),
			),
		).toBe(true);
		expect(hostnameMatches(saved(["https://example.com:8443"], "etld1"), "example.com")).toBe(true);
	});

	it("keeps a capture on another port from becoming an update of a pinned login", () => {
		const index = indexOf(
			login({ id: "dsm", ...loginHosts(["http://nas.local:5000"]), subdomainMatch: "exact" }),
		);
		expect(dedupeCapture(index, "nas.local", "alice", "new", "8080").kind).toBe("save");
		expect(dedupeCapture(index, "nas.local", "alice", "new", "5000").kind).toBe("update");
	});

	it("narrows an index entry shaped like a Host-matched Bitwarden import to its port", () => {
		// What core's bitwarden.test.ts shows toAutofillIndex projecting from such an import.
		const index = [
			login({
				id: "dsm",
				name: "DSM",
				hostnames: ["nas.local"],
				ports: ["5000"],
				subdomainMatch: "exact",
			}),
			login({
				id: "pt",
				name: "Portainer",
				hostnames: ["nas.local"],
				ports: ["9000"],
				subdomainMatch: "exact",
			}),
			login({ id: "router", name: "Router", hostnames: ["nas.local"], ports: ["8080"] }),
		];
		const offered = (url: string) =>
			index.filter((e) => hostnameMatches(e, ...on(url))).map((e) => e.name);
		expect(offered("http://nas.local:5000/")).toEqual(["DSM", "Router"]);
		expect(offered("http://nas.local:9000/")).toEqual(["Portainer", "Router"]);
	});
});

describe("hostname policy regressions", () => {
	it.each(["com.sg", "com.hk", "co.th", "edu.au", "net.br", "nhs.uk", "org.nz", "b.ck"])(
		"never offers a sibling site's credentials under %s",
		(suffix) => {
			expect(hostnameMatches({ hostnames: [`dbs.${suffix}`] }, `evil.${suffix}`)).toBe(false);
		},
	);
	it.each(["github.io", "vercel.app", "pages.dev"])(
		"never offers another tenant's credentials under %s",
		(suffix) => {
			expect(hostnameMatches({ hostnames: [`alice.${suffix}`] }, `mallory.${suffix}`)).toBe(false);
			expect(hostnameMatches({ hostnames: [`alice.${suffix}`] }, `www.alice.${suffix}`)).toBe(true);
		},
	);
	it("keeps underscore subdomains within their registrable domain", () => {
		expect(hostnameMatches({ hostnames: ["example.com"] }, "my_host.example.com")).toBe(true);
	});
	it("uses the default eTLD+1 policy for an unknown stored policy", () => {
		const entry = { hostnames: ["accounts.example.com"], subdomainMatch: "legacy" };
		expect(hostnameMatches(entry as unknown as LoginIndexEntry, "mail.example.com")).toBe(true);
		expect(hostnameMatches(entry as unknown as LoginIndexEntry, "evil.com")).toBe(false);
	});
});
