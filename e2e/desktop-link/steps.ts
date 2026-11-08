import type { Page } from "@playwright/test";
import { DESKTOP_PW, desk, expect, RELAY_URL } from "./fixtures";

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
		if (!find(/^Connect a browser$/, "p,span,div")) {
			// A dialog still waiting on a browser that went away: cancel it, as a person would.
			if (find(/^Cancel$/)) await click(/^Cancel$/);
			else { await click(/^Settings$/); await click(/^Sync$/); }
		}
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

/** Settings > Aliases, with the provider that contacts nobody: its domain is all it holds. */
export async function desktopSetAliasDomain(domain: string): Promise<void> {
	await desk(`
		await front();
		if (!find(/^Aliases$/)) await click(/^Settings$/);
		await click(/^Aliases$/);
		await fillLabel(/^Provider/, "catchall");
		await fillLabel(/Your domain/, ${JSON.stringify(domain)});
		await sleep(500);
		await click(/^Go to vault$/);
	`);
}

/** The alias domain the open vault holds, or "" with none. */
export async function desktopAliasDomain(): Promise<string> {
	return desk<string>(`
		await front();
		if (!find(/^Aliases$/)) await click(/^Settings$/);
		await click(/^Aliases$/);
		await sleep(300);
		const value = find(/Your domain/, "label")?.control?.value ?? "";
		await click(/^Go to vault$/);
		return value;
	`);
}

/** A backup target for the open vault, as the Settings form would store it. Off, so no run tries
 * it. What is under test is the app telling the browser it has one. */
export async function desktopSeedBackupTarget(title: string): Promise<void> {
	await desk(`
		const invoke = window.__TAURI_INTERNALS__.invoke;
		const registry = await invoke("storage_get_meta", { key: "vault.registry" });
		const vault = registry.vaults.find((v) => v.label === ${JSON.stringify(title)});
		if (!vault) throw new Error("no vault " + JSON.stringify(registry.vaults));
		await invoke("storage_set_meta", {
			key: "backup.targets:" + vault.id,
			value: [{
				id: "desktop-target",
				providerId: "nextcloud",
				provider: "webdav",
				serverUrl: "https://dav.example.test/",
				path: "/desktop",
				frequency: "off",
				keep: 7,
				creds: { iv: "AAAA", ciphertext: "BBBB" },
			}],
		});
	`);
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

/** The browsers linked to the open vault, as the app's own list says. */
export async function desktopListedBrowsers(): Promise<number> {
	return desk<number>(`return (await window.__TAURI_INTERNALS__.invoke("pairing_list")).length;`);
}

/** Lock, then make another vault from the unlock screen, or the picker with several; it opens
 * empty. */
export async function desktopCreateAnotherVault(name: string): Promise<void> {
	await desk(`
		await front();
		await click(/^Lock vault$/);
		// One vault: the unlock screen offers it. Several: the picker does, in its own words.
		const create = /^Create (another|new) vault$/;
		await waitFor(() => find(create) || find(/^Choose a different vault$/));
		if (!find(create)) await click(/^Choose a different vault$/);
		await click(create);
		await fill("#vault-name", ${JSON.stringify(name)});
		await fillPasswords(${JSON.stringify(DESKTOP_PW)});
		await click(/^Create vault$/);
		await click(/I've saved it/);
		await waitFor(() => find(/^Add New$/));
	`);
}

/** Point the open vault at the local relay: a new vault starts on the hosted one. */
export async function desktopUseLocalRelay(): Promise<void> {
	await desk(`
		await front();
		await click(/^Settings$/);
		await click(/^Sync$/);
		await click(/^Advanced$/);
		await fillLabel(/Nostr relay URL/, ${JSON.stringify(RELAY_URL)});
		await fillLabel(/TURN \\/ ICE servers URL/, "");
		await click(/^Go to vault$/);
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

/** Browsers connected to the desktop now, over any vault. Nothing is pushed to any other. */
export async function desktopConnectedBrowsers(): Promise<number> {
	return desk<number>(
		`return (await window.__TAURI_INTERNALS__.invoke("link_sync_peers")).length;`,
	);
}

/** What the open vault's Settings > Sync lists: browsers under Browser extension, which are the
 * linked ones that don't sync, and the other devices it syncs with. */
export async function desktopSyncRows(): Promise<{ browsers: number; devices: number }> {
	return desk(`
		await front();
		if (!find(/^Connect a browser$/, "p,span,div")) { await click(/^Settings$/); await click(/^Sync$/); }
		const labels = [...document.querySelectorAll("button")].filter(visible).map((b) => b.getAttribute("aria-label") || "");
		return {
			browsers: labels.filter((l) => l === "Disconnect this browser").length,
			devices: labels.filter((l) => l.startsWith("Remove ")).length,
		};
	`);
}

/** Remove every other device the open vault syncs with, then any browser still listed under
 * Browser extension, from its Settings, confirming each in its own row: an armed row shows its
 * confirm where the trigger was. */
export async function desktopRemoveBrowsers(): Promise<void> {
	await desk(`
		await front();
		if (!find(/^Connect a browser$/, "p,span,div")) { await click(/^Settings$/); await click(/^Sync$/); }
		const confirmEach = async (isTrigger, confirmText) => {
			for (let i = 0; i < 50; i++) {
				const trigger = [...document.querySelectorAll("button")]
					.filter(visible)
					.find((b) => isTrigger(b.getAttribute("aria-label") || ""));
				if (!trigger) return;
				const row = trigger.parentElement;
				trigger.click();
				await sleep(150);
				const confirm = await waitFor(() =>
					[...row.querySelectorAll("button")].filter(visible).find((b) => confirmText.test(b.textContent.trim())),
				);
				confirm.click();
				await sleep(300);
			}
		};
		await confirmEach((l) => l.startsWith("Remove "), /^Remove$/);
		await confirmEach((l) => l === "Disconnect this browser", /^Disconnect$/);
	`);
}

/** In the browser's popup, lock and open the vault at `index` in its picker, as a person would. */
export async function browserOpenVaultAt(popup: Page, index: number): Promise<void> {
	await popup.getByRole("button", { name: "Lock vault", exact: true }).click();
	const picker = popup.getByRole("heading", { name: /Choose a vault/i });
	const switchLink = popup.getByRole("button", { name: /Choose a different vault/i });
	await expect(picker.or(switchLink)).toBeVisible();
	if (!(await picker.isVisible())) await switchLink.click();
	await popup
		.getByRole("button")
		.filter({ hasText: /Created on/ })
		.nth(index)
		.click();
	await popup.locator('input[type="password"]').first().fill(DESKTOP_PW);
	await popup.getByRole("button", { name: "Unlock Vault" }).click();
	await expect(popup.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
}

export async function desktopGoToVault(): Promise<void> {
	await desk("await front(); await click(/^Go to vault$/);");
}

export async function desktopAddLogin(
	name: string,
	{ username = "desk@example.com", password = "Desk-made-pw-789" } = {},
): Promise<void> {
	await desk(`
		await front();
		await click(/^Go to vault$/);
		await click(/^Add New$/);
		await click(/^Login/);
		await fill("input[name=name]", ${JSON.stringify(name)});
		await fill("input[name=username]", ${JSON.stringify(username)});
		await fill('input[type="password"]', ${JSON.stringify(password)});
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
export async function addLogin(
	popup: Page,
	name: string,
	{ username = "browser@example.com", password = "Browser-only-pw-456", tag = "", notes = "" } = {},
): Promise<void> {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /^Login Add a new login/ }).click();
	await popup.getByLabel(/^Name$/).fill(name);
	await popup.getByLabel(/Username or email/i).fill(username);
	await popup.locator('input[type="password"]').first().fill(password);
	if (notes) await popup.getByLabel("Notes (optional)").fill(notes);
	if (tag) {
		await popup.getByLabel("Add a tag").fill(tag);
		await popup.getByLabel("Add a tag").press("Enter");
	}
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByText(name)).toBeVisible();
}

/** Settings > Aliases, with the provider that contacts nobody. Saves as it is typed. */
export async function setAliasDomain(popup: Page, domain: string): Promise<void> {
	await popup.getByRole("button", { name: "Settings" }).click();
	await popup.getByRole("button", { name: "Aliases", exact: true }).click();
	await popup.getByLabel("Provider").selectOption("catchall");
	await popup.getByLabel("Your domain").fill(domain);
	await popup.getByLabel("Your domain").blur();
	await expect.poll(() => popup.getByLabel("Your domain").inputValue()).toBe(domain);
	// Written through to the vault's settings before the screen is left.
	await popup.waitForTimeout(500);
	await popup.getByRole("button", { name: "Go to vault" }).click();
}

/** Settings > Backups, a Nextcloud target on the given server. */
export async function addWebDavTarget(
	popup: Page,
	{ url, user, password }: { url: string; user: string; password: string },
): Promise<void> {
	await popup.getByRole("button", { name: "Settings" }).click();
	await popup.getByRole("button", { name: "Backups", exact: true }).click();
	await popup.getByRole("button", { name: /Nextcloud/i }).click();
	await popup.getByLabel("WebDAV URL").fill(url);
	await popup.getByLabel("Username").fill(user);
	await popup.getByLabel("Password", { exact: true }).fill(password);
	await popup.getByRole("button", { name: "Save" }).click();
	await expect(popup.getByRole("button", { name: "Back up now" })).toBeVisible();
	await popup.getByRole("button", { name: "Go to vault" }).click();
}

/** Whether a URL stays on this machine. */
export function isLocal(url: string): boolean {
	const host = new URL(url).hostname;
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
