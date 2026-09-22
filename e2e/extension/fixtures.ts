import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, test as base, chromium } from "@playwright/test";

const dir = path.dirname(fileURLToPath(import.meta.url));
/** The built, unpacked Chromium extension. Build it first: `pnpm --filter @vault/platform-extension build:chromium`. */
const EXTENSION_PATH = path.resolve(dir, "../../packages/platform-extension/dist-chromium");

/**
 * Launch a persistent Chromium with the extension loaded and resolve its id from the MV3
 * background service worker. Each call gets its own throwaway profile, so two calls are two
 * independent "devices" (used by the sync test). Headless by default (Chromium's new headless
 * loads MV3 extensions); set HEADED=1 to watch it.
 */
export async function launchExtensionContext(reuseProfileDir?: string): Promise<{
	context: BrowserContext;
	extensionId: string;
	profileDir: string;
}> {
	// Pass an existing dir to relaunch the SAME profile - a real browser restart (persisted
	// chrome.storage.local carries over). Omit it for a fresh throwaway "device".
	const profileDir = reuseProfileDir ?? mkdtempSync(path.join(tmpdir(), "bramble-e2e-"));
	const context = await chromium.launchPersistentContext(profileDir, {
		// `channel: "chromium"` runs Chromium's NEW headless, which (unlike the default/old headless)
		// actually loads MV3 extensions and starts their service worker. HEADED=1 shows the window.
		channel: "chromium",
		// The specs match English UI strings; a host in another locale would translate them.
		locale: "en-US",
		...(process.env.HEADED ? { headless: false } : {}),
		args: [
			`--disable-extensions-except=${EXTENSION_PATH}`,
			`--load-extension=${EXTENSION_PATH}`,
			"--no-sandbox",
		],
	});
	let [sw] = context.serviceWorkers();
	if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
	const extensionId = new URL(sw.url()).host;
	// Wait out the SW's one-time storage migration: its ghost-record reap can delete a
	// vault that is still being created (registry record written, blob not yet).
	for (let i = 0; i < 100; i++) {
		const settled = await sw.evaluate(async () => {
			const r = await chrome.storage.local.get("vault.registry");
			return r["vault.registry"] !== undefined;
		});
		if (settled) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	return { context, extensionId, profileDir };
}

/** Single-device fixture: `context` + `extensionId` for tests that only need one browser. */
export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures destructuring param.
	context: async ({}, use) => {
		const { context, profileDir } = await launchExtensionContext();
		await use(context);
		await context.close();
		rmSync(profileDir, { recursive: true, force: true });
	},
	extensionId: async ({ context }, use) => {
		let [sw] = context.serviceWorkers();
		if (!sw) sw = await context.waitForEvent("serviceworker");
		await use(new URL(sw.url()).host);
	},
});

export const expect = test.expect;
