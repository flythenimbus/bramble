import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { backgroundWorker, createVault, expectUnlocked, lock, openPopup, unlock } from "./helpers";

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

// A change-password form: old + new + confirm, no username field.
const CHANGE = `<!doctype html><html><head><title>Change password</title></head><body>
	<form>
		<input id="current" name="current" type="password" autocomplete="current-password" />
		<input id="newpass" name="new" type="password" autocomplete="new-password" />
		<input id="confirm" name="confirm" type="password" autocomplete="new-password" />
		<button type="submit">Change password</button>
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

/** Add a saved login for example.com through the popup UI (the account already on file). */
async function seedLogin(popup: Page): Promise<void> {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Example Login");
	await popup.getByRole("button", { name: /Add URL/i }).click();
	await popup.getByLabel("Website URL", { exact: true }).fill("https://example.com");
	await popup.getByLabel("Username or email", { exact: true }).fill("alice@example.com");
	await popup.getByLabel("Password", { exact: true }).fill("s3cr3t-pw-01");
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByText("Example Login")).toBeVisible();
}

/** The `newLogin` flag on the pending capture stash for example.com (save-new vs update intent). */
async function pendingNewLogin(context: BrowserContext): Promise<boolean | undefined> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(async () => {
		const r = await chrome.storage.session.get("capture.pending.example.com");
		return (r["capture.pending.example.com"] as { newLogin?: boolean } | undefined)?.newLogin;
	});
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
	await expect.poll(() => pendingNewLogin(context)).toBe(true);
});

test("a signup with an existing saved login still offers a NEW login, not update", async ({
	context,
	extensionId,
}) => {
	// The exact reported case: the user already has a saved login for the site, then visits its signup
	// page. Using the suggestion must offer to SAVE a new login, not UPDATE the existing one.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedLogin(popup);

	const page = await context.newPage();
	await serve(page, SIGNUP);
	await page.goto("https://example.com/");

	const host = page.locator(HOST);
	await expect(async () => {
		await page.locator("#pass").click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
	const box = await host.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + 30, box!.y + Math.min(36, box!.height / 2));

	await expect(page.locator("#titanpass-corner-prompt")).toBeAttached({ timeout: 10_000 });
	// The capture is flagged as a new login despite the saved match, so the prompt is Save, not Update.
	await expect.poll(() => pendingNewLogin(context)).toBe(true);
});

test("a manually typed signup password captures as a NEW login (submit path)", async ({
	context,
	extensionId,
}) => {
	// The same guarantee for a hand-typed password (no suggestion): submitting a signup form with a
	// saved login on file still captures as a new login, driven by capture.ts.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedLogin(popup);

	const page = await context.newPage();
	await serve(page, SIGNUP);
	await page.goto("https://example.com/");

	await page.locator("#email").fill("new@example.com");
	await page.locator("#pass").fill("Hand-Typed-Pw-123");
	await page.getByRole("button", { name: /Create account/i }).click();

	await expect.poll(() => pendingNewLogin(context)).toBe(true);
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

test("suggests a strong password on a change-password form (new field, not the current one)", async ({
	context,
	extensionId,
}) => {
	// Seed the account being changed, so this is a real rotation scenario, and open the popup so the
	// vault is unlocked and indexed.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedLogin(popup);

	const page = await context.newPage();
	await serve(page, CHANGE);
	await page.goto("https://example.com/");

	// The picker mounts when the NEW-password field is focused (the current-password field is vetoed).
	const host = page.locator(HOST);
	await expect(async () => {
		await page.locator("#newpass").click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	// Use the suggestion (top row).
	const box = await host.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + 30, box!.y + Math.min(36, box!.height / 2));

	// It fills the new-password and confirm fields with the same strong password, leaves the
	// current-password field for the user, and offers to save the rotation.
	await expect.poll(() => page.locator("#newpass").inputValue()).toMatch(STRONG_CHARS);
	const filled = await page.locator("#newpass").inputValue();
	expect(await page.locator("#confirm").inputValue()).toBe(filled);
	expect(await page.locator("#current").inputValue()).toBe("");
	await expect(page.locator("#titanpass-corner-prompt")).toBeAttached({ timeout: 10_000 });
	// A change form is a rotation, not a new login: the capture is NOT flagged new (offers Update).
	await expect.poll(() => pendingNewLogin(context)).toBe(false);
});

test("offers the suggestion while the vault is locked (fills, then prompts Unlock & Save)", async ({
	context,
	extensionId,
}) => {
	// The reported case: a saved login exists, the vault is LOCKED, and the user hits a signup page.
	// Generating a password needs no vault, so the suggestion is offered instead of the unlock row.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedLogin(popup);
	await lock(popup);

	const page = await context.newPage();
	await serve(page, SIGNUP);
	await page.goto("https://example.com/");

	const host = page.locator(HOST);
	await expect(async () => {
		await page.locator("#pass").click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	// Clicking the top row fills a 20-char strong password. (A locked row would instead open the
	// unlock pop-out and leave the field empty.)
	const box = await host.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + 30, box!.y + Math.min(36, box!.height / 2));
	await expect.poll(() => page.locator("#pass").inputValue()).toMatch(STRONG_CHARS);

	// The capture is offered while still locked (the card is "Unlock & Save"), as a new login.
	await expect(page.locator("#titanpass-corner-prompt")).toBeAttached({ timeout: 10_000 });
	await expect.poll(() => pendingNewLogin(context)).toBe(true);
});

test("Unlock & Save commits the new login after unlocking, and confirms it with a toast", async ({
	context,
	extensionId,
}) => {
	// Locked vault -> suggestion -> "Unlock & Save" -> unlock in the pop-out. The capture is
	// parked as a handoff and must be committed on unlock (and shown), not silently dropped.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await lock(popup);

	const page = await context.newPage();
	await serve(page, SIGNUP);
	await page.goto("https://example.com/");

	const host = page.locator(HOST);
	await expect(async () => {
		await page.locator("#pass").click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
	const box = await host.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + 30, box!.y + Math.min(36, box!.height / 2));

	// The locked card offers "Unlock & Save"; click it (bottom-left of the card).
	const card = page.locator("#titanpass-corner-prompt");
	await expect(card).toBeAttached({ timeout: 10_000 });
	const cardBox = await card.boundingBox();
	expect(cardBox).not.toBeNull();
	await page.mouse.click(cardBox!.x + 92, cardBox!.y + 245);
	// The capture is parked for the unlock to pick up.
	await expect
		.poll(
			async () => {
				const sw = await backgroundWorker(context);
				return sw.evaluate(async () => {
					const r = await chrome.storage.session.get("cornerPrompt.handoff");
					return !!r["cornerPrompt.handoff"];
				});
			},
			{ timeout: 10_000 },
		)
		.toBe(true);

	// Unlock: the parked capture commits, a toast confirms it, and the entry lands in the vault.
	await popup.bringToFront();
	await unlock(popup);
	// Toast first: it auto-dismisses after a few seconds.
	await expect(popup.getByRole("status")).toHaveText(/Login saved for example\.com/, {
		timeout: 10_000,
	});
	// The saved login is really in the vault (the toast alone could lie).
	await expect(popup.getByText("Items (1)")).toBeVisible({ timeout: 10_000 });
});

test("click-to-unlock re-surfaces the matches in place, without refocusing (issue b)", async ({
	context,
	extensionId,
}) => {
	// A locked login page: clicking the "Vault locked" row opens the unlock pop-out AND dismisses the
	// dropdown. After unlocking, the matches must re-surface on that field on their own.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedLogin(popup);
	await lock(popup);

	const page = await context.newPage();
	await serve(page, LOGIN);
	await page.goto("https://example.com/");

	const host = page.locator(HOST);
	await expect(async () => {
		await page.locator("#pass").click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	// Click the locked row: it opens the unlock pop-out AND tears the dropdown down (the key
	// condition for this bug — there's no active host left to refresh).
	const box = await host.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
	await expect(host).toHaveCount(0);

	// Unlock (the seed popup is already on the unlock screen after lock()). The matches must
	// re-surface on the field on their own, with nothing focused on the page.
	await unlock(popup);
	await expect(host).toBeAttached({ timeout: 10_000 });
});
