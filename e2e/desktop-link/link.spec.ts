import type { Page } from "@playwright/test";
import { createVault, optionsUrl } from "../extension/helpers";
import { BROWSER_PW, DESKTOP_ENTRY, DESKTOP_PW, desk, expect, RELAY_URL, test } from "./fixtures";
import {
	addLogin,
	browserOpenVaultAt,
	desktopAddLogin,
	desktopApprove,
	desktopConnect,
	desktopConnectedBrowsers,
	desktopCreateAnotherVault,
	desktopDisconnectAll,
	desktopEntryText,
	desktopHide,
	desktopListedBrowsers,
	desktopOpenVault,
	desktopSymbols,
	desktopUseLocalRelay,
	desktopVisible,
	isLocal,
	joinFromSetup,
	linkFromSettings,
	linkFromSetup,
} from "./steps";

// Linking the desktop app and the extension, both real, on one machine. docs/desktop-link-onboarding.md
// has the design; each test here is a flow that once failed when run this way.

test.skip(
	process.platform !== "darwin",
	"macOS only: the desktop app's keychain is isolated with macOS tools",
);
// One desktop app serves every test, so they run in order.
test.describe.configure({ mode: "serial" });

test("first run: links by emoji and takes the desktop's vault over the link", async ({ ext }) => {
	await desktopConnect();
	const shown = await linkFromSetup(ext.page);
	expect(await desktopSymbols()).toBe(shown);
	await ext.page.getByRole("button", { name: "They match" }).click();
	await desktopApprove();
	await expect(ext.page.getByText(/Enter the master password of Vault 1/)).toBeVisible();
	await joinFromSetup(ext.page);

	// The copy rode the link: the extension reached the relay only once the vault was here, and
	// nothing it did left this machine.
	const arrived = ext.watch.first("log", /vault received/);
	expect(arrived, "the joiner never reported the vault").toBeTruthy();
	const relay = ext.watch.first("net", /localhost:7400/);
	if (relay && arrived) expect(relay.t).toBeGreaterThanOrEqual(arrived.t);
	const away = ext.watch.seen.filter((s) => s.kind === "net" && !isLocal(s.text));
	expect(away.map((s) => s.text)).toEqual([]);
	expect(await ext.stored("sync.relay")).toBe(RELAY_URL);

	const popup = await ext.popup();
	await expect(popup.getByText(DESKTOP_ENTRY)).toBeVisible();

	// Ongoing sync starts on the link at once: an entry made on the desktop arrives.
	const name = `From the desktop ${Date.now().toString(36)}`;
	await desktopAddLogin(name);
	await expect(popup.getByText(name)).toBeVisible({ timeout: 30_000 });

	// The relay finds the desktop too, once per relay session, and must then leave it alone.
	// Forgetting the skip showed as the peer found again on its next announce (every 30 s), so
	// watch past one. Sync runs in the offscreen document; the worker repeats its status lines.
	const found = /peer \w+ found/;
	await expect.poll(() => ext.watch.count("log", found, "offscreen.html")).toBeGreaterThan(0);
	const firstFound = ext.watch.first("log", found)?.t ?? Date.now();
	await popup.waitForTimeout(Math.max(0, firstFound + 35_000 - Date.now()));
	expect(ext.watch.count("log", found, "offscreen.html")).toBeLessThanOrEqual(2);
});

test("settings: combines this browser's vault and its files into the desktop's", async ({
	ext,
}) => {
	await createVault(ext.page, ext.extensionId, BROWSER_PW);
	const popup = await ext.popup();
	await addLogin(popup, "Browser only");
	await popup.getByText("Browser only").first().click();
	await popup.locator('input[type="file"]').setInputFiles({
		name: "note.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("carried across\n"),
	});
	await expect(popup.getByText("note.txt")).toBeVisible();

	await desktopConnect();
	const shown = await linkFromSettings(popup);
	expect(await desktopSymbols()).toBe(shown);
	await popup.getByRole("button", { name: "They match" }).click();
	await desktopApprove();

	await expect(popup.getByText("You have two vaults")).toBeVisible();
	await popup.getByText("Combine into one").click();
	await popup.getByText("Keep a copy of this vault").click();
	await popup.getByLabel("Master password").last().fill(DESKTOP_PW);
	await popup.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(popup.getByText("This vault syncs with the desktop app.")).toBeVisible({
		timeout: 30_000,
	});

	// The browser now opens the desktop's vault with its own entry and file copied in, and keeps
	// its old vault set aside.
	await expect
		.poll(async () => {
			const registry = (await ext.stored("vault.registry")) as {
				vaults: { setAsideAt?: number }[];
			};
			return registry.vaults.filter((v) => v.setAsideAt).length;
		})
		.toBe(1);
	await popup.getByRole("button", { name: "Go to vault" }).click();
	await expect(popup.getByText(DESKTOP_ENTRY)).toBeVisible();
	await popup.getByText("Browser only").first().click();
	await expect(popup.getByText("note.txt")).toBeVisible();

	// And the copy reached the desktop over the link, file included.
	await expect
		.poll(() => desktopEntryText("Browser only"), { timeout: 30_000 })
		.toContain("note.txt");
});

test("approving and then leaving the screen links nothing", async ({ ext, desktop }) => {
	const before = desktop.linkedBrowsers();
	await desktopConnect();
	await linkFromSetup(ext.page);
	await desk(`
		await waitFor(() => /Check these match/.test(text()));
		await front();
		await click(/^Approve$/);
		await sleep(300);
		await click(/^Go to vault$/);
	`);
	await ext.page.getByRole("button", { name: "They match" }).click();

	await expect(ext.page.getByText("The desktop app did not approve the link.")).toBeVisible();
	expect(desktop.linkedBrowsers()).toBe(before);
	expect(await ext.stored("desktopLink")).toBeUndefined();
});

test("links again after backing out, and the second link still brings the vault", async ({
	ext,
}) => {
	await desktopConnect();
	await linkFromSetup(ext.page);
	await ext.page.getByRole("button", { name: "They match" }).click();
	await desktopApprove();
	await expect(ext.page.getByText(/Enter the master password of/)).toBeVisible();
	await ext.page.getByRole("button", { name: /back/i }).click();

	// A second link mints a new key. The vault has to come to that key, not the first one.
	await desktopConnect();
	const shown = await linkFromSetup(ext.page);
	expect(await desktopSymbols()).toBe(shown);
	await ext.page.getByRole("button", { name: "They match" }).click();
	await desktopApprove();
	await expect(ext.page.getByText(/Enter the master password of Vault 1/)).toBeVisible();
	await joinFromSetup(ext.page);
});

// A browser that grants the permission when it links, which is every first link in the shipped
// extension. Its background worker cannot open a native pipe until it restarts, so everything it
// says to the app rides a pipe a page lends it (see launchBrowser in fixtures.ts).
test.describe("granting the permission at link time", () => {
	test.use({ borrowsPipe: true });

	test("settings: an empty vault takes the desktop's, the browser confirming first", async ({
		ext,
	}) => {
		await createVault(ext.page, ext.extensionId, BROWSER_PW);
		const popup = await ext.popup();
		await desktopConnect();
		const shown = await linkFromSettings(popup);
		expect(await desktopSymbols()).toBe(shown);
		await popup.getByRole("button", { name: "They match" }).click();
		await expect(popup.getByText("Waiting for the desktop app…")).toBeVisible();
		await desktopApprove();

		// Settings asked for the app's key while the link flow asked for its vault. On one shared
		// pipe the app dropped both, and this said "The desktop app didn't send its vault."
		const offer = popup.locator("form").filter({ hasText: "Sync with the desktop app" });
		await expect(offer).toBeVisible();
		await offer.getByLabel("Master password").fill(DESKTOP_PW);
		await offer.getByRole("button", { name: "Sync", exact: true }).click();
		await expect(popup.getByText("This vault syncs with the desktop app.")).toBeVisible({
			timeout: 30_000,
		});
		await popup.getByRole("button", { name: "Go to vault" }).click();
		await expect(popup.getByText(DESKTOP_ENTRY)).toBeVisible();
	});

	test("first run: the app comes forward, approves first and waits for the browser", async ({
		ext,
	}) => {
		await desktopConnect();
		// The website's puzzle, and no code for an extension from before the emoji.
		const section = await desk<{ puzzle: boolean; text: string }>(`return {
			puzzle: [...document.querySelectorAll("svg > title")].some((t) => t.textContent === "Browser extension"),
			text: text(),
		};`);
		expect(section.puzzle).toBe(true);
		expect(section.text).not.toMatch(/older extension|Show a code/);

		// Whoever pressed Link is looking at the browser: the app has to come to them.
		await desktopHide();
		const shown = await linkFromSetup(ext.page);
		await expect.poll(desktopVisible, { timeout: 10_000 }).toBe(true);
		expect(await desktopSymbols()).toBe(shown);

		// Approve here first: the app says what it is waiting for, and the browser completes it.
		await desk("await click(/^Approve$/); await waitFor(() => /Waiting for .+…/.test(text()));");
		await ext.page.getByRole("button", { name: "They match" }).click();
		await expect(ext.page.getByText(/Enter the master password of Vault 1/)).toBeVisible();
		await expect
			.poll(() => desk<string>("return text();"), { timeout: 10_000 })
			.toMatch(/Waiting for .+ to finish linking/);
		// Listed, and connected, once the browser holds the vault.
		await joinFromSetup(ext.page);
		await expect
			.poll(() => desk<string>("return text();"), { timeout: 10_000 })
			.toMatch(/Connected to .+\. It is syncing this vault/);
		const popup = await ext.popup();
		await expect(popup.getByText(DESKTOP_ENTRY)).toBeVisible();
	});

	test("opening a window brings the link back at once, when the one that linked has closed", async ({
		ext,
	}) => {
		// This worker can never open a pipe, and replacing it takes a minute. A window can lend it one.
		await createVault(ext.page, ext.extensionId, BROWSER_PW);
		const linking = await ext.popup();
		await desktopConnect();
		const shown = await linkFromSettings(linking);
		expect(await desktopSymbols()).toBe(shown);
		await linking.getByRole("button", { name: "They match" }).click();
		await desktopApprove();
		const offer = linking.locator("form").filter({ hasText: "Sync with the desktop app" });
		await offer.getByLabel("Master password").fill(DESKTOP_PW);
		await offer.getByRole("button", { name: "Sync", exact: true }).click();
		await expect(linking.getByText("This vault syncs with the desktop app.")).toBeVisible({
			timeout: 30_000,
		});
		await linking.close();
		await ext.page.close();
		await expect.poll(desktopConnectedBrowsers, { timeout: 15_000 }).toBe(0);

		const again = await ext.popup();
		await expect.poll(desktopConnectedBrowsers, { timeout: 5_000 }).toBeGreaterThan(0);

		// Sync is back on it, both ways, in the time it takes to look.
		const name = `While the window is open ${Date.now().toString(36)}`;
		await desktopAddLogin(name);
		await again.getByRole("button", { name: "Go to vault" }).click();
		await expect(again.getByText(name)).toBeVisible({ timeout: 10_000 });
		await addLogin(again, "Made in the window");
		await expect
			.poll(() => desktopEntryText("Made in the window"), { timeout: 10_000 })
			.toContain("Made in the window");
	});
});

test.describe("an empty desktop vault, linked from a browser vault that holds something", () => {
	test.use({ borrowsPipe: true });

	test("copies into it with no choice to make, and all of it stays when the popup reopens", async ({
		ext,
	}) => {
		await desktopCreateAnotherVault("Test 1");
		await desktopUseLocalRelay();
		await createVault(ext.page, ext.extensionId, BROWSER_PW);
		const popup = await ext.popup();
		await addLogin(popup, "Browser only");
		await popup.getByText("Browser only").first().click();
		await popup.locator('input[type="file"]').setInputFiles({
			name: "note.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("carried across\n"),
		});
		await expect(popup.getByText("note.txt")).toBeVisible();
		// Named, so nothing of this vault's may land on the one the link opens.
		await popup.getByRole("button", { name: "Settings" }).click();
		await popup.getByRole("button", { name: "General", exact: true }).click();
		await popup.getByLabel("Vault name").fill("Personal");
		await popup.getByLabel("Vault name").blur();
		await expect(popup.getByTestId("active-vault-label")).toHaveText("Personal");

		await desktopConnect();
		const shown = await linkFromSettings(popup);
		expect(await desktopSymbols()).toBe(shown);
		await popup.getByRole("button", { name: "They match" }).click();
		await desktopApprove();

		const offer = popup.locator("form").filter({ hasText: "Sync with the desktop app" });
		await expect(offer.getByRole("radio")).toHaveCount(0);
		await expect(
			offer.getByRole("checkbox", { name: "Keep a copy of this vault" }),
		).not.toBeChecked();
		await offer.getByLabel("Master password").fill(DESKTOP_PW);
		await offer.getByRole("button", { name: "Sync", exact: true }).click();
		await expect(popup.getByText("This vault syncs with the desktop app.")).toBeVisible({
			timeout: 30_000,
		});

		const inVault = async (page: Page) => {
			await page.getByRole("button", { name: "Go to vault" }).click();
			await expect(page.getByText("Browser only").first()).toBeVisible();
			await expect(page.getByTestId("active-vault-label")).toHaveText("Test 1");
		};
		await inVault(popup);
		await expect
			.poll(() => desktopEntryText("Browser only"), { timeout: 30_000 })
			.toContain("note.txt");

		// A named vault used to lose everything here: the reopened popup published its name over an
		// empty snapshot, and with the link down on a worker like this one, nothing brought it back.
		await popup.close();
		const again = await ext.popup();
		await inVault(again);
		await again.getByText("Browser only").first().click();
		await expect(again.getByText("note.txt")).toBeVisible();

		// With nothing asked, the old vault goes: all of it is in this one now, and nothing of it stays.
		const registry = (await ext.stored("vault.registry")) as { vaults: { label: string }[] };
		expect(registry.vaults.map((v) => v.label)).toEqual(["Test 1"]);
		expect(await ext.storedKeys("vault-blob-b64:")).toHaveLength(1);
		// Back to the vault the rest of the suite expects open.
		await desktopOpenVault("Vault 1");
	});
});

// Last: it leaves the desktop with a second vault.
test("a browser is linked to the vault that was open, not to every vault", async ({ ext }) => {
	await desktopConnect();
	await linkFromSetup(ext.page);
	await ext.page.getByRole("button", { name: "They match" }).click();
	await desktopApprove();
	await expect(ext.page.getByText(/Enter the master password of Vault 1/)).toBeVisible();
	// Listed once the browser holds the vault, not before.
	await joinFromSetup(ext.page);
	const linked = await desktopListedBrowsers();
	expect(linked).toBeGreaterThan(0);

	// A vault made after the link lists none of the browsers linked to another.
	await desktopCreateAnotherVault("Second");
	expect(await desktopListedBrowsers()).toBe(0);

	await desktopOpenVault("Vault 1");
	expect(await desktopListedBrowsers()).toBe(linked);
});

// Piece 3: one browser vault, one desktop vault. After the tests above, the desktop holds Vault 1
// (open), Test 1 and Second. docs/desktop-link-onboarding.md has the rule.
test.describe("a link per vault", () => {
	/** Link from the open setup screen and take the desktop's vault into a new browser vault. */
	async function linkAndJoin(ext: { page: Page }) {
		await desktopConnect();
		await linkFromSetup(ext.page);
		await ext.page.getByRole("button", { name: "They match" }).click();
		await desktopApprove();
		await joinFromSetup(ext.page);
	}

	test("two pairs in one browser profile, and nothing crosses between them", async ({ ext }) => {
		// ext-a with Vault 1.
		await linkAndJoin(ext);
		const first = await ext.storedKeys("desktopLink:");
		expect(first).toHaveLength(1);

		// A link to Second abandoned at the copy step leaves nothing on either side.
		await desktopOpenVault("Second");
		await ext.page.goto(optionsUrl(ext.extensionId));
		await desktopConnect();
		await linkFromSetup(ext.page);
		await ext.page.getByRole("button", { name: "They match" }).click();
		await desktopApprove();
		await expect(ext.page.getByText(/Enter the master password of Second/)).toBeVisible();
		await ext.page.getByRole("button", { name: /back/i }).click();
		expect(await ext.storedKeys("desktopLink:")).toEqual(first);
		expect(await desktopListedBrowsers()).toBe(0);

		// ext-b with Second, made from the browser's Add a vault screen. ext-a's link is untouched.
		await linkAndJoin(ext);
		const both = await ext.storedKeys("desktopLink:");
		expect(both).toHaveLength(2);
		expect(both).toEqual(expect.arrayContaining(first));
		const popup = await ext.popup();
		const inSecond = `In Second ${Date.now().toString(36)}`;
		await desktopAddLogin(inSecond);
		await expect(popup.getByText(inSecond)).toBeVisible({ timeout: 30_000 });

		// ext-b open in the browser, Vault 1 open in the app: not a pair, so no link at all, and
		// nothing (sync, fills) can reach the browser.
		await desktopOpenVault("Vault 1");
		await expect.poll(desktopConnectedBrowsers, { timeout: 30_000 }).toBe(0);

		// Open ext-a in the browser: its own link comes back, and Vault 1's entries arrive.
		await browserOpenVaultAt(popup, 0);
		const inFirst = `In Vault 1 ${Date.now().toString(36)}`;
		await desktopAddLogin(inFirst);
		await expect(popup.getByText(inFirst)).toBeVisible({ timeout: 30_000 });
		await expect(popup.getByText(inSecond)).not.toBeVisible();
	});

	test("a browser removed on the desktop drops its link", async ({ ext }) => {
		await linkAndJoin(ext);
		expect(await ext.storedKeys("desktopLink:")).toHaveLength(1);

		await desktopDisconnectAll();
		expect(await desktopListedBrowsers()).toBe(0);
		// Its connection goes at once, rather than at its next frame.
		await expect.poll(desktopConnectedBrowsers, { timeout: 10_000 }).toBe(0);

		// Told at its next connect (the keepalive, every 20 s) that nothing here is linked to it.
		await expect.poll(() => ext.storedKeys("desktopLink:"), { timeout: 45_000 }).toEqual([]);
	});

	test("two browser profiles both pair with one desktop vault", async ({ ext, ext2 }) => {
		await linkAndJoin(ext);
		await linkAndJoin(ext2);

		expect(await ext.storedKeys("desktopLink:")).toHaveLength(1);
		expect(await ext2.storedKeys("desktopLink:")).toHaveLength(1);
		expect(await desktopListedBrowsers()).toBe(2);
	});
});
