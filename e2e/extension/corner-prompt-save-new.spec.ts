import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	backgroundWorker,
	clickCornerAction,
	createVault,
	openPopup,
	seedExampleLogin,
} from "./helpers";

// "Save as new" on the update-login corner card must add a separate login and leave the saved
// one alone. It used to reply with the plain save action, whose dedupe upgrades a
// single-candidate capture to an update, so the button rotated the existing login instead.

const PROMPT = "#bramble-corner-prompt";

// Signs in without navigating, so the card lands on this document (the SPA path).
const LOGIN = `<!doctype html><html><head><title>login</title></head><body>
	<form id="login">
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
	<script>
		document.getElementById('login').addEventListener('submit', function (e) {
			e.preventDefault();
			setTimeout(function () { document.getElementById('login').remove(); }, 100);
		});
	</script>
</body></html>`;

async function serve(page: Page, html: string): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: html, headers: { "content-type": "text/html" } })
				: route.fulfill({ status: 200, body: "" }),
		);
}

async function hasPendingCapture(context: BrowserContext): Promise<boolean> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(async () => {
		const r = await chrome.storage.session.get("capture.pending.example.com");
		return !!r["capture.pending.example.com"];
	});
}

/** Open a login from the vault list, read its detail view with the password revealed, and go back. */
async function readLogin(popup: Page, name: string) {
	await popup.getByText(name, { exact: true }).click();
	await expect(popup.getByRole("button", { name: "Edit entry" })).toBeVisible();
	await popup.getByRole("button", { name: "Show password" }).click();
	const text = await popup.locator("#root").innerText();
	await popup.getByRole("button", { name: "Go back" }).click();
	return text;
}

test("'Save as new' on the update card adds a login and keeps the existing one", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup, "https://foo.example.com");

	const page = await context.newPage();
	await serve(page, LOGIN);
	await page.goto("https://bar.example.com/");

	// A second account on a sibling subdomain. Dedupe matches on eTLD+1, so the card offers to
	// update the saved alice login.
	await page.locator("#user").fill("bob@example.com");
	await page.locator("#pass").fill("B0b-Second-Account-Pw");
	await page.getByRole("button", { name: "Sign in" }).click();

	await expect(page.locator(PROMPT)).toBeAttached({ timeout: 10_000 });
	await expect.poll(() => hasPendingCapture(context)).toBe(true);
	await clickCornerAction(page, "save-new");
	await expect(page.locator(PROMPT)).toHaveCount(0);
	// The stash is cleared once the background has committed the reply.
	await expect.poll(() => hasPendingCapture(context), { timeout: 10_000 }).toBe(false);

	await openPopup(popup, extensionId);
	await expect(popup.getByText("Example Login", { exact: true })).toBeVisible();
	await expect(popup.getByText("bar.example.com", { exact: true })).toBeVisible();

	const existing = await readLogin(popup, "Example Login");
	expect(existing).toContain("https://foo.example.com");
	expect(existing).toContain("alice@example.com");
	expect(existing).toContain("s3cr3t-pw-01");
	expect(existing).not.toContain("B0b-Second-Account-Pw");

	// The new login is for the page it was captured on, not the entry it was offered against.
	const added = await readLogin(popup, "bar.example.com");
	expect(added).toContain("https://bar.example.com");
	expect(added).not.toContain("foo.example.com");
	expect(added).toContain("bob@example.com");
	expect(added).toContain("B0b-Second-Account-Pw");
});
