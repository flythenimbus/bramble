import { type BrowserContext, expect, type Page, type Worker } from "@playwright/test";

export const optionsUrl = (id: string) => `chrome-extension://${id}/options.html`;
export const popupUrl = (id: string) => `chrome-extension://${id}/popup.html`;

/** A strong master password that clears the weak-password gate (so "Create vault" enables). */
export const STRONG_PW = "Zx9-mQ2-vLp7-wK4-tR8";

/**
 * Create the first vault through the full-tab options setup flow (which the popup's "Create your
 * vault" opens). Leaves the vault created and unlocked. Pass through the recovery-code screen.
 */
/** The picker drops clicks in its first 500 ms on screen and again after it moves, since a page
 *  could put it under a click already in flight. Wait that out before clicking a row. */
export async function waitOutPickerClickGuard(page: Page): Promise<void> {
	await page.waitForTimeout(600);
}

export async function createVault(page: Page, extensionId: string, password = STRONG_PW) {
	await page.goto(optionsUrl(extensionId));
	await expect(page.locator("#root")).not.toBeEmpty();
	await page.locator('input[type="password"]').first().fill(password);
	await page.locator('input[type="password"]').nth(1).fill(password);
	await page.getByRole("button", { name: "Create vault" }).click();
	await page.getByRole("button", { name: /I've saved it/i }).click();
	await expect(page.getByRole("heading", { name: /Vault ready/i })).toBeVisible();
}

/** Open the popup UI and wait for the app to mount. */
export async function openPopup(page: Page, extensionId: string) {
	await page.goto(popupUrl(extensionId));
	await expect(page.locator("#root")).not.toBeEmpty();
}

/** True once the popup shows an unlocked vault (the header lock button is only present then). */
export async function expectUnlocked(page: Page) {
	await expect(page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
}

/** Lock the unlocked popup via its header lock button; resolves on the unlock screen. */
export async function lock(page: Page) {
	await page.getByRole("button", { name: "Lock vault", exact: true }).click();
	await expect(page.getByRole("heading", { name: /master password to unlock/i })).toBeVisible();
}

/** Unlock the locked popup with the master password. */
export async function unlock(page: Page, password = STRONG_PW) {
	await page.locator('input[type="password"]').first().fill(password);
	await page.getByRole("button", { name: "Unlock Vault" }).click();
	await expectUnlocked(page);
}

/** Lock the popup and land on the vault picker. Locking keeps the vault selected, so it shows
 * that vault's unlock screen; follow "Choose a different vault" to reach the picker. */
export async function lockToPicker(page: Page) {
	await page.getByRole("button", { name: "Lock vault", exact: true }).click();
	const picker = page.getByRole("heading", { name: /Choose a vault/i });
	const switchLink = page.getByRole("button", { name: /Choose a different vault/i });
	await expect(picker.or(switchLink)).toBeVisible();
	if (!(await picker.isVisible())) await switchLink.click();
	await expect(picker).toBeVisible();
}

/** Pick a vault from the picker by its label, unlocking with the password if prompted. */
export async function selectVault(page: Page, name: RegExp, password = STRONG_PW) {
	await page.getByRole("button", { name }).click();
	const lockBtn = page.getByRole("button", { name: "Lock vault", exact: true });
	const pw = page.locator('input[type="password"]').first();
	// The app either opens the vault directly (its VEK is cached) or asks for the password.
	await expect(lockBtn.or(pw)).toBeVisible();
	if (!(await lockBtn.isVisible())) {
		await pw.fill(password);
		await page.getByRole("button", { name: "Unlock Vault" }).click();
	}
	await expectUnlocked(page);
}

/** Add the saved login the autofill specs match against (alice@example.com on example.com),
 * through the unlocked popup's own UI. */
export async function seedExampleLogin(popup: Page, url = "https://example.com") {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Example Login");
	await popup.getByRole("button", { name: /Add URL/i }).click();
	await popup.getByLabel("Website URL", { exact: true }).fill(url);
	await popup.getByLabel("Username or email", { exact: true }).fill("alice@example.com");
	await popup.getByLabel("Password", { exact: true }).fill("s3cr3t-pw-01");
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByText("Example Login")).toBeVisible();
}

/** Add a login for example.com carrying an authenticator key, through the popup's own UI. */
export async function seedTotpLogin(popup: Page, name: string, key: string) {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill(name);
	await popup.getByRole("button", { name: /Add URL/i }).click();
	await popup.getByLabel("Website URL", { exact: true }).fill("https://example.com");
	await popup.getByLabel("Username or email", { exact: true }).fill("alice@example.com");
	await popup.getByLabel("Password", { exact: true }).fill("s3cr3t-pw-01");
	await popup.getByLabel("Authenticator key (TOTP)", { exact: true }).fill(key);
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByText(name)).toBeVisible();
}

/** Seed one payment card. Cards are offered on any payment form, so it needs no URL. */
export async function seedExampleCard(popup: Page) {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Payment card/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Personal Visa");
	await popup.getByLabel("Cardholder name", { exact: true }).fill("Alice Example");
	await popup.getByLabel("Card number", { exact: true }).fill("4242424242424242");
	await popup.getByLabel("Month (MM)", { exact: true }).fill("04");
	await popup.getByLabel("Year (YY)", { exact: true }).fill("2030");
	await popup.getByLabel("CVV", { exact: true }).fill("123");
	await popup.getByRole("button", { name: /^Save/i }).click();
	await expect(popup.getByText("Personal Visa")).toBeVisible();
}

/** A second card, so a pick has something to be switched away from (and an order to change). */
export async function seedSecondCard(popup: Page) {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Payment card/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Travel Mastercard");
	await popup.getByLabel("Cardholder name", { exact: true }).fill("Alice Example");
	await popup.getByLabel("Card number", { exact: true }).fill("5555555555554444");
	await popup.getByLabel("Month (MM)", { exact: true }).fill("11");
	await popup.getByLabel("Year (YY)", { exact: true }).fill("2032");
	await popup.getByLabel("CVV", { exact: true }).fill("987");
	await popup.getByRole("button", { name: /^Save/i }).click();
	await expect(popup.getByText("Travel Mastercard")).toBeVisible();
}

type CdpNode = {
	nodeId: number;
	attributes?: string[];
	children?: CdpNode[];
	shadowRoots?: CdpNode[];
};

function findById(node: CdpNode, id: string): CdpNode | undefined {
	const attrs = node.attributes ?? [];
	for (let i = 0; i < attrs.length; i += 2) {
		if (attrs[i] === "id" && attrs[i + 1] === id) return node;
	}
	for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
		const hit = findById(child, id);
		if (hit) return hit;
	}
	return undefined;
}

/**
 * Click a corner-prompt button by its `data-tp-action`. The card is a closed shadow root that
 * selectors can't reach, so locate the button over CDP (which pierces closed roots) and send a
 * real mouse click to its centre.
 */
export async function clickCornerAction(page: Page, action: string) {
	const cdp = await page.context().newCDPSession(page);
	try {
		const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
		const shadow = findById(root, "bramble-corner-prompt")?.shadowRoots?.[0];
		if (!shadow) throw new Error("corner prompt is not mounted");
		const { nodeId } = await cdp.send("DOM.querySelector", {
			nodeId: shadow.nodeId,
			selector: `[data-tp-action="${action}"]`,
		});
		if (!nodeId) throw new Error(`corner prompt has no "${action}" button`);
		const { quads } = await cdp.send("DOM.getContentQuads", { nodeId });
		const q = quads[0];
		if (!q) throw new Error(`"${action}" button is not rendered`);
		await page.mouse.click((q[0]! + q[4]!) / 2, (q[1]! + q[5]!) / 2);
	} finally {
		await cdp.detach();
	}
}

/** From an unlocked popup, open Settings and select the Device sync panel. */
export async function gotoSync(page: Page) {
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Sync", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Device sync" })).toBeVisible();
}

/** From an unlocked popup, open Settings and select the Backups panel. */
export async function gotoBackups(page: Page) {
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Backups", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Cloud backups" })).toBeVisible();
}

/** The background service worker, for reading/writing the extension's storage in a test. */
export async function backgroundWorker(context: BrowserContext): Promise<Worker> {
	let [sw] = context.serviceWorkers();
	if (!sw) sw = await context.waitForEvent("serviceworker");
	return sw;
}

/** Every key in chrome.storage.local (the extension's persisted state). */
export async function localStorageKeys(context: BrowserContext): Promise<string[]> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)));
}

/**
 * Attach a CDP virtual authenticator to `page`, so a WebAuthn ceremony completes with no
 * hardware and no human. This is what makes tap-to-unlock testable in CI at all.
 *
 * `hasPrf` is the interesting knob. With it off you get the failure a real user hits by
 * choosing their browser's own passkey store instead of iCloud Keychain: a perfectly good
 * user-verified credential that then declines to produce a secret. That case is awkward to
 * trigger by hand (you have to hope the OS dialog offers the wrong option) and trivial here.
 *
 * `transport: "internal"` emulates a platform authenticator (Touch ID / Windows Hello);
 * "usb" emulates a security key. See docs/security-keys.md.
 */
export async function addVirtualAuthenticator(
	page: Page,
	opts: { hasPrf?: boolean; transport?: "internal" | "usb" } = {},
): Promise<{ authenticatorId: string; remove: () => Promise<void> }> {
	const { hasPrf = true, transport = "internal" } = opts;
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			ctap2Version: "ctap2_1",
			transport,
			hasResidentKey: true,
			hasUserVerification: true,
			hasPrf,
			// No prompt to click: the authenticator reports presence and verification itself.
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	return {
		authenticatorId,
		remove: () => cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }),
	};
}

/** Register a key through the real Settings UI. Requires an unlocked vault on `page`. */
export async function addTapToUnlockKey(
	page: Page,
	kind: "This device" | "Security key",
	label?: string,
) {
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Security", exact: true }).click();
	await page.getByRole("button", { name: "Add", exact: true }).click();
	if (label) await page.getByPlaceholder(/Name this key/i).fill(label);
	await page.getByRole("button", { name: kind, exact: true }).click();
}

/**
 * From an unlocked popup, configure an alias provider with a throwaway key.
 *
 * Deliberately never presses "Check key": the key field persists on blur, so this saves a
 * provider without contacting Addy or SimpleLogin. A test that reached a real provider would
 * need a secret in CI, would spend the user's alias allowance on every run, and would fail
 * whenever a third party did.
 */
export async function configureAliasProvider(page: Page, apiKey = "test-key-not-real") {
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Aliases", exact: true }).click();
	const key = page.locator('input[type="password"]').first();
	await key.fill(apiKey);
	await key.blur();
	// The Disconnect button only exists once a provider is stored, so it is the tell that the
	// write landed rather than a timeout.
	await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

/** Add a login through the real create-entry UI. */
export async function addLogin(page: Page, name: string): Promise<void> {
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
