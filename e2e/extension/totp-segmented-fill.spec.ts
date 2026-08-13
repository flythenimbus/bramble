import { createHmac } from "node:crypto";
import type { Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, seedTotpLogin } from "./helpers";

// A one-time code filled into a segmented widget, end to end: the real content script detects the
// boxes, the real background computes the code, and the picker hands it over on a trusted click.
// The unit suites cover each of those alone; what only shows up here is the seam between them,
// and both halves of the reported bug lived in that seam.
//
// The widget is Cloudflare's 2FA form, verbatim: six boxes that declare their width with
// pattern="\d{1}" rather than maxlength, plus a visually-hidden input holding the assembled code.
// Filling it wrote all six digits correctly and then blanked them, by writing the empty string
// into that hidden mirror as if it were a seventh box. Fixing that revealed the second half,
// which no unit test could see: the picker suppressed the very autocomplete token detection had
// found the box by, so the pick was refused and clicking the row did nothing at all.
//
// The expected code is computed here from node:crypto rather than from the extension's own
// generator, so a bug that agreed with itself would still fail.

const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function base32Decode(input: string): Buffer {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of input.toUpperCase().replace(/[\s=-]/g, "")) {
		value = (value << 5) | alphabet.indexOf(ch);
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			out.push((value >>> bits) & 0xff);
		}
	}
	return Buffer.from(out);
}

/** The code for the seeded key at a given instant, by RFC 6238 and nothing of ours. */
function rfcCode(atMs: number): string {
	const counter = Math.floor(atMs / 1000 / 30);
	const msg = Buffer.alloc(8);
	msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
	msg.writeUInt32BE(counter >>> 0, 4);
	const mac = createHmac("sha1", base32Decode(SEED)).update(msg).digest();
	const offset = mac[mac.length - 1]! & 0x0f;
	const truncated = mac.readUInt32BE(offset) & 0x7fff_ffff;
	return String(truncated % 1_000_000).padStart(6, "0");
}

/**
 * The codes a fill happening "about now" could legitimately produce: the current time-step and
 * the one before it, since the step can roll over between the click and the assertion.
 */
function acceptable(): string[] {
	const now = Date.now();
	return [rfcCode(now), rfcCode(now - 30_000)];
}

// Verbatim from dash.cloudflare.com's two-factor screen (see the fixture of the same name in the
// extension's unit tests), trimmed to the widget itself.
const CLOUDFLARE_2FA = `<!doctype html><html><head><title>Two-factor</title></head><body>
	<form action="/two-factor" method="post">
		<div role="group">
			<input data-length="6" id="c1" type="text" inputmode="numeric" autocomplete="one-time-code" enterkeyhint="next" maxlength="6" tabindex="0" pattern="\\d{1}" value="">
			<input data-length="6" id="c2" type="text" inputmode="numeric" autocomplete="one-time-code" enterkeyhint="next" tabindex="-1" pattern="\\d{1}" value="">
			<input data-length="6" id="c3" type="text" inputmode="numeric" autocomplete="one-time-code" enterkeyhint="next" tabindex="-1" pattern="\\d{1}" value="">
			<input data-length="6" id="c4" type="text" inputmode="numeric" autocomplete="one-time-code" enterkeyhint="next" tabindex="-1" pattern="\\d{1}" value="">
			<input data-length="6" id="c5" type="text" inputmode="numeric" autocomplete="one-time-code" enterkeyhint="next" tabindex="-1" pattern="\\d{1}" value="">
			<input data-length="6" id="c6" type="text" inputmode="numeric" autocomplete="one-time-code" enterkeyhint="done" tabindex="-1" pattern="\\d{1}" value="">
		</div>
		<input type="text" id="mirror" autocomplete="one-time-code" inputmode="numeric" minlength="6" maxlength="6" pattern="\\d{6}" aria-hidden="true" tabindex="-1" value="" style="clip-path: inset(50%); overflow: hidden; white-space: nowrap; border: 0; padding: 0; width: 1px; height: 1px; margin: -1px; position: fixed; top: 0; left: 0;">
		<button type="submit">Verify</button>
	</form>
</body></html>`;

async function serve(page: Page, html: string): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: html, headers: { "content-type": "text/html" } })
				: route.fulfill({ status: 200, body: "" }),
		);
}

function pickerFrame(page: Page): Frame | undefined {
	return page.frames().find((f) => f.url().includes("autofill-ui.html"));
}

/** `display` of the host wrapping the picker's iframe, or "gone" once it is torn down. */
function hostDisplay(page: Page): Promise<string> {
	return page.evaluate(() => {
		const el = document.querySelector<HTMLElement>('div[id^="tp-"]');
		return el ? getComputedStyle(el).display : "gone";
	});
}

/** Focus a box until the picker's iframe renderer is up, and return it. */
async function openPicker(page: Page, field: string): Promise<Frame> {
	await expect(async () => {
		await page.locator(field).click();
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	return pickerFrame(page)!;
}

/** What the widget holds, read box by box in DOM order. */
function boxValues(page: Page, selector: string): Promise<string[]> {
	return page.$$eval(selector, (els) => els.map((el) => (el as HTMLInputElement).value));
}

test("fills Cloudflare's six-box widget without blanking it on the hidden mirror", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedTotpLogin(popup, "Cloudflare", SEED);

	const page = await context.newPage();
	await serve(page, CLOUDFLARE_2FA);
	await page.goto("https://example.com/two-factor");

	// The page has no login fields at all, so the row on offer is the code itself.
	const frame = await openPicker(page, "#c1");
	const row = frame.locator("[data-entry-id]");
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.click();

	// One digit per box, and the assembled code in the mirror rather than the empty string
	// that used to reset the widget the moment it was filled.
	await expect
		.poll(() => boxValues(page, '[role="group"] input'), { timeout: 10_000 })
		.not.toEqual(["", "", "", "", "", ""]);
	const boxes = await boxValues(page, '[role="group"] input');
	expect(acceptable()).toContain(boxes.join(""));
	expect(boxes.every((v) => v.length === 1)).toBe(true);
	expect(await page.locator("#mirror").inputValue()).toBe(boxes.join(""));

	// Filling focuses each box in turn, and focus() fires a trusted focusin: the dropdown must
	// not answer its own fill by reopening on the box it just wrote to.
	await page.waitForTimeout(1000);
	expect(await hostDisplay(page)).toMatch(/none|gone/);
});
