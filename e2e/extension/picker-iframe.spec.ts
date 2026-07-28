import type { Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, seedExampleLogin } from "./helpers";

// The picker's PRIMARY renderer: an extension-origin iframe that keeps the UI out of the page's
// reach. Every other picker spec serves its page under COEP, which blocks the iframe on purpose and
// exercises the shadow-DOM fallback - so nothing covered this path, and it was dead in Chromium for
// a different reason: `use_dynamic_url` gives the content script a per-session GUID origin while
// the frame it loads reports the extension's static one, so the bridge's origin check dropped the
// READY handshake (and every render post) and the fallback silently took over on every page.
//
// Serve the page plainly, so the iframe is the renderer under test.

const LOGIN = `<!doctype html><html><head><title>login</title></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
</body></html>`;

async function serve(page: Page): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: LOGIN, headers: { "content-type": "text/html" } })
				: route.fulfill({ status: 200, body: "" }),
		);
}

/** The picker's iframe, if it is still alive (the shadow fallback tears it down). */
function pickerFrame(page: Page): Frame | undefined {
	return page.frames().find((f) => f.url().includes("autofill-ui.html"));
}

test("the picker renders in its extension-origin iframe, and fills from it", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	const page = await context.newPage();
	await serve(page);
	await page.goto("https://example.com/");

	// Focusing the field mounts the iframe and it survives (it reported READY): the fallback would
	// have detached it ~700ms in.
	await expect(async () => {
		await page.locator("#user").click();
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	await page.waitForTimeout(1500);
	const frame = pickerFrame(page);
	expect(frame, "the iframe renderer was torn down; the shadow fallback took over").toBeDefined();
	await expect(page.locator("#titanpass-autofill-dropdown")).toHaveCount(0);

	// The saved login is rendered inside the iframe (the parent's RENDER_MATCHES got through)...
	const row = frame!.locator("[data-entry-id]");
	await expect(row).toBeVisible({ timeout: 10_000 });
	await expect(row).toContainText("alice@example.com");

	// ...and picking it fills the page.
	await row.click();
	await expect(page.locator("#user")).toHaveValue("alice@example.com", { timeout: 10_000 });
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
});
