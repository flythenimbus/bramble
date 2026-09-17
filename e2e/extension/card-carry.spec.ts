import type { BrowserContext, Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, seedExampleCard, seedSecondCard } from "./helpers";

// The card a tab has already filled, on the checkout that needs it: hosted fields, one
// cross-origin frame per box, each frame filling only its own inputs (the relay itself is
// covered in picker-relay.spec.ts). One pick fills the number frame; the CVV frame then asks
// from scratch and offers every stored card with nothing saying which one is already in the
// form. What it now leads with, and marks, is what these cover.
//
// Real browser, not jsdom: two genuine origins in one frame tree, a background reading the tab
// id off the verified sender, and a sibling frame whose cached answer predates the pick.

const MERCHANT = "https://merchant.example";
const PCI = "https://pci.example";

const DECOY =
	'data-honeypot-field tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px"';
const BOXES = [
	["number", "cc-number"],
	["name", "cc-name"],
	["expiry_month", "cc-exp-month"],
	["expiry_year", "cc-exp-year"],
	["verification_value", "cc-csc"],
] as const;

/** Shopify's frame document: the whole field set, one box visible and the rest hidden decoys. */
function cardFrameDoc(visible: string): string {
	const inputs = BOXES.map(
		([id, token]) =>
			`<input autocomplete="${token}" id="${id}" name="${id}" type="text" ${
				id === visible ? "" : DECOY
			}>`,
	).join("");
	return `<!doctype html><html><head><title>${visible}</title></head>
<body style="margin:0"><form>${inputs}</form></body></html>`;
}

const CHECKOUT = `<!doctype html><html><head><title>Checkout</title></head>
<body style="margin:0">
	<div style="height:260px">Order summary</div>
	<label for="numberframe">Card number</label>
	<iframe id="numberframe" src="${PCI}/number" frameborder="0" scrolling="no"
		style="height:47px;width:432px;border:0;display:block"></iframe>
	<label for="cvvframe">Security code</label>
	<iframe id="cvvframe" src="${PCI}/cvv" frameborder="0" scrolling="no"
		style="height:47px;width:200px;border:0;display:block"></iframe>
</body></html>`;

/** Route both origins for the whole context, so a second tab is served the same checkout. */
async function serve(context: BrowserContext): Promise<void> {
	await context.route(/^https:\/\/(merchant|pci)\.example\//, (route) => {
		if (route.request().resourceType() !== "document") {
			return route.fulfill({ status: 200, body: "" });
		}
		const url = route.request().url();
		const headers = { "content-type": "text/html" };
		if (url.startsWith(`${PCI}/number`)) {
			return route.fulfill({ body: cardFrameDoc("number"), headers });
		}
		if (url.startsWith(`${PCI}/cvv`)) {
			return route.fulfill({ body: cardFrameDoc("verification_value"), headers });
		}
		return route.fulfill({ body: CHECKOUT, headers });
	});
}

/** The extension-origin picker UI, wherever in the frame tree it was hosted. */
function uiFrame(page: Page): Frame | undefined {
	return page.frames().find((f) => f.url().includes("autofill-ui.html"));
}

function boxFrame(page: Page, which: "number" | "cvv"): Frame {
	const frame = page.frames().find((f) => f.url() === `${PCI}/${which}`);
	if (!frame) throw new Error(`${which} frame missing`);
	return frame;
}

const FIELD = { number: "#number", cvv: "#verification_value" } as const;

/** Click the visible box of `which` frame and wait for the picker to come up with rows. */
async function openPicker(page: Page, which: "number" | "cvv"): Promise<Frame> {
	await expect(async () => {
		await boxFrame(page, which).locator(FIELD[which]).click();
		expect(uiFrame(page)).toBeDefined();
	}).toPass({ timeout: 25_000 });
	const ui = uiFrame(page);
	expect(ui, "the picker UI never appeared").toBeDefined();
	await expect(ui!.locator("[data-entry-id]").first()).toBeVisible({ timeout: 15_000 });
	return ui!;
}

async function setUp(context: BrowserContext, extensionId: string): Promise<void> {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleCard(popup);
	await seedSecondCard(popup);
	await popup.close();
}

/** A checkout tab with both card frames loaded. */
async function checkout(context: BrowserContext, path = "/"): Promise<Page> {
	const page = await context.newPage();
	await page.goto(`${MERCHANT}${path}`);
	await expect(page.locator("#cvvframe")).toBeAttached();
	return page;
}

test("the card picked in one hosted field leads the list in the next", async ({
	context,
	extensionId,
}) => {
	await setUp(context, extensionId);
	await serve(context);
	const page = await checkout(context);

	// Take the SECOND card, so leading with it later is a real change of order rather than the
	// list it would have shown anyway.
	const numberUi = await openPicker(page, "number");
	await expect(numberUi.locator("[data-entry-id]")).toHaveCount(2);
	await numberUi.locator("[data-entry-id]").filter({ hasText: "Travel Mastercard" }).click();
	await expect(boxFrame(page, "number").locator("#number")).toHaveValue("5555555555554444", {
		timeout: 15_000,
	});
	// Nothing reached the CVV frame: it holds its own boxes and was never told.
	await expect(boxFrame(page, "cvv").locator("#verification_value")).toHaveValue("");

	const cvvUi = await openPicker(page, "cvv");
	const rows = cvvUi.locator("[data-entry-id]");
	await expect(rows).toHaveCount(2);
	await expect(rows.first()).toContainText("Travel Mastercard");
	await expect(rows.first().locator(".tp-badge")).toHaveText("Used here");
	await expect(rows.nth(1)).toContainText("Personal Visa");
	await expect(rows.nth(1).locator(".tp-badge")).toHaveCount(0);

	// And taking that first row fills this frame from the same card.
	await rows.first().click();
	await expect(boxFrame(page, "cvv").locator("#verification_value")).toHaveValue("987", {
		timeout: 15_000,
	});
});

test("a second tab is not told what the first one filled", async ({ context, extensionId }) => {
	await setUp(context, extensionId);
	await serve(context);
	const first = await checkout(context);

	const ui = await openPicker(first, "number");
	await ui.locator("[data-entry-id]").filter({ hasText: "Travel Mastercard" }).click();
	await expect(boxFrame(first, "number").locator("#number")).toHaveValue("5555555555554444", {
		timeout: 15_000,
	});

	// A different tab is a different checkout, and gets the plain list in its own order.
	const second = await checkout(context);
	const secondUi = await openPicker(second, "number");
	await expect(secondUi.locator("[data-entry-id]").first()).toContainText("Personal Visa");
	await expect(secondUi.locator(".tp-badge")).toHaveCount(0);
});

test("navigating away ends it", async ({ context, extensionId }) => {
	// The carry belongs to one page. The next checkout in this tab is a different purchase, and
	// starting it with the previous one's card marked would be a claim about this form that is
	// not true.
	await setUp(context, extensionId);
	await serve(context);
	const page = await checkout(context);

	const ui = await openPicker(page, "number");
	await ui.locator("[data-entry-id]").filter({ hasText: "Travel Mastercard" }).click();
	await expect(boxFrame(page, "number").locator("#number")).toHaveValue("5555555555554444", {
		timeout: 15_000,
	});

	await page.goto(`${MERCHANT}/second-order`);
	await expect(page.locator("#cvvframe")).toBeAttached();

	const afterUi = await openPicker(page, "cvv");
	await expect(afterUi.locator("[data-entry-id]").first()).toContainText("Personal Visa");
	await expect(afterUi.locator(".tp-badge")).toHaveCount(0);
});
