import { describe, expect, it } from "vitest";
import { linkOutcome } from "./link-outcome";

const base = { from: "settings" as const, sharesGroup: false };

describe("linkOutcome", () => {
	it("switches when this browser already shares the desktop's vault", () => {
		expect(linkOutcome({ ...base, browser: "full", desktop: "full", sharesGroup: true })).toBe(
			"switch",
		);
	});

	it("adds alongside from Add a vault, whatever each side holds", () => {
		expect(linkOutcome({ ...base, from: "add", browser: "full", desktop: "full" })).toBe("add");
	});

	it("takes the desktop's vault when the browser has none", () => {
		expect(linkOutcome({ ...base, from: "setup", browser: "none", desktop: "full" })).toBe("take");
	});

	it("takes the desktop's vault when the browser's is empty, even if the desktop's is too", () => {
		expect(linkOutcome({ ...base, browser: "empty", desktop: "empty" })).toBe("take");
	});

	it("combines without asking when only the browser has anything", () => {
		expect(linkOutcome({ ...base, browser: "full", desktop: "empty" })).toBe("combine");
	});

	it("asks when both have something", () => {
		expect(linkOutcome({ ...base, browser: "full", desktop: "full" })).toBe("ask");
	});
});
