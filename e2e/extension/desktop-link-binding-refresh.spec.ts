import { expect, test } from "./fixtures";

// Why the desktop link pairs in a reloaded pop-out instead of in the background.
//
// Chromium fixes a context's API bindings when the context is CREATED. Granting an optional
// permission at runtime does not retro-fit them, so the service worker that owns the native port
// never gains `chrome.runtime.connectNative`, and neither does the page that asked for the grant.
// Only a context created afterwards has it. That single fact is what forces the page-side pairing
// path in packages/platform-extension/src/desktop-link.ts; see
// docs/desktop-link-optional-permission.md.
//
// This is not a security gate. If Chromium ever starts refreshing bindings, nothing breaks: the
// workaround is strictly more conservative than it would need to be. This exists so a future
// maintainer can answer "is that workaround still necessary?" with one command instead of a
// research session, and delete it when the answer is no.
//
// THIS TEST NEEDS A HUMAN. It is a manual probe wearing a spec's clothes, and it CANNOT be
// automated. `permissions.request()` raises a native browser dialog: headless cannot draw one, so
// the call hangs forever with nothing to catch, and headed shows a real prompt that somebody has
// to click Allow on. Playwright cannot reach either. So it is opt-in through its own variable
// rather than HEADED, which is the general debugging switch and would otherwise hang any run that
// used it.
//
//   MANUAL_GRANT=1 HEADED=1 pnpm exec playwright test e2e/extension/desktop-link-binding-refresh.spec.ts
//
// Last confirmed by hand: Google Chrome for Testing 151.0.7922.34, Brave 151.1.93.138.

test("a runtime grant reaches only contexts created after it", async ({ context, extensionId }) => {
	test.skip(
		!process.env.MANUAL_GRANT || !process.env.HEADED,
		"needs MANUAL_GRANT=1 HEADED=1 and a human to click Allow on the permission prompt",
	);

	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/popup.html`);

	// A real Playwright click is a trusted user gesture, which permissions.request() requires.
	await page.evaluate(() => {
		const btn = document.createElement("button");
		btn.id = "grant-probe";
		btn.style.cssText = "position:fixed;inset:0;z-index:99999";
		(window as unknown as { __outcome: Promise<unknown> }).__outcome = new Promise((resolve) => {
			btn.addEventListener("click", () => {
				chrome.permissions
					.request({ permissions: ["nativeMessaging"] })
					.then((granted) => resolve({ state: "resolved", granted }))
					.catch((e) => resolve({ state: "rejected", error: String(e) }));
			});
		});
		document.body.appendChild(btn);
	});
	await page.click("#grant-probe");

	const outcome = (await Promise.race([
		page.evaluate(() => (window as unknown as { __outcome: Promise<unknown> }).__outcome),
		new Promise((r) => setTimeout(() => r({ state: "never-settled" }), 90_000)),
	])) as { state: string; granted?: boolean };

	// Say which of the two it was, because "expected resolved, got never-settled" reads as a
	// product bug when it almost always means nobody was watching the window.
	expect(
		outcome,
		outcome.state === "never-settled"
			? "the prompt was never answered: this test needs a human to click Allow within 90s"
			: "the browser refused the grant",
	).toEqual({ state: "resolved", granted: true });

	const worker = await context.serviceWorkers()[0].evaluate(async () => ({
		binding: typeof chrome.runtime.connectNative,
		contains: await chrome.permissions.contains({ permissions: ["nativeMessaging"] }),
	}));
	const requester = await page.evaluate(() => typeof chrome.runtime.connectNative);

	const fresh = await context.newPage();
	await fresh.goto(`chrome-extension://${extensionId}/popup.html`);
	const freshBinding = await fresh.evaluate(() => typeof chrome.runtime.connectNative);

	// The worker KNOWS it holds the permission and still cannot call the API. That gap is the
	// whole problem, and asserting both halves is what makes the failure legible if it changes.
	expect(worker.contains).toBe(true);
	expect(worker.binding).toBe("undefined");
	// Not even the page that asked for it.
	expect(requester).toBe("undefined");
	// A context born after the grant. The only place pairing can run.
	expect(freshBinding).toBe("function");
});
