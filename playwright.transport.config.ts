import { defineConfig } from "@playwright/test";

// Security gate for the document-bound autofill transport (GHSA-xm22-vwcg-9jqg): proves a held
// request/reply is never redirected into a replacement document after a navigation reuses the
// frame. Separate from playwright.config.ts because it loads a tiny contract fixture instead of
// Bramble, so it needs no `build:chromium` and stays seconds-fast.
//
// Run: pnpm test:transport-race                      (both browsers)
//      pnpm test:transport-race --project=chromium   (one browser; CI runs them as separate jobs)
//
// Firefox needs FIREFOX_BINARY, since web-ext drives it (Playwright cannot install a Firefox
// add-on). FIREFOX_HEADLESS=0 to watch it.
export default defineConfig({
	testDir: "./e2e/extension",
	// One fixture server and one browser per file; the races are timing-sensitive.
	fullyParallel: false,
	workers: 1,
	// Firefox boots a fresh browser per case, so allow for three cold starts.
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	forbidOnly: !!process.env.CI,
	// A race that only passes on retry is a failure; this gate must be deterministic.
	retries: 0,
	projects: [
		{ name: "chromium", testMatch: /transport-race\.chromium\.spec\.ts$/ },
		{ name: "firefox", testMatch: /transport-race\.firefox\.spec\.ts$/ },
	],
});
