import { popupUrl } from "../extension/helpers";
import {
	createVault,
	enterCode,
	expect,
	gotoSync,
	invite,
	relayedBytes,
	test,
	useLocalRelay,
	withoutWebRTC,
} from "./fixtures";

// An idle vault costs the relay almost nothing: peers send the whole envelope only when it changed,
// and a heartbeat on the other ticks (docs/sync-rebroadcast.md). The phone has no WebRTC, so its
// entries are forwarded by the relay, whose /stats counts every byte it carried. The vault holds
// one large note, so a single whole envelope stands out from the heartbeats and hellos.

const NOTE = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(2600);

test("an idle vault costs the relay less than one envelope a minute", async ({ ext, mobile }) => {
	await withoutWebRTC(mobile.page);

	await createVault(ext.page);
	const popup = await ext.context.newPage();
	await popup.goto(`${popupUrl(ext.extensionId)}?detached=1`);
	await expect(popup.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup
		.getByRole("button", { name: /^Login/ })
		.first()
		.click();
	await popup.getByLabel(/^Name$/).fill("Big note");
	await popup.getByLabel(/Username or email/i).fill("me@example.com");
	await popup.getByLabel(/Notes/i).fill(NOTE);
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByText("Big note")).toBeVisible();

	await ext.page.goto(popupUrl(ext.extensionId));
	await gotoSync(ext.page);
	await useLocalRelay(ext.page);
	const code = await invite(ext.page);
	await mobile.page.getByRole("button", { name: /Create your vault/i }).click();
	await mobile.page.getByRole("button", { name: /Join a device/i }).click();
	await enterCode(mobile.page, code);
	await expect(ext.page.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	await ext.page.getByRole("button", { name: /They match, approve/i }).click();
	await expect(mobile.page.getByText("Big note")).toBeVisible({ timeout: 90_000 });

	// Let the first exchanges after joining settle, then watch a quiet minute.
	await mobile.page.waitForTimeout(15_000);
	const before = await relayedBytes();
	await mobile.page.waitForTimeout(60_000);
	const relayed = (await relayedBytes()) - before;
	console.log(`[e2e] an idle minute cost the relay ${relayed} bytes`);
	// Every 4 s both ways, as before, this would be about 30 envelopes.
	expect(relayed).toBeLessThan(NOTE.length);
});
