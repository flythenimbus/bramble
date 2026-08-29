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

// The regression this whole phase exists for, and the one the unit tests structurally cannot
// catch. A browser that PAIRED while it held the permission, and no longer holds it: the stored
// link state loads, so every early return that keys off "not paired" is passed, and the next step
// is a connectNative that Chrome never installed. In a mock that is a stubbed function; here it is
// genuinely undefined, so an ungated path throws a TypeError into whatever was awaiting it and the
// link dies with nothing said.
test("a paired browser that lost the grant fails in words, not a TypeError", async ({
	context,
	extensionId,
}) => {
	const [sw] = context.serviceWorkers();
	await sw.evaluate(() => {
		// Real 32-byte base64 keys, not placeholders. Junk here dies in the offscreen crypto on
		// its way to the handshake, which would make this pass for a reason that has nothing to do
		// with the permission.
		const key = btoa(String.fromCharCode(...new Uint8Array(32)));
		return chrome.storage.local.set({
			desktopLink: { privateKey: key, publicKey: key, appPublicKey: key, pairedAt: 1 },
		});
	});

	const errors: string[] = [];
	sw.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});

	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/popup.html`);
	const ask = (type: string) =>
		page.evaluate((t) => chrome.runtime.sendMessage({ type: t }), type) as Promise<{
			ok: boolean;
			data?: unknown;
		}>;

	// Paired and unpermitted are independent facts, and the UI needs both to say which of the two
	// unhappy states this is.
	expect(await ask("DESKTOP_LINK_STATUS")).toEqual({
		ok: true,
		data: { paired: true, pairedAt: 1, permitted: false },
	});
	// A refusal, not a rejection and not a crash.
	expect(await ask("DESKTOP_LINK_CONNECT")).toEqual({ ok: true, data: false });
	expect(errors.join("\n")).not.toContain("connectNative");
});
