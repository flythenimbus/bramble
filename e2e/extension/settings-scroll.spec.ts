import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup } from "./helpers";

async function openSettings(page: Page, extensionId: string) {
	await createVault(page, extensionId);
	await page.setViewportSize({ width: 500, height: 550 });
	await openPopup(page, extensionId);
	await expectUnlocked(page);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const tabs = page.getByRole("navigation", { name: "Settings sections" });
	await expect(tabs).toBeVisible();
	await expect
		.poll(() => tabs.evaluate((el) => el.scrollWidth - el.clientWidth))
		.toBeGreaterThan(0);
	await expect(page.getByRole("button", { name: "Scroll right" })).toBeVisible();
	return tabs;
}

test("a mouse wheel scrolls settings tabs and releases the page at the edge", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	const tabs = await openSettings(page, extensionId);
	const settingsPage = page.getByRole("main").locator("..");

	await tabs.hover();
	await page.mouse.wheel(0, 60);
	await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
	expect(await settingsPage.evaluate((el) => el.scrollTop)).toBe(0);
	await expect(tabs.getByRole("button", { name: "General", exact: true })).toHaveAttribute(
		"aria-current",
		"true",
	);

	await page.mouse.wheel(0, -60);
	await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBe(0);
	expect(await settingsPage.evaluate((el) => el.scrollTop)).toBe(0);

	// Wheel input must also work over the arrow overlay rather than scrolling the page.
	await page.getByRole("button", { name: "Scroll right" }).hover();
	await page.mouse.wheel(0, 1000);
	await expect
		.poll(() => tabs.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft))
		.toBeLessThanOrEqual(1);
	await expect(page.getByRole("button", { name: "Scroll right" })).toHaveCount(0);
	await page.mouse.wheel(0, 100);
	await expect.poll(() => settingsPage.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("settings edge arrows scroll with mouse clicks and keyboard activation", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	const tabs = await openSettings(page, extensionId);
	const left = page.getByRole("button", { name: "Scroll left" });
	const right = page.getByRole("button", { name: "Scroll right" });

	await expect(left).toHaveCount(0);
	await right.click();
	await expect(right).toHaveCount(0);
	// The tab underline overlaps the bottom border by 1px; check horizontal clipping only.
	await expect
		.poll(() =>
			tabs
				.getByRole("button", { name: "About", exact: true })
				.evaluate(
					(el) =>
						el.getBoundingClientRect().right - el.parentElement!.getBoundingClientRect().right,
				),
		)
		.toBeLessThanOrEqual(1);
	await left.click();
	await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBe(0);
	await expect(left).toHaveCount(0);

	await right.focus();
	await page.keyboard.press("Enter");
	await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
	await expect(tabs.getByRole("button", { name: "General", exact: true })).toHaveAttribute(
		"aria-current",
		"true",
	);
});

test("settings tabs keep native horizontal and Shift-wheel scrolling", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	const tabs = await openSettings(page, extensionId);

	await tabs.hover();
	await page.mouse.wheel(40, 0);
	await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBe(40);
	await page.mouse.wheel(-40, 0);
	await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBe(0);

	await page.keyboard.down("Shift");
	try {
		await page.mouse.wheel(0, 40);
		await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBe(40);
	} finally {
		await page.keyboard.up("Shift");
	}
});

for (const shift of [false, true]) {
	test(`settings edge arrows forward ${shift ? "Shift-wheel" : "horizontal"} scrolling`, async ({
		context,
		extensionId,
	}) => {
		const page = await context.newPage();
		const tabs = await openSettings(page, extensionId);
		const settingsPage = page.getByRole("main").locator("..");
		const deltaX = shift ? 0 : 40;
		const deltaY = shift ? 40 : 0;

		if (shift) await page.keyboard.down("Shift");
		try {
			await page.getByRole("button", { name: "Scroll right" }).hover();
			await page.mouse.wheel(deltaX, deltaY);
			await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBe(40);
			expect(await settingsPage.evaluate((el) => el.scrollTop)).toBe(0);

			await page.getByRole("button", { name: "Scroll left" }).hover();
			await page.mouse.wheel(-deltaX, -deltaY);
			await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBe(0);
			expect(await settingsPage.evaluate((el) => el.scrollTop)).toBe(0);
		} finally {
			if (shift) await page.keyboard.up("Shift");
		}
	});
}
