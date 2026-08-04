import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup } from "./helpers";

// Issue #46, replayed against the SITE'S OWN APPLICATION rather than a
// hand-written stand-in. e2e/hars/skanetrafiken-login.har.zip is a recording of
// www.skanetrafiken.se/mitt-konto/ made by scripts/capture-har.mjs, so the real
// Vue app boots here with its real click handlers and router. Nothing leaves the
// machine: the HAR serves every page asset, and the three routes below stand in
// for the services it can't reach (reCAPTCHA, and the two authenticated calls).
//
// What this pins that the synthetic spec cannot: on a successful login the app
// does NOT remove the password field, it hides it (0x0, still connected). Our
// commit gate has to treat "no longer rendered" as gone, not just "detached", or
// capture never fires on this site. The old vanishing-field fallback tested
// exactly the wrong thing, which is why the site never offered to save.

const HAR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../hars/skanetrafiken-login.har.zip",
);

const PROMPT = "#titanpass-corner-prompt";
const LOGIN_URL = "https://www.skanetrafiken.se/mitt-konto/";

/** Serve the recorded app, then override the calls the recording can't carry. */
async function replay(context: BrowserContext, opts: { authStatus: number }): Promise<void> {
	// Registered first: Playwright runs the most recently added handler first, so
	// the specific stubs below take precedence over the HAR.
	await context.routeFromHAR(HAR, { notFound: "abort" });

	// The app loads reCAPTCHA through its own loader, which injects Google's
	// api.js and waits for window.grecaptcha. Without this it never reaches its
	// own auth call at all.
	await context.route("**/recaptcha/api.js*", (route) =>
		route.fulfill({
			contentType: "application/javascript",
			body: 'window.grecaptcha={ready:function(c){c()},execute:function(){return Promise.resolve("stub-token")},render:function(){return 0}};',
		}),
	);
	// POST /gw-bns/tokens returns the JWT the app stores in a cookie; it then
	// fetches the account, and only resolves once that lands. Both are needed for
	// a login the app considers successful.
	await context.route("**/gw-bns/tokens", (route) =>
		route.request().method() === "POST"
			? route.fulfill({
					status: opts.authStatus,
					contentType: "application/json",
					body: JSON.stringify(opts.authStatus === 200 ? "stub.jwt.token" : { message: "invalid" }),
				})
			: route.fallback(),
	);
	await context.route("**/mitt-konto/get-account", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ email: "resenar@example.se", firstName: "Test", customerNumber: "1" }),
		}),
	);
}

async function unlockedVault(context: BrowserContext, extensionId: string): Promise<void> {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
}

/** The login button. The page has four elements sharing id="submit" (the modals reuse it). */
function loginButton(page: Page) {
	return page.locator(".st-login-form__actions").getByRole("button", { name: "Logga in" });
}

async function signIn(page: Page): Promise<void> {
	await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#password")).toBeVisible({ timeout: 20_000 });
	await page.locator("#email").fill("resenar@example.se");
	await page.locator("#password").fill("Formless-Spa-Pw-123");
	await loginButton(page).click();
}

test("offers to save after a real successful login", async ({ context, extensionId }) => {
	await unlockedVault(context, extensionId);
	await replay(context, { authStatus: 200 });

	const page = await context.newPage();
	await signIn(page);

	// The load-bearing observation: the app swaps in the account view and the
	// password field stops being rendered, but is NOT detached. A commit gate
	// keyed on removal alone would never fire here.
	await expect(page.locator("#password")).toBeHidden({ timeout: 20_000 });
	await expect(page.locator("#password")).toHaveCount(1);
	await expect(page.getByText("Välkommen").first()).toBeVisible();

	await expect(page.locator(PROMPT)).toBeAttached({ timeout: 15_000 });
});

test("does not offer to save when the real login fails", async ({ context, extensionId }) => {
	await unlockedVault(context, extensionId);
	await replay(context, { authStatus: 401 });

	const page = await context.newPage();
	await signIn(page);

	// The app keeps the form up on a rejected credential, so the attempt expires.
	await page.waitForTimeout(12_000);
	await expect(page.locator("#password")).toBeVisible();
	await expect(page.locator(PROMPT)).toHaveCount(0);
});
