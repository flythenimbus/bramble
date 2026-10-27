import { rmSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { launchExtensionContext } from "../extension/fixtures";
import { optionsUrl, popupUrl, STRONG_PW } from "../extension/helpers";
import { adbShell, expect } from "./fixtures";

// The extension paired with the app on a phone over the hosted relay and Cloudflare's TURN, the
// phone's WebRTC forced to relay-only. Shared by the specs that measure real TURN, which are opt-in
// because they use production infrastructure (see turn-idle-traffic.spec.ts).

/** Run before the app loads: every connection relay-only, and kept so its stats can be read. */
const RELAY_ONLY = `(() => {
	const Native = window.RTCPeerConnection;
	if (!Native || window.__pcs) return;
	window.__pcs = [];
	const Forced = function (config, ...rest) {
		const pc = new Native({ ...(config || {}), iceTransportPolicy: "relay" }, ...rest);
		window.__pcs.push(pc);
		return pc;
	};
	Forced.prototype = Native.prototype;
	Object.setPrototypeOf(Forced, Native);
	window.RTCPeerConnection = Forced;
})();`;

export interface Link {
	state: string;
	local?: string;
	remote?: string;
	sent: number;
	received: number;
}

/** The phone's connected peer connections: how each is routed, and the bytes it has carried. */
export const links = (device: Page): Promise<Link[]> =>
	device.evaluate(async () => {
		const out: Link[] = [];
		for (const pc of (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []) {
			if (pc.connectionState !== "connected") continue;
			const stats = await pc.getStats();
			let pair: RTCIceCandidatePairStats | undefined;
			stats.forEach((r) => {
				if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) pair = r;
			});
			if (!pair) continue;
			out.push({
				state: pc.connectionState,
				local: stats.get(pair.localCandidateId)?.candidateType,
				remote: stats.get(pair.remoteCandidateId)?.candidateType,
				sent: Number(pair.bytesSent ?? 0),
				received: Number(pair.bytesReceived ?? 0),
			});
		}
		return out;
	});

export const total = (ls: Link[], k: "sent" | "received") => ls.reduce((n, l) => n + l[k], 0);

/** Keep the phone awake (a locked phone pauses the WebView), then reload the app relay-only. */
export async function forceRelayOnly(context: BrowserContext, device: Page): Promise<void> {
	adbShell("svc power stayon usb");
	await context.addInitScript(RELAY_ONLY);
	await device.reload();
	await device.locator("#root").waitFor();
	expect(
		await device.evaluate(() => Array.isArray((window as unknown as { __pcs?: unknown }).__pcs)),
		"the relay-only script didn't load before the app",
	).toBe(true);
}

export interface TurnPair {
	/** The extension's detached popup. */
	popup: Page;
	/** Delete the joined vault on the phone, close the extension, let the phone sleep again. */
	cleanup(): Promise<void>;
}

/**
 * A vault on a fresh extension holding one login `entry` (with `note`, if given), and the phone
 * joined to it over the hosted relay. Cleans up after itself if pairing fails partway.
 */
export async function pairOverHostedRelay(
	device: Page,
	opts: { entry: string; note?: string },
): Promise<TurnPair> {
	const inviter = await launchExtensionContext(undefined, process.env.BRAMBLE_EXTENSION);
	let joined = false;
	const cleanup = async () => {
		adbShell("svc power stayon false");
		if (joined) {
			try {
				await device.getByRole("button", { name: "Settings" }).click();
				await device.getByRole("button", { name: "General", exact: true }).click();
				await device
					.getByRole("button", { name: /Delete this vault/i })
					.first()
					.click();
				await device.getByLabel(/Master password/i).fill(STRONG_PW);
				await device
					.getByRole("button", { name: /Delete this vault/i })
					.last()
					.click();
			} catch {
				console.log("[turn] couldn't delete the joined vault; clear it by hand");
			}
		}
		await inviter.context.close();
		rmSync(inviter.profileDir, { recursive: true, force: true });
	};
	try {
		const setup = await inviter.context.newPage();
		await setup.goto(optionsUrl(inviter.extensionId));
		const pw = setup.locator('input[type="password"]');
		await pw.nth(0).fill(STRONG_PW);
		await pw.nth(1).fill(STRONG_PW);
		await setup.getByRole("button", { name: "Create vault" }).click();
		await setup.getByRole("button", { name: /I've saved it/i }).click();
		const popup = await inviter.context.newPage();
		await popup.goto(`${popupUrl(inviter.extensionId)}?detached=1`);
		await expect(popup.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
		await popup.getByRole("button", { name: /Add New/i }).click();
		await popup
			.getByRole("button", { name: /^Login/ })
			.first()
			.click();
		await popup.getByLabel(/^Name$/).fill(opts.entry);
		await popup.getByLabel(/Username or email/i).fill("me@example.com");
		if (opts.note) await popup.getByLabel(/Notes/i).fill(opts.note);
		await popup.getByRole("button", { name: /Save Login/i }).click();
		await expect(popup.getByText(opts.entry)).toBeVisible();

		// Invite over the hosted relay, the default, from the popup's own Sync page.
		await popup.getByRole("button", { name: "Settings" }).click();
		await popup.getByRole("button", { name: "Sync", exact: true }).click();
		await popup
			.getByRole("button", { name: /^Add a device$/i })
			.last()
			.click();
		await popup.locator('input[type="password"]').first().fill(STRONG_PW);
		await popup.getByRole("button", { name: "Continue", exact: true }).click();
		const code = await popup.locator("input[readonly]").inputValue();
		expect(code).toMatch(/^bramble-pair-1\./);

		const picker = device.getByRole("heading", { name: /Choose a vault/i });
		const switchLink = device.getByRole("button", { name: /Choose a different vault/i });
		if (!(await picker.isVisible().catch(() => false))) await switchLink.click();
		await device.getByRole("button", { name: /Create new vault/i }).click();
		await device.getByRole("button", { name: /Join a device/i }).click();
		const paste = device.getByRole("button", { name: /Paste code instead/i });
		if (await paste.isVisible().catch(() => false)) await paste.click();
		await device.getByPlaceholder(/Paste the code from your other device/i).fill(code);
		await device.getByLabel(/Master password/i).fill(STRONG_PW);
		await device.getByRole("button", { name: /Join vault/i }).click();
		await expect(popup.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 120_000 });
		await popup.getByRole("button", { name: /They match, approve/i }).click();
		await expect(device.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
			timeout: 120_000,
		});
		joined = true;
		await expect(device.getByText(opts.entry)).toBeVisible({ timeout: 120_000 });

		// Back to the vault list, which the Sync page left behind.
		for (
			let i = 0;
			i < 3 && !(await popup.getByRole("button", { name: /Add New/i }).isVisible());
			i++
		) {
			await popup
				.getByRole("button", { name: /^(Back|Go back)/i })
				.first()
				.click();
		}
		return { popup, cleanup };
	} catch (e) {
		await cleanup();
		throw e;
	}
}
