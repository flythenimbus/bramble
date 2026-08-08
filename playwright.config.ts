import { defineConfig } from "@playwright/test";

// End-to-end tests that drive a real Chromium with the built extension loaded (see
// e2e/fixtures.ts). Build the extension first: `pnpm --filter @vault/platform-extension build:chromium`.
// Run: `pnpm test:e2e`. These are excluded from the vitest unit suites (different runner).
export default defineConfig({
	testDir: "./e2e/extension",
	// The transport-race gate lives here too but loads its own contract fixture rather than the
	// built extension, so it needs no build and runs from playwright.transport.config.ts.
	testIgnore: /transport-race\.(chromium|firefox)\.spec\.ts$/,
	// Extension tests share a persistent profile and (for sync) a local relay on a fixed port,
	// so run them serially rather than in parallel workers.
	fullyParallel: false,
	workers: 1,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: [["list"]],
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
});
