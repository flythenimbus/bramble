import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { launchExtensionContext } from "../extension/fixtures";
import { optionsUrl, popupUrl, unlock } from "../extension/helpers";
import {
	addLogin,
	createVault,
	enterCode,
	expect,
	gotoSync,
	invite,
	type Peer,
	relayedBytes,
	test,
	useLocalRelay,
	withoutWebRTC,
} from "./fixtures";

// An attachment made on one device, opened on another, byte for byte. Two browsers pair over the
// local relay; the file goes over the second, file-only session, which may use the relay to find
// a peer and must never use it to carry one. The relay counts what it forwards (RELAY_STATS), so
// the file crossing while the relay carries a fraction of its size is the proof the bytes went
// peer to peer. See docs/file-attachments.md (Transfer).

/** Several windows and one short tail: a resume or window-boundary slip fails the byte check. */
const FILE = {
	name: "passport scan.bin",
	body: Buffer.from(
		Uint8Array.from({ length: 6 * 1024 * 1024 + 1234 }, (_, i) => (i * 7 + (i >> 11)) % 251),
	),
};

/** The inviter: a vault holding an entry with the file on it, then an invite to it. */
async function inviteWithAFile(ext: Peer & { extensionId: string }): Promise<string> {
	// --- inviter: a vault with an entry and a file on it ---
	await createVault(ext.page);
	const popup = await ext.context.newPage();
	await popup.goto(`${popupUrl(ext.extensionId)}?detached=1`);
	await expect(popup.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup
		.getByRole("button", { name: /^Login/ })
		.first()
		.click();
	await popup.getByLabel(/^Name$/).fill("Passport");
	await popup.getByLabel(/Username or email/i).fill("me@example.com");
	await popup
		.getByLabel(/^Password$/)
		.first()
		.fill("hunter2-c0rrect-h0rse");
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await popup.getByText("Passport").click();
	const sources = mkdtempSync(path.join(tmpdir(), "bramble-attach-sync-"));
	const source = path.join(sources, FILE.name);
	writeFileSync(source, FILE.body);
	await popup.locator('input[type="file"]').setInputFiles(source);
	await expect(popup.getByText(FILE.name)).toBeVisible({ timeout: 60_000 });

	await ext.page.goto(popupUrl(ext.extensionId));
	await gotoSync(ext.page);
	await useLocalRelay(ext.page);
	return invite(ext.page);
}

/** Join with the code and approve on the inviter, as a user does with both screens in front. */
async function join(inviter: Page, joiner: Page, code: string): Promise<void> {
	await enterCode(joiner, code);
	await expect(inviter.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	await inviter.getByRole("button", { name: /They match, approve/i }).click();
}

test("a file attached in one browser opens in another, and never crosses the relay", async ({
	ext,
	ext2,
}) => {
	const before = await relayedBytes();

	const code = await inviteWithAFile(ext);

	// --- joiner: a second browser with no vault of its own ---
	// The extension's setup tab opens on the create form; the join flow is a sibling tab.
	await ext2.page.getByRole("button", { name: /Join a device/i }).click();
	await join(ext.page, ext2.page, code);

	// --- the joiner gets the entry, then the file's bytes ---
	const joined = await ext2.context.newPage();
	await joined.goto(`${popupUrl(ext2.extensionId)}?detached=1`);
	await expect(joined.getByText("Passport")).toBeVisible({ timeout: 90_000 });
	await joined.getByText("Passport").click();
	await expect(joined.getByText(FILE.name)).toBeVisible({ timeout: 60_000 });
	const open = joined.getByRole("button", { name: "Open attachment" });
	await expect(open).toBeEnabled({ timeout: 120_000 });

	const downloading = joined.waitForEvent("download");
	await open.click();
	const saved = readFileSync((await (await downloading).path()) as string);
	expect(saved.equals(FILE.body)).toBe(true);

	// Pairing, signalling and entry sync went through the relay; the file did not. Its sealed
	// form is larger than its body, so even a quarter of it relayed would show here.
	const relayed = (await relayedBytes()) - before;
	console.log(`[e2e] relay carried ${relayed} bytes while a ${FILE.body.length}-byte file moved`);
	expect(relayed).toBeLessThan(FILE.body.length / 4);
});

// A device without WebRTC is Firefox's case: none in any extension context. Entries still reach
// it, forwarded by the relay. Its files must not, since TURN needs WebRTC too: they wait, and say so.
test("a device without WebRTC gets the entry and not the file, which waits", async ({
	ext,
	mobile,
}) => {
	await withoutWebRTC(mobile.page);
	const before = await relayedBytes();

	const code = await inviteWithAFile(ext);
	await mobile.page.getByRole("button", { name: /Create your vault/i }).click();
	await mobile.page.getByRole("button", { name: /Join a device/i }).click();
	await join(ext.page, mobile.page, code);

	await expect(mobile.page.getByText("Passport")).toBeVisible({ timeout: 90_000 });
	await mobile.page.getByText("Passport").click();
	// The browser is seen over the relay and can't be connected to, and the row says so once it
	// has had its chance to connect.
	const unreachable = mobile.page.getByText("A device is online but can't connect to this one.");
	await expect(unreachable).toBeVisible({ timeout: 90_000 });
	// Long enough for several announcements and pulls to have happened, had any path allowed one.
	await mobile.page.waitForTimeout(20_000);
	await expect(unreachable).toBeVisible();
	await expect(mobile.page.getByRole("button", { name: "Open attachment" })).toHaveCount(0);

	const relayed = (await relayedBytes()) - before;
	console.log(`[e2e] relay carried ${relayed} bytes with no WebRTC`);
	expect(relayed).toBeLessThan(FILE.body.length / 4);
});

// The upgrade path: a browser that paired on a build predating attachments, then updated. The old
// build can't read file records, so it drops them on every write; after the update, the next sync
// with a peer that kept them has to bring them back. BRAMBLE_OLD_EXTENSION is that build's
// dist-chromium, e.g. a worktree at 1.32.0-chromium after `pnpm wasm:build && pnpm build`.
test("a browser that paired before attachments gets the file once it updates", async ({ ext }) => {
	const oldBuild = process.env.BRAMBLE_OLD_EXTENSION;
	test.skip(!oldBuild, "needs BRAMBLE_OLD_EXTENSION, a build that predates attachments");
	const code = await inviteWithAFile(ext);

	// --- the old build joins and syncs, keeping the entry and dropping the file record ---
	const profileDir = mkdtempSync(path.join(tmpdir(), "bramble-e2e-upgrade-"));
	try {
		const before = await launchExtensionContext(profileDir, oldBuild);
		const setup = await before.context.newPage();
		await setup.goto(optionsUrl(before.extensionId));
		await setup.getByRole("button", { name: /Join a device/i }).click();
		await join(ext.page, setup, code);
		const old = await before.context.newPage();
		await old.goto(`${popupUrl(before.extensionId)}?detached=1`);
		await expect(old.getByText("Passport")).toBeVisible({ timeout: 90_000 });
		// A few gossip rounds, so the old build has rewritten its copy without the file.
		await old.waitForTimeout(15_000);
		await before.context.close();

		// --- updated in place: the same profile on this build ---
		// A relaunch on another path keeps the stored service worker, so without this the "updated"
		// browser runs the new pages over the OLD background. A store update re-registers it.
		rmSync(path.join(profileDir, "Default", "Service Worker"), { recursive: true, force: true });
		const after = await launchExtensionContext(profileDir);
		// Registering it again takes a moment, and a page that asks before it's done never hears
		// back. It has started once its offscreen document is up.
		const worker = after.context.serviceWorkers()[0];
		await expect
			.poll(() =>
				worker?.evaluate(
					async () =>
						(await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length,
				),
			)
			.toBeGreaterThan(0);
		const popup = await after.context.newPage();
		await popup.goto(`${popupUrl(after.extensionId)}?detached=1`);
		await unlock(popup);
		await popup.getByText("Passport").click();
		await expect(popup.getByText(FILE.name)).toBeVisible({ timeout: 90_000 });
		const open = popup.getByRole("button", { name: "Open attachment" });
		await expect(open).toBeEnabled({ timeout: 120_000 });
		const downloading = popup.waitForEvent("download");
		await open.click();
		const saved = readFileSync((await (await downloading).path()) as string);
		expect(saved.equals(FILE.body)).toBe(true);
		await after.context.close();
	} finally {
		rmSync(profileDir, { recursive: true, force: true });
	}
});

/** A small file of its own, so each direction's bytes can be told apart. */
const small = (name: string, seed: number) => {
	const dir = mkdtempSync(path.join(tmpdir(), "bramble-attach-"));
	const body = Buffer.from(
		Uint8Array.from({ length: 1024 * 1024 + seed }, (_, i) => (i * seed) % 251),
	);
	const file = path.join(dir, name);
	writeFileSync(file, body);
	return { name, body, file };
};

/** Attach `f` to the entry from wherever the page is: the list or that entry's detail. */
async function attach(page: Page, entry: string, f: ReturnType<typeof small>): Promise<void> {
	await page.getByText(entry).first().click();
	await page.locator('input[type="file"]').setInputFiles(f.file);
	await expect(page.getByText(f.name)).toBeVisible({ timeout: 60_000 });
}

/** The entry on `page` shows `f`, and it opens identical. */
async function expectFile(page: Page, entry: string, f: ReturnType<typeof small>): Promise<void> {
	await page.getByText(entry).first().click();
	await expect(page.getByText(f.name)).toBeVisible({ timeout: 60_000 });
	// This file's own row, the nearest rounded card around its name, whose Open appears once the
	// bytes are here: nothing wider, or another file's Open could stand in for it.
	const open = page
		.getByText(f.name, { exact: true })
		.locator("xpath=ancestor::div[contains(@class, 'rounded-lg')][1]")
		.getByRole("button", { name: "Open attachment" });
	await expect(open).toBeEnabled({ timeout: 120_000 });
	const downloading = page.waitForEvent("download");
	await open.click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe(f.name);
	expect(readFileSync((await download.path()) as string).equals(f.body)).toBe(true);
}

// The attachments above are made before pairing, so their records arrive in the enrollment. One
// attached on a paired device rides its next envelope instead, which now goes out only because
// the vault changed (docs/sync-rebroadcast.md).
test("a file attached after pairing reaches the other browser, either way", async ({
	ext,
	ext2,
}) => {
	await createVault(ext.page);
	const popup = await ext.context.newPage();
	await popup.goto(`${popupUrl(ext.extensionId)}?detached=1`);
	await expect(popup.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
	await addLogin(popup, "Passport");
	await ext.page.goto(popupUrl(ext.extensionId));
	await gotoSync(ext.page);
	await useLocalRelay(ext.page);
	const code = await invite(ext.page);
	await ext2.page.getByRole("button", { name: /Join a device/i }).click();
	await join(ext.page, ext2.page, code);
	const joined = await ext2.context.newPage();
	await joined.goto(`${popupUrl(ext2.extensionId)}?detached=1`);
	await expect(joined.getByText("Passport")).toBeVisible({ timeout: 90_000 });

	const first = small("from the inviter.bin", 3);
	const second = small("from the joiner.bin", 7);
	await attach(popup, "Passport", first);
	await expectFile(joined, "Passport", first);
	await attach(joined, "Passport", second);
	await expectFile(popup, "Passport", second);
});
