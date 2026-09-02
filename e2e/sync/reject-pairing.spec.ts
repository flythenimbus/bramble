import { popupUrl } from "../extension/helpers";
import { createVault, expect, gotoSync, PW, RELAY_URL, test } from "./fixtures";

// Rejecting the SAS prompt must send nothing AND burn the code. The burn is the half that is easy
// to get wrong: re-arming a refused invite would hand a second attempt to whoever the code reached,
// which is exactly the party the user just said was not their device.
//
// No vault contents needed: nothing is ever transferred here.

const LOCAL_RELAY_HOST = "localhost:7400";

test("rejecting the prompt sends nothing and kills the code", async ({ ext, mobile }) => {
	await createVault(ext.page);
	await ext.page.goto(popupUrl(ext.extensionId));
	await expect(ext.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();

	await gotoSync(ext.page);
	await ext.page.getByRole("button", { name: /Advanced/i }).click();
	await ext.page.getByLabel(/Nostr relay URL/i).fill(RELAY_URL);
	await ext.page.getByLabel(/TURN \/ ICE servers URL/i).fill("");

	await ext.page
		.getByRole("button", { name: /^Add a device$/i })
		.last()
		.click();
	await ext.page.locator('input[type="password"]').first().fill(PW);
	await ext.page.getByRole("button", { name: "Continue", exact: true }).click();

	const code = await ext.page.locator("input[readonly]").inputValue();
	const decoded = JSON.parse(
		Buffer.from(code.replace("bramble-pair-1.", ""), "base64").toString("utf8"),
	) as { relay: string };
	expect(decoded.relay).toContain(LOCAL_RELAY_HOST);

	const join = async (): Promise<void> => {
		const paste = mobile.page.getByRole("button", { name: /Paste code instead/i });
		if (await paste.isVisible().catch(() => false)) await paste.click();
		await mobile.page.getByPlaceholder(/Paste the code from your other device/i).fill(code);
		await mobile.page.getByLabel(/Master password/i).fill(PW);
		await mobile.page.getByRole("button", { name: /Join vault/i }).click();
	};

	await mobile.page.getByRole("button", { name: /Create your vault/i }).click();
	await mobile.page.getByRole("button", { name: /Join a device/i }).click();
	await join();

	// --- the prompt, then Reject ---
	await expect(ext.page.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	await ext.page.getByRole("button", { name: /^Reject$/i }).click();

	// Rejecting just closes the pairing UI: no confirmation screen to dismiss. Both the prompt and
	// the code itself go away, so a dead code can't be left on screen to be scanned.
	await expect(ext.page.getByText(/Is this your device\?/i)).toBeHidden();
	await expect(ext.page.locator("input[readonly]")).toBeHidden();

	// The joiner is TOLD, rather than being left on a spinner until its own wait expires. That wait
	// is the whole invite window, so without the explicit notice the real device sits there for
	// minutes after being refused.
	await expect(mobile.page.getByText(/confirm this pairing|used up/i).first()).toBeVisible({
		timeout: 30_000,
	});

	// --- the burn: the same code must not work a second time ---
	// The inviter tore its session down on reject, so the retry finds an empty room and simply
	// never connects. That is a negative, and `toBeHidden` alone would pass instantly against an
	// element that was never going to appear, proving nothing — so dwell first, then assert. The
	// deterministic half of this (a second peer is refused rather than served) is the unit test
	// "sends nothing and burns the invite when the user rejects"; this covers the user-visible end.
	await join();
	await expect(mobile.page.getByText(/Connecting to your other device/i)).toBeVisible();
	await mobile.page.waitForTimeout(8_000);
	await expect(mobile.page.getByRole("button", { name: "Lock vault", exact: true })).toBeHidden();
	await expect(mobile.page.getByText(/Connecting to your other device/i)).toBeVisible();
});
