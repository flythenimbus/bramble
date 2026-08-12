import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import {
	FIXTURE_DIR,
	type FixtureServer,
	runCase,
	startFixtureServer,
	stopProcess,
	TRANSPORT_CASES,
} from "./transport-race/harness";

// Firefox half of the document-bound transport gate (GHSA-xm22-vwcg-9jqg).
//
// Playwright cannot install a WebExtension in Firefox (extensions are Chromium-only, and only
// with a persistent context), so `web-ext` drives the browser and Playwright is only the runner:
// it supplies the reporter, timeouts and CI wiring. The contract itself is shared with the
// Chromium spec via ./transport-race/harness, so both browsers prove the identical property.
//
// FIREFOX_BINARY must name the browser to test. CI runs the declared floor (128.0) and latest;
// there is deliberately no frame-target fallback if a floor fails.

const dir = path.dirname(fileURLToPath(import.meta.url));
const webExt = process.env.WEB_EXT ?? path.resolve(dir, "../../node_modules/.bin/web-ext");
const firefox = process.env.FIREFOX_BINARY;

let server: FixtureServer;

test.beforeAll(async () => {
	if (!firefox) {
		throw new Error(
			"FIREFOX_BINARY must name Firefox ESR 128+ or current Firefox; no frame-target fallback is permitted",
		);
	}
	server = await startFixtureServer();
});

test.afterAll(async () => {
	await server?.close();
});

for (const testCase of TRANSPORT_CASES) {
	test(`held reply is not redirected across a ${testCase.mode} navigation`, async () => {
		await runCase(
			async (url, state) => {
				const args = [
					"run",
					"--source-dir",
					FIXTURE_DIR,
					"--firefox",
					firefox as string,
					"--no-reload",
					"--start-url",
					url,
				];
				// Firefox sizes the back/forward cache from detected RAM
				// (browser.sessionhistory.max_total_viewers defaults to -1, "decide for me"), and on a
				// small or busy machine that decision is 0, which disables bfcache outright. The
				// bfcache case then cannot set itself up: A leaves with pagehide persisted=false and
				// going back builds a new document. Pinning it makes this gate test the transport
				// rather than the runner it happens to land on.
				args.push("--pref=browser.sessionhistory.max_total_viewers=3");
				// Explicit for the same reason: it is the default in the versions under test, but the
				// point here is not to depend on a default.
				args.push("--pref=fission.bfcacheInParent=true");
				if (process.env.FIREFOX_HEADLESS !== "0") args.push("--arg=-headless");
				// Detached so the wrapper leads a process group: stopProcess signals the group, which
				// is the only way the Firefox web-ext started goes down with it. See stopProcess.
				const child = spawn(webExt, args, { detached: true, stdio: "inherit" });
				child.once("error", (error) => {
					state.processError = `web-ext could not start Firefox: ${error.message}`;
					state.notify();
				});
				child.once("exit", (code, signal) => {
					if (state.stopping) return;
					state.processError = `web-ext exited before the transport contract completed (code ${code}, signal ${signal})`;
					state.notify();
				});
				return () => stopProcess(child);
			},
			server,
			testCase,
		);
	});
}
