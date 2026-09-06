import { describe, expect, it } from "vitest";
import { etld1 } from "./etld1";

describe("etld1", () => {
	it("collapses subdomains to eTLD+1", () => {
		expect(etld1("mail.google.com")).toBe("google.com");
		expect(etld1("a.b.example.com")).toBe("example.com");
	});

	it("passes through bare apex domains", () => {
		expect(etld1("example.com")).toBe("example.com");
	});

	it("handles two-level suffixes", () => {
		expect(etld1("mail.example.co.uk")).toBe("example.co.uk");
		expect(etld1("example.co.uk")).toBe("example.co.uk");
	});

	it("rejects bare public suffixes", () => {
		expect(etld1("com")).toBeNull();
		expect(etld1("co.uk")).toBeNull();
	});

	it("returns null for IPs, localhost, single labels", () => {
		expect(etld1("127.0.0.1")).toBeNull();
		expect(etld1("localhost")).toBeNull();
		expect(etld1("intranet")).toBeNull();
	});

	it("is case-insensitive", () => {
		expect(etld1("MAIL.GOOGLE.COM")).toBe("google.com");
	});
});

// Multi-label, wildcard and exception rules must retain their full PSL boundary.
describe("PSL regressions", () => {
	it.each(["com.sg", "com.hk", "co.th", "edu.au", "net.br", "nhs.uk", "org.nz"])(
		"does not collapse separate sites under %s",
		(suffix) => {
			expect(etld1(`dbs.${suffix}`)).toBe(`dbs.${suffix}`);
			expect(etld1(`evil.${suffix}`)).toBe(`evil.${suffix}`);
			expect(etld1(suffix)).toBeNull();
		},
	);
	it("honors PSL wildcard and exception rules", () => {
		expect(etld1("www.city.kobe.jp")).toBe("city.kobe.jp");
		expect(etld1("a.b.ck")).toBe("a.b.ck");
		expect(etld1("b.ck")).toBeNull();
		expect(etld1("www.ck")).toBe("www.ck");
	});
	it("retains the domain for subdomains containing underscores", () => {
		expect(etld1("my_host.example.com")).toBe("example.com");
	});
});
