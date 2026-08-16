import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { formatIn } from "./format-date";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatIn", () => {
	beforeAll(() => {
		// The formatter reads i18n.locale, which is undefined until a catalog is activated.
		i18n.loadAndActivate({ locale: "en", messages: {} });
	});

	it("picks the largest unit that fits", () => {
		expect(formatIn(15 * MIN)).toBe("in 15 minutes");
		expect(formatIn(2 * HOUR)).toBe("in 2 hours");
		expect(formatIn(3 * DAY)).toBe("in 3 days");
	});

	it("says one rather than a bare number", () => {
		expect(formatIn(HOUR)).toBe("in 1 hour");
		expect(formatIn(DAY)).toBe("in 1 day");
	});

	// "in 0 minutes" reads as a bug, and a sub-minute wait is still a wait.
	it("never rounds down to zero", () => {
		expect(formatIn(1)).toBe("in 1 minute");
		expect(formatIn(20_000)).toBe("in 1 minute");
	});

	it("crosses each boundary without a gap", () => {
		expect(formatIn(59 * MIN)).toBe("in 59 minutes");
		expect(formatIn(90 * MIN)).toBe("in 2 hours"); // rounded, not truncated to 1
		expect(formatIn(23 * HOUR)).toBe("in 23 hours");
		expect(formatIn(36 * HOUR)).toBe("in 2 days");
	});

	it("follows the active locale", () => {
		i18n.loadAndActivate({ locale: "de", messages: {} });
		expect(formatIn(2 * HOUR)).toBe("in 2 Stunden");
		i18n.loadAndActivate({ locale: "en", messages: {} });
	});
});
