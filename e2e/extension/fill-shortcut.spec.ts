import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { backgroundWorker, createVault, openPopup, seedExampleLogin } from "./helpers";

// Two ways to act on a site's logins besides picking one: the fill shortcut (#215), Ctrl+Shift+L
// (Cmd+Shift+L on a Mac), which fills the site's first login, or the first whose username starts
// with what is typed, also with "Autofill on web pages" off; and the dropdown's New login row (#213).
//
// A synthetic key press never reaches Chrome's extension shortcuts, so the test dispatches the
// command to the background's real listener, with the real tab, as the browser would.

let server: Server;
let port: number;
const site = () => `http://launch.test:${port}`;

const LOGIN = `<!doctype html><html><head><title>Sign in</title></head>
<body><form action="/login">
	<input id="user" name="username" type="text" autocomplete="username" />
	<input id="pass" name="password" type="password" autocomplete="current-password" />
	<button type="submit">Sign in</button>
</form></body></html>`;

test.beforeAll(async () => {
	server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(LOGIN);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});
test.afterAll(() => server.close());

const pickerFrame = (page: Page): Frame | undefined =>
	page.frames().find((f) => f.url().includes("autofill-ui.html"));

async function pressShortcut(context: BrowserContext): Promise<void> {
	const sw = await backgroundWorker(context);
	await sw.evaluate(async (url) => {
		const [tab] = await chrome.tabs.query({ url });
		(
			chrome.commands.onCommand as unknown as {
				dispatch: (command: string, tab?: chrome.tabs.Tab) => void;
			}
		).dispatch("fill-login", tab);
	}, `${site()}/*`);
}

async function vaultWithLogin(context: BrowserContext, extensionId: string): Promise<Page> {
	await createVault(await context.newPage(), extensionId);
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup, `${site()}/`);
	return popup;
}

async function openSite(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	await page.goto(`${site()}/`);
	await page.bringToFront();
	return page;
}

test("the shortcut fills the page's login", async ({ context, extensionId }) => {
	await vaultWithLogin(context, extensionId);
	const page = await openSite(context);
	await pressShortcut(context);
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
	await expect(page.locator("#user")).toHaveValue("alice@example.com");
});

test("it fills with Autofill on web pages off", async ({ context, extensionId }) => {
	await vaultWithLogin(context, extensionId);
	const sw = await backgroundWorker(context);
	await sw.evaluate(() => chrome.storage.local.set({ "pref.autofillEnabled": false }));
	const page = await openSite(context);
	// Off, a click into the field shows no dropdown.
	await page.locator("#user").click();
	await page.waitForTimeout(1_000);
	expect(pickerFrame(page)).toBeUndefined();
	await pressShortcut(context);
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
});

test("with several logins it fills the first, or the one whose username starts with what's typed", async ({
	context,
	extensionId,
}) => {
	const popup = await vaultWithLogin(context, extensionId);
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Second Login");
	await popup.getByRole("button", { name: /Add URL/i }).click();
	await popup.getByLabel("Website URL", { exact: true }).fill(`${site()}/`);
	await popup.getByLabel("Username or email", { exact: true }).fill("bob@example.com");
	await popup.getByLabel("Password", { exact: true }).fill("another-pw-02");
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByText("Second Login")).toBeVisible();

	const page = await openSite(context);
	await pressShortcut(context);
	await expect(page.locator("#pass")).toHaveValue(/^(s3cr3t-pw-01|another-pw-02)$/);
	const first = await page.locator("#user").inputValue();

	// Typed "bo": bob's login, whichever came first.
	await page.reload();
	await page.locator("#user").fill("bo");
	await pressShortcut(context);
	await expect(page.locator("#user")).toHaveValue("bob@example.com");
	await expect(page.locator("#pass")).toHaveValue("another-pw-02");

	// Typed "al": alice's.
	await page.reload();
	await page.locator("#user").fill("al");
	await pressShortcut(context);
	await expect(page.locator("#user")).toHaveValue("alice@example.com");
	expect(["alice@example.com", "bob@example.com"]).toContain(first);
});

// #213: under a site's logins, a row that opens Bramble's form to save another one, with the site
// and a name filled in.
test("the dropdown's New login row opens the create form for the site", async ({
	context,
	extensionId,
}) => {
	await vaultWithLogin(context, extensionId);
	const page = await openSite(context);
	await page.locator("#user").click();
	await expect.poll(() => pickerFrame(page), { timeout: 10_000 }).toBeDefined();
	const row = pickerFrame(page)?.locator("[data-tp-new-login]");
	if (!row) throw new Error("no picker");
	await expect(row).toBeVisible();

	const [form] = await Promise.all([context.waitForEvent("page"), row.click()]);
	await expect(form.getByRole("heading", { name: "New Login" })).toBeVisible();
	await expect(form.getByLabel("Website URL", { exact: true })).toHaveValue(site());
	await expect(form.getByLabel("Name", { exact: true })).toHaveValue("launch.test");
});
