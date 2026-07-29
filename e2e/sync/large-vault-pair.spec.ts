import type { Page } from "@playwright/test";
import { popupUrl } from "../extension/helpers";
import { createVault, expect, gotoSync, PW, RELAY_URL, test } from "./fixtures";

// A vault big enough that the enrolment bundle spans many Noise frames, transferred over a real
// transport and then torn down. That combination is the one thing neither the unit tests nor
// pair-and-sync.spec.ts can reach, and it is where the transport bites:
//
//   `sendSecure` resolving means the frames were handed to the channel, NOT that they were sent.
//   On the relay path `channel.send` only queues `void publish(...)`, which awaits two WebCrypto
//   ops before reaching the socket, while `mesh.stop()` closes the client synchronously in the
//   same macrotask. On WebRTC, `pc.close()` discards whatever SCTP still has queued, and nothing
//   in the transport drains `bufferedAmount`. With `stop()` running straight after the send, the
//   tail of the bundle was dropped, and losing one frame fails the whole message.
//
// The existing tests are structurally blind to it: pair-and-sync pairs a two-login vault (about
// 30 entries fit in one 32 KiB frame, so it is single-frame), and the enroll-host unit tests use
// in-memory channels, which model framing but not teardown. Hence a spec whose only job is size.
//
// Needs no physical device: the "mobile" peer is the same Vite SPA in a browser context. See
// fixtures.ts for what that does and does not cover.

const LOCAL_RELAY_HOST = "localhost:7400";

// Sized to comfortably exceed CHUNK_BYTES (32 KiB of plaintext per Noise frame) once encrypted
// and base64'd, so the bundle is many frames rather than borderline: a test that is only just
// multi-frame would go green again the moment an unrelated change shaved the payload.
const ENTRY_COUNT = 400;
const NOTE_PADDING = "p".repeat(200);
/** Imported last, so it can only be visible on the joiner if the FINAL frames survived. */
const LAST_ENTRY = `Zzz Final Entry ${ENTRY_COUNT - 1}`;

/** An unencrypted Bitwarden export: the cheapest real path to a large vault (the alternative is
 * 400 trips through the create-entry UI, which would dominate the suite's runtime). */
function bitwardenExport(count: number): string {
	const items = Array.from({ length: count }, (_, i) => ({
		type: 1,
		name: i === count - 1 ? LAST_ENTRY : `Imported Entry ${i}`,
		notes: `${NOTE_PADDING} ${i}`,
		login: {
			username: `user${i}@example.com`,
			password: `pw-${i}-Zx9mQ2vLp7wK4tR8`,
			uris: [{ uri: `https://site${i}.example.com` }],
		},
	}));
	return JSON.stringify({ encrypted: false, items });
}

/** Import the generated export through the real import wizard. */
async function importLargeVault(page: Page, extensionId: string): Promise<void> {
	await page.goto(`chrome-extension://${extensionId}/options.html?screen=import`);
	await page.locator("#root").waitFor();

	// The wizard gates on an unlocked vault; a freshly opened options page may be locked.
	const gate = page.getByLabel(/Master password/i);
	if (await gate.isVisible().catch(() => false)) {
		await gate.fill(PW);
		await page.getByRole("button", { name: /^Unlock$/i }).click();
	}

	// Each provider card owns a hidden file input; Bitwarden is the first.
	await expect(page.getByText(/Bitwarden/i).first()).toBeVisible();
	await page
		.locator('input[type="file"]')
		.first()
		.setInputFiles({
			name: "bitwarden-export.json",
			mimeType: "application/json",
			buffer: Buffer.from(bitwardenExport(ENTRY_COUNT), "utf8"),
		});

	// Preview, then commit. Parsing + writing 400 entries is real crypto, so allow for it.
	await expect(page.getByText(`${ENTRY_COUNT} items ready to import`)).toBeVisible({
		timeout: 60_000,
	});
	await page.getByRole("button", { name: new RegExp(`Import ${ENTRY_COUNT} items`) }).click();
	// Wait for the DONE screen specifically. Not the button disappearing: its accessible name
	// changes to "Importing…" the moment the write starts, so waiting for it to go away returns
	// immediately and navigating on that signal aborts the import, leaving an empty vault and a
	// spec that passes while proving nothing.
	await expect(page.getByText(`Imported ${ENTRY_COUNT} items`)).toBeVisible({ timeout: 180_000 });
}

test("a multi-frame vault survives the transfer and the teardown that follows it", async ({
	ext,
	mobile,
}) => {
	// Force the relay data path by hiding RTCPeerConnection from the joiner: the mesh only uses a
	// data channel when BOTH sides advertise it (mesh.ts:278), so one side is enough.
	//
	// Two reasons. First, it is the path real users on hardened Firefox or a hard NAT actually get,
	// and nothing else covers it end to end. Second, it is the only way this bug is reachable on one
	// machine: over loopback WebRTC the SCTP queue drains as fast as sendSecure can fill it, so the
	// truncation never reproduces (verified: the WebRTC version of this spec passes with the flush
	// barrier removed). On the relay path the loss is deterministic, because `channel.send` only
	// queues `void publish(...)`, which awaits two WebCrypto ops, while `mesh.stop()` closes the
	// relay client synchronously in the same macrotask.
	await mobile.page.addInitScript(() => {
		delete (window as unknown as Record<string, unknown>).RTCPeerConnection;
	});
	await mobile.page.reload({ waitUntil: "domcontentloaded" });
	await mobile.page.locator("#root").waitFor();

	// --- inviter: a vault whose bundle cannot fit in one frame ---
	await createVault(ext.page);
	await importLargeVault(ext.page, ext.extensionId);

	await ext.page.goto(popupUrl(ext.extensionId));
	await expect(ext.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();

	// Prove the inviter really holds the large vault before pairing it. Without this the spec
	// would still go green against an empty vault, which is exactly the failure mode it exists
	// to rule out (a single-frame bundle proves nothing about multi-frame teardown).
	await ext.page.getByLabel(/Search vault/i).fill(LAST_ENTRY);
	await expect(ext.page.getByText(LAST_ENTRY)).toBeVisible({ timeout: 30_000 });
	await ext.page.getByLabel(/Search vault/i).fill("");

	await gotoSync(ext.page);
	await ext.page.getByRole("button", { name: /Advanced/i }).click();
	await ext.page.getByLabel(/Nostr relay URL/i).fill(RELAY_URL);
	await ext.page.getByLabel(/TURN \/ ICE servers URL/i).fill("");

	await ext.page
		.getByRole("button", { name: /^Add a device$/i })
		.last()
		.click();
	await ext.page.locator('input[type="password"]').first().fill(PW);
	await ext.page.getByRole("button", { name: /Continue/i }).click();

	const codeField = ext.page.locator("input[readonly]");
	await expect(codeField).toBeVisible();
	const code = await codeField.inputValue();
	const decoded = JSON.parse(
		Buffer.from(code.replace("bramble-pair-1.", ""), "base64").toString("utf8"),
	) as { relay: string };
	expect(decoded.relay).toContain(LOCAL_RELAY_HOST);

	// --- joiner ---
	await mobile.page.getByRole("button", { name: /Create your vault/i }).click();
	await mobile.page.getByRole("button", { name: /Join a device/i }).click();
	const paste = mobile.page.getByRole("button", { name: /Paste code instead/i });
	if (await paste.isVisible().catch(() => false)) await paste.click();
	await mobile.page.getByPlaceholder(/Paste the code from your other device/i).fill(code);
	await mobile.page.getByLabel(/Master password/i).fill(PW);
	await mobile.page.getByRole("button", { name: /Join vault/i }).click();

	// --- approve, comparing the digits as a user would ---
	const joinerSas = mobile.page.locator("p.font-mono.tabular-nums");
	await expect(joinerSas).toBeVisible({ timeout: 90_000 });
	await expect(ext.page.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	const inviterSas = ext.page.locator("p.font-mono.tabular-nums");
	expect(await inviterSas.textContent()).toBe(await joinerSas.textContent());
	await ext.page.getByRole("button", { name: /Numbers match, approve/i }).click();

	// --- the payoff ---
	// Reaching an unlocked vault at all already proves the whole bundle arrived: a dropped frame
	// leaves recvSecure waiting for a frame index that never comes, so the join fails outright
	// rather than completing with fewer entries.
	await expect(mobile.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
		timeout: 120_000,
	});

	// Then assert the tail specifically, via search: the list virtualises, so a late entry is not
	// in the DOM until it is filtered to. This is the entry that only exists if the LAST frames
	// of the transfer survived the teardown.
	await mobile.page.getByLabel(/Search vault/i).fill(LAST_ENTRY);
	await expect(mobile.page.getByText(LAST_ENTRY)).toBeVisible({ timeout: 60_000 });
});
