import { createVault } from "../extension/helpers";
import { BROWSER_PW, DESKTOP_ENTRY, DESKTOP_PW, desk, expect, RELAY_URL, test } from "./fixtures";
import {
	addLogin,
	desktopAddLogin,
	desktopApprove,
	desktopConnect,
	desktopEntryText,
	desktopSymbols,
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
	await popup.getByLabel("Master password").last().fill(DESKTOP_PW);
	await popup.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(popup.getByText("This vault syncs with the desktop app.")).toBeVisible({
		timeout: 30_000,
	});

	// The browser now opens the desktop's vault with its own entry and file copied in, and keeps
	// its old vault set aside.
	const registry = (await ext.stored("vault.registry")) as { vaults: { setAsideAt?: number }[] };
	expect(registry.vaults.filter((v) => v.setAsideAt)).toHaveLength(1);
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
