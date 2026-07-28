import { expect, test } from "./fixtures";

// Increment 2: the built extension loads in a real Chromium and exposes its background worker.
test("loads the extension and resolves its id", async ({ extensionId }) => {
	expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test("renders the options page UI", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/options.html`);
	// A real render, not a blank crash: the app mounts something under the body.
	await expect(page.locator("#root")).not.toBeEmpty();
});
