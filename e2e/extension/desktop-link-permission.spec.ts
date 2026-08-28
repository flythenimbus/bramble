import { expect, test } from "./fixtures";

// `nativeMessaging` is optional on Chromium and asked for when the user connects the desktop app,
// so the shipped default state is DECLARED BUT NOT HELD. Everything here runs in that state.
//
// This is a real browser rather than the unit tests' mock because the failure mode only exists in
// one: without the grant Chrome does not install `chrome.runtime.connectNative` at all, so calling
// it is a TypeError on an undefined property, not a rejected promise. A mocked `connectNative`
// cannot reproduce that, which is exactly how a browser could end up with a silently dead link.
//
// The grant itself is not testable here. `permissions.request()` raises native browser UI that
// Playwright cannot click, so the transition is covered by the unit tests and by the manual probe
// in docs/desktop-link-optional-permission.md.

test("ships without the nativeMessaging grant", async ({ context }) => {
	const [sw] = context.serviceWorkers();
	const state = await sw.evaluate(async () => ({
		binding: typeof chrome.runtime.connectNative,
		contains: await chrome.permissions.contains({ permissions: ["nativeMessaging"] }),
		declared: chrome.runtime.getManifest().optional_permissions ?? [],
	}));

	expect(state.declared).toContain("nativeMessaging");
	expect(state.contains).toBe(false);
	// The whole reason this file is an e2e test and not a unit test.
	expect(state.binding).toBe("undefined");
});

test("an unpaired, ungranted browser starts its worker cleanly", async ({ context }) => {
	const [sw] = context.serviceWorkers();
	const errors: string[] = [];
	sw.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});

	// A weak guard, deliberately labelled as one. background.ts calls openDesktopLink() at every
	// worker start, but on an UNPAIRED browser that returns at its loadState() check before it
	// reaches connectNative, so this cannot fail for the reason the file is about.
	//
	// The case that can is PAIRED WITHOUT THE GRANT: loadState() returns, ensureHeld() proceeds,
	// and `new NativeSession()` calls an undefined connectNative. That test belongs with the
	// phase-4 short-circuit that fixes it; asserting it here would only pin the bug in place.
	const alive = await sw.evaluate(async () => {
		await chrome.storage.local.get("desktopLink");
		return true;
	});

	expect(alive).toBe(true);
	expect(errors.join("\n")).not.toContain("connectNative");
});

test("an unpaired browser stores no link state", async ({ context }) => {
	const [sw] = context.serviceWorkers();
	// Pairing is the only thing that writes this key, and it cannot have run: there is no grant.
	// Guards the phase-4 short-circuit, which must not invent state it cannot use.
	const stored = await sw.evaluate(
		async () => (await chrome.storage.local.get("desktopLink")).desktopLink ?? null,
	);

	expect(stored).toBeNull();
});
