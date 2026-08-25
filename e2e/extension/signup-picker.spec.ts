import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, lock, openPopup, seedExampleLogin } from "./helpers";

// What the picker offers on a form that CREATES a credential rather than fills one. The user is
// inventing an account there, so the matches are clutter and the "Vault locked" row is worse: it
// offers a window and a master password to fill a form that fills nothing.
//
// The safety half matters more than the suppression half, because a false positive here is
// SILENT - the picker simply never appears. The riskiest shape is a two-step login's email
// screen, which is structurally a signup's email screen minus one field, so every negative case
// below is guarded by a positive one on the same tab: the /signin page must still offer. A plain
// login form is covered end to end by autofill-unlock.spec.ts.
//
// Pages are served under COEP: require-corp, which blocks the picker's extension-origin iframe
// and forces its shadow-DOM renderer, whose host is a light-DOM element we can observe.

const COEP = {
	"content-type": "text/html",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
};

const HOST = "#titanpass-autofill-dropdown";
const STRONG_CHARS = /^[A-Za-z0-9!@#$%^&*()_+\-=[\]{}|;:,.<>?]{20}$/;

const doc = (body: string, title: string): string =>
	`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

// An ordinary signup form: the password box is right here, and scores on its own token.
const SIGNUP = doc(
	`<form>
		<input id="email" name="email" type="email" autocomplete="email" />
		<input id="pass" name="password" type="password" autocomplete="new-password" />
		<button type="submit">Create account</button>
	</form>`,
	"Sign up",
);

// The reported page: a registration step that collects the identity and defers the password to
// the next screen. Nothing here is a password field, so the only tell is the repeated email.
const SIGNUP_STEP = doc(
	`<form>
		<label for="country">Country</label>
		<select id="country" name="country"><option>CA - Canada</option></select>
		<label for="email">Email address</label>
		<input id="email" name="email" type="email" autocomplete="email" />
		<label for="email2">Repeat your Email address</label>
		<input id="email2" name="email_confirm" type="email" />
		<button type="submit">Continue</button>
	</form>`,
	"Create your account",
);

// The same screen minus the repeat: a two-step login asking who you are. This must keep its
// picker, and it is the reason the page-level signals (the route, the heading, the "Create
// account" link) are not allowed to decide anything here.
const LOGIN_STEP = doc(
	`<form>
		<label for="email">Email address</label>
		<input id="email" name="email" type="email" autocomplete="username" />
		<button type="submit">Next</button>
	</form>
	<a href="/register">Create account</a>`,
	"Sign in",
);

/** Serve example.com by path, under COEP; subresources are empty 200s. */
async function serve(page: Page): Promise<void> {
	await page.context().route(/example\.com/, (route) => {
		if (route.request().resourceType() !== "document") {
			return route.fulfill({ status: 200, body: "" });
		}
		const path = new URL(route.request().url()).pathname;
		const body = path.startsWith("/register")
			? SIGNUP_STEP
			: path.startsWith("/signin")
				? LOGIN_STEP
				: SIGNUP;
		return route.fulfill({ body, headers: COEP });
	});
}

/** Click `field` until the picker mounts, absorbing content-script injection timing. */
async function expectPickerOn(page: Page, field: string): Promise<void> {
	await expect(async () => {
		await page.locator(field).click();
		await expect(page.locator(HOST)).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
}

/** Click `field` and assert nothing mounts, outliving the iframe readiness fallback (~700ms). */
async function expectNoPickerOn(page: Page, field: string): Promise<void> {
	await page.locator(field).click();
	await page.waitForTimeout(1500);
	await expect(page.locator(HOST)).not.toBeAttached();
}

test("offers nothing on a signup form's email field while locked", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await lock(popup);

	const page = await context.newPage();
	await serve(page);
	await page.goto("https://example.com/signup");

	// The password box offers its suggestion, which proves the content script is live here and
	// has classified the page - so the email box below is a decision, not a dead script.
	await expectPickerOn(page, "#pass");
	await expectNoPickerOn(page, "#email");
});

test("offers nothing on a signup form's email field when a login is saved for the site", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	const page = await context.newPage();
	await serve(page);
	await page.goto("https://example.com/signup");

	await expectPickerOn(page, "#pass");
	await expectNoPickerOn(page, "#email");
});

test("offers nothing on a signup step that asks for the email twice, while locked", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await lock(popup);

	const page = await context.newPage();
	await serve(page);

	// Guard and safety case in one: the two-step LOGIN screen still gets its unlock row.
	await page.goto("https://example.com/signin");
	await expectPickerOn(page, "#email");

	// One field's difference, same tab: the repeated email says the user is signing up.
	await page.goto("https://example.com/register");
	await expectNoPickerOn(page, "#email");
});

test("offers nothing on that step when a login is saved for the site", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	const page = await context.newPage();
	await serve(page);

	// Unlocked, the two-step login screen offers the saved match.
	await page.goto("https://example.com/signin");
	await expectPickerOn(page, "#email");

	await page.goto("https://example.com/register");
	await expectNoPickerOn(page, "#email");
});

test("still offers the generated password on the signup form's own password box", async ({
	context,
	extensionId,
}) => {
	// The one row a signup form should carry. Suppressing its neighbours must not touch it.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await lock(popup);

	const page = await context.newPage();
	await serve(page);
	await page.goto("https://example.com/signup");

	await expectPickerOn(page, "#pass");
	const box = await page.locator(HOST).boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + 30, box!.y + Math.min(36, box!.height / 2));
	await expect.poll(() => page.locator("#pass").inputValue()).toMatch(STRONG_CHARS);
});
