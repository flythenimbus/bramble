import { expect, test } from "./fixtures";
import {
	addTapToUnlockKey,
	addVirtualAuthenticator,
	createVault,
	expectUnlocked,
	lock,
	openPopup,
} from "./helpers";

// Tap to unlock (github issue #67), driven through the real Settings and unlock UI against a CDP
// virtual authenticator. Everything below was previously provable only by hand on real hardware,
// including two failures a human can barely reproduce on purpose. See docs/security-keys.md.

test("register a platform key, then unlock with it instead of the password", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);

	const popup = await context.newPage();
	await addVirtualAuthenticator(popup, { hasPrf: true });
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	await addTapToUnlockKey(popup, "This device", "Test Touch ID");
	await expect(popup.getByText("Test Touch ID")).toBeVisible();

	await lock(popup);
	await popup.getByRole("button", { name: /Tap to unlock/i }).click();
	await expectUnlocked(popup);
});

test("a provider without PRF is refused, and leaves no key behind", async ({
	context,
	extensionId,
}) => {
	// What a real user does by picking their browser's own passkey store over iCloud Keychain:
	// the credential is created and user-verified, then no secret comes back. Persisting a slot
	// here would leave an unlock method that can never work.
	const setup = await context.newPage();
	await createVault(setup, extensionId);

	const popup = await context.newPage();
	await addVirtualAuthenticator(popup, { hasPrf: false });
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	await addTapToUnlockKey(popup, "This device", "Doomed key");
	await expect(popup.getByText(/can't unlock your vault/i)).toBeVisible();
	await expect(popup.getByText("Doomed key")).toHaveCount(0);
});

test("a security key still registers after platform keys moved to a shared rpID", async ({
	context,
	extensionId,
}) => {
	// Regression guard for the rpID split: platform keys register under bramble.sh, security
	// keys deliberately stayed on the implicit extension-id rpID. Moving them would silently
	// invalidate every already-registered YubiKey.
	const setup = await context.newPage();
	await createVault(setup, extensionId);

	const popup = await context.newPage();
	await addVirtualAuthenticator(popup, { hasPrf: true, transport: "usb" });
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	await addTapToUnlockKey(popup, "Security key", "Test YubiKey");
	await expect(popup.getByText("Test YubiKey")).toBeVisible();

	await lock(popup);
	await popup.getByRole("button", { name: /Tap to unlock/i }).click();
	await expectUnlocked(popup);
});

test("falls back to the other rpID when the first one has nothing to offer", async ({
	context,
	extensionId,
}) => {
	// The retry exists because a vault's slots can live under two rpIDs with nothing recording
	// which is which. Registering both kinds and then taking the platform authenticator away
	// forces the ordering's first guess to miss, so the fallback is what completes the unlock.
	// Without removing it the platform rpID answers immediately and the retry never runs, which
	// is why this test is not simply "a mixed vault unlocks".
	const setup = await context.newPage();
	await createVault(setup, extensionId);

	const popup = await context.newPage();
	const platform = await addVirtualAuthenticator(popup, { hasPrf: true, transport: "internal" });
	await addVirtualAuthenticator(popup, { hasPrf: true, transport: "usb" });
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);

	await addTapToUnlockKey(popup, "This device", "Platform key");
	await expect(popup.getByText("Platform key")).toBeVisible();
	await addTapToUnlockKey(popup, "Security key", "Roaming key");
	await expect(popup.getByText("Roaming key")).toBeVisible();

	// The platform credential is gone; only the security key can answer now, and it lives under
	// the OTHER rpID. The vault still holds a platform label, so the order still guesses it first.
	await platform.remove();

	await lock(popup);
	await popup.getByRole("button", { name: /Tap to unlock/i }).click();
	await expectUnlocked(popup);
});
