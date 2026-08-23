import type { Page } from "@playwright/test";
import { popupUrl } from "../extension/helpers";
import { createVault, expect, gotoSync, PW, RELAY_URL, test } from "./fixtures";

// Two real peers — the browser extension and the mobile app — pairing over WebRTC through a local
// signaling relay, then merging a vault. Closes the gap e2e/README.md flagged as "a further step".
//
// Only the INVITER needs the relay configured: the pairing code carries it (PairingCodeSchema.relay)
// and the joiner adopts it. And it must be set AFTER the vault exists, because creating the first
// vault calls resetSyncState(), which removes sync.relay along with the rest of the sync identity.

const LOCAL_RELAY_HOST = "localhost:7400";

/** Point this peer's sync at the local relay, via the Advanced panel a user would use. */
async function useLocalRelay(page: Page): Promise<void> {
	await page.getByRole("button", { name: /Advanced/i }).click();
	const field = page.getByLabel(/Nostr relay URL/i);
	await field.fill(RELAY_URL);
	// The ICE endpoint derives from the relay; blank it so nothing reaches for the hosted one.
	await page.getByLabel(/TURN \/ ICE servers URL/i).fill("");
}

/** Run the inviter flow and return the pairing code. */
async function invite(page: Page): Promise<string> {
	await page
		.getByRole("button", { name: /^Add a device$/i })
		.last()
		.click();
	// Re-auth: adding a device is authorised by the master password, not just an unlocked session.
	await page.locator('input[type="password"]').first().fill(PW);
	await page.getByRole("button", { name: /Continue/i }).click();

	const codeField = page.locator("input[readonly]");
	await expect(codeField).toBeVisible();
	const code = await codeField.inputValue();
	expect(code).toMatch(/^bramble-pair-1\./);
	return code;
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

test("the extension and the mobile app pair over a real relay and share a vault", async ({
	ext,
	mobile,
}) => {
	// --- inviter: the extension, with something worth syncing ---
	// Setup runs in the options tab; the vault UI and Settings live in the popup.
	await createVault(ext.page);
	await ext.page.goto(popupUrl(ext.extensionId));
	await expect(ext.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
	// Written before the invite so there is real data to move. It reaches the joiner by whichever
	// path gets there first — the enrolment bundle or the ongoing merge. Measured, not assumed:
	// forcing the bundle to ship zero entries still passes, because the merge delivers it. So this
	// pins the end-to-end outcome (the joiner can READ the inviter's data), NOT the bundle path.
	const NAME = `Synced ${Date.now().toString(36)}`;
	await addLogin(ext.page, NAME);
	await gotoSync(ext.page);
	await useLocalRelay(ext.page);
	const code = await invite(ext.page);

	// The code must name OUR relay, not the hosted default — otherwise the test would be
	// silently exercising production infrastructure.
	const decoded = JSON.parse(
		Buffer.from(code.replace("bramble-pair-1.", ""), "base64").toString("utf8"),
	) as { relay: string };
	expect(decoded.relay).toContain(LOCAL_RELAY_HOST);

	await expect(ext.page.getByText(/Waiting for a device to join/i).first()).toBeVisible();

	// --- joiner: the mobile app, with no vault of its own ---
	// Setup opens on "Create new vault"; the join flow is a sibling tab.
	await mobile.page.getByRole("button", { name: /Create your vault/i }).click();
	await mobile.page.getByRole("button", { name: /Join a device/i }).click();
	// On mobile the camera scanner is offered first; take the paste path instead.
	const paste = mobile.page.getByRole("button", { name: /Paste code instead/i });
	if (await paste.isVisible().catch(() => false)) await paste.click();
	await mobile.page.getByPlaceholder(/Paste the code from your other device/i).fill(code);
	await mobile.page.getByLabel(/Master password/i).fill(PW);
	await mobile.page.getByRole("button", { name: /Join vault/i }).click();

	// --- the SAS gate: the vault does not move until the user says both screens match ---
	// The only test that proves two independently-built peers derive the SAME number from a real
	// handshake. A drift in the derivation on either side would leave pairing permanently broken
	// in the field, and unit tests can't catch it (each side would agree with itself).
	const joinerSas = mobile.page.locator(".font-mono.tabular-nums");
	await expect(joinerSas).toBeVisible({ timeout: 90_000 });
	const approvalDialog = ext.page.getByText(/Is this your device\?/i);
	await expect(approvalDialog).toBeVisible({ timeout: 90_000 });
	const inviterSas = ext.page.locator(".font-mono.tabular-nums");
	await expect(inviterSas).toHaveText(/^\d{4} \d{4} \d{4}$/);
	expect(await inviterSas.textContent()).toBe(await joinerSas.textContent());
	await ext.page.getByRole("button", { name: /They match, approve/i }).click();
	// Answering spends the invite, so the code comes off screen. Approving used to leave the QR up
	// while the transfer ran behind it, which reads as "still waiting" and invites a second scan.
	await expect(ext.page.locator("input[readonly]")).toBeHidden();

	// --- both sides observe the pairing ---
	// The joiner ends up in an unlocked vault it did not create.
	await expect(mobile.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
		timeout: 90_000,
	});
	// And the inviter's roster gains the peer.
	await expect(ext.page.getByText(/THIS DEVICE/i)).toBeVisible();

	// --- the payoff: the joiner can actually READ the inviter's data ---
	// Decrypted with the key it was handed, which is the outcome issue #27 destroys: slots and
	// entries under different keys. Shipping a wrong VEK fails even earlier than this — the join
	// never completes — so the pairing assertions above cover that case.
	await expect(mobile.page.getByText(NAME)).toBeVisible({ timeout: 90_000 });
});
