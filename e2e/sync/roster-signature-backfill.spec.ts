import type { Page, Worker } from "@playwright/test";
import { backgroundWorker, popupUrl } from "../extension/helpers";
import { createVault, expect, gotoSync, type Peer, PW, RELAY_URL, test } from "./fixtures";

// The phase-1 -> phase-2 roster migration, end to end over a real relay.
//
// Roster entries have carried an Ed25519 signature since 2026-07-09, but they are only signed at
// create / join / invite: a device enrolled before that, in a group that has not paired since, stays
// unsigned forever, and flipping `rosterRequireSignatures` would drop its updates. The backfill
// (`ensureOwnEntrySigned`, run from a post-unlock effect) is what lets the migration finish.
//
// The unit tests mock the shell, so they cannot see the part that actually breaks in the field: the
// signature is produced through popup -> background (SYNC_SIGN_ENTRY) -> offscreen (roster_sign), and
// then has to win a merge on a peer that holds the older entry. This drives all of it. A backfill
// that silently no-ops (a mis-wired host declines, and the code deliberately returns rather than
// throwing) passes every unit test and fails here.
//
// It simulates the pre-signing world by stripping the signatures out of both peers' stored rosters
// after they pair, which is the only way to get a genuinely unsigned entry out of a current build.

const LOCAL_RELAY_HOST = "localhost:7400";

/** Point this peer's sync at the local relay, via the Advanced panel a user would use. */
async function useLocalRelay(page: Page): Promise<void> {
	await page.getByRole("button", { name: /Advanced/i }).click();
	await page.getByLabel(/Nostr relay URL/i).fill(RELAY_URL);
	await page.getByLabel(/TURN \/ ICE servers URL/i).fill("");
}

/** Run the inviter flow and return the pairing code. */
async function invite(page: Page): Promise<string> {
	await page
		.getByRole("button", { name: /^Add a device$/i })
		.last()
		.click();
	await page.locator('input[type="password"]').first().fill(PW);
	await page.getByRole("button", { name: /Continue/i }).click();
	const codeField = page.locator("input[readonly]");
	await expect(codeField).toBeVisible();
	return codeField.inputValue();
}

interface StoredGroup {
	groupKey: string;
	roster: { devices: Array<Record<string, unknown>>; revoked: unknown[] };
}

/** The extension's stored sync group, read straight out of chrome.storage.local. */
async function readExtGroup(sw: Worker): Promise<{ key: string; group: StoredGroup }> {
	return sw.evaluate(async () => {
		const all = await chrome.storage.local.get(null);
		const key = Object.keys(all).find((k) => k.startsWith("sync.group"));
		if (!key) throw new Error("no sync.group in chrome.storage.local: the peers never paired");
		return { key, group: all[key] as StoredGroup };
	});
}

/** Drop `sigKey`/`sig` from every device in the extension's stored roster. */
async function stripExtSignatures(sw: Worker): Promise<void> {
	await sw.evaluate(async () => {
		const all = await chrome.storage.local.get(null);
		const key = Object.keys(all).find((k) => k.startsWith("sync.group"));
		if (!key) throw new Error("no sync.group to strip");
		const group = all[key] as { roster: { devices: Array<Record<string, unknown>> } };
		for (const d of group.roster.devices) {
			delete d.sigKey;
			delete d.sig;
		}
		await chrome.storage.local.set({ [key]: group });
	});
}

/**
 * Drop `sigKey`/`sig` from every device in the mobile peer's stored roster. Capacitor Preferences
 * is localStorage in a browser; the key is found by substring so the group prefix is not pinned.
 */
async function stripMobileSignatures(page: Page): Promise<void> {
	const stripped = await page.evaluate(() => {
		const key = Object.keys(localStorage).find((k) => k.includes("meta:sync.group"));
		if (!key) return false;
		const group = JSON.parse(localStorage.getItem(key) as string) as {
			roster: { devices: Array<Record<string, unknown>> };
		};
		for (const d of group.roster.devices) {
			delete d.sigKey;
			delete d.sig;
		}
		localStorage.setItem(key, JSON.stringify(group));
		return true;
	});
	expect(stripped, "the mobile peer stored no sync group: the peers never paired").toBe(true);
}

/** Pair the two peers over the local relay, approving the SAS as a user would. */
async function pair(ext: Peer & { extensionId: string }, mobile: Peer): Promise<void> {
	await createVault(ext.page);
	await ext.page.goto(popupUrl(ext.extensionId));
	await expect(ext.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
	await gotoSync(ext.page);
	await useLocalRelay(ext.page);

	const code = await invite(ext.page);
	const decoded = JSON.parse(
		Buffer.from(code.replace("bramble-pair-1.", ""), "base64").toString("utf8"),
	) as { relay: string };
	expect(decoded.relay, "the pairing code must name the local relay").toContain(LOCAL_RELAY_HOST);

	await mobile.page.getByRole("button", { name: /Create your vault/i }).click();
	await mobile.page.getByRole("button", { name: /Join a device/i }).click();
	const paste = mobile.page.getByRole("button", { name: /Paste code instead/i });
	if (await paste.isVisible().catch(() => false)) await paste.click();
	await mobile.page.getByPlaceholder(/Paste the code from your other device/i).fill(code);
	await mobile.page.getByLabel(/Master password/i).fill(PW);
	await mobile.page.getByRole("button", { name: /Join vault/i }).click();

	// The digits comparison is pair-and-sync.spec.ts's job; here the SAS just has to be answered.
	await expect(mobile.page.getByRole("heading", { name: /Check this matches/i })).toBeVisible({
		timeout: 90_000,
	});
	await expect(ext.page.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	await ext.page.getByRole("button", { name: /They match, approve/i }).click();
	await expect(mobile.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
		timeout: 90_000,
	});
}

test("an unsigned device signs itself on unlock, and its peer converges on the signature", async ({
	ext,
	mobile,
}) => {
	await pair(ext, mobile);
	const sw = await backgroundWorker(ext.context);

	// Baseline: both peers enrolled on a signing build, so the extension's own entry is signed.
	// Without this the strip below could be a no-op and every later assertion would be vacuous.
	const before = await readExtGroup(sw);
	expect(before.group.roster.devices).toHaveLength(2);
	expect(before.group.roster.devices.every((d) => typeof d.sigKey === "string")).toBe(true);

	// Rewind both stores to the pre-2026-07-09 world: entries with no signature at all.
	await stripExtSignatures(sw);
	await stripMobileSignatures(mobile.page);

	// The mobile peer now sees two unsigned devices, and says so. Its own entry is only fixed by
	// ITS next unlock, which this spec never triggers, so it stays unsigned throughout and is the
	// control: the count going 2 -> 1 is the extension's signature arriving, not a local repair.
	await gotoSync(mobile.page);
	const unsignedOnMobile = mobile.page.getByText("Unsigned", { exact: true });
	await expect(unsignedOnMobile).toHaveCount(2);

	// Reopening the popup is an unlock as far as the app is concerned (the background holds the
	// session), so the post-unlock effect runs the backfill: sign through the real host and write.
	await ext.page.goto(popupUrl(ext.extensionId));
	await expect(ext.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();

	// The extension re-signed its own entry, through background -> offscreen. Exactly one: a device
	// only ever signs for itself, so the peer's entry stays unsigned here.
	await expect
		.poll(
			async () =>
				(await readExtGroup(sw)).group.roster.devices.filter((d) => typeof d.sigKey === "string")
					.length,
			{ timeout: 30_000, message: "the backfill never re-signed this device's own entry" },
		)
		.toBe(1);

	// Re-stamped, not just re-signed: without a newer stamp the signed entry loses the merge to the
	// unsigned one the peer holds, and the convergence below would never happen.
	const after = await readExtGroup(sw);
	const own = after.group.roster.devices.find((d) => typeof d.sigKey === "string");
	const wasOwn = before.group.roster.devices.find((d) => d.publicKey === own?.publicKey);
	expect(own, "no signed device in the roster after the backfill").toBeDefined();
	expect(wasOwn, "the signed device was absent from the roster before").toBeDefined();
	expect((own!.hlc as { wall: number }).wall).toBeGreaterThanOrEqual(
		(wasOwn!.hlc as { wall: number }).wall,
	);

	// The payoff: that signature crossed a real relay, merged on the peer, and the peer's own UI
	// now reports one unsigned device instead of two.
	await expect(unsignedOnMobile).toHaveCount(1, { timeout: 60_000 });
});
