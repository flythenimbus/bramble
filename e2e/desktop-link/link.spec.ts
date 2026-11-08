import type { Page } from "@playwright/test";
import { createVault, optionsUrl } from "../extension/helpers";
import { basicAuth, fakeWebDav } from "./fake-webdav";
import {
	BROWSER_PW,
	type Browser,
	DESKTOP_ENTRY,
	DESKTOP_PW,
	desk,
	expect,
	RELAY_URL,
	test,
} from "./fixtures";
import {
	addLogin,
	addWebDavTarget,
	browserOpenVaultAt,
	desktopAddLogin,
	desktopAliasDomain,
	desktopApprove,
	desktopConnect,
	desktopConnectedBrowsers,
	desktopCreateAnotherVault,
	desktopEntryText,
	desktopHide,
	desktopListedBrowsers,
	desktopOpenVault,
	desktopRemoveBrowsers,
	desktopSeedBackupTarget,
	desktopSetAliasDomain,
	desktopSymbols,
	desktopSyncRows,
	desktopUseLocalRelay,
	desktopVisible,
	isLocal,
	joinFromSetup,
	linkFromSettings,
	linkFromSetup,
	setAliasDomain,
} from "./steps";

// Linking the desktop app and the extension, both real, on one machine. docs/desktop-link-onboarding.md
// has the design; each test here is a flow that once failed when run this way.

test.skip(
	process.platform !== "darwin",
	"macOS only: the desktop app's keychain is isolated with macOS tools",
);
// One desktop app serves every test, so they run in order.
test.describe.configure({ mode: "serial" });

/** The vault a combine copied out: off the list, still whole on disk, with nothing asked. */
async function expectOldVaultHidden(ext: Browser): Promise<void> {
	await expect
		.poll(async () => {
			const { vaults } = (await ext.stored("vault.registry")) as { vaults: { hidden?: unknown }[] };
			return [vaults.length, vaults.filter((v) => v.hidden).length];
		})
		.toEqual([2, 1]);
	expect(await ext.storedKeys("vault-blob-b64:")).toHaveLength(2);
}

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
	await popup.getByLabel("Master password").last().fill(DESKTOP_PW);
	await popup.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(popup.getByText("This vault syncs with the desktop app.")).toBeVisible({
		timeout: 30_000,
	});

	// All of it came across: the old vault is off the list, still on disk, and nothing is asked.
	await expectOldVaultHidden(ext);
	await expect(popup.getByRole("dialog")).toHaveCount(0);
	await expect(popup.getByText(/before linking/)).toHaveCount(0);

	await popup.getByRole("button", { name: "Go to vault" }).click();
	await expect(popup.getByText(DESKTOP_ENTRY)).toBeVisible();
	await popup.getByText("Browser only").first().click();
	await expect(popup.getByText("note.txt")).toBeVisible();

	// And the copy reached the desktop over the link, file included.
	await expect
		.poll(() => desktopEntryText("Browser only"), { timeout: 30_000 })
		.toContain("note.txt");
});

test("settings: an entry on both sides keeps what the browser's copy held, and the old vault is hidden", async ({
	ext,
}) => {
	const both = { username: "both@example.com", password: "Both-sides-pw-321" };
	await desktopAddLogin("On both sides", both);
	await createVault(ext.page, ext.extensionId, BROWSER_PW);
	const popup = await ext.popup();
	await addLogin(popup, "On both sides", { ...both, tag: "from-browser" });

	await desktopConnect();
	const shown = await linkFromSettings(popup);
	expect(await desktopSymbols()).toBe(shown);
	await popup.getByRole("button", { name: "They match" }).click();
	await desktopApprove();

	await expect(popup.getByText("You have two vaults")).toBeVisible();
	await popup.getByText("Combine into one").click();
	await popup.getByLabel("Master password").last().fill(DESKTOP_PW);
	await popup.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(popup.getByText("This vault syncs with the desktop app.")).toBeVisible({
		timeout: 30_000,
	});

	await expectOldVaultHidden(ext);
	await expect(popup.getByRole("dialog")).toHaveCount(0);

	// One entry, with the tag, here and on the desktop.
	await popup.getByRole("button", { name: "Go to vault" }).click();
	await expect(popup.getByText("On both sides")).toHaveCount(1);
	await popup.getByText("On both sides").click();
	await expect(popup.getByText("from-browser")).toBeVisible();
	await expect
		.poll(() => desktopEntryText("On both sides"), { timeout: 30_000 })
		.toContain("from-browser");
});

for (const [copied, copies] of [
	[true, 2],
	[false, 1],
] as const) {
	test(`settings: a look-alike ${copied ? "copied" : "left out"}, and the old vault hidden`, async ({
		ext,
	}) => {
		// Its own name per run: one desktop vault serves both, and an exact copy of the first run's
		// would be dropped without asking.
		const name = `Looks alike ${copies}`;
		const both = { username: "alike@example.com", password: "Alike-pw-321" };
		await desktopAddLogin(name, both);
		await createVault(ext.page, ext.extensionId, BROWSER_PW);
		const popup = await ext.popup();
		await addLogin(popup, name, { ...both, notes: "only in the browser" });
		await popup.getByText(name).first().click();
		await popup.locator('input[type="file"]').setInputFiles({
			name: "held.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("held back\n"),
		});
		await expect(popup.getByText("held.txt")).toBeVisible();

		await desktopConnect();
		const shown = await linkFromSettings(popup);
		expect(await desktopSymbols()).toBe(shown);
		await popup.getByRole("button", { name: "They match" }).click();
		await desktopApprove();

		await expect(popup.getByText("You have two vaults")).toBeVisible();
		await popup.getByText("Combine into one").click();
		await popup.getByLabel("Master password").last().fill(DESKTOP_PW);
		await popup.getByRole("button", { name: "Continue", exact: true }).click();
		const warning = popup.getByText(/1 entry looks like one .* so it wasn't copied\./);
		await expect(warning).toBeVisible({ timeout: 30_000 });
		await expect(popup.getByRole("button", { name: /delete/i })).toHaveCount(0);
		await expectOldVaultHidden(ext);

		if (copied) {
			await popup.getByRole("button", { name: "Copy them anyway" }).click();
			await expect(warning).toHaveCount(0);
		}
		await popup.getByRole("button", { name: "Done" }).click();
		await expect(popup.getByRole("dialog")).toHaveCount(0);
		await expectOldVaultHidden(ext);

		await popup.getByRole("button", { name: "Go to vault" }).click();
		await expect(popup.getByText(name)).toHaveCount(copies);
		if (copied) {
			// Its file came too, though the old vault's key was dropped before the copy was asked for.
			const found: number[] = [];
			for (const i of [0, 1]) {
				await popup.getByText(name).nth(i).click();
				await popup.waitForTimeout(300);
				found.push(await popup.getByText("held.txt").count());
				await popup.getByRole("button", { name: "Go to vault" }).click();
			}
			expect(found.reduce((a, b) => a + b)).toBeGreaterThan(0);
		}
	});
}

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
		await offer.getByLabel("Master password").fill(DESKTOP_PW);
		await offer.getByRole("button", { name: "Sync", exact: true }).click();
		await expect(popup.getByText("This vault syncs with the desktop app.")).toBeVisible({
			timeout: 30_000,
		});

		await expectOldVaultHidden(ext);

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

		// All of it is in this one now. The old vault is off the list, and nothing deleted it.
		const registry = (await ext.stored("vault.registry")) as {
			vaults: { label: string; hidden?: unknown }[];
		};
		expect(registry.vaults.filter((v) => !v.hidden).map((v) => v.label)).toEqual(["Test 1"]);
		await expectOldVaultHidden(ext);
		// Back to the vault the rest of the suite expects open.
		await desktopOpenVault("Vault 1");
	});
});

test.describe("a combine copies what the disk holds, not what the window does", () => {
	test.use({ borrowsPipe: true });

	/** Combine into a new desktop vault, as far as the old vault leaving the list. */
	const combineInto = async (
		ext: Browser,
		title: string,
		{ seenHere = true, savedElsewhere = false } = {},
	) => {
		await desktopCreateAnotherVault(title);
		await desktopUseLocalRelay();
		await createVault(ext.page, ext.extensionId, BROWSER_PW);
		const popup = await ext.popup();
		if (seenHere) await addLogin(popup, "Browser only");
		if (savedElsewhere) {
			// A window's save reaches no other window's memory.
			const other = await ext.popup();
			await addLogin(other, "Saved elsewhere");
			await other.close();
		}

		await desktopConnect();
		const shown = await linkFromSettings(popup);
		expect(await desktopSymbols()).toBe(shown);
		await popup.getByRole("button", { name: "They match" }).click();
		await desktopApprove();
		const offer = popup.locator("form").filter({ hasText: "Sync with the desktop app" });
		await offer.getByLabel("Master password").fill(DESKTOP_PW);
		await offer.getByRole("button", { name: "Sync", exact: true }).click();
		await expect(popup.getByText("This vault syncs with the desktop app.")).toBeVisible({
			timeout: 30_000,
		});
		await expectOldVaultHidden(ext);
		return popup;
	};

	test("a login saved in another window comes across", async ({ ext }) => {
		const popup = await combineInto(ext, "Two windows", { savedElsewhere: true });

		await popup.getByRole("button", { name: "Go to vault" }).click();
		await expect(popup.getByText("Browser only").first()).toBeVisible();
		await expect(popup.getByText("Saved elsewhere").first()).toBeVisible();
		await expect
			.poll(() => desktopEntryText("Saved elsewhere"), { timeout: 30_000 })
			.toContain("Saved elsewhere");
		await desktopOpenVault("Vault 1");
	});

	test("a window that thinks its vault is empty still combines what the disk holds", async ({
		ext,
	}) => {
		const popup = await combineInto(ext, "Looks empty", {
			seenHere: false,
			savedElsewhere: true,
		});

		await popup.getByRole("button", { name: "Go to vault" }).click();
		await expect(popup.getByText("Saved elsewhere").first()).toBeVisible();
		await desktopOpenVault("Vault 1");
	});
});

test.describe("the alias provider and backup targets of a vault combined in", () => {
	const USER = "browser-user";
	const SECRET = "browser-dav-secret";
	/** The vault the combine opened, which the old one's hidden record sits beside. */
	const openVaultId = async (ext: { stored(key: string): Promise<unknown> }) =>
		(
			(await ext.stored("vault.registry")) as { vaults: { id: string; hidden?: unknown }[] }
		).vaults.find((v) => !v.hidden)?.id;
	/** Link from Settings as far as the desktop's vault arriving, the box as asked. */
	const linkAndCombine = async (popup: Page, { ask = false } = {}) => {
		await desktopConnect();
		const shown = await linkFromSettings(popup);
		expect(await desktopSymbols()).toBe(shown);
		await popup.getByRole("button", { name: "They match" }).click();
		await desktopApprove();
		if (ask) {
			await expect(popup.getByText("You have two vaults")).toBeVisible();
			await popup.getByText("Combine into one").click();
		}
		await popup.getByLabel("Master password").last().fill(DESKTOP_PW);
		// Settings has a tab called Sync too.
		const offer = popup.locator("form").filter({ hasText: "Sync with the desktop app" });
		await (ask
			? popup.getByRole("button", { name: "Continue", exact: true })
			: offer.getByRole("button", { name: "Sync", exact: true })
		).click();
		await expect(popup.getByText("This vault syncs with the desktop app.")).toBeVisible({
			timeout: 30_000,
		});
	};

	test("settings: both come across to a desktop vault with neither, and the backup runs on the new key", async ({
		ext,
	}) => {
		const dav = await fakeWebDav();
		try {
			await desktopCreateAnotherVault("Has neither");
			await desktopUseLocalRelay();
			await createVault(ext.page, ext.extensionId, BROWSER_PW);
			const popup = await ext.popup();
			await addLogin(popup, "Browser only");
			await setAliasDomain(popup, "mine.example");
			await addWebDavTarget(popup, { url: dav.url, user: USER, password: SECRET });

			await linkAndCombine(popup);

			// All of it came across, so nothing is said about either, or at all.
			await expectOldVaultHidden(ext);
			await expect(popup.getByRole("dialog")).toHaveCount(0);
			await expect(popup.getByText(/email alias provider/)).toHaveCount(0);
			await expect(popup.getByText(/backup target/)).toHaveCount(0);

			await popup.getByRole("button", { name: "Aliases", exact: true }).click();
			await expect(popup.getByLabel("Your domain")).toHaveValue("mine.example");

			// The old vault's key is gone. A snapshot stamped with this vault, sent with the password
			// the target was given, means it was sealed under the new one.
			await popup.getByRole("button", { name: "Backups", exact: true }).click();
			await popup.getByRole("button", { name: "Back up now" }).click();
			const stamp = `-v${(await openVaultId(ext))?.replace(/-/g, "").slice(0, 8)}.bramble`;
			await expect
				.poll(() => dav.snapshots().filter((name) => name.endsWith(stamp)).length, {
					timeout: 30_000,
				})
				.toBeGreaterThan(0);
			expect(dav.auths()).toEqual([basicAuth(USER, SECRET)]);

			// The provider is a synced setting, so it reached the desktop over the link.
			await expect.poll(() => desktopAliasDomain(), { timeout: 30_000 }).toBe("mine.example");
		} finally {
			await dav.close();
		}
		await desktopOpenVault("Vault 1");
	});

	test("settings: neither comes across to a desktop vault with its own, and the dialog says so", async ({
		ext,
	}) => {
		const dav = await fakeWebDav();
		try {
			await desktopCreateAnotherVault("Has both");
			await desktopUseLocalRelay();
			await desktopSetAliasDomain("theirs.example");
			await desktopSeedBackupTarget("Has both");
			await createVault(ext.page, ext.extensionId, BROWSER_PW);
			const popup = await ext.popup();
			await addLogin(popup, "Browser only");
			await setAliasDomain(popup, "mine.example");
			await addWebDavTarget(popup, { url: dav.url, user: USER, password: SECRET });

			await linkAndCombine(popup, { ask: true });

			// Both say so, and the old vault is off the list all the same.
			await expect(popup.getByText(/has its own email alias provider/)).toBeVisible();
			await expect(popup.getByText(/already has a backup target/)).toBeVisible();
			await expect(popup.getByRole("button", { name: /delete/i })).toHaveCount(0);
			await expectOldVaultHidden(ext);
			await popup.getByRole("button", { name: "Done" }).click();

			// The desktop's own stand, on both sides, and the vault it opened here has no target.
			expect(await ext.storedKeys(`backup.targets:${await openVaultId(ext)}`)).toEqual([]);
			await popup.getByRole("button", { name: "Aliases", exact: true }).click();
			await expect(popup.getByLabel("Your domain")).toHaveValue("theirs.example");
			expect(await desktopAliasDomain()).toBe("theirs.example");
		} finally {
			await dav.close();
		}
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

	test("a browser shows once on the desktop, and removing it there ends its sync and its link", async ({
		ext,
	}) => {
		// Earlier tests leave browsers on this vault: count from here.
		const before = await desktopSyncRows();
		await linkAndJoin(ext);
		expect(await ext.storedKeys("desktopLink:")).toHaveLength(1);
		// Once it syncs over the link, it is listed with the other devices and not again.
		await expect
			.poll(async () => (await desktopSyncRows()).devices, { timeout: 30_000 })
			.toBe(before.devices + 1);
		await expect
			.poll(async () => (await desktopSyncRows()).browsers, { timeout: 30_000 })
			.toBe(before.browsers);

		await desktopRemoveBrowsers();
		expect(await desktopSyncRows()).toEqual({ browsers: 0, devices: 0 });
		await expect.poll(desktopListedBrowsers, { timeout: 10_000 }).toBe(0);
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
