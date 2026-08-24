import type { Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, lock, openPopup, STRONG_PW, seedExampleLogin } from "./helpers";

// The picker's PRIMARY renderer: an extension-origin iframe that keeps the UI out of the page's
// reach. Every other picker spec serves its page under COEP, which blocks the iframe on purpose and
// exercises the shadow-DOM fallback - so nothing covered this path, and it was dead in Chromium for
// a different reason: `use_dynamic_url` gives the content script a per-session GUID origin while the
// frame it loads reports the extension's static one, so the bridge's origin check dropped the READY
// handshake (and every render post) and the fallback silently took over on every page.
//
// These pages are served plainly, so the iframe is the renderer under test. Between them they cover
// every message the bridge carries in each direction: RENDER_MATCHES / RENDER_LOCKED / UI_KEY out,
// READY / UI_RESIZE / UI_PICK / UI_POPOUT / UI_HIGHLIGHT / UI_USE_SUGGESTED / UI_REGENERATE back.

const LOGIN = `<!doctype html><html><head><title>login</title></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
</body></html>`;

const SIGNUP = `<!doctype html><html><head><title>Sign up</title></head><body>
	<form>
		<input id="email" name="email" type="email" autocomplete="email" />
		<input id="pass" name="password" type="password" autocomplete="new-password" />
		<button type="submit">Create account</button>
	</form>
</body></html>`;

const STRONG_CHARS = /^[A-Za-z0-9!@#$%^&*()_+\-=[\]{}|;:,.<>?]{20}$/;

async function serve(page: Page, html: string): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: html, headers: { "content-type": "text/html" } })
				: route.fulfill({ status: 200, body: "" }),
		);
}

/** The picker's iframe, if it is still alive (the shadow fallback tears it down). */
function pickerFrame(page: Page): Frame | undefined {
	return page.frames().find((f) => f.url().includes("autofill-ui.html"));
}

/** `display` of the iframe's host element (the random-id div wrapping it), or "gone". */
function hostDisplay(page: Page): Promise<string> {
	return page.evaluate(() => {
		const el = document.querySelector<HTMLElement>('div[id^="tp-"]');
		return el ? getComputedStyle(el).display : "gone";
	});
}

/** Click `field` until the iframe renderer is up, and assert the shadow fallback did NOT take over
 *  (it detaches the frame ~700ms in when the READY handshake is missed). */
async function openPickerIframe(page: Page, field: string): Promise<Frame> {
	await expect(async () => {
		await page.locator(field).click();
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	// Outlive the readiness timeout, then confirm the frame is still the renderer.
	await page.waitForTimeout(1200);
	const frame = pickerFrame(page);
	expect(frame, "the iframe renderer was torn down; the shadow fallback took over").toBeDefined();
	await expect(page.locator("#titanpass-autofill-dropdown")).toHaveCount(0);
	return frame!;
}

test("renders the match inside the iframe, and fills from it", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	const page = await context.newPage();
	await serve(page, LOGIN);
	await page.goto("https://example.com/");

	const frame = await openPickerIframe(page, "#user");

	// The saved login is rendered inside the iframe (the parent's RENDER_MATCHES got through), and
	// the host was sized from the frame's UI_RESIZE report.
	const row = frame.locator("[data-entry-id]");
	await expect(row).toBeVisible({ timeout: 10_000 });
	await expect(row).toContainText("alice@example.com");
	expect(await page.locator('div[id^="tp-"]').boundingBox()).toMatchObject({
		height: expect.any(Number),
	});

	// Picking it fills the page (UI_PICK back through the bridge).
	await row.click();
	await expect(page.locator("#user")).toHaveValue("alice@example.com", { timeout: 10_000 });
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
});

test("keyboard nav drives the iframe: Down highlights, Enter fills, Escape dismisses", async ({
	context,
	extensionId,
}) => {
	// UI_KEY is posted TO the frame and UI_HIGHLIGHT comes back: both directions of the bridge, and
	// the highlight is what gates Enter (without one, Enter must fall through to the form).
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	const page = await context.newPage();
	await serve(page, LOGIN);
	await page.goto("https://example.com/");

	const frame = await openPickerIframe(page, "#user");
	const row = frame.locator("[data-entry-id]");
	await expect(row).toBeVisible({ timeout: 10_000 });
	await expect(row).not.toHaveClass(/tp-active/);

	// Escape closes it without filling, and leaves the page field focused.
	await page.keyboard.press("Escape");
	await expect.poll(() => hostDisplay(page)).toBe("none");
	await expect(page.locator("#user")).toHaveValue("");

	// Re-engage the field, then drive the highlight with the keyboard and pick with Enter.
	await page.locator("#user").click();
	await expect(row).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press("ArrowDown");
	await expect(row).toHaveClass(/tp-active/);
	await page.keyboard.press("Enter");
	await expect(page.locator("#user")).toHaveValue("alice@example.com", { timeout: 10_000 });
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
});

test("dismisses when a route change takes the anchored field away", async ({
	context,
	extensionId,
}) => {
	// A client-side route change unmounts the form without a navigation, so the content script
	// survives and keeps tracking a field that is no longer laid out. A gone field measures 0x0 at
	// the document origin, and the picker used to follow it into the page's top-left corner and sit
	// there, still offering entries for a form that had left the screen.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	const page = await context.newPage();
	await serve(page, LOGIN);
	await page.goto("https://example.com/");

	const frame = await openPickerIframe(page, "#user");
	await expect(frame.locator("[data-entry-id]")).toBeVisible({ timeout: 10_000 });

	await page.evaluate(() => {
		document.querySelector("form")?.remove();
		history.pushState({}, "", "/account");
	});

	await expect.poll(() => hostDisplay(page)).toBe("none");
});

test("the strong-password suggestion renders and regenerates in the iframe", async ({
	context,
	extensionId,
}) => {
	// UI_USE_SUGGESTED and UI_REGENERATE only exist on this path (the shadow renderer has its own
	// handlers), so they had no coverage at all while the iframe was dead.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);

	const page = await context.newPage();
	await serve(page, SIGNUP);
	await page.goto("https://example.com/");

	const frame = await openPickerIframe(page, "#pass");
	const suggest = frame.locator("[data-tp-suggest]");
	await expect(suggest).toBeVisible({ timeout: 10_000 });

	// Regenerate swaps the offered password for a different one (a fresh RENDER_MATCHES).
	const first = (await frame.locator(".tp-suggest-pw").textContent())?.trim() ?? "";
	expect(first).toMatch(STRONG_CHARS);
	await frame.locator("[data-tp-regenerate]").click();
	await expect
		.poll(async () => (await frame.locator(".tp-suggest-pw").textContent())?.trim(), {
			timeout: 10_000,
		})
		.not.toBe(first);

	// Using the suggestion fills the field with the password shown, and offers to save it.
	const shown = (await frame.locator(".tp-suggest-pw").textContent())?.trim() ?? "";
	await suggest.click();
	await expect(page.locator("#pass")).toHaveValue(shown, { timeout: 10_000 });
	await expect(page.locator("#titanpass-corner-prompt")).toBeAttached({ timeout: 10_000 });
});

test("click-to-unlock from the iframe: the pop-out closes and the match replaces the locked row", async ({
	context,
	extensionId,
}) => {
	// The reported flow, on the renderer users actually get. The locked row lives INSIDE the iframe
	// here, so the stale-row bug is directly observable: the frame must end up showing the match.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await lock(popup);
	await popup.close();

	const page = await context.newPage();
	await serve(page, LOGIN);
	await page.goto("https://example.com/");

	const frame = await openPickerIframe(page, "#user");
	await expect(frame.locator("[data-tp-popout]")).toBeVisible({ timeout: 10_000 });

	// Clicking the locked row hides the picker and opens the unlock pop-out window.
	await frame.locator("[data-tp-popout]").click();
	await expect.poll(() => hostDisplay(page)).toBe("none");
	await expect
		.poll(() => context.pages().filter((p) => p.url().includes("detached=1")).length, {
			timeout: 20_000,
		})
		.toBe(1);
	const popout = context.pages().find((p) => p.url().includes("detached=1"))!;

	await expect(popout.getByRole("heading", { name: /master password to unlock/i })).toBeVisible({
		timeout: 20_000,
	});
	await popout.locator('input[type="password"]').first().fill(STRONG_PW);
	await popout.getByRole("button", { name: "Unlock Vault" }).click();

	// The window closes itself...
	await expect.poll(() => popout.isClosed(), { timeout: 15_000 }).toBe(true);
	// ...and the picker comes back showing the login, with no locked row left in the frame.
	await expect.poll(() => hostDisplay(page), { timeout: 15_000 }).not.toBe("none");
	const shown = pickerFrame(page);
	expect(shown, "the iframe renderer was replaced after the unlock").toBeDefined();
	await expect(shown!.locator("[data-entry-id]")).toBeVisible({ timeout: 15_000 });
	await expect(shown!.locator("[data-tp-popout]")).toHaveCount(0);

	// And it really fills.
	await shown!.locator("[data-entry-id]").click();
	await expect(page.locator("#user")).toHaveValue("alice@example.com", { timeout: 10_000 });
});
