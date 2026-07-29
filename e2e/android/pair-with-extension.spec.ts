import { rmSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { launchExtensionContext } from "../extension/fixtures";
import { optionsUrl, popupUrl, STRONG_PW } from "../extension/helpers";
import { adbReverse, expect, test } from "./fixtures";

// The most realistic test we can run: the browser extension pairs with the SHIPPED Android app on
// a real device, over a relay on this machine.
//
// The device peer is the thing nothing else covers. e2e/sync pairs the extension with the mobile
// SPA in a desktop browser, where Capacitor falls back to the WASM crypto core and the web
// Filesystem/Preferences. Here the joiner rebuilds its vault with the uniffi Rust core and writes
// it through the Android storage adapter — the layer issue #27 actually shipped on.
//
// Two environmental dependencies, both of which fail as test failures rather than obvious ones:
//   - adb reverse routes the DEVICE's localhost:7400 to this machine's relay. Without it the
//     joiner cannot signal at all.
//   - the WebRTC data channel needs a real IP route between phone and host. Same LAN is enough;
//     a guest network with client isolation is not.
//
// This MUTATES the device: the joiner ends up with a real new vault. It deletes the one it made,
// but a mid-test failure will leave it behind for you to clear.

const RELAY = "ws://localhost:7400";

/** The extension peer, in a throwaway profile. */
async function launchInviter(): Promise<{
	context: BrowserContext;
	page: Page;
	extensionId: string;
	profileDir: string;
}> {
	const { context, extensionId, profileDir } = await launchExtensionContext();
	const page = await context.newPage();
	await page.goto(optionsUrl(extensionId));
	await page.locator("#root").waitFor();
	return { context, page, extensionId, profileDir };
}

test("the extension pairs with the app on the device and its data lands there", async ({
	page: device,
}) => {
	const stopReverse = adbReverse(7400);
	const inviter = await launchInviter();
	let joined = false;

	try {
		// --- inviter: a vault with something in it ---
		const pw = inviter.page.locator('input[type="password"]');
		await pw.nth(0).fill(STRONG_PW);
		await pw.nth(1).fill(STRONG_PW);
		await inviter.page.getByRole("button", { name: "Create vault" }).click();
		await inviter.page.getByRole("button", { name: /I've saved it/i }).click();

		await inviter.page.goto(popupUrl(inviter.extensionId));
		await expect(
			inviter.page.getByRole("button", { name: "Lock vault", exact: true }),
		).toBeVisible();
		const NAME = `e2e-${Date.now().toString(36)}`;
		await inviter.page.getByRole("button", { name: /Add New/i }).click();
		await inviter.page
			.getByRole("button", { name: /^Login/ })
			.first()
			.click();
		await inviter.page.getByLabel(/^Name$/).fill(NAME);
		await inviter.page.getByLabel(/Username or email/i).fill("octocat@example.com");
		await inviter.page
			.getByLabel(/^Password$/)
			.first()
			.fill("hunter2-c0rrect-h0rse");
		await inviter.page.getByRole("button", { name: /Save Login/i }).click();
		await expect(inviter.page.getByText(NAME)).toBeVisible();

		// --- inviter: point at the local relay, then invite ---
		// After the vault exists: creating the first one calls resetSyncState(), which drops
		// sync.relay and would silently send us to the hosted relay.
		await inviter.page.getByRole("button", { name: "Settings" }).click();
		await inviter.page.getByRole("button", { name: "Sync", exact: true }).click();
		await inviter.page.getByRole("button", { name: /Advanced/i }).click();
		await inviter.page.getByLabel(/Nostr relay URL/i).fill(RELAY);
		await inviter.page.getByLabel(/TURN \/ ICE servers URL/i).fill("");
		await inviter.page
			.getByRole("button", { name: /^Add a device$/i })
			.last()
			.click();
		await inviter.page.locator('input[type="password"]').first().fill(STRONG_PW);
		await inviter.page.getByRole("button", { name: /Continue/i }).click();

		const code = await inviter.page.locator("input[readonly]").inputValue();
		expect(code).toMatch(/^bramble-pair-1\./);
		// The device resolves this URL literally, via adb reverse, so it has to be OUR relay —
		// otherwise the test would quietly pair through production infrastructure.
		const decoded = JSON.parse(
			Buffer.from(code.replace("bramble-pair-1.", ""), "base64").toString("utf8"),
		) as { relay: string };
		expect(decoded.relay).toBe(RELAY);

		// --- joiner: the real app on the device ---
		// It already has vaults, so join from the picker's "Create new vault" -> "Join a device".
		const picker = device.getByRole("heading", { name: /Choose a vault/i });
		const switchLink = device.getByRole("button", { name: /Choose a different vault/i });
		if (!(await picker.isVisible().catch(() => false))) await switchLink.click();
		await device.getByRole("button", { name: /Create new vault/i }).click();
		await device.getByRole("button", { name: /Join a device/i }).click();
		const paste = device.getByRole("button", { name: /Paste code instead/i });
		if (await paste.isVisible().catch(() => false)) await paste.click();
		await device.getByPlaceholder(/Paste the code from your other device/i).fill(code);
		await device.getByLabel(/Master password/i).fill(STRONG_PW);
		await device.getByRole("button", { name: /Join vault/i }).click();

		// --- the SAS gate ---
		// Worth having here as well as in the mobile-web spec: this is the only run where the
		// joiner's SAS comes out of the native Rust core's handshake on a real device, so it is
		// what proves the Android build derives the same number the extension does.
		const deviceSas = device.locator("p.font-mono.tabular-nums");
		await expect(deviceSas).toBeVisible({ timeout: 90_000 });
		await expect(inviter.page.getByText(/Is this your device\?/i)).toBeVisible({
			timeout: 90_000,
		});
		const inviterSas = inviter.page.locator("p.font-mono.tabular-nums");
		await expect(inviterSas).toHaveText(/^\d{4} \d{4} \d{4}$/);
		expect(await inviterSas.textContent()).toBe(await deviceSas.textContent());
		await inviter.page.getByRole("button", { name: /Numbers match, approve/i }).click();

		// The device now holds a vault it did not create...
		await expect(device.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
			timeout: 90_000,
		});
		joined = true;
		// ...and can READ the inviter's entry, decrypted by the native Rust core.
		await expect(device.getByText(NAME)).toBeVisible({ timeout: 90_000 });
	} finally {
		// Remove only the vault this test created; it is the active one right after joining.
		if (joined) {
			try {
				await device.getByRole("button", { name: "Settings" }).click();
				await device.getByRole("button", { name: "General", exact: true }).click();
				await device
					.getByRole("button", { name: /Delete this vault/i })
					.first()
					.click();
				await device.getByLabel(/Master password/i).fill(STRONG_PW);
				await device
					.getByRole("button", { name: /Delete this vault/i })
					.last()
					.click();
				await expect(device.getByText(/Choose a vault|Welcome to Bramble/i).first()).toBeVisible();
			} catch {
				// Leave it rather than flailing: a stray e2e-* vault is obvious and harmless.
			}
		}
		await inviter.context.close();
		rmSync(inviter.profileDir, { recursive: true, force: true });
		stopReverse();
	}
});
