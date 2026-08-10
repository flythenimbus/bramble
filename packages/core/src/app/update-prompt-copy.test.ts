import { i18n } from "@lingui/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updatePromptCopy } from "./update-prompt-copy";

// The desktop asks about an update in a native dialog, which means the strings are read rather
// than rendered. Two things can go wrong there and neither shows up as a broken build: the
// version can go missing from a sentence that exists to name it, and Lingui can throw on a locale
// that has not loaded yet, which would swallow the only nudge anyone gets about a fix.

afterEach(() => vi.restoreAllMocks());

describe("updatePromptCopy", () => {
	it("names the version once a locale is active", () => {
		i18n.load("en", {});
		i18n.activate("en");

		const copy = updatePromptCopy("2.4.1");

		expect(copy.body).toContain("2.4.1");
		expect(copy.title.length).toBeGreaterThan(0);
		expect(copy.ok.length).toBeGreaterThan(0);
		expect(copy.cancel.length).toBeGreaterThan(0);
	});

	it("answers in English rather than throwing when no locale is loaded", () => {
		// Lingui throws here instead of falling back, and the caller runs off a launch timer that
		// could beat the catalog load. Throwing would mean no dialog at all.
		// Stubbed rather than reset: i18n.locale is read-only, and the singleton stays activated
		// once any other test in this worker has touched it.
		vi.spyOn(i18n, "locale", "get").mockReturnValue("");

		const copy = updatePromptCopy("2.4.1");

		expect(copy.body).toContain("2.4.1");
		expect(copy.title).toBe("Update Bramble");
	});
});
