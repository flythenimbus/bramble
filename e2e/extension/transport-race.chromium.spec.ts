import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BrowserContext, chromium, test } from "@playwright/test";
import {
	FIXTURE_DIR,
	type FixtureServer,
	runCase,
	startFixtureServer,
	TRANSPORT_CASES,
} from "./transport-race/harness";

// Chromium half of the document-bound transport gate (GHSA-xm22-vwcg-9jqg). Deliberately does NOT
// use ./fixtures.ts: this loads the tiny contract fixture, not Bramble, and so needs no
// `build:chromium`. Excluded from `pnpm test:e2e`; run via `pnpm test:transport-race`.

let server: FixtureServer;
let browser: BrowserContext;
let profile: string;

test.beforeAll(async () => {
	server = await startFixtureServer();
	profile = await mkdtemp(path.join(tmpdir(), "bramble-transport-chromium-"));
	try {
		browser = await chromium.launchPersistentContext(profile, {
			args: [
				`--disable-extensions-except=${FIXTURE_DIR}`,
				`--load-extension=${FIXTURE_DIR}`,
				"--no-sandbox",
			],
			// Chromium's new headless is the one that actually loads MV3 extensions.
			channel: "chromium",
			headless: true,
			// Playwright disables BFCache by default, and a BFCache restore is one of the three cases.
			ignoreDefaultArgs: ["--disable-back-forward-cache"],
		});
	} catch (error) {
		throw new Error(
			`Chromium prerequisite unavailable. Run \`pnpm exec playwright install chromium\` and retry. ${
				(error as Error).message
			}`,
		);
	}
});

test.afterAll(async () => {
	await browser?.close();
	await server?.close();
	if (profile) await rm(profile, { force: true, recursive: true });
});

for (const testCase of TRANSPORT_CASES) {
	test(`held reply is not redirected across a ${testCase.mode} navigation`, async () => {
		await runCase(
			async (url, state) => {
				const page = await browser.newPage();
				page.on("console", (message) => {
					if (message.type() === "error") state.diagnostics.push(`console: ${message.text()}`);
				});
				page.on("pageerror", (error) => state.diagnostics.push(`pageerror: ${error.message}`));
				await page.goto(url);
				return () => page.close();
			},
			server,
			testCase,
		);
	});
}
