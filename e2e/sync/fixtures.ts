import { rmSync } from "node:fs";
import { type BrowserContext, test as base, chromium, type Page } from "@playwright/test";
import { launchExtensionContext } from "../extension/fixtures";
import { popupUrl } from "../extension/helpers";

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
const MOBILE_URL = process.env.MOBILE_APP_URL ?? "http://localhost:5199";

/** Event bytes the local relay has forwarded so far (RELAY_STATS, set by the sync config). */
export async function relayedBytes(): Promise<number> {
	const res = await fetch(RELAY_URL.replace(/^ws/, "http").replace(/\/?$/, "/stats"));
	const stats = (await res.json().catch(() => null)) as { eventBytes?: number } | null;
	if (typeof stats?.eventBytes !== "number") {
		throw new Error(
			"the relay on 7400 serves no /stats: stop it and let the sync config start one with RELAY_STATS=1",
		);
	}
	return stats.eventBytes;
}

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

/** One extension peer for the life of a test, in a profile of its own. */
async function useExtensionPeer(use: (peer: Peer & { extensionId: string }) => Promise<void>) {
	const peer = await launchExtensionPeer();
	await use(peer as Peer & { extensionId: string });
	await peer.context.close();
	rmSync(peer.profileDir, { recursive: true, force: true });
}

export const test = base.extend<{
	ext: Peer & { extensionId: string };
	/** A second browser, for the tests that pair two extensions rather than one and a phone. */
	ext2: Peer & { extensionId: string };
	mobile: Peer;
}>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures destructuring param.
	ext: async ({}, use) => useExtensionPeer(use),
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures destructuring param.
	ext2: async ({}, use) => useExtensionPeer(use),
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures destructuring param.
	mobile: async ({}, use) => {
		const peer = await launchMobilePeer();
		await use(peer);
		await peer.context.browser()?.close();
	},
});

export const expect = test.expect;

/** Bring the mobile app back after its page closed: the same browser profile, so the same vault. */
export async function reopenMobile(peer: Peer): Promise<void> {
	peer.page = await peer.context.newPage();
	await peer.page.goto(MOBILE_URL, { waitUntil: "domcontentloaded" });
	await peer.page.locator("#root").waitFor();
}

// --- shared UI drivers (the two peers render the same @core screens) ---

/** Reload a peer's page with no RTCPeerConnection, as Firefox's extension contexts have none:
 * the mesh then reaches it only through the relay, which entries may use and files may not. */
export async function withoutWebRTC(page: Page): Promise<void> {
	await page.addInitScript(() => {
		delete (window as unknown as Record<string, unknown>).RTCPeerConnection;
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.locator("#root").waitFor();
}

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

/** The relay the sync config starts. Checked against the code itself, so pointing the suite at
 * another relay fails it rather than quietly exercising that one (see e2e/README.md). */
const LOCAL_RELAY_HOST = "localhost:7400";

/**
 * Point this peer's sync at the local relay, via the Advanced panel a user would use. After the
 * vault exists: creating the first one resets the relay (see launchExtensionPeer).
 */
export async function useLocalRelay(page: Page): Promise<void> {
	await page.getByRole("button", { name: /Advanced/i }).click();
	await page.getByLabel(/Nostr relay URL/i).fill(RELAY_URL);
	// The ICE endpoint derives from the relay; blank it so nothing reaches for the hosted one.
	await page.getByLabel(/TURN \/ ICE servers URL/i).fill("");
}

/**
 * Run the inviter flow from the Sync panel and return the pairing code. Re-auth included: adding
 * a device is authorised by the master password, not just an unlocked session.
 *
 * Only the inviter needs the relay configured, because the code carries it, so the code is
 * decoded and must name the local relay. Otherwise a spec would be silently exercising
 * production infrastructure.
 */
export async function invite(page: Page): Promise<string> {
	await page
		.getByRole("button", { name: /^Add a device$/i })
		.last()
		.click();
	await page.locator('input[type="password"]').first().fill(PW);
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	const codeField = page.locator("input[readonly]");
	await expect(codeField).toBeVisible();
	const code = await codeField.inputValue();
	expect(code).toMatch(/^bramble-pair-1\./);
	const { relay } = JSON.parse(
		Buffer.from(code.replace("bramble-pair-1.", ""), "base64").toString("utf8"),
	) as { relay: string };
	expect(relay, "the pairing code must name the local relay").toContain(LOCAL_RELAY_HOST);
	return code;
}

/** Enter a pairing code on a joiner already on the join form, taking the paste path where a
 * camera scanner is offered first. */
export async function enterCode(joiner: Page, code: string): Promise<void> {
	const paste = joiner.getByRole("button", { name: /Paste code instead/i });
	if (await paste.isVisible().catch(() => false)) await paste.click();
	await joiner.getByPlaceholder(/Paste the code from your other device/i).fill(code);
	await joiner.getByLabel(/Master password/i).fill(PW);
	await joiner.getByRole("button", { name: /Join vault/i }).click();
}

/** Add a login through the vault list's Add New. */
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

/** Comfortably above one 4-second sync tick plus a merge, far below the 10-minute backstop. */
export const EDIT_WITHIN_MS = 15_000;

/** Add a login on `from` and time how long `to` takes to show it. See edit-latency.spec.ts. */
export async function timeEdit(from: Page, to: Page, label: string): Promise<number> {
	const name = `${label} ${Date.now().toString(36)}`;
	await addLogin(from, name);
	const saved = Date.now();
	await expect(to.getByText(name)).toBeVisible({ timeout: EDIT_WITHIN_MS });
	const ms = Date.now() - saved;
	console.log(`[e2e] ${label}: ${ms} ms`);
	return ms;
}

/**
 * A vault on the extension, an invite over the local relay, and `phone` joined to it. Returns the
 * extension's detached popup on its vault list, opened before the other page goes to Sync: a new
 * popup restores the last route.
 */
export async function pairWithPhone(
	ext: Pick<Peer, "context" | "page"> & { extensionId: string },
	phone: Peer,
): Promise<Page> {
	await createVault(ext.page);
	const popup = await ext.context.newPage();
	await popup.goto(`${popupUrl(ext.extensionId)}?detached=1`);
	await expect(popup.getByRole("button", { name: /Add New/i })).toBeVisible();
	await ext.page.goto(popupUrl(ext.extensionId));
	await gotoSync(ext.page);
	await useLocalRelay(ext.page);
	const code = await invite(ext.page);
	await phone.page.getByRole("button", { name: /Create your vault/i }).click();
	await phone.page.getByRole("button", { name: /Join a device/i }).click();
	await enterCode(phone.page, code);
	await expect(ext.page.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	await ext.page.getByRole("button", { name: /They match, approve/i }).click();
	await expect(phone.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
		timeout: 90_000,
	});
	return popup;
}
