import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, seedExampleLogin, waitOutPickerClickGuard } from "./helpers";

// doctolib.de's two-step Keycloak sign-in (issue #47), from the unit suite's captured fixtures.
// See docs/field-detection.md.

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
	readFileSync(
		path.resolve(dir, `../../clients/extension/src/fixtures/sites/${name}.html`),
		"utf8",
	);

const page = (body: string): string =>
	`<!doctype html><html><head><title>Doctolib</title></head><body>${body}</body></html>`;

const USERNAME_STEP = page(fixture("doctolib-login-username"));
const PASSWORD_STEP = page(fixture("doctolib-login-password"));
// The same step with the twin clipped rather than display:none, so detection takes it.
const PASSWORD_STEP_CLIPPED_TWIN = PASSWORD_STEP.replace(
	'<input id="password" class="hidden"',
	'<input id="password" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0);"',
);

async function serve(p: Page, routes: Record<string, string>): Promise<void> {
	await p.context().route(/example\.com/, (route) => {
		const { pathname } = new URL(route.request().url());
		const html = routes[pathname];
		return html && route.request().resourceType() === "document"
			? route.fulfill({ body: html, headers: { "content-type": "text/html" } })
			: route.fulfill({ status: 200, body: "" });
	});
}

function pickerFrame(p: Page): Frame | undefined {
	return p.frames().find((f) => f.url().includes("autofill-ui.html"));
}

/** Click `field` until the picker shows a row for it, then pick that row. */
async function pickFrom(p: Page, field: string): Promise<void> {
	await expect(async () => {
		await p.locator(field).click();
		const frame = pickerFrame(p);
		expect(frame).toBeDefined();
		await expect(frame!.locator("[data-entry-id]")).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 20_000 });
	await waitOutPickerClickGuard(p);
	await pickerFrame(p)!.locator("[data-entry-id]").first().click();
}

test("fills both steps of doctolib.de's sign-in from the picker", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	const site = await context.newPage();
	await serve(site, {
		"/username": USERNAME_STEP,
		"/password": PASSWORD_STEP,
		"/password-clipped": PASSWORD_STEP_CLIPPED_TWIN,
	});

	await site.goto("https://example.com/username");
	await pickFrom(site, '[id="input_:r0:"]');
	await expect(site.locator('[id="input_:r0:"]')).toHaveValue("alice@example.com");

	await site.goto("https://example.com/password");
	await pickFrom(site, '[id="input_:r1:"]');
	await expect(site.locator('[id="input_:r1:"]')).toHaveValue("s3cr3t-pw-01");
	expect(await site.locator("#password").inputValue()).toBe("");

	await site.goto("https://example.com/password-clipped");
	await pickFrom(site, '[id="input_:r1:"]');
	await expect(site.locator('[id="input_:r1:"]')).toHaveValue("s3cr3t-pw-01");
	expect(await site.locator("#password").inputValue()).toBe("");
});
