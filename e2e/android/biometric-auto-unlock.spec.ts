import type { Locator } from "@playwright/test";
import { STRONG_PW } from "../extension/helpers";
import { APP_ID, adbShell, expect, test } from "./fixtures";

/**
 * "Unlock on open" (issue #43) on a REAL device. Two seams, because the interesting half is
 * outside the WebView: `dumpsys biometric` proves the OS raised a prompt, the DOM's "Verifying…"
 * proves the app asked for it unprompted.
 *
 * ONE MANUAL STEP: arming the gate needs a real fingerprint (the Keystore key is
 * `setUserAuthenticationRequired`, and a physical sensor cannot be driven from adb —
 * `cmd fingerprint fingerdown` is virtual-sensor-only). The test says when to touch and waits;
 * nothing after that needs a finger. On an emulator `adb emu finger touch 1` closes the gap.
 *
 * Device gotchas: clicks are `force`, because the soft keyboard resizes the viewport and
 * Playwright's stability check then times out on perfectly tappable buttons; and KEYCODE_BACK
 * cancels the prompt but also reaches Capacitor's back handler, and Android may restore the
 * dismissed BiometricPrompt fragment on the next resume — so post-cancel assertions stay in the
 * foreground.
 *
 * MUTATES the device: creates its own vault and deletes it at the end.
 */

// Long enough for a prompt to appear, and how long we watch for one that must not.
const SETTLE_MS = 4_000;
const TOUCH_TIMEOUT = 90_000;

/** Non-null exactly while a BiometricPrompt is up. */
const gateIsUp = (): boolean => !/CurrentSession:\s*null/.test(adbShell("dumpsys biometric"));

/** Fingerprints enrolled for the primary user; 0 means this spec cannot run. */
function enrolledCount(): number {
	const primary = /"id":0,"count":(\d+)/.exec(adbShell("dumpsys fingerprint"));
	return primary ? Number(primary[1]) : 0;
}

const relaunch = () =>
	adbShell(`monkey -p ${APP_ID} -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1`);

/** The background/return cycle "Immediately" auto-lock keys off. */
async function backgroundAndReturn(): Promise<void> {
	adbShell("input keyevent KEYCODE_HOME");
	await new Promise((r) => setTimeout(r, 1_500));
	relaunch();
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Set a Toggle to a known state: the pref is device-global, so a blind click is a coin toss. */
async function setToggle(toggle: Locator, on: boolean): Promise<void> {
	const pressed = (await toggle.getAttribute("aria-pressed")) === "true";
	if (pressed !== on) await toggle.click({ force: true });
	await expect(toggle).toHaveAttribute("aria-pressed", String(on));
}

test("'Unlock on open' raises the gate by itself, once, and only when it should", async ({
	page,
}) => {
	test.skip(enrolledCount() === 0, "no fingerprint enrolled on this device");
	test.setTimeout(360_000);

	const label = `e2e-${Date.now().toString(36)}`;
	const lockButton = page.getByRole("button", { name: "Lock vault", exact: true });
	const biometricButton = page.getByRole("button", { name: /Unlock with biometrics/i });
	const verifying = page.getByRole("button", { name: /Verifying…/ });
	const autoRow = page.getByText("Unlock on open", { exact: true });
	const autoToggle = page.getByRole("button", { name: /Toggle unlock on open/i });
	let created = false;

	// The submit button is the flakiest thing on a phone; the form takes Enter.
	const unlockWithPassword = async () => {
		const field = page.locator('input[type="password"]').first();
		await field.fill(STRONG_PW);
		await field.press("Enter");
		await expect(lockButton).toBeVisible({ timeout: 60_000 });
	};

	const openSecuritySettings = async () => {
		await page.getByRole("button", { name: "Settings" }).click({ force: true });
		await page.getByRole("button", { name: "Security", exact: true }).click({ force: true });
		await expect(page.getByText("Biometric unlock", { exact: true })).toBeVisible();
	};

	try {
		// --- a disposable vault of our own ---
		if (await lockButton.isVisible().catch(() => false)) await lockButton.click({ force: true });
		const switchLink = page.getByRole("button", { name: /Choose a different vault/i });
		if (await switchLink.isVisible().catch(() => false)) await switchLink.click({ force: true });
		await page
			.getByRole("button", { name: /Create (new|another) vault/i })
			.first()
			.click({ force: true });
		await page.getByLabel("Vault name").fill(label);
		await page.getByLabel("Master password", { exact: true }).fill(STRONG_PW);
		await page.getByLabel("Confirm master password").fill(STRONG_PW);
		await page.getByRole("button", { name: "Create vault", exact: true }).click({ force: true });
		await page.getByRole("button", { name: /I've saved it/i }).click({ force: true });
		await expect(lockButton).toBeVisible({ timeout: 60_000 });
		created = true;

		// --- the toggle is not offered until there is a gate to open ---
		await openSecuritySettings();
		await expect(autoRow).toBeHidden();

		// --- arm the gate (the one manual step) ---
		await page
			.getByRole("button", { name: "Biometric unlock", exact: true })
			.click({ force: true });
		await expect.poll(gateIsUp, { timeout: 20_000 }).toBe(true);
		console.log("\n>>> TOUCH THE FINGERPRINT SENSOR to arm the gate (waiting)…\n");
		await expect(autoRow).toBeVisible({ timeout: TOUCH_TIMEOUT });
		await setToggle(autoToggle, true);
		await page.getByRole("button", { name: "Go back" }).click({ force: true });

		// --- the feature: the unlock screen prompts without being asked ---
		await backgroundAndReturn();
		await expect(verifying).toBeVisible({ timeout: 30_000 });
		await expect.poll(gateIsUp, { timeout: 20_000 }).toBe(true);

		// --- a cancel is an answer, not an error ---
		adbShell("input keyevent KEYCODE_BACK");
		await expect.poll(gateIsUp, { timeout: 20_000 }).toBe(false);
		relaunch(); // BACK can reach Capacitor's handler and minimize the app
		await expect(biometricButton).toBeEnabled({ timeout: 20_000 });
		await expect(page.getByText(/Cancelled|Authentication failed/i)).toBeHidden();
		// One attempt per lock episode, so no second prompt while we sit here.
		await pause(SETTLE_MS);
		expect(gateIsUp()).toBe(false);
		await expect(verifying).toBeHidden();

		// --- an explicit Lock is honoured, even across a background cycle ---
		await unlockWithPassword();
		await lockButton.click({ force: true });
		await expect(biometricButton).toBeVisible();
		await backgroundAndReturn();
		await pause(SETTLE_MS);
		expect(gateIsUp()).toBe(false);
		await expect(verifying).toBeHidden();

		// --- and it is genuinely opt-in ---
		await unlockWithPassword();
		await openSecuritySettings();
		await setToggle(autoToggle, false);
		await page.getByRole("button", { name: "Go back" }).click({ force: true });
		await backgroundAndReturn();
		await expect(biometricButton).toBeVisible({ timeout: 30_000 });
		await pause(SETTLE_MS);
		expect(gateIsUp()).toBe(false);
		await expect(verifying).toBeHidden();
	} finally {
		if (created) {
			try {
				if (await biometricButton.isVisible().catch(() => false)) await unlockWithPassword();
				await page.getByRole("button", { name: "Settings" }).click({ force: true });
				await page.getByRole("button", { name: "General", exact: true }).click({ force: true });
				await page
					.getByRole("button", { name: /Delete this vault/i })
					.first()
					.click({ force: true });
				await page.getByLabel(/Master password/i).fill(STRONG_PW);
				await page
					.getByRole("button", { name: /Delete this vault/i })
					.last()
					.click({ force: true });
				await expect(page.getByText(/Choose a vault|Welcome to Bramble/i).first()).toBeVisible();
			} catch {
				// Leave it rather than flailing: a stray e2e-* vault is obvious and harmless.
			}
		}
	}
});
