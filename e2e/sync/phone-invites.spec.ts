import { type Browser, chromium, type Page } from "@playwright/test";
import {
	addLogin,
	createVault,
	enterCode,
	expect,
	gotoSync,
	invite,
	test,
	useLocalRelay,
	withoutWebRTC,
} from "./fixtures";

// The app as the INVITER, which the other specs never are (the extension always invites there).
// Its first pairing makes the group, and sync used to start only on unlock, so nothing crossed
// until the phone was locked and unlocked. Also run with the inviter lacking WebRTC, as the Linux
// desktop app does (#228): every frame then rides the relay.

const MOBILE_URL = process.env.MOBILE_APP_URL ?? "http://localhost:5199";

async function openApp(browser: Browser, rtc: boolean): Promise<Page> {
	const page = await (await browser.newContext()).newPage();
	await page.goto(MOBILE_URL, { waitUntil: "domcontentloaded" });
	await page.locator("#root").waitFor();
	if (!rtc) await withoutWebRTC(page);
	return page;
}

for (const inviterRtc of [true, false]) {
	test(`the app invites ${inviterRtc ? "with" : "without"} WebRTC: pairs, then edits cross both ways`, async () => {
		const browser = await chromium.launch();
		try {
			const inviter = await openApp(browser, inviterRtc);
			// createVault clicks this only if it is already showing, which it isn't straight after a load.
			await inviter.getByRole("button", { name: /Create your vault/i }).click();
			await createVault(inviter);
			await gotoSync(inviter);
			await useLocalRelay(inviter);
			const code = await invite(inviter);

			const joiner = await openApp(browser, true);
			await joiner.getByRole("button", { name: /Create your vault/i }).click();
			await joiner.getByRole("button", { name: /Join a device/i }).click();
			await enterCode(joiner, code);
			await expect(inviter.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
			await inviter.getByRole("button", { name: /They match, approve/i }).click();
			await expect(joiner.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
				timeout: 90_000,
			});
			// Back to the list, which Settings doesn't show.
			await inviter.getByRole("button", { name: /Go to vault/i }).click();

			await addLogin(joiner, "From the joiner");
			await expect(inviter.getByText("From the joiner")).toBeVisible({ timeout: 45_000 });
			await addLogin(inviter, "From the inviter");
			await expect(joiner.getByText("From the inviter")).toBeVisible({ timeout: 45_000 });
		} finally {
			await browser.close();
		}
	});
}
