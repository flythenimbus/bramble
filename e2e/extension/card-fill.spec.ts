import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	createVault,
	openPopup,
	seedExampleCard,
	seedSecondCard,
	waitOutPickerClickGuard,
} from "./helpers";

// Card fill on an ordinary same-document checkout, as opposed to the hosted-fields iframe case
// in picker-relay.spec.ts. What is driven here needs a real browser: switching cards depends on
// the picker's anchor surviving a second round-trip, and the visibility rule depends on real
// layout, which jsdom has none of (its boxes are all 0x0, so unit tests mock the rects and can
// only assert the rule they were handed).

const COEP = {
	"content-type": "text/html",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
};

// Labelled the ordinary way; the number field is the one the picker anchors to.
const CHECKOUT = `<!doctype html><html><head><title>Checkout</title></head><body>
	<form>
		<label for="num">Card number</label><input id="num" name="cardnumber" autocomplete="cc-number" />
		<label for="exp">Expiry</label><input id="exp" name="expiry" autocomplete="cc-exp" />
		<label for="cvv">CVV</label><input id="cvv" name="cvv" autocomplete="cc-csc" />
	</form>
</body></html>`;

// The Semafone shape: a PAN-only capture whose cvc box is display:none but still submitted.
const PAN_ONLY = `<!doctype html><html><head><title>Secure payment</title></head><body>
	<input type="hidden" name="cardScheme" id="cardScheme" value="" />
	<input type="hidden" name="sf.req.card.expiryMonth" id="sf.req.card.expiryMonth" value="" />
	<input type="text" name="pan" id="pan" maxlength="16" />
	<input type="text" name="cvc" id="cvc" style="display: none" maxlength="4" />
</body></html>`;

// An unrelated expiry, the way a passport or document form has one: no tokens, just a label.
const PASSPORT = `<!doctype html><html><head><title>Travel document</title></head><body>
	<form id="form">
		<label for="doc">Passport number</label><input id="doc" name="passport" />
		<label for="exp">Expiry</label><input id="exp" name="expiry" />
	</form>
</body></html>`;

// A card form named only by its labels: the pair is what makes it one.
const UNTAGGED_CHECKOUT = `<!doctype html><html><head><title>Checkout</title></head><body>
	<form>
		<label for="num">Card number</label><input id="num" name="number" />
		<label for="exp">Expiry</label><input id="exp" name="exp" />
	</form>
</body></html>`;

const HOST = "#bramble-autofill-dropdown";

/** Serve `html` for example.com under COEP, which forces the observable shadow renderer. */
async function serve(page: Page, html: string): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: html, headers: COEP })
				: route.fulfill({ status: 200, body: "" }),
		);
}

/** Open the picker on `selector` and return the host's on-screen box. */
async function openPickerOn(page: Page, selector: string) {
	const host = page.locator(HOST);
	await expect(async () => {
		await page.locator(selector).click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 25_000 });
	const box = await host.boundingBox();
	expect(box, "the picker never got a box").not.toBeNull();
	return box!;
}

/** Click the nth row of the open picker (rows live in a closed shadow root, so click by position). */
async function clickRow(page: Page, box: { x: number; y: number; height: number }, n: number) {
	await waitOutPickerClickGuard(page);
	await page.mouse.click(box.x + 30, box.y + 24 + n * 44);
}

async function setUp(context: BrowserContext, extensionId: string, second = false) {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleCard(popup);
	if (second) await seedSecondCard(popup);
	await popup.close();
}

test("picking a second card replaces the first, in every field", async ({
	context,
	extensionId,
}) => {
	// The reported bug: fillCard's guard was unconditional, so a second pick was a total no-op.
	// Every field bailed, the first card's expiry and CVV stayed put, and it read as if the
	// dropdown had filled the wrong entry.
	await setUp(context, extensionId, true);
	const page = await context.newPage();
	await serve(page, CHECKOUT);
	await page.goto("https://example.com/checkout");

	const first = await openPickerOn(page, "#num");
	await clickRow(page, first, 0);
	await expect.poll(() => page.locator("#num").inputValue()).toMatch(/^\d{16}$/);

	const filled = await page.locator("#num").inputValue();
	const otherCard = filled.startsWith("4242") ? "5555555555554444" : "4242424242424242";
	const otherRow = filled.startsWith("4242") ? 1 : 0;
	const otherCvv = filled.startsWith("4242") ? "987" : "123";

	// Re-open on the same field and take the other card.
	const second = await openPickerOn(page, "#num");
	await clickRow(page, second, otherRow);

	await expect.poll(() => page.locator("#num").inputValue()).toBe(otherCard);
	// The CVV is the field that used to keep the previous card's value.
	await expect.poll(() => page.locator("#cvv").inputValue()).toBe(otherCvv);
});

test("never fills a card box the form has hidden", async ({ context, extensionId }) => {
	// The Semafone frame tokenises the PAN only, but its display:none cvc box is still appended
	// to the submit when it holds a value, so filling it would send a CVV in a request that was
	// not collecting one. Needs real layout: in jsdom every box is 0x0 and this cannot be told
	// apart from an ordinary field.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, PAN_ONLY);
	await page.goto("https://example.com/pay");

	const box = await openPickerOn(page, "#pan");
	await clickRow(page, box, 0);

	await expect.poll(() => page.locator("#pan").inputValue()).toBe("4242424242424242");
	// Give any stray write a chance to land before asserting the absence.
	await page.waitForTimeout(500);
	expect(await page.locator("#cvc").inputValue()).toBe("");
});

test('offers a card on an unlabelled name="pan" field', async ({ context, extensionId }) => {
	// No label, no placeholder, no autocomplete, no aria-label: `pan` is the only thing naming
	// this field, and the parent's <iframe title="Enter credit card number"> is unreachable from
	// inside a cross-origin frame. Without the weak lexicon the field is not a candidate at all,
	// so the picker never opens and the assertion below times out.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, PAN_ONLY);
	await page.goto("https://example.com/pay");

	await openPickerOn(page, "#pan");
});

test("a lone Expiry box is not a card form, until a CVV joins it", async ({
	context,
	extensionId,
}) => {
	// The reported bug: an unrelated "Expiry" field offered every stored card.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, PASSPORT);
	await page.goto("https://example.com/passport");

	await page.locator("#exp").click();
	// A negative about something asynchronous: give the query the round trip it would need.
	await page.waitForTimeout(2000);
	await expect(page.locator(HOST)).toHaveCount(0);

	// Expiry and CVV together are a card form, and the same box now offers the card.
	await page.evaluate(() => {
		document
			.getElementById("form")
			?.insertAdjacentHTML(
				"beforeend",
				'<label for="cvv">CVV</label><input id="cvv" name="cvv" />',
			);
	});
	const box = await openPickerOn(page, "#exp");
	await clickRow(page, box, 0);
	await expect.poll(() => page.locator("#exp").inputValue()).toBe("04/30");
	await expect.poll(() => page.locator("#cvv").inputValue()).toBe("123");
	expect(await page.locator("#doc").inputValue()).toBe("");
});

test("a card number and expiry with no cc-* tokens are a card form", async ({
	context,
	extensionId,
}) => {
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, UNTAGGED_CHECKOUT);
	await page.goto("https://example.com/checkout");

	const box = await openPickerOn(page, "#exp");
	await clickRow(page, box, 0);
	await expect.poll(() => page.locator("#num").inputValue()).toBe("4242424242424242");
	await expect.poll(() => page.locator("#exp").inputValue()).toBe("04/30");
});
