import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup } from "./helpers";

// Each open extension window holds the vault in its own memory, and writes the whole vault from it.
// The toolbar popup and a Settings window are two such windows, which these pages stand in for: same
// app, same storage, one provider each. A save tells the other windows, and a window that didn't
// hear merges with the disk rather than writing over it. See docs/multiple-vaults.md "Two windows".

async function addLogin(page: Page, name: string) {
	await page.getByRole("button", { name: /Add New/i }).click();
	await page.getByRole("button", { name: /^Login Add a new login/ }).click();
	await page.getByLabel(/^Name$/).fill(name);
	await page.getByLabel(/Username or email/i).fill("me@example.com");
	await page.locator('input[type="password"]').first().fill("Some-pw-123456");
	await page.getByRole("button", { name: /Save Login/i }).click();
	await expect(page.getByText(name).first()).toBeVisible();
}

async function openWindow(context: BrowserContext, extensionId: string, { deaf = false } = {}) {
	const page = await context.newPage();
	if (deaf) {
		// A window that doesn't hear of a save, as one does while it is still starting up. Only the
		// merge can save it now.
		await page.addInitScript(() => {
			const events = chrome.runtime.onMessage;
			const add = events.addListener.bind(events);
			events.addListener = (listener) =>
				add((message, sender, respond) =>
					message?.type === "VAULT_CHANGED_EXTERNAL" ? false : listener(message, sender, respond),
				);
		});
	}
	await openPopup(page, extensionId);
	await expectUnlocked(page);
	return page;
}

/** A new window reads what is really stored. */
async function stored(context: BrowserContext, extensionId: string) {
	const fresh = await openWindow(context, extensionId);
	await expect(fresh.getByRole("button", { name: /Add New/i })).toBeVisible();
	return fresh;
}

const toVault = (page: Page) => page.getByRole("button", { name: "Go to vault" }).click();

async function deleteOpenEntry(page: Page) {
	await page
		.getByRole("button", { name: /^Delete/ })
		.first()
		.click();
	await page
		.getByRole("button", { name: /^Delete/ })
		.last()
		.click();
}

for (const deaf of [false, true]) {
	const which = deaf ? "a window that didn't hear of it" : "another open window";

	test(`a login saved in one window survives the next save from ${which}`, async ({
		context,
		extensionId,
	}) => {
		const setup = await context.newPage();
		await createVault(setup, extensionId);
		const first = await openWindow(context, extensionId);
		const second = await openWindow(context, extensionId, { deaf });

		await addLogin(first, "Saved in the first window");
		if (deaf) {
			// It really is stored, and this window really didn't hear.
			const check = await stored(context, extensionId);
			await expect(check.getByText("Saved in the first window").first()).toBeVisible();
			await check.close();
			await second.waitForTimeout(500);
			await expect(second.getByText("Saved in the first window")).toHaveCount(0);
		} else {
			await expect(second.getByText("Saved in the first window").first()).toBeVisible();
		}

		await addLogin(second, "Saved in the second window");

		const fresh = await stored(context, extensionId);
		await expect(fresh.getByText("Saved in the second window").first()).toBeVisible();
		await expect(fresh.getByText("Saved in the first window").first()).toBeVisible();

		// And both windows end up showing both.
		await toVault(second);
		await expect(second.getByText("Saved in the first window").first()).toBeVisible();
		await toVault(first);
		await expect(first.getByText("Saved in the second window").first()).toBeVisible();
	});

	test(`a login deleted in one window stays deleted after the next save from ${which}`, async ({
		context,
		extensionId,
	}) => {
		const setup = await context.newPage();
		await createVault(setup, extensionId);
		const first = await openWindow(context, extensionId);
		await addLogin(first, "Short lived");
		const second = await openWindow(context, extensionId, { deaf });
		await expect(second.getByText("Short lived").first()).toBeVisible();

		await toVault(first);
		await first.getByText("Short lived").first().click();
		await deleteOpenEntry(first);
		// It really is gone from storage.
		await expect
			.poll(async () => {
				const check = await stored(context, extensionId);
				const held = await check.getByText("Short lived").count();
				await check.close();
				return held;
			})
			.toBe(0);

		await addLogin(second, "Saved in the second window");

		const fresh = await stored(context, extensionId);
		await expect(fresh.getByText("Saved in the second window").first()).toBeVisible();
		await expect(fresh.getByText("Short lived")).toHaveCount(0);
		await toVault(second);
		await expect(second.getByText("Short lived")).toHaveCount(0);
	});
}

test("a window that didn't hear can save again before it has caught up, and still loses nothing", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	const first = await openWindow(context, extensionId);
	const second = await openWindow(context, extensionId, { deaf: true });

	await addLogin(first, "Saved in the first window");
	await addLogin(second, "Second, once");
	await toVault(second);
	await addLogin(second, "Second, twice");
	await toVault(first);
	await addLogin(first, "First, again");

	const fresh = await stored(context, extensionId);
	for (const name of [
		"Saved in the first window",
		"Second, once",
		"Second, twice",
		"First, again",
	]) {
		await expect(fresh.getByText(name).first()).toBeVisible();
	}
});

test("control: the same saves from one window both stay", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	const only = await openWindow(context, extensionId);

	await addLogin(only, "Saved first");
	await toVault(only);
	await addLogin(only, "Saved second");

	const fresh = await stored(context, extensionId);
	await expect(fresh.getByText("Saved second").first()).toBeVisible();
	await expect(fresh.getByText("Saved first").first()).toBeVisible();
});
