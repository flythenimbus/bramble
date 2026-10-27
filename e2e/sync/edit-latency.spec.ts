import { type Peer, pairWithPhone, test, timeEdit, withoutWebRTC } from "./fixtures";

// An edit reaches the other device within seconds, both ways, now that an unchanged vault is no
// longer resent every tick (docs/sync-rebroadcast.md). The extension pushes its own edits at once;
// the app, like the desktop app, sends its edits on the next 4-second tick, so either way an edit
// should land well inside the 10-minute backstop it must not depend on.

async function bothWays(ext: Peer & { extensionId: string }, mobile: Peer) {
	const popup = await pairWithPhone(ext, mobile);
	// Long enough for both sides' first exchanges to settle into heartbeats.
	await popup.waitForTimeout(15_000);
	await timeEdit(popup, mobile.page, "browser to phone");
	await timeEdit(mobile.page, popup, "phone to browser");
	// And again after a quiet stretch, so the second edit isn't riding the first one's sends.
	await popup.waitForTimeout(20_000);
	await timeEdit(mobile.page, popup, "phone to browser, after a pause");
}

test("an edit on either device reaches the other within seconds, over WebRTC", async ({
	ext,
	mobile,
}) => {
	await bothWays(ext, mobile);
});

test("...and over relay-forward, where the phone has no WebRTC", async ({ ext, mobile }) => {
	await withoutWebRTC(mobile.page);
	await bothWays(ext, mobile);
});
