import type { BrowserContext, Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { backgroundWorker, createVault, openPopup, seedExampleLogin } from "./helpers";

// When the content script looks at the page again, and what that costs. Issue #59:
// the MutationObserver dropped the cached field model on every childList batch, so
// a page that rewrites itself continuously (YouTube, a feed, a video player) paid a
// full page scan twice a second, and every keystroke and click paid another.
//
// Unit tests (content/content.mutations.dom.test.ts, content/detection.perf.dom.test.ts)
// pin the policy and the traversal count in jsdom. These drive the real thing: a real
// observer delivering real batches, a real background receiving (or not receiving) the
// re-query, and real layout under the keystrokes. Two of them assert on cost, which is
// only meaningful in a real engine.
//
// Pages are served under COEP where a test only needs to see the picker mount (that
// blocks the extension-origin iframe and forces the shadow-DOM renderer, whose host is
// a light-DOM element), and served plainly where a test needs to CLICK a row: the
// dropdown's own shadow root is closed, so the iframe is the renderer that can be
// driven. See picker-iframe.spec.ts.

const COEP = {
	"content-type": "text/html",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
};

const DROPDOWN = "#titanpass-autofill-dropdown";

const LOGIN = `<!doctype html><html><head><title>login</title></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
	<div id="feed"></div>
	<script>
		// A page that never stops rewriting itself, touching nothing field-shaped.
		window.__churn = function () {
			var feed = document.getElementById('feed');
			var timer = setInterval(function () {
				var row = document.createElement('div');
				row.className = 'item';
				row.innerHTML = '<span>' + Math.random() + '</span><b>x</b>';
				feed.append(row);
				if (feed.children.length > 40) feed.firstElementChild.remove();
			}, 16);
			return function () { clearInterval(timer); };
		};
	</script>
</body></html>`;

// An SPA that renders its login step later, into a container that starts empty.
const LATE_LOGIN = `<!doctype html><html><head><title>app</title></head><body>
	<div id="root"><p>Loading your account…</p></div>
	<script>
		window.__renderLogin = function () {
			document.getElementById('root').innerHTML =
				'<form><input id="user" name="username" type="text" autocomplete="username" />' +
				'<input id="pass" name="password" type="password" autocomplete="current-password" />' +
				'<button type="submit">Sign in</button></form>';
		};
	</script>
</body></html>`;

// The login form lives in an OPEN shadow root, the shape querySelectorAll cannot see
// (Reddit's faceplate-text-input, and any design system built on web components).
const SHADOW_LOGIN = `<!doctype html><html><head><title>login</title></head><body>
	<x-login></x-login>
	<script>
		customElements.define('x-login', class extends HTMLElement {
			connectedCallback() {
				this.attachShadow({ mode: 'open' }).innerHTML =
					'<form><input id="user" name="username" type="text" autocomplete="username" />' +
					'<input id="pass" name="password" type="password" autocomplete="current-password" />' +
					'<button type="submit">Sign in</button></form>';
			}
		});
	</script>
</body></html>`;

// Big, and busy: the comment box people complained about typing in sits on a page
// that is both huge and constantly rewriting itself. The churn is what makes each
// keystroke expensive, because it is what drops the cached field model.
const BIG_PAGE = `<!doctype html><html><head><title>comments</title></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
	</form>
	<textarea id="comment" rows="4" cols="60"></textarea>
	<div id="feed"></div>
	<div id="filler"></div>
	<script>
		var parts = [];
		for (var i = 0; i < 12000; i++) {
			parts.push('<div class="c"><span>comment ' + i + '</span><b>reply</b></div>');
		}
		document.getElementById('filler').innerHTML = parts.join('');
		window.__churn = function () {
			var feed = document.getElementById('feed');
			var timer = setInterval(function () {
				var row = document.createElement('div');
				row.className = 'item';
				row.innerHTML = '<span>' + Math.random() + '</span><b>x</b>';
				feed.append(row);
				if (feed.children.length > 40) feed.firstElementChild.remove();
			}, 16);
			return function () { clearInterval(timer); };
		};
	</script>
</body></html>`;

async function serve(page: Page, html: string, coep = true): Promise<void> {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: html, headers: coep ? COEP : { "content-type": "text/html" } })
				: route.fulfill({ status: 200, body: "" }),
		);
}

/**
 * Count AUTOFILL_QUERY messages arriving at the background. An extra
 * chrome.runtime.onMessage listener sees every message the router does and answers
 * none of them, so it observes the content script's re-query rate without changing it.
 */
async function watchQueries(context: BrowserContext): Promise<{
	reset: () => Promise<void>;
	count: () => Promise<number>;
}> {
	const sw = await backgroundWorker(context);
	await sw.evaluate(() => {
		(globalThis as unknown as { __queries: number }).__queries = 0;
		chrome.runtime.onMessage.addListener((message: { type?: string }) => {
			if (message?.type === "AUTOFILL_QUERY") {
				(globalThis as unknown as { __queries: number }).__queries += 1;
			}
		});
	});
	return {
		reset: () =>
			sw.evaluate(() => ((globalThis as unknown as { __queries: number }).__queries = 0)),
		count: () => sw.evaluate(() => (globalThis as unknown as { __queries: number }).__queries),
	};
}

/** A vault holding the example.com login, left unlocked. */
async function seededPopup(context: BrowserContext, extensionId: string): Promise<Page> {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	return popup;
}

/** The picker's iframe renderer, once it is up. */
async function pickerFrame(page: Page, field: string): Promise<Frame> {
	let frame: Frame | undefined;
	await expect(async () => {
		await page.locator(field).click();
		frame = page.frames().find((f) => f.url().includes("autofill-ui.html"));
		expect(frame).toBeDefined();
	}).toPass({ timeout: 20_000 });
	return frame as Frame;
}

test("a page that rewrites itself without touching a field never triggers a re-query", async ({
	context,
	extensionId,
}) => {
	await seededPopup(context, extensionId);
	const queries = await watchQueries(context);

	const page = await context.newPage();
	await serve(page, LOGIN);
	await page.goto("https://example.com/");
	// Let the load-time query land, then measure only what the churn causes.
	await expect.poll(queries.count, { timeout: 10_000 }).toBeGreaterThan(0);
	await queries.reset();

	const seconds = 4;
	await page.evaluate(() => {
		(window as unknown as { __stop: () => void }).__stop = (
			window as unknown as { __churn: () => () => void }
		).__churn();
	});
	await page.waitForTimeout(seconds * 1000);
	const churned = await page.evaluate(() => document.querySelectorAll("#feed .item").length);
	await page.evaluate(() => (window as unknown as { __stop: () => void }).__stop());

	// ~250 mutation batches. Before the fix this was one re-query every 500ms, each
	// preceded by a full-page scan; now the batches are recognised as page churn.
	expect(churned).toBeGreaterThan(0);
	expect(await queries.count()).toBe(0);

	// And the picker still works on a page that never stops mutating.
	await page.locator("#user").click();
	await expect(page.locator(DROPDOWN)).toBeAttached({ timeout: 10_000 });
});

test("a login form rendered after load is picked up", async ({ context, extensionId }) => {
	await seededPopup(context, extensionId);
	const queries = await watchQueries(context);

	const page = await context.newPage();
	await serve(page, LATE_LOGIN);
	await page.goto("https://example.com/");
	await page.waitForTimeout(1500);
	// Nothing fillable on the page yet, so nothing to ask about.
	await queries.reset();

	await page.evaluate(() => (window as unknown as { __renderLogin: () => void }).__renderLogin());

	// The batch that carried the form is field-shaped, so it must survive the filter.
	await expect.poll(queries.count, { timeout: 10_000 }).toBeGreaterThan(0);
	await page.locator("#user").click();
	await expect(page.locator(DROPDOWN)).toBeAttached({ timeout: 10_000 });
});

test("typing outside a field does not cost a page scan", async ({ context, extensionId }) => {
	await seededPopup(context, extensionId);

	const page = await context.newPage();
	await serve(page, BIG_PAGE);
	await page.goto("https://example.com/");
	await expect
		.poll(() => page.evaluate(() => document.querySelectorAll("*").length))
		.toBeGreaterThan(30_000);
	// The content script is injected at document_idle; let its first query settle so
	// the budget below covers the keystrokes only.
	await page.waitForTimeout(2000);

	await page.evaluate(() => {
		const state = window as unknown as {
			__blocked: number;
			__stop: () => void;
			__churn: () => () => void;
		};
		state.__blocked = 0;
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) state.__blocked += entry.duration;
		}).observe({ entryTypes: ["longtask"] });
		// The churn is load-bearing: it is what used to drop the cached field model,
		// leaving the next keystroke to rebuild it.
		state.__stop = state.__churn();
	});

	// Real keystrokes: the content script ignores untrusted input events.
	await page.locator("#comment").click();
	await page.keyboard.type("a comment long enough to be worth typing out");

	const blocked = await page.evaluate(() => {
		const state = window as unknown as { __blocked: number; __stop: () => void };
		state.__stop();
		return state.__blocked;
	});
	// Each of those keystrokes used to re-scan a 36k-element page: this fixture
	// measured 4,467ms of blocked main thread for one typed sentence. The target is
	// a textarea, which no rung can claim, so the model is never consulted now and
	// the run produces no long task at all. The budget is loose on purpose, well
	// under the regression and well over the noise.
	expect(blocked).toBeLessThan(1000);
	await expect(page.locator("#comment")).toHaveValue(
		"a comment long enough to be worth typing out",
	);
});

test("fills a login form rendered inside an open shadow root", async ({ context, extensionId }) => {
	await seededPopup(context, extensionId);

	const page = await context.newPage();
	// Served plainly: this one needs to click a row, so it needs the iframe renderer.
	await serve(page, SHADOW_LOGIN, false);
	await page.goto("https://example.com/");

	// Playwright pierces the open root, and so must the detector: a native
	// querySelectorAll stops at the boundary, which is why the page census exists.
	const user = page.locator("x-login #user");
	const pass = page.locator("x-login #pass");
	await expect(user).toBeAttached();

	const frame = await pickerFrame(page, "x-login #user");
	const row = frame.locator("[data-entry-id]");
	await expect(row).toBeVisible({ timeout: 10_000 });
	await expect(row).toContainText("alice@example.com");

	await row.click();
	await expect(user).toHaveValue("alice@example.com", { timeout: 10_000 });
	await expect(pass).toHaveValue("s3cr3t-pw-01");
});
