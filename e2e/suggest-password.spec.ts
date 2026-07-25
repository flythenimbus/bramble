import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup } from "./helpers";

// Drives the strong-password suggestion end to end through the real content script, the picker,
// and the background save path. Like autofill-unlock.spec.ts, the pages are served with
// COEP: require-corp, which blocks the picker's extension-origin iframe and forces its shadow-DOM
// renderer, whose host (`#titanpass-autofill-dropdown`) is a light-DOM element we can observe and
// click. The suggestion row itself lives in a closed shadow root, so we activate it by clicking
// its on-screen position rather than by selector.

const COEP = {
	"content-type": "text/html",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
};

const SIGNUP = `<!doctype html><html><head><title>Sign up</title></head><body>
	<form>
		<input id="email" name="email" type="email" autocomplete="email" />
		<input id="pass" name="password" type="password" autocomplete="new-password" />
		<button type="submit">Create account</button>
	</form>
</body></html>`;

const LOGIN = `<!doctype html><html><head><title>login</title></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
</body></html>`;

const HOST = "#titanpass-autofill-dropdown";
const STRONG_CHARS = /^[A-Za-z0-9!@#$%^&*()_+\-=[\]{}|;:,.<>?]{20}$/;

/** Serve `html` for example.com under COEP (forces the shadow renderer); subresources are empty 200s. */
async function serve(page: Page, html: string): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: html, headers: COEP })
				: route.fulfill({ status: 200, body: "" }),
		);
}

test("suggests a strong password on a signup form, then fills it and offers to save", async ({
	context,
	extensionId,
}) => {
	// A fresh unlocked vault with no saved login for the site, so the only thing the dropdown can
	// offer on the password field is the generated-password suggestion. Open the popup so the vault
	// is unlocked and the (empty) autofill index is pushed before the page queries.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	const page = await context.newPage();
	await serve(page, SIGNUP);
	await page.goto("https://example.com/");

	// Focusing the new-password field mounts the picker; the suggestion is its only possible content.
	const host = page.locator(HOST);
	await expect(async () => {
		await page.locator("#pass").click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	// The suggestion row is the top row of the dropdown; click its left area (past the avatar, clear
	// of the regenerate button on the right) to use it.
	const box = await host.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + 30, box!.y + Math.min(36, box!.height / 2));

	// It fills the page's password field with a 20-character strong password...
	await expect.poll(() => page.locator("#pass").inputValue()).toMatch(STRONG_CHARS);
	// ...and the in-page save prompt is offered for the new login.
	await expect(page.locator("#titanpass-corner-prompt")).toBeAttached({ timeout: 10_000 });
});

test("does not suggest on a login form (current-password vetoes the offer)", async ({
	context,
	extensionId,
}) => {
	// Unlocked vault, no saved login: a signup form would offer a suggestion here, but a login form
	// (current-password, no matches) must show nothing at all. Open the popup first so the query
	// resolves as unlocked (an un-hydrated index would mount the "Vault locked" row and confound us).
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	const page = await context.newPage();
	await serve(page, LOGIN);
	await page.goto("https://example.com/");

	await page.locator("#pass").click();
	// Give the content script ample time to inject, query the background, and decide.
	await page.waitForTimeout(3000);
	await expect(page.locator(HOST)).toHaveCount(0);
});
