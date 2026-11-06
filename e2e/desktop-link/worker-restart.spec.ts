import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createVault, popupUrl } from "../extension/helpers";
import { BROWSER_PW, browserFiles, DESKTOP_PW, expect, test } from "./fixtures";
import {
	addLogin,
	desktopAddLogin,
	desktopApprove,
	desktopConnect,
	desktopConnectedBrowsers,
	desktopCreateAnotherVault,
	desktopSymbols,
	desktopUseLocalRelay,
	linkFromSettings,
} from "./steps";

// A browser that granted the permission when it linked: its worker can never open a pipe, and only
// the worker after it can. See docs/desktop-link-optional-permission.md.
//
// That takes the worker going idle, which an attached debugger prevents, so no other test here can
// see it, and neither can a person with that worker's DevTools open. This one drives the flow, then
// detaches, and watches from outside: the browser's list of targets, and the app's connected browsers.

const PORT = 9377;
/** Past the worker going idle and the alarm after it: about 60 s, with room to spare. */
const RECOVERS_WITHIN_S = 120;

test("the link comes back by itself once the page that lent the pipe has closed", async ({
	desktop,
}) => {
	test.setTimeout(RECOVERS_WITHIN_S * 1000 + 120_000);
	test.skip(process.platform !== "darwin", "macOS only");
	await desktopCreateAnotherVault(`Restart ${Date.now().toString(36)}`);
	await desktopUseLocalRelay();

	const { scratch, profile, extension } = browserFiles(desktop.home, {
		borrowsPipe: true,
		bindingFrom: Date.now() + 12_000,
	});
	const chrome: ChildProcess = spawn(
		chromium.executablePath(),
		[
			`--user-data-dir=${profile}`,
			"--headless=new",
			"--no-first-run",
			"--no-default-browser-check",
			"--no-sandbox",
			"--disable-component-extensions-with-background-pages",
			`--disable-extensions-except=${extension}`,
			`--load-extension=${extension}`,
			`--remote-debugging-port=${PORT}`,
			"about:blank",
		],
		{
			env: { ...process.env, HOME: desktop.home, CFFIXED_USER_HOME: desktop.home },
			stdio: "ignore",
		},
	);
	const debuggerOn = async () => {
		for (let i = 0; ; i++) {
			try {
				return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
			} catch (e) {
				if (i >= 40) throw e;
				await new Promise((r) => setTimeout(r, 500));
			}
		}
	};
	try {
		const browser = await debuggerOn();
		const context = browser.contexts()[0];
		if (!context) throw new Error("no default context");
		const ours = (w: { url(): string }) => w.url().endsWith("/e2e-background.js");
		const sw =
			context.serviceWorkers().find(ours) ??
			(await context.waitForEvent("serviceworker", { predicate: ours, timeout: 30_000 }));
		const extensionId = new URL(sw.url()).host;
		expect(await sw.evaluate(() => typeof chrome.runtime.connectNative)).toBe("undefined");

		const page = await context.newPage();
		await createVault(page, extensionId, BROWSER_PW);
		const detached = `${popupUrl(extensionId)}?detached=1`;
		const popup = await context.newPage();
		await popup.goto(detached);
		await addLogin(popup, "Browser only");
		await desktopConnect();
		const shown = await linkFromSettings(popup);
		expect(await desktopSymbols()).toBe(shown);
		await popup.getByRole("button", { name: "They match" }).click();
		await desktopApprove();
		const offer = popup.locator("form").filter({ hasText: "Sync with the desktop app" });
		await offer.getByLabel("Master password").fill(DESKTOP_PW);
		await offer.getByRole("button", { name: "Sync", exact: true }).click();
		await expect(popup.getByText("This vault syncs with the desktop app.")).toBeVisible({
			timeout: 30_000,
		});
		await expect.poll(desktopConnectedBrowsers, { timeout: 10_000 }).toBeGreaterThan(0);

		// The window that linked closes, nothing lends a pipe now, and the debugger goes too.
		await popup.close();
		await page.close();
		await browser.close();
		await expect.poll(desktopConnectedBrowsers, { timeout: 30_000 }).toBe(0);

		await expect
			.poll(desktopConnectedBrowsers, {
				timeout: RECOVERS_WITHIN_S * 1000,
				intervals: [2000],
			})
			.toBeGreaterThan(0);

		// Sync is back on it, in both directions.
		const name = `After restart ${Date.now().toString(36)}`;
		await desktopAddLogin(name);
		const inspect = await debuggerOn();
		const again = await inspect.contexts()[0]?.newPage();
		if (!again) throw new Error("no default context");
		await again.goto(detached);
		await again.getByRole("button", { name: "Go to vault" }).click();
		await expect(again.getByText("Browser only").first()).toBeVisible();
		await expect(again.getByText(name)).toBeVisible({ timeout: 30_000 });
		await inspect.close();
	} finally {
		chrome.kill();
		await new Promise((r) => setTimeout(r, 500));
		rmSync(scratch, { recursive: true, force: true });
	}
});
