import { rmSync } from "node:fs";
import { chromium } from "@playwright/test";
import { launchExtensionContext } from "../extension/fixtures";
import { optionsUrl } from "../extension/helpers";
import { type Peer, pairWithPhone, test, timeEdit } from "./fixtures";

// Apps update at different times, so for weeks after a release a device that resends its whole
// vault every 4 s is paired with one that sends only what changed (docs/sync-rebroadcast.md).
// Edits must keep moving both ways. Each test needs the older build and skips without it:
//
//   BRAMBLE_OLD_EXTENSION   an older extension's dist-chromium (see e2e/README.md)
//   BRAMBLE_OLD_MOBILE_URL  the mobile app from an older checkout, served by its own vite, e.g.
//                           `npx vite --port 5299` in that checkout's packages/platform-mobile

async function bothWays(browser: Parameters<typeof pairWithPhone>[0], phone: Peer) {
	const popup = await pairWithPhone(browser, phone);
	await popup.waitForTimeout(10_000);
	await timeEdit(popup, phone.page, "browser to phone");
	await timeEdit(phone.page, popup, "phone to browser");
	await popup.waitForTimeout(20_000);
	await timeEdit(popup, phone.page, "browser to phone, after a pause");
	await timeEdit(phone.page, popup, "phone to browser, after a pause");
}

test("an older extension and the current app keep each other in step", async ({ mobile }) => {
	const oldBuild = process.env.BRAMBLE_OLD_EXTENSION;
	test.skip(!oldBuild, "needs BRAMBLE_OLD_EXTENSION, an older extension build");
	const older = await launchExtensionContext(undefined, oldBuild);
	try {
		const page = await older.context.newPage();
		await page.goto(optionsUrl(older.extensionId));
		await page.locator("#root").waitFor();
		await bothWays({ context: older.context, page, extensionId: older.extensionId }, mobile);
	} finally {
		await older.context.close();
		rmSync(older.profileDir, { recursive: true, force: true });
	}
});

test("the current extension and an older app keep each other in step", async ({ ext }) => {
	const oldApp = process.env.BRAMBLE_OLD_MOBILE_URL;
	test.skip(!oldApp, "needs BRAMBLE_OLD_MOBILE_URL, an older mobile app being served");
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto(oldApp as string, { waitUntil: "domcontentloaded" });
		await page.locator("#root").waitFor();
		await bothWays(ext, { context, page });
	} finally {
		await browser.close();
	}
});
