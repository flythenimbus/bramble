import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { backgroundWorker, createVault, expectUnlocked, openPopup } from "./helpers";

// The generator end to end: the panel in the entry form, the settings it saves, and the in-page
// signup suggestion those settings shape. The page half is served with COEP: require-corp for the
// same reason as suggest-password.spec.ts -- it blocks the picker's extension-origin iframe and
// forces the shadow-DOM renderer, whose host is a light-DOM element the test can find and click.

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

const HOST = "#bramble-autofill-dropdown";
// Five EFF words joined by hyphens. Four of the list's words are themselves hyphenated, so the
// count is a floor rather than an exact 4. Nothing the character generator produces can pass
// this: its charset would have to come up all-lowercase with hyphens in every gap.
const PASSPHRASE = /^[a-z]+(?:-[a-z]+){4,}$/;
const CHARACTER_PASSWORD = /^[A-Za-z0-9!@#$%^&*()_+\-=[\]{}|;:,.<>?]{20}$/;

async function serve(page: Page, html: string): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: html, headers: COEP })
				: route.fulfill({ status: 200, body: "" }),
		);
}

/** Count GENERATE_PASSWORD requests reaching the service worker from now on. An extra listener
 * is additive: returning nothing leaves the router's own handling of the message alone. */
async function countGenerateRequests(context: BrowserContext): Promise<() => Promise<number>> {
	const sw = await backgroundWorker(context);
	await sw.evaluate(() => {
		const counted = globalThis as unknown as { __generateCalls?: number };
		counted.__generateCalls = 0;
		chrome.runtime.onMessage.addListener((message: { type?: string }) => {
			if (message?.type === "GENERATE_PASSWORD")
				counted.__generateCalls = (counted.__generateCalls ?? 0) + 1;
		});
	});
	return () =>
		sw.evaluate(() => (globalThis as unknown as { __generateCalls?: number }).__generateCalls ?? 0);
}

/** The generator settings as the background sees them: what the panel saved, read back from the
 * storage the service worker generates from. */
async function storedGeneratorMode(context: BrowserContext): Promise<string | undefined> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(async () => {
		const r = await chrome.storage.local.get("pref.generator");
		return (r["pref.generator"] as { mode?: string } | undefined)?.mode;
	});
}

/** Open the new-login form and the generator panel over it. */
async function openGenerator(popup: Page) {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByRole("button", { name: "Generate strong password" }).click();
	const dialog = popup.getByRole("dialog");
	await expect(dialog).toBeVisible();
	return dialog;
}

/** Focus the signup form's password field until the picker mounts, and return its host. */
async function openPicker(page: Page) {
	const host = page.locator(HOST);
	await expect(async () => {
		await page.locator("#pass").click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
	return host;
}

test("the panel generates into the entry form, in the mode the user picks", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	const dialog = await openGenerator(popup);
	const preview = dialog.locator("p.font-mono").first();
	// It opens with a candidate already made, in the default character mode.
	await expect.poll(() => preview.textContent()).toMatch(CHARACTER_PASSWORD);

	// Switching mode regenerates: the wordlist loads on demand and a passphrase replaces it.
	await dialog.getByRole("button", { name: "Passphrase", exact: true }).click();
	await expect.poll(() => preview.textContent()).toMatch(PASSPHRASE);
	const shown = await preview.textContent();

	// "Use" puts exactly what was on screen into the form's password field, and closes.
	await dialog.getByRole("button", { name: "Use password" }).click();
	await expect(dialog).toHaveCount(0);
	expect(await popup.getByLabel("Password", { exact: true }).inputValue()).toBe(shown);
});

test("the field's refresh icon regenerates from the saved settings, without the panel", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	const dialog = await openGenerator(popup);
	await dialog.getByRole("button", { name: "Passphrase", exact: true }).click();
	await expect.poll(() => dialog.locator("p.font-mono").first().textContent()).toMatch(PASSPHRASE);
	await dialog.getByRole("button", { name: "Use password" }).click();
	const first = await popup.getByLabel("Password", { exact: true }).inputValue();

	// One tap on the icon in the field: a different passphrase, no panel, no second choice to make.
	await popup.getByRole("button", { name: "Generate password" }).click();
	await expect
		.poll(() => popup.getByLabel("Password", { exact: true }).inputValue())
		.not.toBe(first);
	expect(await popup.getByLabel("Password", { exact: true }).inputValue()).toMatch(PASSPHRASE);
});

test("a signup form is suggested a password in the shape the panel was left in", async ({
	context,
	extensionId,
}) => {
	// The point of the whole exercise: settings chosen once in the app reach the place where new
	// passwords are actually made.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	const dialog = await openGenerator(popup);
	await dialog.getByRole("button", { name: "Passphrase", exact: true }).click();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	// The panel saves on change, not on Use: cancelling still leaves the choice made. Gate on the
	// background's own view of it, since that is what the page's suggestion is generated from.
	await expect.poll(() => storedGeneratorMode(context), { timeout: 10_000 }).toBe("passphrase");

	const page = await context.newPage();
	await serve(page, SIGNUP);
	await page.goto("https://example.com/");

	const host = await openPicker(page);
	// Use the suggestion (its row is the dropdown's first, clicked left of the regenerate button).
	const box = await host.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + 30, box!.y + Math.min(36, box!.height / 2));

	await expect.poll(() => page.locator("#pass").inputValue()).toMatch(PASSPHRASE);
});

test("regenerating in the page asks the background, so it stays in that shape too", async ({
	context,
	extensionId,
}) => {
	// The regenerate button makes its own round trip rather than spending what the query carried.
	// A fallback to the content script's own generator would show up here as a character password.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	const dialog = await openGenerator(popup);
	await dialog.getByRole("button", { name: "Passphrase", exact: true }).click();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect.poll(() => storedGeneratorMode(context), { timeout: 10_000 }).toBe("passphrase");

	const page = await context.newPage();
	await serve(page, SIGNUP);
	await page.goto("https://example.com/");

	const host = await openPicker(page);
	const generateRequests = await countGenerateRequests(context);
	const box = await host.boundingBox();
	expect(box).not.toBeNull();
	// The regenerate button sits at the row's right edge. Clicking it must reach the background
	// for a new one...
	await page.mouse.click(box!.x + box!.width - 22, box!.y + Math.min(36, box!.height / 2));
	await expect.poll(generateRequests, { timeout: 10_000 }).toBeGreaterThan(0);
	// ...and swap the offer rather than take it, which is also what proves the click cleared the
	// row it sits inside.
	expect(await page.locator("#pass").inputValue()).toBe("");

	// Now take what regenerate left on offer: still a passphrase.
	await page.mouse.click(box!.x + 30, box!.y + Math.min(36, box!.height / 2));
	await expect.poll(() => page.locator("#pass").inputValue()).toMatch(PASSPHRASE);
});
