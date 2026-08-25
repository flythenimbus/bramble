import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, seedExampleLogin } from "./helpers";

// A login form inside a modal, the picker open on it, and then the modal closes. The picker is
// anchored to a field that is no longer on screen, so it has to go with it. There is no
// navigation here and nothing is necessarily unmounted: the tracker's per-frame check on the
// anchor is the only thing watching, and a modal has several ways of going away.
//
// Served under COEP: require-corp, which forces the picker's shadow-DOM renderer, whose host is
// a light-DOM element that is REMOVED on dismissal (the iframe host is only hidden).

const COEP = {
	"content-type": "text/html",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
};

const HOST = "#bramble-autofill-dropdown";

const MODAL = `<!doctype html><html><head><title>login</title></head><body>
	<p>Page content behind the modal.</p>
	<div id="modal" style="position: fixed; inset: 20% 30%; background: #fff; padding: 24px;">
		<form>
			<input id="user" name="username" type="text" autocomplete="username" />
			<input id="pass" name="password" type="password" autocomplete="current-password" />
			<button type="submit">Sign in</button>
		</form>
	</div>
</body></html>`;

// The same modal, with the form inside an open shadow root. The anchor's root node is the
// shadow root rather than the document, which is the branch a document-level hit test gets
// wrong: it would answer with the HOST and never with the field.
const SHADOW_MODAL = `<!doctype html><html><head><title>login</title></head><body>
	<p>Page content behind the modal.</p>
	<div id="modal" style="position: fixed; inset: 20% 30%; background: #fff; padding: 24px;">
		<div id="host"></div>
	</div>
	<script>
		document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
			'<form>' +
			'<input id="user" name="username" type="text" autocomplete="username" />' +
			'<input id="pass" name="password" type="password" autocomplete="current-password" />' +
			'<button type="submit">Sign in</button>' +
			'</form>';
	</script>
</body></html>`;

// A login form under enough page to scroll it clean out of the viewport.
const TALL = `<!doctype html><html><head><title>login</title></head><body>
	<div style="height: 300vh">Lots of page.</div>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
	<div style="height: 300vh">Lots more page.</div>
</body></html>`;

async function serve(page: Page, body = MODAL): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body, headers: COEP })
				: route.fulfill({ status: 200, body: "" }),
		);
}

/** A page with a login saved for the site and the picker open on the modal's username field. */
async function openPickerInModal(
	context: BrowserContext,
	extensionId: string,
	body = MODAL,
): Promise<Page> {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	const page = await context.newPage();
	await serve(page, body);
	await page.goto("https://example.com/");
	// `#user` may live in a shadow root; Playwright pierces open ones.
	await expect(async () => {
		await page.locator("#user").click();
		await expect(page.locator(HOST)).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
	return page;
}

/** Apply `style` to the modal (or remove it, for `null`) and assert the picker went with it. */
async function closeModal(page: Page, style: Record<string, string> | null): Promise<void> {
	await page.evaluate((css) => {
		const modal = document.getElementById("modal") as HTMLElement;
		if (!css) return modal.remove();
		for (const [prop, value] of Object.entries(css)) modal.style.setProperty(prop, value);
	}, style);
	await expect(page.locator(HOST)).not.toBeAttached({ timeout: 5000 });
}

test("dismisses when the modal is unmounted", async ({ context, extensionId }) => {
	const page = await openPickerInModal(context, extensionId);
	await closeModal(page, null);
});

test("dismisses when the modal is display:none", async ({ context, extensionId }) => {
	const page = await openPickerInModal(context, extensionId);
	await closeModal(page, { display: "none" });
});

test("dismisses when the modal is visibility:hidden", async ({ context, extensionId }) => {
	// Still attached, still measuring a box: only a style check that answers for ANCESTORS
	// sees this one.
	const page = await openPickerInModal(context, extensionId);
	await closeModal(page, { visibility: "hidden" });
});

test("dismisses when the modal fades to opacity:0", async ({ context, extensionId }) => {
	// How a transition-based modal ends up: mounted, laid out, and invisible.
	const page = await openPickerInModal(context, extensionId);
	await closeModal(page, { opacity: "0" });
});

test("dismisses when the modal collapses to nothing and clips", async ({
	context,
	extensionId,
}) => {
	// The field stays attached, visible by every style anyone can read, and keeps its own box.
	// It is the ANCESTOR that has gone to nothing, and clipped the field out of the picture.
	const page = await openPickerInModal(context, extensionId);
	await closeModal(page, { height: "0", padding: "0", overflow: "hidden" });

	// Guard the fixture: this must be the collapsed-ancestor shape, not an ordinary hide, or
	// the case above would be covering it and this test would be proving nothing.
	const shape = await page.evaluate(() => {
		const field = document.getElementById("user") as HTMLElement;
		const rect = field.getBoundingClientRect();
		return {
			fieldStillAttached: field.isConnected,
			fieldStillHasABox: rect.width > 0 && rect.height > 0,
			fieldStillReadsAsVisible: field.checkVisibility({
				checkOpacity: true,
				checkVisibilityCSS: true,
			}),
			modalHeight: (document.getElementById("modal") as HTMLElement).getBoundingClientRect().height,
		};
	});
	expect(shape).toEqual({
		fieldStillAttached: true,
		fieldStillHasABox: true,
		fieldStillReadsAsVisible: true,
		modalHeight: 0,
	});
});

test("dismisses when a modal holding the form in a shadow root closes", async ({
	context,
	extensionId,
}) => {
	const page = await openPickerInModal(context, extensionId, SHADOW_MODAL);

	// It has to survive being open first: this is the branch where a naive hit test answers
	// with the shadow host instead of the field and takes the picker down on sight.
	await page.waitForTimeout(1000);
	await expect(page.locator(HOST)).toBeAttached();

	await closeModal(page, { visibility: "hidden" });
});

test("keeps the picker when the field is only scrolled out of view", async ({
	context,
	extensionId,
}) => {
	// Not a dismissal: the picker is pinned to the field and rides along off-screen, as it
	// always has. Off-viewport is also where a hit test has nothing to hit, so this is the
	// case that has to stay exempt from it.
	const page = await openPickerInModal(context, extensionId, TALL);

	await page.evaluate(() => window.scrollTo(0, 0));
	await page.waitForTimeout(1000);
	await expect(page.locator(HOST)).toBeAttached();

	// And it is still tracking: scrolling back leaves it under the field.
	await page.evaluate(() => (document.getElementById("user") as HTMLElement).scrollIntoView());
	await page.waitForTimeout(500);
	await expect(page.locator(HOST)).toBeAttached();
});
