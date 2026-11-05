import type { Page } from "@playwright/test";
import { DESKTOP_PW, desk, expect } from "./fixtures";

// The moves a person makes on each screen. Desktop steps run in its window through the bridge;
// browser steps are ordinary Playwright on the extension's pages.

/**
 * The emoji and their digits as one comparable string, from either screen's text. Matched on
 * the characters rather than the lines, since the desktop's text may come without line breaks
 * (see the bridge prelude in fixtures.ts).
 */
export function symbolsIn(text: string): string {
	const m = /Check these match([\s\S]*?)Compare this instead: (\d{4} \d{4} \d{4})/.exec(text);
	const emoji = m?.[1]?.match(/\p{Extended_Pictographic}/gu);
	if (!m || !emoji) throw new Error(`no symbols on screen:\n${text.slice(0, 400)}`);
	return `${emoji.join(" ")} | ${m[2]}`;
}

// ---- desktop ----

/** Settings > Sync > Connect a browser, past the master-password gate, to the open link window. */
export async function desktopConnect(): Promise<void> {
	await desk(`
		await front();
		if (!find(/^Connect a browser$/, "p,span,div")) { await click(/^Settings$/); await click(/^Sync$/); }
		await click(/^Connect$/);
		await waitFor(() => find(/Confirm it.s you/, "h2"));
		await fillPasswords(${JSON.stringify(DESKTOP_PW)});
		await click(/^Continue$/);
		await waitFor(() => /press Link on the first screen/.test(text()));
	`);
}

/** The symbols the desktop shows for a link waiting on it. */
export async function desktopSymbols(): Promise<string> {
	return symbolsIn(
		await desk<string>("await waitFor(() => /Check these match/.test(text())); return text();"),
	);
}

export async function desktopApprove(): Promise<void> {
	await desk("await front(); await click(/^Approve$/);");
}

/** Whether the vault window is on screen, read without bringing it forward. */
export async function desktopVisible(): Promise<boolean> {
	return desk<boolean>(
		`return await window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" });`,
	);
}

/** Put the vault window away, as its close button does. */
export async function desktopHide(): Promise<void> {
	await desk(`await window.__TAURI_INTERNALS__.invoke("hide_to_tray");`);
	await expect.poll(desktopVisible).toBe(false);
}

/** The browsers the open vault's Settings lists as linked to it. */
export async function desktopListedBrowsers(): Promise<number> {
	return desk<number>(`
		await front();
		if (!find(/^Connect a browser$/, "p,span,div")) { await click(/^Settings$/); await click(/^Sync$/); }
		await waitFor(() => find(/^Connect a browser$/, "p,span,div"));
		await sleep(500);
		return [...document.querySelectorAll("button")]
			.filter(visible)
			.filter((b) => b.getAttribute("aria-label") === "Disconnect this browser").length;
	`);
}

/** Lock, then make another vault from the unlock screen; it opens empty. */
export async function desktopCreateAnotherVault(name: string): Promise<void> {
	await desk(`
		await front();
		await click(/^Lock vault$/);
		await click(/^Create another vault$/);
		await fill("#vault-name", ${JSON.stringify(name)});
		await fillPasswords(${JSON.stringify(DESKTOP_PW)});
		await click(/^Create vault$/);
		await click(/I've saved it/);
		await waitFor(() => find(/^Add New$/));
	`);
}

/** Lock, then unlock the vault titled `title` from the unlock screen's list. */
export async function desktopOpenVault(title: string): Promise<void> {
	await desk(`
		await front();
		await click(/^Lock vault$/);
		await click(/^Choose a different vault$/);
		// Each row reads initials, title, then the date it was made.
		await click(new RegExp(${JSON.stringify(title)}));
		await fillPasswords(${JSON.stringify(DESKTOP_PW)});
		await click(/^Unlock Vault$/);
		await waitFor(() => find(/^Add New$/));
	`);
}

export async function desktopGoToVault(): Promise<void> {
	await desk("await front(); await click(/^Go to vault$/);");
}

export async function desktopAddLogin(name: string): Promise<void> {
	await desk(`
		await front();
		await click(/^Go to vault$/);
		await click(/^Add New$/);
		await click(/^Login/);
		await fill("input[name=name]", ${JSON.stringify(name)});
		await fill("input[name=username]", "desk@example.com");
		await fill('input[type="password"]', "Desk-made-pw-789");
		await click(/^Save Login$/);
		await waitFor(() => text().includes(${JSON.stringify(name)}));
	`);
}

/** The text of an entry's page on the desktop, or "" while it has not arrived. */
export async function desktopEntryText(name: string): Promise<string> {
	return desk<string>(`
		await front();
		await click(/^Go to vault$/);
		const entry = [...document.querySelectorAll("p,span,div,button")]
			.filter(visible)
			.find((el) => names(el).includes(${JSON.stringify(name)}));
		if (!entry) return "";
		entry.click();
		await sleep(800);
		return text();
	`);
}

// ---- browser ----

/** From the first-run screen's banner to the symbols. */
export async function linkFromSetup(page: Page): Promise<string> {
	await page.getByRole("button", { name: "Link", exact: true }).first().click();
	await expect(page.getByText("Open Bramble on this computer")).toBeVisible();
	await page.getByRole("button", { name: "Link", exact: true }).click();
	await expect(page.getByText("Check these match your desktop app")).toBeVisible({
		timeout: 20_000,
	});
	return symbolsIn(await page.locator("body").innerText());
}

/** From Settings > Sync > Desktop app in an unlocked popup to the symbols. */
export async function linkFromSettings(popup: Page): Promise<string> {
	await popup.getByRole("button", { name: "Settings" }).click();
	await popup.getByRole("button", { name: "Sync", exact: true }).click();
	await popup.getByRole("button", { name: "Link", exact: true }).click();
	await expect(popup.getByText("Check these match your desktop app")).toBeVisible({
		timeout: 20_000,
	});
	return symbolsIn(await popup.locator("body").innerText());
}

/** Enter the desktop vault's password on the setup card and wait for the finished screen. */
export async function joinFromSetup(page: Page): Promise<void> {
	await page.getByLabel("Master password").fill(DESKTOP_PW);
	await page.getByRole("button", { name: "Link", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Vault unlocked" })).toBeVisible({
		timeout: 30_000,
	});
}

/** Add a login through the vault list's Add New. */
export async function addLogin(popup: Page, name: string): Promise<void> {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /^Login Add a new login/ }).click();
	await popup.getByLabel(/^Name$/).fill(name);
	await popup.getByLabel(/Username or email/i).fill("browser@example.com");
	await popup.locator('input[type="password"]').first().fill("Browser-only-pw-456");
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByText(name)).toBeVisible();
}

/** Whether a URL stays on this machine. */
export function isLocal(url: string): boolean {
	const host = new URL(url).hostname;
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
