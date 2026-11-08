import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, seedExampleLogin } from "./helpers";

// "Open website" fills that login once in the tab it opened. See docs/launch-and-fill.md.
//
// Served from a real local server (the hostnames resolve to it, see fixtures.ts), not
// context.route: Playwright can't intercept the first navigation of a tab the extension opens,
// and that first load is the feature.

let server: Server;
let port: number;
let pages: Record<string, string> = {};

const site = () => `http://launch.test:${port}`;
const sameSite = () => `http://login.launch.test:${port}`;
const other = () => `http://other-site.test:${port}`;

test.beforeAll(async () => {
	server = createServer((req, res) => {
		const body = pages[`http://${req.headers.host}${req.url}`];
		res.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html" });
		res.end(body ?? "");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});
test.afterAll(() => server.close());

const USERNAME = "alice@example.com";
const PASSWORD = "s3cr3t-pw-01";
// Long enough for the content script to have run and claimed, in the cases that must not fill.
const SETTLE_MS = 1_500;

const LOGIN = `<!doctype html><html><head><title>Sign in</title></head>
<body style="margin:0;height:380px"><form action="/login">
	<input id="user" name="username" type="text" autocomplete="username" />
	<input id="pass" name="password" type="password" autocomplete="current-password" />
	<button type="submit">Sign in</button>
</form></body></html>`;

const redirectTo = (url: string) =>
	`<!doctype html><script>location.replace(${JSON.stringify(url)})</script>`;

function framed(src: string, style = "", before = ""): string {
	return `<!doctype html><html><head><title>Account</title></head>
<body style="margin:0">${before}<div style="height:40px">Account</div>
	<iframe id="f" src="${src}" frameborder="0"
		style="height:400px;width:432px;border:0;display:block;${style}"></iframe>
</body></html>`;
}

/** A vault holding the example login, then "Open website" on it. Returns the tab it opened. */
async function launch(context: BrowserContext, extensionId: string): Promise<Page> {
	await createVault(await context.newPage(), extensionId);
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup, `${site()}/`);
	const [tab] = await Promise.all([
		context.waitForEvent("page"),
		popup.getByRole("link", { name: "Open website" }).first().click(),
	]);
	await tab.waitForLoadState();
	return tab;
}

test("a launch fills the login", async ({ context, extensionId }) => {
	pages = { [`${site()}/`]: LOGIN };
	const tab = await launch(context, extensionId);
	await expect(tab.locator("#pass")).toHaveValue(PASSWORD);
	await expect(tab.locator("#user")).toHaveValue(USERNAME);
});

test("a launch fills after a redirect to the login page", async ({ context, extensionId }) => {
	pages = { [`${site()}/`]: redirectTo(`${site()}/login`), [`${site()}/login`]: LOGIN };
	const tab = await launch(context, extensionId);
	await expect(tab.locator("#pass")).toHaveValue(PASSWORD);
});

test("a reload doesn't fill again", async ({ context, extensionId }) => {
	pages = { [`${site()}/`]: LOGIN };
	const tab = await launch(context, extensionId);
	await expect(tab.locator("#pass")).toHaveValue(PASSWORD);
	await tab.reload();
	await tab.waitForTimeout(SETTLE_MS);
	await expect(tab.locator("#pass")).toHaveValue("");
});

test("a page opened any other way doesn't fill", async ({ context, extensionId }) => {
	pages = { [`${site()}/`]: LOGIN };
	await createVault(await context.newPage(), extensionId);
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup, `${site()}/`);
	const tab = await context.newPage();
	await tab.goto(`${site()}/`);
	await tab.waitForTimeout(SETTLE_MS);
	await expect(tab.locator("#pass")).toHaveValue("");
});

test("another site in the tab gets nothing", async ({ context, extensionId }) => {
	pages = { [`${site()}/`]: redirectTo(`${other()}/login`), [`${other()}/login`]: LOGIN };
	const tab = await launch(context, extensionId);
	await tab.waitForURL(`${other()}/login`);
	await tab.waitForTimeout(SETTLE_MS);
	await expect(tab.locator("#pass")).toHaveValue("");
});

test("a same-site frame fills", async ({ context, extensionId }) => {
	pages = {
		[`${site()}/`]: framed(`${sameSite()}/signin`),
		[`${sameSite()}/signin`]: LOGIN,
	};
	const tab = await launch(context, extensionId);
	await expect(tab.frameLocator("#f").locator("#pass")).toHaveValue(PASSWORD);
});

test("a cross-site frame doesn't fill", async ({ context, extensionId }) => {
	pages = { [`${site()}/`]: framed(`${other()}/signin`), [`${other()}/signin`]: LOGIN };
	const tab = await launch(context, extensionId);
	await tab.waitForTimeout(SETTLE_MS);
	await expect(tab.frameLocator("#f").locator("#pass")).toHaveValue("");
});

test("the login's own frame doesn't fill under another site's page", async ({
	context,
	extensionId,
}) => {
	pages = {
		[`${site()}/`]: redirectTo(`${other()}/`),
		[`${other()}/`]: framed(`${site()}/signin`),
		[`${site()}/signin`]: LOGIN,
	};
	const tab = await launch(context, extensionId);
	await tab.waitForURL(`${other()}/`);
	await tab.waitForTimeout(SETTLE_MS);
	await expect(tab.frameLocator("#f").locator("#pass")).toHaveValue("");
});

test("a frame the user can't see doesn't fill", async ({ context, extensionId }) => {
	pages = {
		[`${site()}/`]: framed(`${sameSite()}/signin`, "opacity:0"),
		[`${sameSite()}/signin`]: LOGIN,
	};
	const tab = await launch(context, extensionId);
	await tab.waitForTimeout(SETTLE_MS);
	await expect(tab.frameLocator("#f").locator("#pass")).toHaveValue("");
});

test("a frame yields to a password field on the top page", async ({ context, extensionId }) => {
	// Already filled in, so the top page can't claim and the frame is the only one asking.
	const topForm = `<form action="/login">
		<input id="pass" name="password" type="password" value="typed" autocomplete="current-password" /></form>`;
	pages = {
		[`${site()}/`]: framed(`${sameSite()}/signin`, "", topForm),
		[`${sameSite()}/signin`]: LOGIN,
	};
	const tab = await launch(context, extensionId);
	await tab.waitForTimeout(SETTLE_MS);
	await expect(tab.frameLocator("#f").locator("#pass")).toHaveValue("");
});

test("a password prompt the user clicked through to doesn't fill", async ({
	context,
	extensionId,
}) => {
	pages = {
		[`${site()}/`]: `<!doctype html><body><a id="go" href="/confirm">Delete account</a></body>`,
		[`${site()}/confirm`]: LOGIN,
	};
	const tab = await launch(context, extensionId);
	await tab.locator("#go").click();
	await tab.waitForURL(`${site()}/confirm`);
	await tab.waitForTimeout(SETTLE_MS);
	await expect(tab.locator("#pass")).toHaveValue("");
});

test("a frame nested inside another site's frame doesn't fill", async ({
	context,
	extensionId,
}) => {
	const inner = `<!doctype html><body style="margin:0"><iframe id="inner" src="${sameSite()}/signin"
		frameborder="0" style="height:400px;width:432px;border:0;display:block"></iframe></body>`;
	pages = {
		[`${site()}/`]: framed(`${other()}/partner`),
		[`${other()}/partner`]: inner,
		[`${sameSite()}/signin`]: LOGIN,
	};
	const tab = await launch(context, extensionId);
	await tab.waitForTimeout(SETTLE_MS);
	await expect(tab.frameLocator("#f").frameLocator("#inner").locator("#pass")).toHaveValue("");
});

test("a change-password form doesn't fill", async ({ context, extensionId }) => {
	pages = {
		[`${site()}/`]: `<!doctype html><body><form action="/account">
			<input id="pass" name="old" type="password" autocomplete="current-password" />
			<input name="new" type="password" autocomplete="new-password" />
			<input name="confirm" type="password" autocomplete="new-password" /></form></body>`,
	};
	const tab = await launch(context, extensionId);
	await tab.waitForTimeout(SETTLE_MS);
	await expect(tab.locator("#pass")).toHaveValue("");
});

test("the top page's form wins over a frame's", async ({ context, extensionId }) => {
	const topForm = `<form action="/login">
		<input id="user" name="username" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" /></form>`;
	pages = {
		[`${site()}/`]: framed(`${sameSite()}/signin`, "", topForm),
		[`${sameSite()}/signin`]: LOGIN,
	};
	const tab = await launch(context, extensionId);
	await expect(tab.locator("#pass")).toHaveValue(PASSWORD);
	await expect(tab.frameLocator("#f").locator("#pass")).toHaveValue("");
});
