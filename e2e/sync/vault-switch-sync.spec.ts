import type { Page, Worker } from "@playwright/test";
import {
	backgroundWorker,
	createVault as createAnotherVault,
	lockToPicker,
	popupUrl,
	selectVault,
} from "../extension/helpers";
import { createVault, expect, gotoSync, type Peer, PW, RELAY_URL, test } from "./fixtures";

// A vault opened while a synced one is still unlocked must never receive the synced vault's peer
// entries: one sealed under another vault's key fails that vault's unlock with "aead::Error".

const LOCAL_RELAY_HOST = "localhost:7400";

/** Point this peer's sync at the local relay, via the Advanced panel a user would use. */
async function useLocalRelay(page: Page): Promise<void> {
	await page.getByRole("button", { name: /Advanced/i }).click();
	await page.getByLabel(/Nostr relay URL/i).fill(RELAY_URL);
	await page.getByLabel(/TURN \/ ICE servers URL/i).fill("");
}

/** Run the inviter flow and return the pairing code. */
async function invite(page: Page): Promise<string> {
	await page
		.getByRole("button", { name: /^Add a device$/i })
		.last()
		.click();
	await page.locator('input[type="password"]').first().fill(PW);
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	const codeField = page.locator("input[readonly]");
	await expect(codeField).toBeVisible();
	return codeField.inputValue();
}

/** Pair the two peers over the local relay, approving the SAS as a user would. */
async function pair(ext: Peer & { extensionId: string }, mobile: Peer): Promise<void> {
	await createVault(ext.page);
	await ext.page.goto(popupUrl(ext.extensionId));
	await expect(ext.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
	await gotoSync(ext.page);
	await useLocalRelay(ext.page);

	const code = await invite(ext.page);
	const decoded = JSON.parse(
		Buffer.from(code.replace("bramble-pair-1.", ""), "base64").toString("utf8"),
	) as { relay: string };
	expect(decoded.relay, "the pairing code must name the local relay").toContain(LOCAL_RELAY_HOST);

	await mobile.page.getByRole("button", { name: /Create your vault/i }).click();
	await mobile.page.getByRole("button", { name: /Join a device/i }).click();
	const paste = mobile.page.getByRole("button", { name: /Paste code instead/i });
	if (await paste.isVisible().catch(() => false)) await paste.click();
	await mobile.page.getByPlaceholder(/Paste the code from your other device/i).fill(code);
	await mobile.page.getByLabel(/Master password/i).fill(PW);
	await mobile.page.getByRole("button", { name: /Join vault/i }).click();

	await expect(mobile.page.getByRole("heading", { name: /Check this matches/i })).toBeVisible({
		timeout: 90_000,
	});
	await expect(ext.page.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	await ext.page.getByRole("button", { name: /They match, approve/i }).click();
	await expect(mobile.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
		timeout: 90_000,
	});
}

/** Add a login through the real create-entry UI. */
async function addLogin(page: Page, name: string): Promise<void> {
	await page.getByRole("button", { name: /Add New/i }).click();
	await page
		.getByRole("button", { name: /^Login/ })
		.first()
		.click();
	await page.getByLabel(/^Name$/).fill(name);
	await page.getByLabel(/Username or email/i).fill("octocat@example.com");
	await page
		.getByLabel(/^Password$/)
		.first()
		.fill("hunter2-c0rrect-h0rse");
	await page.getByRole("button", { name: /Save Login/i }).click();
	await expect(page.getByText(name)).toBeVisible();
}

/** Leave whichever screen the popup restored, for the vault list. */
async function showVaultList(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Go to vault" }).click();
	await expect(page.getByRole("button", { name: /Add New/i })).toBeVisible();
}

/** The synced vault (it has a sync group) and the other one, by id. */
async function vaultIds(sw: Worker): Promise<{ synced: string; other: string }> {
	return sw.evaluate(async () => {
		const all = await chrome.storage.local.get(null);
		const reg = all["vault.registry"] as { vaults: { id: string }[] };
		const synced = reg.vaults.find((v) => all[`sync.group:${v.id}`] !== undefined);
		const other = reg.vaults.find((v) => v !== synced);
		if (!synced || !other)
			throw new Error(`expected a synced vault and another: ${reg.vaults.length}`);
		return { synced: synced.id, other: other.id };
	});
}

/** A vault's stored bytes, base64. */
function readBlob(sw: Worker, id: string): Promise<string | undefined> {
	return sw.evaluate(
		async (key) => (await chrome.storage.local.get(key))[key] as string | undefined,
		`vault-blob-b64:${id}`,
	);
}

/** Whether `read` returns something other than `before` within `ms`. */
async function changesWithin(
	read: () => Promise<unknown>,
	before: unknown,
	ms: number,
): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if ((await read()) !== before) return true;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
}

test("a peer of the synced vault never writes into a vault opened alongside it", async ({
	ext,
	mobile,
}) => {
	await pair(ext, mobile);
	const sw = await backgroundWorker(ext.context);
	const stamp = Date.now().toString(36);

	// Precondition: the extension's sync session is live and merges into the synced vault.
	await showVaultList(ext.page);
	const beforeSwitch = `Before switch ${stamp}`;
	await addLogin(mobile.page, beforeSwitch);
	await expect(ext.page.getByText(beforeSwitch)).toBeVisible({ timeout: 90_000 });

	// A second vault becomes active while the synced one stays unlocked, as Settings' desktop link does.
	const setup = await ext.context.newPage();
	await createAnotherVault(setup, ext.extensionId);
	const { other } = await vaultIds(sw);
	const otherBefore = await readBlob(sw, other);

	const afterSwitch = `After switch ${stamp}`;
	await addLogin(mobile.page, afterSwitch);
	const otherRewritten = await changesWithin(() => readBlob(sw, other), otherBefore, 30_000);

	// What the user sees: reopen the popup and open the second vault with its correct password.
	const popup = await ext.context.newPage();
	await popup.goto(popupUrl(ext.extensionId));
	const lockButton = popup.getByRole("button", { name: "Lock vault", exact: true });
	const password = popup.locator('input[type="password"]').first();
	await expect(lockButton.or(password)).toBeVisible();
	if (!(await lockButton.isVisible())) {
		await password.fill(PW);
		await popup.getByRole("button", { name: "Unlock Vault" }).click();
	}
	const rawError = popup.getByText(/aead::Error|aes decrypt/);
	await expect(lockButton.or(rawError)).toBeVisible({ timeout: 30_000 });
	await test.info().attach("second vault unlock", {
		body: await popup.screenshot(),
		contentType: "image/png",
	});
	const shown = (await rawError.isVisible()) ? await rawError.textContent() : null;
	expect(shown, "the right password on the second vault showed a raw crypto error").toBeNull();
	expect(otherRewritten, "sync wrote the synced vault's entries into the second vault").toBe(false);
	await expect(lockButton).toBeVisible();
	await showVaultList(popup);
	await expect(popup.getByText(beforeSwitch)).toHaveCount(0);

	// Positive control: the peer's post-switch edit still reaches its own vault.
	await lockToPicker(popup);
	await selectVault(popup, /Vault 1/);
	await showVaultList(popup);
	await expect(popup.getByText(afterSwitch)).toBeVisible({ timeout: 90_000 });
});
