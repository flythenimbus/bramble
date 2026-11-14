import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	clickCornerAction,
	clickCornerElement,
	cornerHas,
	cornerValue,
	createVault,
	openPopup,
} from "./helpers";

// What the user types on the save card must not reach the page. The card's closed shadow root
// hid its DOM and nothing else: with the Username box in the page's own document, a page heard
// every keystroke (a forum ran its "c" shortcut), could read the box and could write into it.
// The page below listens from its first script and at window capture, which is ahead of
// anything a content script can add.

const PROMPT = "#bramble-corner-prompt";
// The Username box the user can type in, wherever it lives.
const EDITABLE = "#tp-username:not([readonly]):not([hidden]), iframe.tp-field:not([hidden])";
const READ_ONLY = "#tp-username[readonly]:not([hidden])";

const TYPED = [
	"keydown",
	"keypress",
	"keyup",
	"beforeinput",
	"input",
	"textInput",
	"compositionstart",
	"compositionupdate",
	"compositionend",
	"paste",
	"copy",
	"cut",
];

const LOGIN = `<!doctype html><html><head><title>login</title>
	<script>
		window.__heard = [];
		${JSON.stringify(TYPED)}.forEach(function (type) {
			function hear(where) {
				return function (e) { window.__heard.push(where + ":" + type + ":" + (e.key || e.data || "")); };
			}
			window.addEventListener(type, hear("window-capture"), true);
			document.addEventListener(type, hear("document-bubble"));
		});
	</script>
</head><body>
	<form id="login">
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
	<script>
		document.getElementById('login').addEventListener('submit', function (e) {
			e.preventDefault();
			setTimeout(function () { document.getElementById('login').remove(); }, 100);
		});
	</script>
</body></html>`;

async function serve(
	page: Page,
	html: string,
	headers: Record<string, string> = {},
): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: html, headers: { "content-type": "text/html", ...headers } })
				: route.fulfill({ status: 200, body: "" }),
		);
}

/** Sign in as alice, which raises the save card, and forget what the page heard on the way. */
async function raiseSaveCard(page: Page): Promise<void> {
	await page.goto("https://keys.example.com/");
	await page.locator("#user").fill("alice@example.com");
	await page.locator("#pass").fill("Al1ce-Keys-Pw");
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.locator(PROMPT)).toBeAttached({ timeout: 10_000 });
	await page.evaluate(() => {
		(window as unknown as { __heard: string[] }).__heard.length = 0;
	});
}

const heard = (page: Page) =>
	page.evaluate(() => (window as unknown as { __heard: string[] }).__heard);

/** Whether the caret is in the Username box, wherever it lives. The page's own active element
 *  names the card only once the browser has moved keyboard focus there. */
async function usernameHasFocus(page: Page): Promise<boolean> {
	const onCard = await page.evaluate(
		(sel) => document.activeElement === document.querySelector(sel),
		PROMPT,
	);
	const frame = page.frames().find((f) => f.url().includes("corner-field.html"));
	if (!onCard || !frame) return onCard;
	return frame.evaluate(() => document.activeElement instanceof HTMLInputElement);
}

/** Click into the Username box and wait for the caret, as a person does before typing. The frame
 *  is swapped in a moment after the card appears, and a click or a key sent in that same instant
 *  lands on the page with nothing focused, which is not what this spec is about. */
async function clickUsername(page: Page): Promise<void> {
	await expect(async () => {
		await clickCornerElement(page, EDITABLE);
		expect(await usernameHasFocus(page)).toBe(true);
	}).toPass({ timeout: 10_000 });
}

/** The saved login's detail view, as text. */
async function savedLogin(popup: Page, extensionId: string): Promise<string> {
	await openPopup(popup, extensionId);
	await popup.getByText("keys.example.com", { exact: true }).click();
	await expect(popup.getByRole("button", { name: "Edit entry" })).toBeVisible();
	return popup.locator("#root").innerText();
}

test("a username typed on the save card reaches the card and not the page", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	const page = await context.newPage();
	await serve(page, LOGIN);
	await raiseSaveCard(page);

	await clickUsername(page);
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.type("carol");

	// Nor can the page read the box or write into it while the user is in it.
	const reached = await page.evaluate(() => {
		document.execCommand("selectAll");
		const selected = String(window.getSelection());
		document.execCommand("insertText", false, "EVIL");
		return selected;
	});
	expect(await heard(page)).toEqual([]);
	expect(reached).not.toContain("carol");

	await clickCornerAction(page, "save");
	await expect(page.locator(PROMPT)).toHaveCount(0);
	const detail = await savedLogin(popup, extensionId);
	expect(detail).toContain("carol");
	expect(detail).not.toContain("alice@example.com");
	expect(detail).not.toContain("EVIL");
});

test("the typed username survives the page moving the card", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	const page = await context.newPage();
	await serve(page, LOGIN);
	await raiseSaveCard(page);

	await clickUsername(page);
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.type("carol");
	const box = () => page.frames().find((f) => f.url().includes("corner-field.html"));
	const first = box();
	// Re-inserting the host reloads the frame inside it, as any page script may do.
	await page.evaluate((sel) => {
		const host = document.querySelector(sel);
		if (host) document.body.appendChild(host);
	}, PROMPT);
	await expect.poll(() => box() !== undefined && box() !== first).toBe(true);
	await expect(box()!.locator("input")).toHaveValue("carol");

	await clickCornerAction(page, "save");
	await expect(page.locator(PROMPT)).toHaveCount(0);
	expect(await savedLogin(popup, extensionId)).toContain("carol");
});

test("where the page blocks extension frames, the card takes no typing at all", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	const page = await context.newPage();
	// COEP is the one header that keeps an extension frame out (see docs/autofill.md).
	await serve(page, LOGIN, {
		"cross-origin-embedder-policy": "require-corp",
		"cross-origin-opener-policy": "same-origin",
	});
	await raiseSaveCard(page);

	await page.waitForTimeout(1500);
	expect(await cornerHas(page, EDITABLE)).toBe(false);
	await clickCornerElement(page, READ_ONLY);
	await page.keyboard.type("carol");
	expect(await cornerValue(page, "#tp-username")).toBe("alice@example.com");

	await clickCornerAction(page, "save");
	await expect(page.locator(PROMPT)).toHaveCount(0);
	const detail = await savedLogin(popup, extensionId);
	expect(detail).toContain("alice@example.com");
	expect(detail).not.toContain("carol");
});
