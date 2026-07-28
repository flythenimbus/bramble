import { expect, test } from "./fixtures";
import { createVault, lock, openPopup, unlock } from "./helpers";

// Regression for issue #20: with a locked vault, focusing a login field shows the on-page "Vault
// locked" picker. Unlocking (via the toolbar/pop-out) moves focus off the page, and the picker used
// to stay stale until the user clicked away and refocused. It must now refresh in place. This drives
// the real content script + picker + background lock-state broadcast end to end.
//
// The page is served with COEP: require-corp, which blocks the picker's extension-origin iframe and
// forces its shadow-DOM renderer (the fallback that exists for exactly these pages). That renderer's
// host is a light-DOM element we can observe: the fix tears the stale locked host down and mounts a
// fresh one for the match; pre-fix the locked host survived untouched.

const FORM = `<!doctype html><html><head><title>login</title></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
</body></html>`;

const HOST = "#titanpass-autofill-dropdown";

test("the on-page picker refreshes after unlock, without refocusing (#20)", async ({
	context,
	extensionId,
}) => {
	// Seed a login for example.com through the popup UI, then lock the vault.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Example Login");
	await popup.getByRole("button", { name: /Add URL/i }).click();
	await popup.getByLabel("Website URL", { exact: true }).fill("https://example.com");
	await popup.getByLabel("Username or email", { exact: true }).fill("alice@example.com");
	await popup.getByLabel("Password", { exact: true }).fill("s3cr3t-pw-01");
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByText("Example Login")).toBeVisible();
	await lock(popup);

	// Serve a real https login page (COEP forces the picker's shadow renderer, see file header).
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
	const pageA = await context.newPage();
	await pageA.goto("https://example.com/");

	// Focus the username field: the "Vault locked" picker mounts (retry to absorb inject timing).
	const host = pageA.locator(HOST);
	await expect(async () => {
		await pageA.locator("#user").click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20000 });
	const lockedHost = await pageA.evaluateHandle(() =>
		document.querySelector("#titanpass-autofill-dropdown"),
	);

	// Focus leaves the page, as it does when unlocking via the toolbar/pop-out; the picker stays open.
	await pageA.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

	// Unlock in the popup. The background broadcasts VAULT_LOCK_STATE(false); the stale locked picker
	// must be torn down and the matching login mounted in its place, with nothing focused on the page.
	await unlock(popup);

	// The original locked host is detached (pre-fix it survived), and a fresh picker is mounted.
	await expect
		.poll(() => lockedHost.evaluate((el) => (el as Element | null)?.isConnected ?? false), {
			timeout: 20000,
		})
		.toBe(false);
	await expect(host).toBeAttached();
});
