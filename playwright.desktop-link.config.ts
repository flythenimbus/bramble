import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

// The real desktop app and the real extension, linked on one machine (e2e/desktop-link). Opt-in
// and macOS only: it runs the desktop app's debug build with a throwaway keychain, and its window
// appears on screen while the suite runs. See e2e/README.md.
//
// Run: pnpm test:e2e:desktop-link   (builds the extension and the desktop app first)

// One secret per run for the desktop's dev-only bridge. Set here, before the servers start, so the
// dev server and the test workers (which inherit this environment) hold the same one.
process.env.BRAMBLE_E2E_TOKEN ??= randomBytes(32).toString("hex");

const mac = process.platform === "darwin";

export default defineConfig({
	testDir: "./e2e/desktop-link",
	// One desktop app, one link socket and fixed ports: nothing here is parallel-safe.
	fullyParallel: false,
	workers: 1,
	// Argon2 vault builds on both sides, plus a 20 s watch of the relay in the first test.
	timeout: 180_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	forbidOnly: !!process.env.CI,
	retries: 0,
	webServer: mac
		? [
				{
					// The relay the desktop is pointed at, so nothing reaches the hosted one.
					command: "node services/nostr-relay/node/relay.mjs",
					port: 7400,
					reuseExistingServer: false,
					stdout: "ignore",
				},
				{
					// The desktop app's debug build loads its window from here, on this fixed port.
					// Never reused: a dev server already on 1420 would be someone else's.
					command: "pnpm --filter @vault/platform-desktop exec vite --port 1420 --strictPort",
					url: "http://localhost:1420",
					env: { VITE_E2E_BRIDGE: "1" },
					reuseExistingServer: false,
					stdout: "ignore",
				},
			]
		: [],
});
