import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundHarness,
	extensionSender,
	loadBackground,
	pageSender,
	setAutofillIndex,
	TEST_VEK_KEY,
	TWO_VAULTS,
} from "../test/test-harness";

afterEach(() => {
	vi.unstubAllGlobals();
});

const LOGIN = {
	type: "login",
	id: "login1",
	hostnames: ["example.com"],
	name: "Example",
	username: "alice",
	password: "pw1",
};

async function unlocked(extra?: {
	localSeed?: Record<string, unknown>;
}): Promise<BackgroundHarness> {
	const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" }, ...extra });
	await setAutofillIndex(bg, [LOGIN]);
	return bg;
}

describe("CORNER_PROMPT_CAPTURE dedupe", () => {
	it("derives the hostname from the sender, not the body", async () => {
		const bg = await unlocked();
		const { resp } = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "bob", password: "pw" } },
			{}, // no verifiable origin
		);
		expect(resp).toEqual({ ok: false, error: "no verifiable origin on sender" });
	});

	it("ignores a capture with no password", async () => {
		const bg = await unlocked();
		const { resp } = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "bob", password: "" } },
			pageSender("newsite.com", 5),
		);
		expect(resp).toEqual({ ok: true, data: null });
	});

	it("offers a save-login prompt for a new credential and stashes it + notifies the tab", async () => {
		const bg = await unlocked();
		const { resp } = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "bob", password: "pw" } },
			pageSender("newsite.com", 5),
		);
		expect(resp.data).toMatchObject({
			kind: "save-login",
			username: "bob",
			password: "pw",
			locked: false,
		});
		expect(bg.state.session["capture.pending.newsite.com"]).toBeDefined();
		const shown = bg.state.tabMessages.find((m) => m.message.type === "CORNER_PROMPT_SHOW");
		expect(shown?.tabId).toBe(5);
	});

	it("suppresses an exact duplicate of a stored credential", async () => {
		const bg = await unlocked();
		const { resp } = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "alice", password: "pw1" } },
			pageSender("example.com", 5),
		);
		expect(resp).toEqual({ ok: true, data: null });
		expect(bg.state.session["capture.pending.example.com"]).toBeUndefined();
	});

	it("offers an update prompt when the password changed for a known login", async () => {
		const bg = await unlocked();
		const { resp } = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "alice", password: "NEWPW" } },
			pageSender("example.com", 5),
		);
		expect(resp.data.kind).toBe("update-login");
		expect(resp.data.candidates).toEqual([{ id: "login1", name: "Example", username: "alice" }]);
		expect(resp.data.newPassword).toBe("NEWPW");
	});

	it("offers an update only on the port an exact login is pinned to", async () => {
		const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" } });
		await setAutofillIndex(bg, [
			{ ...LOGIN, hostnames: ["nas.local"], ports: ["5000"], subdomainMatch: "exact" },
		]);
		const other = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "alice", password: "NEWPW" } },
			pageSender("nas.local:8080", 5),
		);
		expect(other.resp.data.kind).toBe("save-login");
		const same = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "alice", password: "NEWPW" } },
			pageSender("nas.local:5000", 5),
		);
		expect(same.resp.data.kind).toBe("update-login");
	});

	it("stays silent when offer-to-save is off", async () => {
		const bg = await unlocked({ localSeed: { "pref.offerToSave": false } });
		const { resp } = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "bob", password: "pw" } },
			pageSender("newsite.com", 5),
		);
		expect(resp).toEqual({ ok: true, data: null });
	});

	it("stays silent for a never-save site", async () => {
		const bg = await unlocked({ localSeed: { "pref.neverSaveSites": ["newsite.com"] } });
		const { resp } = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "bob", password: "pw" } },
			pageSender("newsite.com", 5),
		);
		expect(resp).toEqual({ ok: true, data: null });
	});
});

describe("CORNER_PROMPT_QUERY (post-navigation poll)", () => {
	it("surfaces a capture stashed by a prior page", async () => {
		const bg = await unlocked();
		await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "bob", password: "pw" } },
			pageSender("newsite.com", 5),
		);
		const { resp } = await bg.send({ type: "CORNER_PROMPT_QUERY" }, pageSender("newsite.com", 6));
		expect(resp.data).toMatchObject({ kind: "save-login", username: "bob" });
	});

	it("returns null when nothing is stashed", async () => {
		const bg = await unlocked();
		const { resp } = await bg.send({ type: "CORNER_PROMPT_QUERY" }, pageSender("newsite.com", 6));
		expect(resp).toEqual({ ok: true, data: null });
	});

	it("returns null when offer-to-save is off", async () => {
		const bg = await unlocked({ localSeed: { "pref.offerToSave": false } });
		const { resp } = await bg.send({ type: "CORNER_PROMPT_QUERY" }, pageSender("newsite.com", 6));
		expect(resp).toEqual({ ok: true, data: null });
	});
});

describe("CORNER_PROMPT_RESPONSE (non-committing actions)", () => {
	async function stashSave(bg: BackgroundHarness): Promise<string> {
		const cap = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "bob", password: "pw" } },
			pageSender("newsite.com", 5),
		);
		return cap.resp.data.promptId;
	}

	it("dismiss clears the stash without saving", async () => {
		const bg = await unlocked();
		const promptId = await stashSave(bg);
		const { resp } = await bg.send(
			{ type: "CORNER_PROMPT_RESPONSE", payload: { promptId, action: "dismiss" } },
			pageSender("newsite.com", 5),
		);
		expect(resp).toEqual({ ok: true, data: null });
		expect(bg.state.session["capture.pending.newsite.com"]).toBeUndefined();
		expect(bg.state.broadcasts).toHaveLength(0);
	});

	it("never records the site and clears the stash", async () => {
		const bg = await unlocked();
		const promptId = await stashSave(bg);
		await bg.send(
			{ type: "CORNER_PROMPT_RESPONSE", payload: { promptId, action: "never" } },
			pageSender("newsite.com", 5),
		);
		expect(bg.state.local["pref.neverSaveSites"]).toEqual(["newsite.com"]);
		expect(bg.state.session["capture.pending.newsite.com"]).toBeUndefined();
	});

	it("a stale promptId commits nothing but still clears the stash", async () => {
		const bg = await unlocked();
		await stashSave(bg);
		const { resp } = await bg.send(
			{ type: "CORNER_PROMPT_RESPONSE", payload: { promptId: "stale", action: "dismiss" } },
			pageSender("newsite.com", 5),
		);
		expect(resp).toEqual({ ok: true, data: null });
		expect(bg.state.session["capture.pending.newsite.com"]).toBeUndefined();
		expect(bg.state.broadcasts).toHaveLength(0);
	});

	it("save-unlock-first while locked parks a handoff and opens the popup on the last opened vault", async () => {
		const bg = await loadBackground({
			hasOpenPopup: true,
			localSeed: { ...TWO_VAULTS, "vault.lastOpenedId": "v2" },
			sessionSeed: { "vault.activeId": undefined },
		});
		// Locked capture -> save prompt.
		const cap = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "bob", password: "pw" } },
			pageSender("newsite.com", 5),
		);
		const promptId = cap.resp.data.promptId;
		const { resp } = await bg.send(
			{ type: "CORNER_PROMPT_RESPONSE", payload: { promptId, action: "save-unlock-first" } },
			pageSender("newsite.com", 5),
		);
		expect(resp).toEqual({ ok: true, data: null });
		expect(bg.state.session["cornerPrompt.handoff"]).toMatchObject({ intent: "save" });
		expect(bg.chrome.action.openPopup).toHaveBeenCalled();
		expect(bg.state.session["vault.activeId"]).toBe("v2");
	});
});

describe("CORNER_FLUSH_HANDOFF", () => {
	it("reports false when there is no parked handoff", async () => {
		const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" } });
		const { resp } = await bg.send({ type: "CORNER_FLUSH_HANDOFF" });
		expect(resp).toEqual({ ok: true, data: false });
	});

	it("refuses to flush while the vault is still locked", async () => {
		const bg = await loadBackground({
			sessionSeed: {
				"cornerPrompt.handoff": {
					intent: "save",
					capture: { etld1: "n.com", hostname: "n.com", username: "b", password: "p" },
				},
			},
		});
		const { resp } = await bg.send({ type: "CORNER_FLUSH_HANDOFF" });
		expect(resp).toEqual({ ok: false, error: "vault still locked" });
		// The handoff SURVIVES: it's the only copy of the capture, and this flush can land before
		// the unlock is visible here. Consuming it on the locked path lost the entry outright.
		expect(bg.state.session["cornerPrompt.handoff"]).toBeDefined();
	});
});

describe("capture public-suffix isolation", () => {
	it.each(["com.sg", "com.hk", "b.ck"])(
		"does not expose a capture to a sibling under %s",
		async (suffix) => {
			const bg = await unlocked();
			await bg.send(
				{
					type: "CORNER_PROMPT_CAPTURE",
					payload: { username: "alice", password: "private-capture" },
				},
				pageSender(`dbs.${suffix}`, 5),
			);
			const own = await bg.send({ type: "CORNER_PROMPT_QUERY" }, pageSender(`dbs.${suffix}`, 6));
			expect(own.resp.data).toMatchObject({ password: "private-capture" });
			const other = await bg.send({ type: "CORNER_PROMPT_QUERY" }, pageSender(`evil.${suffix}`, 7));
			expect(other.resp).toEqual({ ok: true, data: null });
		},
	);
});

// The save card's Username box is an extension-origin frame, and Firefox gives an embedded
// frame no tabs API, so it reaches the card through here.
describe("CORNER_FIELD relay", () => {
	const fieldSender = (
		tabId: number | undefined,
		page = "corner-field.html?id=abc",
		frameId = 7,
	) => ({
		origin: extensionSender.origin,
		url: `${extensionSender.origin}/${page}`,
		...(tabId === undefined ? {} : { tab: { id: tabId }, frameId }),
	});
	const OPEN = { type: "CORNER_FIELD", payload: { id: "abc", op: "open" } };

	it("hands the frame's message to the tab's top frame and returns its answer", async () => {
		const bg = await loadBackground({
			tabReply: () => ({ ok: true, data: { value: "alice" } }),
		});
		const { resp } = await bg.send(OPEN, fieldSender(5));
		expect(resp).toEqual({ ok: true, data: { value: "alice" } });
		expect(bg.state.tabMessages).toEqual([{ tabId: 5, message: OPEN, options: { frameId: 0 } }]);
	});

	it("relays nothing but the payload", async () => {
		const bg = await loadBackground({ tabReply: () => ({ ok: true }) });
		await bg.send({ ...OPEN, target: "somewhere", extra: 1 }, fieldSender(5));
		expect(bg.state.tabMessages[0]?.message).toEqual(OPEN);
	});

	it("refuses a content script, whatever frame it runs in", async () => {
		const bg = await loadBackground({ tabReply: () => ({ ok: true }) });
		// A page can be served from the frame's own path; it is still a page.
		const lookalike = {
			...pageSender("evil.com", 5, 3),
			url: "https://evil.com/corner-field.html?id=abc",
		};
		for (const sender of [pageSender("evil.com", 5, 3), pageSender("evil.com", 5), lookalike]) {
			const { resp } = await bg.send(OPEN, sender);
			expect(resp).toEqual({ ok: false, error: "forbidden" });
		}
		expect(bg.state.tabMessages).toEqual([]);
	});

	it("refuses every extension page but the Username frame", async () => {
		const bg = await loadBackground({ tabReply: () => ({ ok: true }) });
		const others = [
			extensionSender, // popup, no tab
			fieldSender(undefined), // the page itself, outside any tab
			fieldSender(5, "corner-field.html?id=abc", 0), // opened as a tab of its own
			fieldSender(5, "autofill-ui.html?parentOrigin=x"),
			fieldSender(5, "popup.html?detached=1"),
			fieldSender(5, "x/corner-field.html"),
		];
		for (const sender of others) {
			const { resp } = await bg.send(OPEN, sender);
			expect(resp).toEqual({ ok: false, error: "forbidden" });
		}
		expect(bg.state.tabMessages).toEqual([]);
	});

	it("says so when the tab has no card to answer", async () => {
		const gone = await loadBackground({
			tabReply: () => {
				throw new Error("Could not establish connection. Receiving end does not exist.");
			},
		});
		expect((await gone.send(OPEN, fieldSender(5))).resp).toEqual({ ok: false, error: "no card" });

		const silent = await loadBackground({ tabReply: () => undefined });
		expect((await silent.send(OPEN, fieldSender(5))).resp).toEqual({ ok: false, error: "no card" });
	});
});
