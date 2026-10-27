import { defineConfig } from "@playwright/test";
import base from "./playwright.sync.config";

// The sync suite with combining switched on (docs/sync-conflicts.md, Phase B), as release B2 will
// ship it: both peers are built with VITE_COMBINE_CONCURRENT_EDITS=1, the extension into its own
// folder and the mobile app on its own port, so the default suite keeps testing what ships now.
//
// Run: pnpm test:e2e:sync:combine   (it builds the extension itself)
process.env.COMBINE_CONCURRENT_EDITS = "1";
process.env.EXTENSION_DIR = "dist-chromium-combine";
process.env.MOBILE_APP_URL = "http://localhost:5198";

export default defineConfig({
	...base,
	webServer: [
		{
			command: "node services/nostr-relay/node/relay.mjs",
			port: 7400,
			// The attachments and idle-traffic specs read /stats; this suite runs them too.
			env: { RELAY_STATS: "1" },
			reuseExistingServer: !process.env.CI,
			stdout: "ignore",
		},
		{
			command: "pnpm --filter @vault/platform-mobile exec vite --port 5198 --strictPort",
			url: "http://localhost:5198",
			env: { VITE_COMBINE_CONCURRENT_EDITS: "1" },
			reuseExistingServer: false,
			stdout: "ignore",
		},
	],
});
