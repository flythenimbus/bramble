import { defineConfig } from "@playwright/test";

// On-device tests: drive the installed Android app over its WebView devtools socket (see
// e2e/android/fixtures.ts). Separate from playwright.config.ts because these need a physical
// device attached and mutate real app state, so they must never join the default `pnpm test:e2e`.
//
// Run: pnpm test:e2e:android   (needs `adb devices` to show exactly one device, and a debuggable
// build of the app installed — Capacitor only exposes the devtools socket for those.)
export default defineConfig({
	testDir: "./e2e/android",
	// One device, one WebView: everything is shared state.
	fullyParallel: false,
	workers: 1,
	// Real hardware plus real Argon2 unlocks; desktop timings don't apply.
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	forbidOnly: !!process.env.CI,
	// No retries: a rerun against a device left mid-flow by the first attempt is misleading.
	retries: 0,
	// The signaling relay for the extension<->device sync spec. Cheap enough to leave running for
	// the read-only specs too. adb reverse (in the fixture) is what lets the phone reach it.
	webServer: [
		{
			command: "node nostr-relay/node/relay.mjs",
			port: 7400,
			reuseExistingServer: !process.env.CI,
			stdout: "ignore",
		},
	],
});
