import { expect, test } from "./fixtures";
import { createVault, openPopup, seedExampleLogin } from "./helpers";

// Settings -> General -> "Autofill on web pages", driven end to end: the Settings toggle writes
// the pref, the background pushes it to open tabs and refuses the queries a page makes anyway,
// and the content script draws nothing while it is off.
//
// Both halves of the switch matter and fail differently, so one test walks the whole cycle:
// a page that already has a dropdown open loses it on the push, a page loaded fresh while the
// switch is off never gets one (that is the background gate, with no push involved), and turning
// it back on returns the dropdown to the page that has been sitting there the whole time.
//
// The page is served with COEP: require-corp, which blocks the picker's extension-origin iframe
// and forces its shadow-DOM renderer, whose host is a light-DOM element this test can observe.
// See autofill-unlock.spec.ts.

const FORM = `<!doctype html><html><head><title>login</title></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
</body></html>`;

const HOST = "#bramble-autofill-dropdown";
const TOGGLE = "Toggle autofill on web pages";

test("the autofill toggle takes the on-page dropdown away, and gives it back", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	await context.route(/example\.com/, (route) =>
		route.request().resourceType() === "document"
			? route.fulfill({
					body: FORM,
					headers: {
						"content-type": "text/html",
						"cross-origin-embedder-policy": "require-corp",
						"cross-origin-opener-policy": "same-origin",
					},
				})
			: route.fulfill({ status: 200, body: "" }),
	);
	const page = await context.newPage();
	await page.goto("https://example.com/");

	// Baseline: the saved login is offered on the page. Retried to absorb inject timing.
	const host = page.locator(HOST);
	await expect(async () => {
		await page.locator("#user").click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20000 });
	const openHost = await page.evaluateHandle(() =>
		document.querySelector("#bramble-autofill-dropdown"),
	);

	// Turn it off in Settings. Switching to the popup tab hides the page but leaves its picker
	// standing (only a lock or the toggle itself takes one down), so what detaches below is the push.
	await popup.getByRole("button", { name: "Settings" }).click();
	await popup.getByRole("button", { name: "General", exact: true }).click();
	const toggle = popup.getByRole("button", { name: TOGGLE });
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "false");

	// The dropdown that was already open goes away, without the page being touched.
	await expect
		.poll(() => openHost.evaluate((el) => (el as Element | null)?.isConnected ?? false), {
			timeout: 20000,
		})
		.toBe(false);

	// A page loaded fresh while the switch is off gets nothing either: no push is involved here,
	// the background simply refuses the query the content script makes on its own.
	await page.reload();
	await page.locator("#user").click();
	// A negative about something asynchronous: give the query the round trip it would need.
	await page.waitForTimeout(2000);
	await expect(host).toHaveCount(0);

	// Back on: the page that has been open this whole time offers the login again, with no reload
	// and nothing clicked on it - the same field is still focused from the check above.
	await popup.bringToFront();
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(host).toBeAttached({ timeout: 20000 });
});
