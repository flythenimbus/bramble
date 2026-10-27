import { timeEdit } from "../sync/fixtures";
import { expect, test } from "./fixtures";
import { forceRelayOnly, links, pairOverHostedRelay, total } from "./turn-pairing";

// How much an idle vault costs the hosted TURN relay, between the extension and the app on a real
// phone. Unlike every other spec this uses production infrastructure on purpose: the hosted relay
// and Cloudflare's TURN, since TURN's metered egress is what it measures. So it is opt-in:
//
//   BRAMBLE_TURN_MEASURE=1 BRAMBLE_EXTENSION=<dist-chromium> \
//     npx playwright test --config playwright.android.config.ts turn-idle-traffic
//
// The phone's WebRTC is forced to relay-only by a script injected before the app loads (nothing in
// the app changes), so every byte goes through TURN even with both devices on one network, and the
// same script keeps each connection so its stats can be read. See docs/sync-rebroadcast.md. It
// MUTATES the device: it joins a new vault and deletes it after, and keeps the screen on meanwhile.
// It ends by timing an edit each way over the same link.

// Under the app's default 15-minute auto-lock, which stops sync and closes the connections.
const MINUTES = Number(process.env.MEASURE_MINUTES ?? 12);
const NOTE = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(2600);

test("an idle vault over TURN, measured on the phone", async ({ page: device, context }) => {
	test.skip(
		!process.env.BRAMBLE_TURN_MEASURE,
		"measures production TURN; opt in with BRAMBLE_TURN_MEASURE=1",
	);
	test.setTimeout((MINUTES + 15) * 60_000);

	await forceRelayOnly(context, device);
	// One large note, so a whole envelope is easy to tell apart from heartbeats.
	const { popup, cleanup } = await pairOverHostedRelay(device, { entry: "Big note", note: NOTE });
	try {
		await device.waitForTimeout(30_000);
		const start = await links(device);
		console.log(`[turn] connections at the start: ${JSON.stringify(start)}`);
		expect(start.length, "no connected peer connection on the phone").toBeGreaterThan(0);
		for (const l of start) expect(`${l.local}/${l.remote}`).toContain("relay");
		console.log(`[turn] idle from ${new Date().toISOString()} for ${MINUTES} min`);
		for (let elapsed = 0; elapsed < MINUTES; ) {
			const step = Math.min(5, MINUTES - elapsed);
			await device.waitForTimeout(step * 60_000);
			elapsed += step;
			const now = await links(device);
			const sent = total(now, "sent") - total(start, "sent");
			const got = total(now, "received") - total(start, "received");
			console.log(
				`[turn] +${elapsed} min: phone sent ${sent} B, received ${got} B (${now.length} links)`,
			);
		}
		console.log(`[turn] idle until ${new Date().toISOString()}`);

		// Edits, both ways, over the same TURN link: seconds, not the 10-minute backstop.
		await timeEdit(popup, device, "[turn] browser to phone");
		await timeEdit(device, popup, "[turn] phone to browser");
		await device.waitForTimeout(20_000);
		await timeEdit(device, popup, "[turn] phone to browser, after a pause");
	} finally {
		await cleanup();
	}
});
