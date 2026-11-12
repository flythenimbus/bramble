import { describe, expect, it } from "vitest";
import { aliasSiteOf } from "./site";

describe("aliasSiteOf", () => {
	it("takes the host from a URL or a bare domain", () => {
		expect(aliasSiteOf("https://www.github.com/login")).toBe("www.github.com");
		expect(aliasSiteOf("github.com")).toBe("github.com");
		expect(aliasSiteOf("  shop.example.co.uk/cart ")).toBe("shop.example.co.uk");
	});

	it("is undefined for nothing usable", () => {
		expect(aliasSiteOf(undefined)).toBeUndefined();
		expect(aliasSiteOf("   ")).toBeUndefined();
		expect(aliasSiteOf("not a url at all")).toBeUndefined();
	});
});
