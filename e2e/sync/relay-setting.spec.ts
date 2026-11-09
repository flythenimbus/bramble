import { lock, unlock } from "../extension/helpers";
import {
	addLogin,
	expect,
	gotoSync,
	type Peer,
	PW,
	pairWithPhone,
	RELAY_URL,
	test,
} from "./fixtures";

// Emptying the relay field used to save a blank, which the panel then showed as the hosted address.
// Sync read the blank back and handed it to new WebSocket, and on the desktop and iOS that ended it
// with "The string did not match the expected pattern." That exact text needs their tauri:// and
// capacitor:// origins, which Playwright can't serve, so these pin what has to be true on any
// origin: blank means the hosted relay, and an unusable address is refused in words.

const HOSTED_HOST = "bramble-relay.flythenimbus.workers.dev";
const HOSTED_RELAY = `wss://${HOSTED_HOST}`;

/** Long enough for a restarted session to find its peer again (the mesh re-announces every 30 s). */
const RECONNECT_WITHIN_MS = 90_000;

/**
 * Answer for the hosted relay from the local one, so a device can be seen going to the hosted
 * address and still reach its peer, without a byte reaching production. Covers the ICE endpoint
 * too, which derives from the relay. Reloads, because Playwright only swaps WebSocket when a page
 * loads, so call it before anything else. Returns how many sockets asked for the hosted address.
 */
async function answerForHostedRelay(peer: Peer): Promise<() => number> {
	let sockets = 0;
	await peer.context.route(`https://${HOSTED_HOST}/**`, (route) =>
		route.fulfill({
			json: { iceServers: [] },
			headers: { "Access-Control-Allow-Origin": "*" },
		}),
	);
	await peer.context.routeWebSocket(new RegExp(`^${HOSTED_RELAY}/?$`), (app) => {
		sockets++;
		const local = new WebSocket(RELAY_URL);
		const early: (string | Buffer)[] = [];
		local.onopen = () => {
			for (const message of early.splice(0)) local.send(message);
		};
		local.onmessage = (e) => app.send(e.data as string);
		local.onclose = () => void app.close().catch(() => {});
		app.onMessage((message) => {
			if (local.readyState === WebSocket.OPEN) local.send(message);
			else early.push(message);
		});
		app.onClose(() => local.close());
	});
	await peer.page.reload({ waitUntil: "domcontentloaded" });
	await peer.page.locator("#root").waitFor();
	return () => sockets;
}

/** What the phone has saved for the relay, as stored: JSON text, or null when nothing is. */
const savedRelay = (phone: Peer) =>
	phone.page.evaluate(() => localStorage.getItem("CapacitorStorage.meta:sync.relay"));

/** Settings apply when sync next starts, which is the next unlock. */
async function restartSync(phone: Peer): Promise<void> {
	await lock(phone.page);
	await unlock(phone.page, PW);
}

const openRelayField = async (phone: Peer) => {
	await gotoSync(phone.page);
	await phone.page.getByRole("button", { name: /Advanced/i }).click();
	return phone.page.getByLabel(/Nostr relay URL/i);
};

test("emptying the relay field goes back to the hosted relay", async ({ ext, mobile }) => {
	const hostedSockets = await answerForHostedRelay(mobile);
	const popup = await pairWithPhone(ext, mobile);

	await (await openRelayField(mobile)).fill("");
	await expect.poll(() => savedRelay(mobile)).toBeNull();
	await restartSync(mobile);

	await addLogin(popup, "Reached over the hosted address");
	await expect(mobile.page.getByText("Reached over the hosted address")).toBeVisible({
		timeout: RECONNECT_WITHIN_MS,
	});
	expect(hostedSockets()).toBeGreaterThan(0);

	// What the field shows is now what sync uses.
	await expect(await openRelayField(mobile)).toHaveValue(HOSTED_RELAY);
});

test("a blank an older version saved still means the hosted relay", async ({ ext, mobile }) => {
	const hostedSockets = await answerForHostedRelay(mobile);
	const popup = await pairWithPhone(ext, mobile);

	// Guards the key below: writing to one the app doesn't read would prove nothing.
	expect(await savedRelay(mobile)).toContain("localhost:7400");
	await mobile.page.evaluate(() =>
		localStorage.setItem("CapacitorStorage.meta:sync.relay", JSON.stringify("")),
	);
	await restartSync(mobile);

	await addLogin(mobile.page, "Sent from the phone");
	await expect(popup.getByText("Sent from the phone")).toBeVisible({
		timeout: RECONNECT_WITHIN_MS,
	});
	expect(hostedSockets()).toBeGreaterThan(0);
});

test("an address that can't be a relay is refused in words, not swapped for the hosted one", async ({
	ext,
	mobile,
}) => {
	const hostedSockets = await answerForHostedRelay(mobile);
	await pairWithPhone(ext, mobile);

	await (await openRelayField(mobile)).fill("relay.example.com");
	await expect.poll(() => savedRelay(mobile)).toContain("relay.example.com");
	await restartSync(mobile);

	await gotoSync(mobile.page);
	await expect(mobile.page.getByText("sync error: the relay URL isn't valid")).toBeVisible();
	expect(hostedSockets()).toBe(0);
});
