import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { lock, popupUrl, unlock } from "../extension/helpers";
import { editEntry, openEntry } from "./entry-edits";
import {
	addLogin,
	createVault,
	enterCode,
	expect,
	gotoSync,
	invite,
	type Peer,
	PW,
	test,
	useLocalRelay,
} from "./fixtures";

// One browser deletes an entry while the other, unable to hear it, changes it: an edit, or a new
// attachment. Both come back as a delete conflict holding every file, and the choice settles both
// browsers. Locking a browser stops its sync, which is what keeps them apart. See
// docs/file-attachments.md, "Deleting an entry hides its attachments".

type ExtPeer = Peer & { extensionId: string };

const NAME = "Passport";
const DELETED = /deleted on one device and changed on another/i;

let sources: string;
test.beforeAll(() => {
	sources = mkdtempSync(path.join(tmpdir(), "bramble-attach-delete-"));
});
test.afterAll(() => rmSync(sources, { recursive: true, force: true }));

/** A popup on its own tab: the one that can attach. */
async function popup(peer: ExtPeer): Promise<Page> {
	const page = await peer.context.newPage();
	await page.goto(`${popupUrl(peer.extensionId)}?detached=1`);
	await expect(page.locator("#root")).not.toBeEmpty();
	return page;
}

async function attach(page: Page, name: string): Promise<void> {
	await openEntry(page, NAME);
	const file = path.join(sources, name);
	writeFileSync(file, `contents of ${name}`);
	await page.locator('input[type="file"]').setInputFiles(file);
	await expect(page.getByText(name)).toBeVisible({ timeout: 60_000 });
}

async function deleteEntry(page: Page): Promise<void> {
	await openEntry(page, NAME);
	await page.getByRole("button", { name: "Delete entry" }).click();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(page.getByText(NAME)).toHaveCount(0);
}

/** Two browsers in one vault, sharing NAME with scan.pdf on it. Returns a popup on each. */
async function pairWithAFile(ext: ExtPeer, ext2: ExtPeer): Promise<[Page, Page]> {
	await createVault(ext.page);
	const a = await popup(ext);
	await addLogin(a, NAME);
	await attach(a, "scan.pdf");
	await ext.page.goto(popupUrl(ext.extensionId));
	await gotoSync(ext.page);
	await useLocalRelay(ext.page);
	const code = await invite(ext.page);

	await ext2.page.getByRole("button", { name: /Join a device/i }).click();
	await enterCode(ext2.page, code);
	await expect(ext.page.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	await ext.page.getByRole("button", { name: /They match, approve/i }).click();

	const b = await popup(ext2);
	await expect(b.getByText(NAME)).toBeVisible({ timeout: 90_000 });
	await openEntry(b, NAME);
	await expect(b.getByText("scan.pdf")).toBeVisible({ timeout: 60_000 });
	return [a, b];
}

/** The entry is back on this page as a delete conflict, showing these files. */
async function expectDeleteConflict(page: Page, files: string[]): Promise<void> {
	await expect(page.getByText(NAME)).toBeVisible({ timeout: 90_000 });
	await openEntry(page, NAME);
	await expect(page.getByText(DELETED)).toBeVisible({ timeout: 90_000 });
	for (const f of files) await expect(page.getByText(f)).toBeVisible();
}

test("keeping an entry deleted while it was edited keeps its attachment", async ({ ext, ext2 }) => {
	const [a, b] = await pairWithAFile(ext, ext2);
	await lock(b);
	await deleteEntry(a);
	await lock(a);
	await unlock(b, PW);
	await editEntry(b, NAME, { notes: "renewed in 2026" });
	await unlock(a, PW);

	for (const page of [a, b]) await expectDeleteConflict(page, ["scan.pdf"]);
	await a.getByRole("button", { name: "Keep it" }).click();
	for (const page of [a, b]) {
		await openEntry(page, NAME);
		await expect(page.getByText(DELETED)).toBeHidden({ timeout: 90_000 });
		await expect(page.getByText("scan.pdf")).toBeVisible();
		await expect(page.getByText("renewed in 2026")).toBeVisible();
	}
});

test("a file attached where the delete hadn't reached brings the entry back to decide on", async ({
	ext,
	ext2,
}) => {
	const [a, b] = await pairWithAFile(ext, ext2);
	await lock(b);
	await deleteEntry(a);
	await lock(a);
	await unlock(b, PW);
	await attach(b, "visa.pdf");
	await unlock(a, PW);

	for (const page of [a, b]) await expectDeleteConflict(page, ["scan.pdf", "visa.pdf"]);
	await a.getByRole("button", { name: "Delete it" }).click();
	for (const page of [a, b]) {
		await expect(page.getByText(NAME)).toHaveCount(0, { timeout: 90_000 });
	}
});
