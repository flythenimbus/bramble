import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBackground, pageSender } from "../test/test-harness";

afterEach(() => vi.unstubAllGlobals());

// A frame's picker may be hosted by the tab's top page only when that page is the same site:
// hosted there, the top page can read the picker's presence and height off its own DOM, which for
// a sign-in frame says whether the user has logins saved for it. Decided here from the browser's
// account of the sender, not by the content script, which runs in a page it cannot vouch for.
function frameSender(frameUrl: string, topUrl: string | undefined, frameId = 3): any {
	const sender = pageSender(new URL(frameUrl).host, 7, frameId);
	sender.origin = new URL(frameUrl).origin;
	sender.url = frameUrl;
	sender.tab.url = topUrl;
	return sender;
}

async function sameSite(sender: any): Promise<unknown> {
	const bg = await loadBackground();
	const { resp } = await bg.send({ type: "AUTOFILL_QUERY", hasLogin: true }, sender);
	return resp.data.sameSiteAsTop;
}

describe("whether a frame is the same site as its tab's top page", () => {
	it("is, for a subdomain of the top page's site", async () => {
		expect(
			await sameSite(frameSender("https://login.merchant.com/x", "https://www.merchant.com/")),
		).toBe(true);
	});

	it("is not, for another site", async () => {
		expect(await sameSite(frameSender("https://pci.example.net/x", "https://merchant.com/"))).toBe(
			false,
		);
	});

	it("is not, for two tenants of a private suffix", async () => {
		expect(
			await sameSite(frameSender("https://evil.github.io/x", "https://victim.github.io/")),
		).toBe(false);
	});

	it("is not, across schemes", async () => {
		expect(await sameSite(frameSender("http://merchant.com/x", "https://merchant.com/"))).toBe(
			false,
		);
	});

	it("is not, when the browser does not say what the top page is", async () => {
		expect(await sameSite(frameSender("https://merchant.com/x", undefined))).toBe(false);
	});

	it("is, for the top frame itself", async () => {
		expect(await sameSite(frameSender("https://merchant.com/", "https://merchant.com/", 0))).toBe(
			true,
		);
	});
});
