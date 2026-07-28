import { defineConfig } from "@playwright/test";

// Two-peer sync tests: the browser extension and the mobile SPA pairing over WebRTC through a
// local signaling relay. Separate from playwright.config.ts because they need two servers up and
// are slower than the single-context extension tests.
//
// Run: pnpm test:e2e:sync   (build the extension first, as with the other e2e suite)
export default defineConfig({
	testDir: "./e2e-sync",
	// Both peers share the relay and fixed ports; nothing here is parallel-safe.
	fullyParallel: false,
	workers: 1,
	// A real handshake plus two Argon2 vault builds.
	timeout: 180_000,
	expect: { timeout: 30_000 },
	reporter: [["list"]],
	forbidOnly: !!process.env.CI,
	retries: 0,
	webServer: [
		{
			// A WebSocket server, so wait on the port rather than an HTTP response.
			command: "node nostr-relay/node/relay.mjs",
			port: 7400,
			reuseExistingServer: !process.env.CI,
			stdout: "ignore",
		},
		{
			command: "pnpm --filter @vault/platform-mobile exec vite --port 5199 --strictPort",
			url: "http://localhost:5199",
			reuseExistingServer: !process.env.CI,
			stdout: "ignore",
		},
	],
});
