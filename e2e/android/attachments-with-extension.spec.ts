import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { launchExtensionContext } from "../extension/fixtures";
import { optionsUrl, popupUrl, STRONG_PW } from "../extension/helpers";
import { adb, adbReverse, adbShell, expect, test } from "./fixtures";

// An attachment crosses between the extension and the SHIPPED Android app, both ways, over the
// blob session's WebRTC connection. The phone side is what nothing else reaches: the native
// sealer, the native blob store and the WebView's own WebRTC.
//
// Same environment as pair-with-extension.spec.ts: adb reverse for the relay, and a real IP route
// between phone and host for the data channel. It MUTATES the device: the joiner ends up with a
// new vault, which it deletes at the end; a failure partway can leave it behind. Start with the
// app on its vault picker or a vault's unlock screen.

const RELAY = "ws://localhost:7400";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const runAs = (cmd: string) => adbShell(`run-as app.bramble.mobile sh -c '${cmd}; true'`);
const top = () => adbShell("dumpsys activity activities | grep topResumedActivity | head -1");

async function launchInviter(): Promise<{
	context: BrowserContext;
	page: Page;
	extensionId: string;
	profileDir: string;
}> {
	const { context, extensionId, profileDir } = await launchExtensionContext();
	const page = await context.newPage();
	page.setDefaultTimeout(60_000);
	await page.goto(optionsUrl(extensionId));
	await page.locator("#root").waitFor();
	return { context, page, extensionId, profileDir };
}

/** The attachment's own row: the entry card around it matches the same text. */
const attachmentRow = (page: Page, name: string) =>
	page.locator("div.rounded-lg.border").filter({ hasText: name }).last();

test("an attachment crosses between the extension and the phone, both ways", async ({
	page: device,
}) => {
	test.setTimeout(600_000);
	adb([
		"shell",
		"monkey",
		"-p",
		"app.bramble.mobile",
		"-c",
		"android.intent.category.LAUNCHER",
		"1",
	]);
	const stopReverse = adbReverse(7400);
	const inviter = await launchInviter();
	let joined = false;
	const NAME = `e2e-files-${Date.now().toString(36)}`;

	try {
		// --- inviter: a vault with one login, pointed at the local relay, inviting ---
		const pw = inviter.page.locator('input[type="password"]');
		await pw.nth(0).fill(STRONG_PW);
		await pw.nth(1).fill(STRONG_PW);
		await inviter.page.getByRole("button", { name: "Create vault" }).click();
		await inviter.page.getByRole("button", { name: /I've saved it/i }).click();
		await inviter.page.goto(`${popupUrl(inviter.extensionId)}?detached=1`);
		await expect(
			inviter.page.getByRole("button", { name: "Lock vault", exact: true }),
		).toBeVisible();
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
		await inviter.page.getByRole("button", { name: "Continue", exact: true }).click();
		const code = await inviter.page.locator("input[readonly]").inputValue();

		// --- joiner: the app on the device ---
		const joinTab = device.getByRole("button", { name: /^Join a device$/i });
		if (!(await joinTab.isVisible().catch(() => false))) {
			const picker = device.getByRole("heading", { name: /Choose a vault/i });
			const switchLink = device.getByRole("button", { name: /Choose a different vault/i });
			if (!(await picker.isVisible().catch(() => false))) await switchLink.click();
			await device.getByRole("button", { name: /Create new vault/i }).click();
		}
		await joinTab.click();
		const paste = device.getByRole("button", { name: /Paste code instead/i });
		if (await paste.isVisible().catch(() => false)) await paste.click();
		await device.getByPlaceholder(/Paste the code from your other device/i).fill(code);
		await device.getByLabel(/Master password/i).fill(STRONG_PW);
		await device.getByRole("button", { name: /Join vault/i }).click();
		await expect(inviter.page.getByText(/Is this your device\?/i)).toBeVisible({
			timeout: 90_000,
		});
		await inviter.page.getByRole("button", { name: /They match, approve/i }).click();
		await expect(device.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
			timeout: 90_000,
		});
		joined = true;
		await expect(device.getByText(NAME)).toBeVisible({ timeout: 90_000 });

		// --- extension -> phone ---
		// The window comes back on the screen it was left on, which is Sync; the header goes home.
		await inviter.page.goto(`${popupUrl(inviter.extensionId)}?detached=1`);
		const goVault = inviter.page.getByRole("button", { name: "Go to vault" });
		await goVault.click();
		await inviter.page.getByText(NAME).click();
		// Past one sealed chunk, so a boundary slip shows.
		const fromExt = Buffer.from(
			Uint8Array.from({ length: 3 * 256 * 1024 + 777 }, (_, i) => (i * 7 + (i >> 9)) % 251),
		);
		await inviter.page
			.locator('input[type="file"]')
			.setInputFiles({ name: "from-chrome.pdf", mimeType: "application/pdf", buffer: fromExt });
		await expect(inviter.page.getByText("from-chrome.pdf")).toBeVisible();

		await device.getByText(NAME).click();
		const onPhone = attachmentRow(device, "from-chrome.pdf");
		await expect(onPhone.getByRole("button", { name: "Open attachment" })).toBeVisible({
			timeout: 300_000,
		});
		await onPhone.getByRole("button", { name: "Open attachment" }).click();
		// The share sheet opens once the decrypted copy is whole.
		await expect.poll(top, { timeout: 60_000 }).toMatch(/intentresolver|Chooser/);
		const copy = runAs("ls cache/open/*/from-chrome.pdf").split("\n")[0];
		expect(runAs(`sha256sum ${copy}`).split(" ")[0]).toBe(sha(fromExt));
		adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
		await expect.poll(top).toMatch(/MainActivity/);

		// --- phone -> extension ---
		const fromPhone = Buffer.from(
			Uint8Array.from({ length: 2 * 256 * 1024 + 99 }, (_, i) => (i * 11 + 3) % 253),
		);
		await device
			.locator('input[type="file"]')
			.setInputFiles({ name: "from-phone.jpg", mimeType: "image/jpeg", buffer: fromPhone });
		await expect(device.getByText("from-phone.jpg")).toBeVisible({ timeout: 120_000 });

		await inviter.page.reload();
		await goVault.click();
		await inviter.page.getByText(NAME).click();
		const inExt = attachmentRow(inviter.page, "from-phone.jpg");
		await expect(inExt.getByRole("button", { name: "Open attachment" })).toBeVisible({
			timeout: 300_000,
		});
		const downloading = inviter.page.waitForEvent("download");
		await inExt.getByRole("button", { name: "Open attachment" }).click();
		const download = await downloading;
		expect(download.suggestedFilename()).toBe("from-phone.jpg");
		expect(sha(readFileSync((await download.path()) as string))).toBe(sha(fromPhone));
	} finally {
		// Remove only the vault this test created; it is the active one after joining.
		if (joined) {
			try {
				if (!/MainActivity/.test(top())) adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
				const back = device.getByRole("button", { name: /^(Back|Go back)$/i }).first();
				if (await back.isVisible().catch(() => false)) await back.click();
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
				await expect(
					device.getByText(/Choose a vault|Welcome to Bramble|master password to unlock/i).first(),
				).toBeVisible();
			} catch {
				// Leave it rather than flailing: a stray vault named after this test is obvious.
			}
		}
		await inviter.context.close();
		rmSync(inviter.profileDir, { recursive: true, force: true });
		stopReverse();
	}
});
