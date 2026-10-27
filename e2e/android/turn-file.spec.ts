import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { forceRelayOnly, links, pairOverHostedRelay, total } from "./turn-pairing";

// A file each way between the extension and the app on a phone, over real TURN: the phone's WebRTC
// forced to relay-only, so the bytes have no other way across (docs/file-attachments.md, Transfer).
// Watches the phone's row on the way in, which says how far the file has got. Opt-in like
// turn-idle-traffic.spec.ts, and it mutates the device the same way:
//
//   BRAMBLE_TURN_MEASURE=1 BRAMBLE_EXTENSION=<dist-chromium> \
//     npx playwright test --config playwright.android.config.ts turn-file

const pattern = (len: number, seed: number) =>
	Buffer.from(Uint8Array.from({ length: len }, (_, i) => (i * seed + (i >> 12)) % 251));

/** An attachment's own row, the nearest rounded card around its name. */
const rowOf = (page: Page, name: string) =>
	page
		.getByText(name, { exact: true })
		.locator("xpath=ancestor::div[contains(@class, 'rounded-lg')][1]");

/** Every distinct line the row shows until the file can be opened. */
async function watchArrival(page: Page, name: string, timeoutMs: number): Promise<string[]> {
	const seen: string[] = [];
	const row = rowOf(page, name);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = (await row.innerText().catch(() => "")).split("\n").at(-1)?.trim() ?? "";
		if (text && !seen.includes(text)) seen.push(text);
		if (await row.getByRole("button", { name: "Open attachment" }).isVisible()) return seen;
		await page.waitForTimeout(1000);
	}
	throw new Error(`${name} never arrived; the row said: ${seen.join(" | ")}`);
}

test("a file crosses real TURN each way, and the row says how far it has got", async ({
	page: device,
	context,
}) => {
	test.skip(
		!process.env.BRAMBLE_TURN_MEASURE,
		"uses production TURN; opt in with BRAMBLE_TURN_MEASURE=1",
	);
	test.setTimeout(20 * 60_000);

	await forceRelayOnly(context, device);
	const { popup, cleanup } = await pairOverHostedRelay(device, { entry: "Passport" });
	try {
		await device.waitForTimeout(20_000);
		const start = await links(device);
		expect(start.length, "no connected peer connection on the phone").toBeGreaterThan(0);
		for (const l of start) expect(`${l.local}/${l.remote}`).toContain("relay");

		// --- browser to phone ---
		const toPhone = pattern(8 * 1024 * 1024, 5);
		await popup.getByText("Passport").first().click();
		await popup.locator('input[type="file"]').setInputFiles({
			name: "to-phone.bin",
			mimeType: "application/octet-stream",
			buffer: toPhone,
		});
		await expect(popup.getByText("to-phone.bin")).toBeVisible({ timeout: 60_000 });
		await device.getByText("Passport").first().click();
		const began = Date.now();
		const lines = await watchArrival(device, "to-phone.bin", 10 * 60_000);
		const afterIn = await links(device);
		console.log(`[turn] the phone's row said: ${lines.join(" | ")}`);
		console.log(
			`[turn] browser to phone: ${toPhone.length} B in ${Date.now() - began} ms; the phone received ${total(afterIn, "received") - total(start, "received")} B over TURN`,
		);
		expect(total(afterIn, "received") - total(start, "received")).toBeGreaterThan(toPhone.length);

		// --- phone to browser ---
		const toBrowser = pattern(4 * 1024 * 1024, 9);
		await device.locator('input[type="file"]').setInputFiles({
			name: "to-browser.bin",
			mimeType: "application/octet-stream",
			buffer: toBrowser,
		});
		await expect(device.getByText("to-browser.bin")).toBeVisible({ timeout: 5 * 60_000 });
		const sealed = Date.now();
		const open = rowOf(popup, "to-browser.bin").getByRole("button", { name: "Open attachment" });
		await expect(open).toBeEnabled({ timeout: 10 * 60_000 });
		const afterOut = await links(device);
		console.log(
			`[turn] phone to browser: ${toBrowser.length} B in ${Date.now() - sealed} ms after it sealed; the phone sent ${total(afterOut, "sent") - total(afterIn, "sent")} B over TURN`,
		);
		const downloading = popup.waitForEvent("download");
		await open.click();
		const download = await downloading;
		expect(download.suggestedFilename()).toBe("to-browser.bin");
		expect(readFileSync((await download.path()) as string).equals(toBrowser)).toBe(true);
	} finally {
		await cleanup();
	}
});
