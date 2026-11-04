import type { Page } from "@playwright/test";
import { expect, gotoSync, pairWithPhone, test } from "./fixtures";

// A name given to a device is a synced setting, so it reaches every device in the group, and any
// device can name any other. Unit tests pin the lookup; only this proves the name crosses a real
// pairing. See docs/synced-settings.md ("Device names").

/** Rename the device in row `row` of the Sync panel (this device sorts first, at 0). */
async function renameRow(page: Page, row: number, name: string): Promise<void> {
	await page
		.getByRole("button", { name: /^Rename / })
		.nth(row)
		.click();
	const field = page.getByLabel("Device name");
	await field.fill(name);
	await field.press("Enter");
	await expect(page.getByRole("button", { name: `Rename ${name}` })).toBeVisible();
}

/** The name shown in row `row`, read off its rename button. */
const rowName = (page: Page, row: number) =>
	page.getByRole("button", { name: /^Rename / }).nth(row);

test("a device's name follows it to every device, named from either side", async ({
	ext,
	mobile,
}) => {
	await pairWithPhone(ext, mobile);
	await expect(ext.page.getByText("Synced · 2 devices")).toBeVisible({ timeout: 90_000 });

	// Named on the extension: the phone sees its own new name.
	await renameRow(ext.page, 1, "Work phone");
	await gotoSync(mobile.page);
	await expect(rowName(mobile.page, 0)).toHaveAccessibleName("Rename Work phone", {
		timeout: 90_000,
	});

	// Named on the phone: the extension sees it, without reopening the panel.
	await renameRow(mobile.page, 1, "Laptop browser");
	await expect(rowName(ext.page, 0)).toHaveAccessibleName("Rename Laptop browser", {
		timeout: 90_000,
	});
	await expect(rowName(ext.page, 1)).toHaveAccessibleName("Rename Work phone");
});
