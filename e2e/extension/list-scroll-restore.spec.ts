import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	createVault,
	expectUnlocked,
	lock,
	openPopup,
	optionsUrl,
	STRONG_PW,
	unlock,
} from "./helpers";

// #200. Rows are asserted by name, not pixels: a restored offset that is right in pixels still
// shows the wrong rows when the virtualizer's row estimate is off.

const ENTRY_COUNT = 150;
/** Deep enough that a few px of estimate error per row moves the list by whole rows. */
const SCROLL_DEPTH = 6400;

function bitwardenExport(): string {
	const items = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
		type: 1,
		name: `Entry ${String(i).padStart(3, "0")}`,
		notes: `Notes for entry ${i}`,
		login: {
			username: `user${i}@example.com`,
			password: `pw-${i}-Zx9mQ2vLp7wK4tR8`,
			uris: [{ uri: `https://site${i}.example.com` }],
		},
	}));
	return JSON.stringify({ encrypted: false, items });
}

async function popupWithLongList(context: BrowserContext, extensionId: string): Promise<Page> {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await setup.goto(`${optionsUrl(extensionId)}?screen=import`);
	await setup.locator("#root").waitFor();
	const gate = setup.getByLabel(/Master password/i);
	if (await gate.isVisible().catch(() => false)) {
		await gate.fill(STRONG_PW);
		await setup.getByRole("button", { name: /^Unlock$/i }).click();
	}
	const card = setup
		.locator("label")
		.filter({ hasText: /Bitwarden/ })
		.first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles({
		name: "bitwarden-export.json",
		mimeType: "application/json",
		buffer: Buffer.from(bitwardenExport(), "utf8"),
	});
	await setup.getByRole("button", { name: new RegExp(`Import ${ENTRY_COUNT} items`) }).click();
	await expect(setup.getByText(`Imported ${ENTRY_COUNT} items`)).toBeVisible({ timeout: 60_000 });

	const popup = await context.newPage();
	await popup.setViewportSize({ width: 500, height: 800 });
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await expect(popup.locator("[data-entry-row]").first()).toBeVisible();
	return popup;
}

const list = (page: Page) => page.locator("div.overflow-y-auto:has([data-entry-row])");

/** Names of the rows on screen, top first, as their "Open …" button labels. */
const visibleRows = (page: Page): Promise<string[]> =>
	list(page).evaluate((el) => {
		const box = el.getBoundingClientRect();
		return [...el.querySelectorAll("[data-row-open]")]
			.filter((row) => {
				const r = row.getBoundingClientRect();
				return r.top >= box.top && r.bottom <= box.bottom;
			})
			.map((row) => row.getAttribute("aria-label") ?? "");
	});

const topRow = async (page: Page) => (await visibleRows(page))[0];

/** Wheel down like a user, so the virtualizer measures every row on the way. */
async function scrollDeep(page: Page): Promise<string[]> {
	await list(page).hover();
	while ((await list(page).evaluate((el) => el.scrollTop)) < SCROLL_DEPTH) {
		await page.mouse.wheel(0, 300);
		await page.waitForTimeout(30);
	}
	await page.waitForTimeout(300);
	const rows = await visibleRows(page);
	expect(rows.length).toBeGreaterThan(3);
	expect(rows[0]).not.toBe("Open Entry 000");
	return rows;
}

async function openRecord(page: Page, label: string) {
	await page.getByRole("button", { name: label, exact: true }).click();
	await expect(page.getByRole("button", { name: "Go back" })).toBeVisible();
}

async function openNewLoginForm(page: Page) {
	await page.getByRole("button", { name: /Add New/i }).click();
	await page.getByRole("button", { name: /Add a new login/i }).click();
	await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
}

test("the back button returns to the row the list was on", async ({ context, extensionId }) => {
	test.setTimeout(120_000);
	const popup = await popupWithLongList(context, extensionId);
	const rows = await scrollDeep(popup);

	await openRecord(popup, rows[2]!);
	await popup.getByRole("button", { name: "Go back" }).click();

	await expect.poll(() => topRow(popup)).toBe(rows[0]);
});

test("deleting a record returns to the row the list was on", async ({ context, extensionId }) => {
	test.setTimeout(120_000);
	const popup = await popupWithLongList(context, extensionId);
	const rows = await scrollDeep(popup);

	await openRecord(popup, rows[2]!);
	await popup
		.getByRole("button", { name: /^Delete/ })
		.first()
		.click();
	await popup
		.getByRole("button", { name: /^Delete/ })
		.last()
		.click();

	await expect.poll(() => topRow(popup)).toBe(rows[0]);
	expect(await visibleRows(popup)).not.toContain(rows[2]);
});

test("cancelling a new item returns to the row the list was on", async ({
	context,
	extensionId,
}) => {
	test.setTimeout(120_000);
	const popup = await popupWithLongList(context, extensionId);
	const rows = await scrollDeep(popup);

	await openNewLoginForm(popup);
	await popup.getByRole("button", { name: "Cancel" }).click();

	await expect.poll(() => topRow(popup)).toBe(rows[0]);
});

test("a position still restores after a sort change with no scroll since", async ({
	context,
	extensionId,
}) => {
	test.setTimeout(120_000);
	const popup = await popupWithLongList(context, extensionId);
	const before = await scrollDeep(popup);

	await popup.getByLabel("Sort").selectOption("name-desc");
	await expect.poll(() => topRow(popup)).not.toBe(before[0]);
	await popup.waitForTimeout(300);
	const rows = await visibleRows(popup);

	await openRecord(popup, rows[2]!);
	await popup.getByRole("button", { name: "Go back" }).click();

	await expect.poll(() => topRow(popup)).toBe(rows[0]);
});

test("saving a new item starts the list at the top", async ({ context, extensionId }) => {
	test.setTimeout(120_000);
	const popup = await popupWithLongList(context, extensionId);
	await scrollDeep(popup);

	await openNewLoginForm(popup);
	await popup.getByLabel("Name", { exact: true }).fill("Brand New");
	await popup.getByLabel("Password", { exact: true }).fill("s3cr3t-pw-01");
	await popup.getByRole("button", { name: /Save Login/i }).click();

	await expect(popup.locator("[data-entry-row]").first()).toBeVisible();
	await expect.poll(() => list(popup).evaluate((el) => el.scrollTop)).toBe(0);
});

test("Settings opened from a scrolled record starts at the top", async ({
	context,
	extensionId,
}) => {
	test.setTimeout(120_000);
	const popup = await popupWithLongList(context, extensionId);
	await openRecord(popup, "Open Entry 000");

	await popup.setViewportSize({ width: 500, height: 300 });
	const record = popup.locator("div.flex-1.overflow-y-auto").first();
	await record.hover();
	await popup.mouse.wheel(0, 200);
	await expect.poll(() => record.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

	await popup.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = popup.getByRole("main").locator("..");
	await expect(popup.getByRole("navigation", { name: "Settings sections" })).toBeVisible();

	// Long enough for the router's restore to have run, were it going to.
	await popup.waitForTimeout(300);
	expect(await settings.evaluate((el) => el.scrollTop)).toBe(0);
});

// A lock bounces to the unlock screen; unlocking returns to the screen it interrupted, as it was
// (mobile's default "Immediately" auto-lock does this on every trip to another app).
test("unlocking returns to the row the list was on", async ({ context, extensionId }) => {
	test.setTimeout(120_000);
	const popup = await popupWithLongList(context, extensionId);
	const rows = await scrollDeep(popup);

	await lock(popup);
	await unlock(popup);

	await expect.poll(() => topRow(popup)).toBe(rows[0]);
});

test("unlocking keeps the search and its scroll", async ({ context, extensionId }) => {
	test.setTimeout(120_000);
	const popup = await popupWithLongList(context, extensionId);
	const search = popup.getByLabel(/Search vault/i);
	await search.fill("Entry 1");
	await expect(popup.getByRole("button", { name: "Open Entry 000", exact: true })).toHaveCount(0);
	await list(popup).hover();
	while ((await list(popup).evaluate((el) => el.scrollTop)) < 1200) {
		await popup.mouse.wheel(0, 300);
		await popup.waitForTimeout(30);
	}
	await popup.waitForTimeout(300);
	const rows = await visibleRows(popup);

	await lock(popup);
	await unlock(popup);

	await expect(search).toHaveValue("Entry 1");
	await expect.poll(() => topRow(popup)).toBe(rows[0]);
});

test("unlocking returns to the Settings tab", async ({ context, extensionId }) => {
	test.setTimeout(120_000);
	const popup = await popupWithLongList(context, extensionId);
	await popup.getByRole("button", { name: "Settings", exact: true }).click();
	const tabs = popup.getByRole("navigation", { name: "Settings sections" });
	await tabs.getByRole("button", { name: "Sync" }).click();

	await lock(popup);
	await unlock(popup);

	await expect(tabs).toBeVisible();
	await expect(tabs.getByRole("button", { name: "Sync" })).toHaveAttribute("aria-current", "true");
});
