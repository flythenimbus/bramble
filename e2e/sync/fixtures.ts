import { rmSync } from "node:fs";
import { type BrowserContext, test as base, chromium, type Page } from "@playwright/test";
import { launchExtensionContext } from "../extension/fixtures";

/**
 * Two REAL peers pairing over WebRTC through a real signaling relay.
 *
 * Peer A is the browser extension (its own persistent profile). Peer B is the mobile app —
 * the same Vite SPA that Capacitor wraps, loaded in an ordinary browser context. Both run the
 * shared @core sync transport, so the enrolment handshake, roster exchange and entry merge are
 * the production ones; only the native shell differs.
 *
 * This is the gap `e2e/README.md` called out: "A full two-device sync test (two contexts pairing
 * over WebRTC + a local relay) is a further step."
 *
 * What it does NOT cover: mobile's native layer. In a desktop browser Capacitor falls back to
 * the WASM crypto core and the web implementations of Filesystem/Preferences, not uniffi and the
 * Android ones. For that, see e2e/android (CDP over adb).
 */

/** Local signaling relay, started by playwright.sync.config.ts. */
export const RELAY_URL = process.env.SYNC_RELAY_URL ?? "ws://localhost:7400";
/** The mobile SPA dev server, also started by the config. */
export const MOBILE_URL = process.env.MOBILE_APP_URL ?? "http://localhost:5199";

/** Master password shared by both peers' vaults (the joiner must prove the same one). */
export const PW = "Zx9-mQ2-vLp7-wK4-tR8";

export interface Peer {
	context: BrowserContext;
	page: Page;
	/** Only the extension peer has one. */
	extensionId?: string;
}

/**
 * The mobile app in a plain browser context.
 *
 * Deliberately NOT seeded with the relay. Seeding storage here looks right and does nothing: the
 * joiner takes the relay from the pairing code (`PairingCodeSchema.relay`), and creating a vault
 * would wipe the key anyway (see launchExtensionPeer).
 */
async function launchMobilePeer(): Promise<Peer> {
	const browser = await chromium.launch();
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(MOBILE_URL, { waitUntil: "domcontentloaded" });
	await page.locator("#root").waitFor();
	return { context, page };
}

/**
 * The extension in its own profile.
 *
 * Also not seeded with the relay, for a reason worth knowing: creating the FIRST vault calls
 * resetSyncState(), which removes `sync.relay` along with the rest of the sync identity. Anything
 * written before that is silently discarded and the app falls back to the hosted relay. The spec
 * therefore sets it through the Advanced panel once the vault exists.
 */
async function launchExtensionPeer(): Promise<Peer & { profileDir: string }> {
	const { context, extensionId, profileDir } = await launchExtensionContext();
	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/options.html`);
	await page.locator("#root").waitFor();
	return { context, page, extensionId, profileDir };
}

export const test = base.extend<{ ext: Peer & { extensionId: string }; mobile: Peer }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures destructuring param.
	ext: async ({}, use) => {
		const peer = await launchExtensionPeer();
		await use(peer as Peer & { extensionId: string });
		await peer.context.close();
		rmSync(peer.profileDir, { recursive: true, force: true });
	},
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures destructuring param.
	mobile: async ({}, use) => {
		const peer = await launchMobilePeer();
		await use(peer);
		await peer.context.browser()?.close();
	},
});

export const expect = test.expect;

// --- shared UI drivers (the two peers render the same @core screens) ---

/** Create the first vault on a peer, through the setup flow. */
export async function createVault(page: Page, password = PW): Promise<void> {
	const start = page.getByRole("button", { name: /Create your vault/i });
	if (await start.isVisible().catch(() => false)) await start.click();
	const pw = page.locator('input[type="password"]');
	await pw.nth(0).fill(password);
	await pw.nth(1).fill(password);
	await page.getByRole("button", { name: "Create vault" }).click();
	await page.getByRole("button", { name: /I've saved it/i }).click();
}

/** Open Settings -> Sync on an unlocked peer. */
export async function gotoSync(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Sync", exact: true }).click();
	await expect(page.getByRole("heading", { name: /Device sync/i })).toBeVisible();
}
