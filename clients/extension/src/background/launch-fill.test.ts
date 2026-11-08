import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ChromeMockOptions,
	extensionSender,
	LAUNCHED_TAB_ID,
	loadBackground,
	pageSender,
	setAutofillIndex,
	TEST_VEK_KEY,
} from "../test/test-harness";

// Launch and fill: "Open website" fills that login once in the tab it opened. See
// docs/launch-and-fill.md.

const TAB = LAUNCHED_TAB_ID;
const URL_ = "https://example.com/login";
const LOGIN = {
	type: "login",
	id: "login1",
	hostnames: ["example.com"],
	name: "Example",
	username: "alice",
	password: "pw1",
};
const TOP_YIELDS = { hasPassword: false, frameVisible: true };

async function unlocked(opts: ChromeMockOptions = {}, entries: unknown[] = [LOGIN]) {
	const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" }, ...opts });
	await setAutofillIndex(bg, entries);
	return bg;
}
type Bg = Awaited<ReturnType<typeof unlocked>>;

const launch = (bg: Bg, entryId = "login1", url = URL_) =>
	bg.send({ type: "AUTOFILL_LAUNCH", payload: { entryId, url } }, extensionSender);
const query = async (bg: Bg, sender: unknown) =>
	(await bg.send({ type: "AUTOFILL_QUERY", hasLogin: true }, sender)).resp;
const claim = async (bg: Bg, sender: unknown, payload?: unknown) =>
	(await bg.send({ type: "AUTOFILL_LAUNCH_CLAIM", payload }, sender)).resp;

/** A frame of the launched tab: `host` inside a top page on `topHost`. */
function frameSender(host: string, topHost = "example.com") {
	return {
		origin: `https://${host}`,
		url: `https://${host}/signin`,
		frameId: 5,
		tab: { id: TAB, windowId: 1, url: `https://${topHost}/` },
	};
}
const SIZE = { frameWidth: 400, frameHeight: 300 };

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("AUTOFILL_LAUNCH", () => {
	it("is refused from a page", async () => {
		const bg = await unlocked();
		const { resp } = await bg.send(
			{ type: "AUTOFILL_LAUNCH", payload: { entryId: "login1", url: URL_ } },
			pageSender("example.com", 11),
		);
		expect(resp).toEqual({ ok: false, error: "forbidden" });
		expect(bg.state.tabsCreated).toEqual([]);
	});

	it("opens the tab in the last focused normal window and brings it forward", async () => {
		const bg = await unlocked({ lastFocusedWindow: { id: 7 } });
		expect((await launch(bg)).resp.ok).toBe(true);
		expect(bg.state.tabsCreated).toEqual([{ url: URL_, windowId: 7, active: true }]);
		expect(bg.chrome.windows.getLastFocused).toHaveBeenCalledWith({ windowTypes: ["normal"] });
		expect(bg.chrome.windows.update).toHaveBeenCalledWith(7, { focused: true });
	});

	it("opens a new window when there is no normal one, and still arms the grant", async () => {
		const bg = await unlocked();
		bg.chrome.windows.getLastFocused = vi.fn(async () => {
			throw new Error("no window");
		});
		bg.chrome.windows.create = vi.fn(async () => ({ id: 9, tabs: [{ id: TAB }] }));
		expect((await launch(bg)).resp.ok).toBe(true);
		expect(bg.chrome.windows.create).toHaveBeenCalledWith({ url: URL_ });
		expect((await claim(bg, pageSender("example.com", TAB))).ok).toBe(true);
	});

	it("rejects a url that isn't http(s), and opens nothing", async () => {
		const bg = await unlocked();
		const { resp } = await launch(bg, "login1", "javascript:alert(1)");
		expect(resp).toEqual({ ok: false, error: "invalid_request" });
		expect(bg.state.tabsCreated).toEqual([]);
	});

	it.each([
		["the login's autofill is off", [{ ...LOGIN, autofillEnabled: false }], "login1", URL_],
		["the url isn't the login's site", [LOGIN], "login1", "https://other.test/"],
		["the login doesn't exist", [LOGIN], "nope", URL_],
		["it has no password", [{ ...LOGIN, password: "" }], "login1", URL_],
	])("opens the tab but arms nothing when %s", async (_why, entries, id, url) => {
		const bg = await unlocked({}, entries);
		expect((await launch(bg, id, url)).resp.ok).toBe(true);
		expect(bg.state.tabsCreated).toHaveLength(1);
		expect((await claim(bg, pageSender("example.com", TAB))).ok).toBe(false);
	});

	it("opens the tab but arms nothing while autofill is off in Settings", async () => {
		const bg = await unlocked({ localSeed: { "pref.autofillEnabled": false } });
		expect((await launch(bg)).resp.ok).toBe(true);
		expect(bg.state.tabsCreated).toHaveLength(1);
		expect((await claim(bg, pageSender("example.com", TAB))).ok).toBe(false);
	});
});

describe("AUTOFILL_QUERY's launch flag", () => {
	it("is set for the launched tab on the login's site, and names no login", async () => {
		const bg = await unlocked();
		await launch(bg);
		const { data } = await query(bg, pageSender("example.com", TAB));
		expect(data.launch).toBe(true);
		expect(JSON.stringify({ launch: data.launch })).not.toContain("login1");
	});

	it("is absent on another tab and on another site", async () => {
		const bg = await unlocked();
		await launch(bg);
		expect((await query(bg, pageSender("example.com", 11))).data.launch).toBeUndefined();
		expect((await query(bg, pageSender("other.test", TAB))).data.launch).toBeUndefined();
	});

	it("is absent once the grant is spent", async () => {
		const bg = await unlocked();
		await launch(bg);
		await claim(bg, pageSender("example.com", TAB));
		expect((await query(bg, pageSender("example.com", TAB))).data.launch).toBeUndefined();
	});

	it("is set for a same-site frame under a matching top page, and not a cross-site one", async () => {
		const bg = await unlocked();
		await launch(bg);
		expect((await query(bg, frameSender("accounts.example.com"))).data.launch).toBe(true);
		expect((await query(bg, frameSender("other.test"))).data.launch).toBeUndefined();
	});
});

describe("AUTOFILL_LAUNCH_CLAIM", () => {
	it("fills the launched login as an auto fill", async () => {
		const bg = await unlocked();
		await launch(bg);
		const resp = await claim(bg, pageSender("example.com", TAB));
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({
			payload: { kind: "login", username: "alice", password: "pw1" },
			isAuto: true,
			otpOnly: false,
		});
		expect(Number.isSafeInteger(resp.data.sessionGeneration)).toBe(true);
	});

	it("fills only once per grant", async () => {
		const bg = await unlocked();
		await launch(bg);
		const sender = pageSender("example.com", TAB);
		expect((await claim(bg, sender)).ok).toBe(true);
		expect((await claim(bg, sender)).ok).toBe(false);
	});

	it("gives another site nothing and leaves the grant for the real one", async () => {
		const bg = await unlocked();
		await launch(bg);
		expect((await claim(bg, pageSender("other.test", TAB))).ok).toBe(false);
		expect((await claim(bg, pageSender("example.com", TAB))).ok).toBe(true);
	});

	it("gives another tab nothing", async () => {
		const bg = await unlocked();
		await launch(bg);
		expect((await claim(bg, pageSender("example.com", 11))).ok).toBe(false);
	});

	it("survives a navigation in the tab", async () => {
		const bg = await unlocked();
		await launch(bg);
		bg.fireTabUpdated(TAB, { url: "https://example.com/redirected" });
		expect((await claim(bg, pageSender("example.com", TAB))).ok).toBe(true);
	});

	it("ends after 60 seconds", async () => {
		vi.useFakeTimers();
		const bg = await unlocked();
		await launch(bg);
		await vi.advanceTimersByTimeAsync(60_001);
		expect((await claim(bg, pageSender("example.com", TAB))).ok).toBe(false);
	});

	it("ends when the tab closes", async () => {
		const bg = await unlocked();
		await launch(bg);
		bg.fireTabRemoved(TAB);
		expect((await claim(bg, pageSender("example.com", TAB))).ok).toBe(false);
	});

	it("ends with a lock", async () => {
		const bg = await unlocked();
		await launch(bg);
		await bg.send({ type: "CRYPTO_LOCK" });
		await bg.chrome.storage.session.set({ "vault.activeId": "v1" });
		await bg.send({ type: "CRYPTO_UNLOCK_WITH_VEK", payload: { vekB64: "NEW" } });
		await setAutofillIndex(bg, [LOGIN]);
		expect((await claim(bg, pageSender("example.com", TAB))).ok).toBe(false);
	});

	it("is refused once autofill is turned off in Settings", async () => {
		const bg = await unlocked();
		await launch(bg);
		bg.state.local["pref.autofillEnabled"] = false;
		expect((await claim(bg, pageSender("example.com", TAB))).ok).toBe(false);
	});
});

describe("AUTOFILL_LAUNCH_CLAIM from a frame", () => {
	const withTop = (reply: unknown) =>
		unlocked({
			tabReply: () => {
				if (reply instanceof Error) throw reply;
				return reply;
			},
		});

	it("fills a visible same-site frame when the top page has no password field", async () => {
		const bg = await withTop(TOP_YIELDS);
		await launch(bg);
		const resp = await claim(bg, frameSender("accounts.example.com"), SIZE);
		expect(resp.ok).toBe(true);
		expect(bg.state.tabMessages).toContainEqual({
			tabId: TAB,
			message: { type: "AUTOFILL_LAUNCH_TOP_CHECK", payload: SIZE },
			options: { frameId: 0 },
		});
	});

	it("gives a cross-site frame nothing", async () => {
		const bg = await withTop(TOP_YIELDS);
		await launch(bg);
		expect((await claim(bg, frameSender("other.test"), SIZE)).ok).toBe(false);
	});

	it("gives a login's own frame nothing under a top page that isn't the login's", async () => {
		// The open-redirect case: the frame is the real site, the page around it isn't.
		const bg = await withTop(TOP_YIELDS);
		await launch(bg);
		expect((await claim(bg, frameSender("example.com", "evil.test"), SIZE)).ok).toBe(false);
	});

	it("needs the top page to match the login, not just share its site", async () => {
		const exact = { ...LOGIN, hostnames: ["accounts.example.com"], subdomainMatch: "exact" };
		const bg = await unlocked({ tabReply: () => TOP_YIELDS }, [exact]);
		await launch(bg, "login1", "https://accounts.example.com/");
		expect((await claim(bg, frameSender("accounts.example.com", "www.example.com"), SIZE)).ok).toBe(
			false,
		);
	});

	it.each([
		["has its own password field", { hasPassword: true, frameVisible: true }],
		["can't see the frame", { hasPassword: false, frameVisible: false }],
		["gives no answer it can read", undefined],
		["isn't there to ask", new Error("no receiver")],
	])("refuses when the top page %s, and keeps the grant", async (_why, reply) => {
		const bg = await withTop(reply);
		await launch(bg);
		expect((await claim(bg, frameSender("accounts.example.com"), SIZE)).ok).toBe(false);
		expect((await claim(bg, pageSender("example.com", TAB))).ok).toBe(true);
	});

	it("refuses a frame claim with no usable size", async () => {
		const bg = await withTop(TOP_YIELDS);
		await launch(bg);
		const resp = await claim(bg, frameSender("accounts.example.com"), { frameWidth: "wide" });
		expect(resp).toEqual({ ok: false, error: "invalid_request" });
	});

	it("doesn't ask the top page about a claim from the top frame", async () => {
		const bg = await withTop(TOP_YIELDS);
		await launch(bg);
		await claim(bg, pageSender("example.com", TAB));
		expect(
			bg.state.tabMessages.filter((m) => m.message.type === "AUTOFILL_LAUNCH_TOP_CHECK"),
		).toEqual([]);
	});
});
