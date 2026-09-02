import type { Page } from "@playwright/test";
import { popupUrl } from "../extension/helpers";
import { createVault, expect, gotoSync, PW, RELAY_URL, test } from "./fixtures";

// A bundle spanning many Noise frames, over a real transport, torn down straight after the send.
// Neither the unit tests (in-memory channels model framing, not teardown) nor pair-and-sync (a
// two-login vault is single-frame) can reach that. See docs/sec-audit-ghsa-x4f5.md.

const LOCAL_RELAY_HOST = "localhost:7400";

// Comfortably past CHUNK_BYTES once encrypted, so a barely-multi-frame payload can't go green.
const ENTRY_COUNT = 400;
const NOTE_PADDING = "p".repeat(200);
/** Imported last, so it can only be visible on the joiner if the FINAL frames survived. */
const LAST_ENTRY = `Zzz Final Entry ${ENTRY_COUNT - 1}`;

/** The cheapest real path to a large vault: 400 trips through the create-entry UI would dominate. */
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

	// Scope to the Bitwarden card. Picking the first file input positionally broke the moment a
	// provider was added above it, and landed on the .bramble password prompt instead.
	const card = page
		.locator("label")
		.filter({ hasText: /Bitwarden/ })
		.first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles({
		name: "bitwarden-export.json",
		mimeType: "application/json",
		buffer: Buffer.from(bitwardenExport(ENTRY_COUNT), "utf8"),
	});

	// Preview, then commit. Parsing + writing 400 entries is real crypto, so allow for it.
	await expect(page.getByText(`${ENTRY_COUNT} items ready to import`)).toBeVisible({
		timeout: 60_000,
	});
	await page.getByRole("button", { name: new RegExp(`Import ${ENTRY_COUNT} items`) }).click();
	// The DONE screen, not the button disappearing: its name flips to "Importing…" at once, so
	// navigating on that aborts the import and the spec then pairs an empty vault.
	await expect(page.getByText(`Imported ${ENTRY_COUNT} items`)).toBeVisible({ timeout: 180_000 });
}

test("a multi-frame vault survives the transfer and the teardown that follows it", async ({
	ext,
	mobile,
}) => {
	// Force the relay data path (the mesh needs BOTH sides to advertise a data channel). Two
	// reasons: it is what hardened Firefox and hard NATs actually get, and over loopback WebRTC the
	// SCTP queue drains as fast as sendSecure fills it, so the truncation never reproduces.
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

	// Prove the inviter really holds it: an empty vault would otherwise pass this spec.
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
	await ext.page.getByRole("button", { name: "Continue", exact: true }).click();

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
	const joinerSas = mobile.page.locator(".font-mono.tabular-nums");
	await expect(joinerSas).toBeVisible({ timeout: 90_000 });
	await expect(ext.page.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	const inviterSas = ext.page.locator(".font-mono.tabular-nums");
	expect(await inviterSas.textContent()).toBe(await joinerSas.textContent());
	await ext.page.getByRole("button", { name: /They match, approve/i }).click();

	// --- the payoff ---
	// Reaching an unlocked vault proves the whole bundle arrived: a dropped frame leaves recvSecure
	// waiting on an index that never comes, so the join fails outright rather than arriving short.
	await expect(mobile.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
		timeout: 120_000,
	});

	// The tail specifically, via search (the list virtualises). Only present if the LAST frames
	// survived the teardown.
	await mobile.page.getByLabel(/Search vault/i).fill(LAST_ENTRY);
	await expect(mobile.page.getByText(LAST_ENTRY)).toBeVisible({ timeout: 60_000 });
});
