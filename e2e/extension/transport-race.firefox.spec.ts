import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import {
	BfcacheUnstageable,
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
		// An environment that cannot bfcache anything cannot run this case; the control inside
		// runCase is what proves that, and only that turns into a skip. A refusal the control does
		// not reproduce is still a failure. See BfcacheUnstageable.
		await stageable(() =>
			runCase(
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
					// stdout is piped, not inherited, so addonInstalled can read it.
					const child = spawn(webExt, args, {
						detached: true,
						stdio: ["ignore", "pipe", "inherit"],
					});
					child.once("error", (error) => {
						state.processError = `web-ext could not start Firefox: ${error.message}`;
						state.notify();
					});
					child.once("exit", (code, signal) => {
						if (state.stopping) return;
						state.processError = `web-ext exited before the transport contract completed (code ${code}, signal ${signal})`;
						state.notify();
					});
					try {
						await addonInstalled(child);
					} catch (error) {
						state.stopping = true;
						await stopProcess(child);
						throw error;
					}
					return () => stopProcess(child);
				},
				server,
				testCase,
			),
		);
	});
}

/**
 * How long Firefox gets to start and take the fixture, apart from the race's own budget. A cold
 * first launch on a CI runner has run past 15 s on its own, which spent the whole race budget before
 * any document existed; launches that made it took 11 s at most.
 */
const STARTUP_TIMEOUT_MS = 45_000;

/** What web-ext logs once the add-on is in (lib/firefox/remote.js). */
const INSTALLED = "as a temporary add-on";

/**
 * Resolves once web-ext has installed the fixture, which it does only after Firefox is up, so
 * open() returns a ready browser the way the Chromium spec's does after page.goto. The start URL
 * is already loading by then, and Firefox injects the content script into it. web-ext's output is
 * passed through so the log keeps it.
 */
function addonInstalled(child: ChildProcess): Promise<void> {
	child.stdout?.pipe(process.stdout, { end: false });
	let output = "";
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() =>
				settle(
					new Error(
						`Firefox did not start with the fixture installed within ${STARTUP_TIMEOUT_MS / 1000} s`,
					),
				),
			STARTUP_TIMEOUT_MS,
		);
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes(INSTALLED)) settle();
		};
		const onExit = () => settle(new Error("web-ext exited before Firefox took the fixture"));
		const onError = (error: Error) =>
			settle(new Error(`web-ext could not start: ${error.message}`));
		function settle(error?: Error) {
			clearTimeout(timer);
			child.stdout?.off("data", onData);
			child.off("exit", onExit);
			child.off("error", onError);
			if (error) reject(error);
			else resolve();
		}
		child.stdout?.on("data", onData);
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

/**
 * Run a case, turning "this environment cannot stage the scenario" into a visible skip. Never a
 * pass: a skipped line in the report says the contract was not exercised here, which is the honest
 * outcome when the browser refuses to cache even a page that holds nothing open.
 */
async function stageable(run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (error) {
		if (error instanceof BfcacheUnstageable) {
			// The reason has to reach the LOG, not just the report annotation: a skip nobody can read
			// is the silent gate this suite exists to avoid.
			console.warn(`SKIPPING a security case: ${error.message}`);
			test.skip(true, error.message);
		}
		throw error;
	}
}
