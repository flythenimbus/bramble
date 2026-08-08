import type { Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, seedExampleCard } from "./helpers";

// Card autofill on a hosted-fields checkout (Shopify, Stripe Elements, Braintree, Adyen). The card
// input lives in a cross-origin iframe sized to the input itself, so a picker mounted in that
// document is positioned below the frame's viewport and an iframe cannot paint outside its own box:
// the field was detected, but nothing was ever visible. The top frame now hosts the ELEMENT while
// the field's frame keeps the conversation with it. See docs/autofill.md.
//
// Two real origins here, so the iframe is genuinely cross-origin and the relay is exercised end to
// end: the frame walk, the extension-origin pin (which unit tests cannot check, since it depends on
// what Chromium actually reports for a `use_dynamic_url` web-accessible resource), and the fill.

const MERCHANT = "https://merchant.example";
const PCI = "https://pci.example";

/** The merchant frame: labels and an empty container, exactly like Shopify's checkout. */
const CHECKOUT = `<!doctype html><html><head><title>Checkout</title></head>
<body style="margin:0">
	<div style="height:300px">Order summary</div>
	<div id="number-container">
		<label for="number">Card number</label>
		<iframe id="cardframe" src="${PCI}/number" frameborder="0" scrolling="no"
			style="height:47px;width:432px;border:0;display:block"></iframe>
	</div>
	<button id="elsewhere" type="button">Somewhere else</button>
</body></html>`;

// Shopify's real frame document: one visible field plus hidden decoys that carry real cc-* tokens,
// so a browser filling this one frame delivers the whole card.
const CARD_FRAME = `<!doctype html><html><head><title>card</title></head>
<body style="margin:0">
	<form>
		<label for="number" style="position:absolute;left:-9999px">Credit Card Number</label>
		<input required autocomplete="cc-number" id="number" name="number" type="text" inputmode="numeric">
		<input autocomplete="cc-name" id="name" name="name" type="text" data-honeypot-field tabindex="-1"
			aria-hidden="true" style="position:absolute;left:-9999px">
		<input autocomplete="cc-exp-month" id="expiry_month" name="expiry_month" type="text" data-honeypot-field
			tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px">
		<input autocomplete="cc-exp-year" id="expiry_year" name="expiry_year" type="text" data-honeypot-field
			tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px">
		<input autocomplete="cc-csc" id="verification_value" name="verification_value" type="text"
			data-honeypot-field tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px">
	</form>
</body></html>`;

// The same card form served at full height, where the picker still fits locally. The control for
// "we did not change the shipped path".
const TALL_FRAME = CARD_FRAME.replace(
	'body style="margin:0"',
	'body style="margin:0;height:800px"',
);

async function serve(page: Page, cardFrameHtml = CARD_FRAME): Promise<void> {
	await page.context().route(/^https:\/\/(merchant|pci)\.example\//, (route) => {
		const url = route.request().url();
		if (route.request().resourceType() !== "document") {
			return route.fulfill({ status: 200, body: "" });
		}
		const body = url.startsWith(PCI) ? cardFrameHtml : CHECKOUT;
		return route.fulfill({ body, headers: { "content-type": "text/html" } });
	});
}

/** The extension-origin picker UI, wherever it ended up in the frame tree. */
function uiFrame(page: Page): Frame | undefined {
	return page.frames().find((f) => f.url().includes("autofill-ui.html"));
}

function cardFrame(page: Page): Frame {
	const frame = page.frames().find((f) => f.url().startsWith(PCI));
	if (!frame) throw new Error("card frame missing");
	return frame;
}

/** Count of picker host elements in a given frame's own document. */
function hostCount(frame: Frame | Page): Promise<number> {
	return frame.evaluate(() => document.querySelectorAll('div[id^="tp-"]').length);
}

async function setUp(context: import("@playwright/test").BrowserContext, extensionId: string) {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleCard(popup);
	await popup.close();
}

/** Click the card field and wait for the picker UI to come up somewhere. */
async function openPicker(page: Page): Promise<Frame> {
	await expect(async () => {
		await cardFrame(page).locator("#number").click();
		expect(uiFrame(page)).toBeDefined();
	}).toPass({ timeout: 25_000 });
	const frame = uiFrame(page);
	expect(frame, "the picker UI never appeared").toBeDefined();
	await expect(frame!.locator("[data-entry-id]")).toBeVisible({ timeout: 15_000 });
	return frame!;
}

test("hosts the picker in the top frame for a card field in a short cross-origin iframe", async ({
	context,
	extensionId,
}) => {
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page);
	await page.goto(`${MERCHANT}/`);

	const ui = await openPicker(page);

	// The decisive assertion: the UI is a child of the TOP document, not of the 47px card frame
	// that owns the field. That is the whole fix; before it, the picker rendered inside the card
	// frame and was clipped out of existence.
	expect(ui.parentFrame()).toBe(page.mainFrame());
	expect(await hostCount(page)).toBe(1);
	expect(await hostCount(cardFrame(page))).toBe(0);

	// It is showing the seeded card, so the extension-origin pin resolved and the summaries got
	// through to the UI document.
	await expect(ui.locator("[data-entry-id]")).toContainText("4242");

	// And the host was sized from the UI's height report, so it is actually visible.
	const box = await page.locator('div[id^="tp-"]').boundingBox();
	expect(box?.height ?? 0).toBeGreaterThan(20);
});

test("picking a card fills the frame that owns the field, decoys included", async ({
	context,
	extensionId,
}) => {
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page);
	await page.goto(`${MERCHANT}/`);

	const ui = await openPicker(page);
	await ui.locator("[data-entry-id]").click();

	const frame = cardFrame(page);
	await expect(frame.locator("#number")).toHaveValue("4242424242424242", { timeout: 15_000 });
	// Shopify reads the decoys to distribute the card across its other frames, so a single fill
	// here has to populate them too.
	await expect(frame.locator("#name")).toHaveValue("Alice Example");
	await expect(frame.locator("#expiry_month")).toHaveValue("04");
	await expect(frame.locator("#expiry_year")).toHaveValue("2030");
	await expect(frame.locator("#verification_value")).toHaveValue("123");

	// The host is released once the pick is done.
	await expect.poll(() => hostCount(page), { timeout: 10_000 }).toBe(0);
});

test("the merchant page cannot forge a pick into the card frame", async ({
	context,
	extensionId,
}) => {
	// The adversarial case the design turns on. Every relay hop is a message event on a window the
	// page shares with us, so a merchant page can post whatever it likes into the card frame. A
	// pick is honoured only from the pinned UI window on one of our own extension origins, and the
	// page can forge neither, so this must not fill even with a REAL entry id.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page);
	await page.goto(`${MERCHANT}/`);

	// Learn a genuine entry id off the rendered row. The picker stays OPEN and bound to
	// the real UI: a closed relay would reject these messages for the wrong reason, and
	// the test would pass even with the origin check removed.
	const ui = await openPicker(page);
	const entryId = await ui.locator("[data-entry-id]").first().getAttribute("data-entry-id");
	expect(entryId).toBeTruthy();

	// Impersonate the picker from the merchant page, using that real id.
	await page.evaluate((id) => {
		const frame = document.querySelector<HTMLIFrameElement>("#cardframe");
		for (const message of [
			{ type: "UI_PICK", entryId: id },
			{ __tp: "tp-ui-here", relayId: "guessed" },
			{ type: "RENDER_MATCHES", matches: [{ id, name: "x", secondary: "y" }] },
		]) {
			frame?.contentWindow?.postMessage(message, "*");
		}
	}, entryId);

	await page.waitForTimeout(1500);
	await expect(cardFrame(page).locator("#number")).toHaveValue("");
	await expect(cardFrame(page).locator("#verification_value")).toHaveValue("");
});

test("a card frame with room still renders the picker locally", async ({
	context,
	extensionId,
}) => {
	// The shipped path must be untouched: when the field's own frame can display the dropdown, it
	// does, and nothing is relayed to the top frame.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, TALL_FRAME);
	await page.goto(`${MERCHANT}/`);
	await page.locator("#cardframe").evaluate((el) => {
		(el as HTMLIFrameElement).style.height = "600px";
	});

	const ui = await openPicker(page);

	expect(ui.parentFrame()).toBe(cardFrame(page));
	expect(await hostCount(cardFrame(page))).toBe(1);
	expect(await hostCount(page)).toBe(0);

	await ui.locator("[data-entry-id]").click();
	await expect(cardFrame(page).locator("#number")).toHaveValue("4242424242424242", {
		timeout: 15_000,
	});
});

test("keyboard nav drives the relayed picker without moving focus off the field", async ({
	context,
	extensionId,
}) => {
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page);
	await page.goto(`${MERCHANT}/`);

	const ui = await openPicker(page);
	const row = ui.locator("[data-entry-id]");
	await expect(row).not.toHaveClass(/tp-active/);

	// The field is in one frame and the rows in another, so this only works if the key forwarding
	// crosses the relay and the highlight comes back.
	await page.keyboard.press("ArrowDown");
	await expect(row).toHaveClass(/tp-active/, { timeout: 10_000 });
	await page.keyboard.press("Enter");

	await expect(cardFrame(page).locator("#number")).toHaveValue("4242424242424242", {
		timeout: 15_000,
	});
});

test("dismisses the relayed picker when the field's frame scrolls it away", async ({
	context,
	extensionId,
}) => {
	// Escape is handled in the field's frame but the host lives upstairs, so the withdrawal has to
	// travel back up the chain for the element to actually go.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page);
	await page.goto(`${MERCHANT}/`);

	await openPicker(page);
	expect(await hostCount(page)).toBe(1);

	await page.keyboard.press("Escape");

	await expect.poll(() => hostCount(page), { timeout: 10_000 }).toBe(0);
	await expect(cardFrame(page).locator("#number")).toHaveValue("");
});
