import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, lock, openPopup, STRONG_PW } from "./helpers";

// The production click-to-unlock flow, end to end: locked vault -> "Vault locked" row in the picker
// -> the real unlock POP-OUT WINDOW the background opens -> master password. Two things must happen
// once it unlocks: the pop-out closes (the user is going back to the form), and the picker offers
// the matching login without a click away and back.
//
// suggest-password.spec.ts covers the same click but unlocks in a separate popup TAB, and asserts
// only that *a* picker is mounted - which a re-rendered "Vault locked" row satisfies too. Here the
// proof is the fill: clicking the row afterwards has to put the saved username in the field, which
// only a real match row does.
//
// COEP forces the picker's shadow renderer, whose host (`#titanpass-autofill-dropdown`) is a
// light-DOM element we can observe and click through (its rows live in a closed shadow root).

const COEP = {
	"content-type": "text/html",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
};

const LOGIN = `<!doctype html><html><head><title>login</title></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
</body></html>`;

const HOST = "#titanpass-autofill-dropdown";

async function serve(page: Page): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: LOGIN, headers: COEP })
				: route.fulfill({ status: 200, body: "" }),
		);
}

/** Add a saved login for example.com through the popup UI. */
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

/** Click the middle of the picker's first row (the rows are in a closed shadow root). */
async function clickPickerRow(page: Page): Promise<void> {
	const box = await page.locator(HOST).boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + box!.width / 2, box!.y + Math.min(37, box!.height / 2));
}

test("click-to-unlock closes the pop-out and re-surfaces the matches", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedLogin(popup);
	await lock(popup);
	// No extension view open: the pop-out the picker opens is the only unlock UI, as in real use.
	await popup.close();

	const page = await context.newPage();
	await serve(page);
	await page.goto("https://example.com/");

	// Focus the username field: the "Vault locked" row mounts.
	const host = page.locator(HOST);
	await expect(async () => {
		await page.locator("#user").click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	// Click the locked row: the background opens the unlock pop-out window (and the click also
	// dismisses the picker, so there is no host left to refresh in place).
	await clickPickerRow(page);
	await expect(host).toHaveCount(0);
	// The window arrives as a new page; its url is empty at creation, so poll for it.
	await expect
		.poll(() => context.pages().filter((p) => p.url().includes("detached=1")).length, {
			timeout: 20_000,
		})
		.toBe(1);
	const popout = context.pages().find((p) => p.url().includes("detached=1"))!;

	// Unlock there.
	await expect(popout.getByRole("heading", { name: /master password to unlock/i })).toBeVisible({
		timeout: 20_000,
	});
	await popout.locator('input[type="password"]').first().fill(STRONG_PW);
	await popout.getByRole("button", { name: "Unlock Vault" }).click();

	// 1. The pop-out closes on its own, leaving the user on the form.
	await expect.poll(() => popout.isClosed(), { timeout: 15_000 }).toBe(true);

	// 2. The picker comes back on the field by itself, offering the saved login: clicking it fills.
	//    (A stale "Vault locked" row would just reopen the pop-out and leave the field empty.)
	await expect(host).toBeAttached({ timeout: 15_000 });
	await clickPickerRow(page);
	await expect(page.locator("#user")).toHaveValue("alice@example.com", { timeout: 15_000 });
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
});
