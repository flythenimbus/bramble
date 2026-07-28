import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launchExtensionContext } from "./fixtures";
import { backgroundWorker, createVault, openPopup, unlock } from "./helpers";

// Regression: a user sets Auto-lock = "Never" (0) and "Lock when the screen locks" = off (false),
// fully quits + reopens the browser, and the Settings UI shows the defaults again - even though
// chrome.storage.local still holds the values (both are FALSY, which is the tell). This drives the
// real restart (close + relaunch the same persistent profile, a cold browser start) and asserts the
// Settings UI reflects the stored values afterward.
test("lock settings survive a browser restart (Never + off)", async () => {
	const { context, extensionId, profileDir } = await launchExtensionContext();
	try {
		const page = await context.newPage();
		await createVault(page, extensionId);
		// Write both lock prefs as their FALSY values, exactly as the Settings toggles/select do.
		const sw = await backgroundWorker(context);
		await sw.evaluate(() =>
			chrome.storage.local.set({ "pref.autoLockMinutes": 0, "pref.lockOnScreenLock": false }),
		);
	} finally {
		await context.close();
	}

	// Restart: relaunch the same profile.
	const restart = await launchExtensionContext(profileDir);
	try {
		// Sanity: the values persisted across the restart.
		const sw = await backgroundWorker(restart.context);
		const stored = await sw.evaluate(() =>
			chrome.storage.local.get(["pref.autoLockMinutes", "pref.lockOnScreenLock"]),
		);
		expect(stored).toEqual({ "pref.autoLockMinutes": 0, "pref.lockOnScreenLock": false });

		// The UI must reflect them: Auto-lock select = Never ("0"), the toggle off (aria-pressed false).
		const popup = await restart.context.newPage();
		await openPopup(popup, restart.extensionId);
		await unlock(popup);
		await popup.getByRole("button", { name: "Settings" }).click();
		await popup.getByRole("button", { name: "General", exact: true }).click();

		await expect(popup.getByRole("combobox").first()).toHaveValue("0");
		await expect(
			popup.getByRole("button", { name: "Toggle lock when the screen locks" }),
		).toHaveAttribute("aria-pressed", "false");
	} finally {
		await restart.context.close();
		rmSync(profileDir, { recursive: true, force: true });
	}
});
