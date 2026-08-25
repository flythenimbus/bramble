import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup } from "./helpers";

// Save capture on a login page with no <form> at all, driven through the real
// content script. Modelled on skanetrafiken.se (issue #46): a Vue SPA whose
// login control is a `type="button"` with a click handler, so no submit event
// ever fires and the credential is only captured by arming on the click and
// committing once the panel tears down. The unit tests in
// content/capture.dom.test.ts call the exported handlers directly; this suite is
// what proves the listener wiring, `isTrusted` gating, and real-layout
// `isRendered` checks agree with them.

const COEP = {
	"content-type": "text/html",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
};

const PROMPT = "#bramble-corner-prompt";

/**
 * A formless login panel. `teardownMs` is how long after the click the panel is
 * removed (a successful auth round-trip); -1 leaves it up, which is what a
 * failed login looks like. "Glömt lösenord?" always tears the panel down, since
 * it is the case where a naive commit would save a password never submitted.
 */
function panel(teardownMs: number): string {
	return `<!doctype html><html><head><title>Mitt konto</title></head><body>
	<div id="panel">
		<label for="email">Mejladress</label>
		<input id="email" type="text" placeholder="Din mejladress" autocomplete="username" />
		<label for="password">Lösenord</label>
		<input id="password" type="password" placeholder="Ditt lösenord" autocomplete="current-password" />
		<label id="toggle" role="checkbox" aria-checked="false" tabindex="0">
			<input id="password-checkbox" type="checkbox" tabindex="-1" /><span>Visa lösenord</span>
		</label>
		<span id="forgot" role="button" tabindex="0">Glömt lösenord?</span>
		<button id="submit" type="button">Logga in</button>
	</div>
	<div id="after"></div>
	<script>
		var teardown = function () { document.getElementById('panel').remove(); };
		document.getElementById('submit').addEventListener('click', function () {
			if (${teardownMs} < 0) {
				document.getElementById('after').textContent = 'Fel mejladress eller lösenord.';
				return;
			}
			setTimeout(teardown, ${teardownMs});
		});
		// Real sites swap the panel for a reset form; removing it is the harsher case.
		document.getElementById('forgot').addEventListener('click', function () {
			setTimeout(teardown, 300);
		});
		document.getElementById('toggle').addEventListener('click', function () {
			var p = document.getElementById('password');
			p.type = p.type === 'password' ? 'text' : 'password';
		});
	</script>
</body></html>`;
}

async function serve(page: Page, html: string): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: html, headers: COEP })
				: route.fulfill({ status: 200, body: "" }),
		);
}

async function typeCredentials(page: Page): Promise<void> {
	await page.locator("#email").fill("resenar@example.se");
	await page.locator("#password").fill("Formless-Spa-Pw-123");
}

test("captures a formless SPA login once the panel tears down", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	const page = await context.newPage();
	// 2500ms: past the old 1500ms vanishing-field window, which is exactly why
	// this site never offered to save before.
	await serve(page, panel(2500));
	await page.goto("https://example.com/");

	await typeCredentials(page);
	await page.locator("#submit").click();

	// Nothing yet: the panel is still up, so the login hasn't landed.
	await expect(page.locator(PROMPT)).toHaveCount(0);

	await expect(page.locator("#panel")).toHaveCount(0, { timeout: 10_000 });
	await expect(page.locator(PROMPT)).toBeAttached({ timeout: 10_000 });
});

test("does not offer to save when the login fails", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	const page = await context.newPage();
	await serve(page, panel(-1));
	await page.goto("https://example.com/");

	await typeCredentials(page);
	await page.locator("#submit").click();

	// The panel survives the whole arm window, so the attempt expires unsaved.
	await page.waitForTimeout(12_000);
	await expect(page.locator("#panel")).toHaveCount(1);
	await expect(page.locator(PROMPT)).toHaveCount(0);
});

test("does not offer to save after 'Glömt lösenord?' tears the panel down", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	const page = await context.newPage();
	await serve(page, panel(2500));
	await page.goto("https://example.com/");

	await typeCredentials(page);
	// Past the 1500ms fallback, so only the armed path could fire. A
	// `<span role="button">` must not arm.
	await page.waitForTimeout(2500);
	await page.locator("#forgot").click();

	await expect(page.locator("#panel")).toHaveCount(0, { timeout: 10_000 });
	await page.waitForTimeout(2000);
	await expect(page.locator(PROMPT)).toHaveCount(0);
});

test("does not offer to save a form the user abandoned", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	const page = await context.newPage();
	await serve(page, panel(2500));
	await page.goto("https://example.com/");

	await typeCredentials(page);
	// Never submits; the panel goes away for an unrelated reason.
	await page.waitForTimeout(2500);
	await page.evaluate(() => document.getElementById("panel")?.remove());

	await page.waitForTimeout(2000);
	await expect(page.locator(PROMPT)).toHaveCount(0);
});
