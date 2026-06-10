import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundHarness,
	extensionSender,
	loadBackground,
	pageSender,
} from "./test-harness";

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
	const bg = await loadBackground({ sessionSeed: { "vault.vek": "SEED" }, ...extra });
	await bg.send({ type: "AUTOFILL_SET_INDEX", payload: [LOGIN] }, extensionSender);
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

	it("save-unlock-first while locked parks a handoff and opens the popup", async () => {
		const bg = await loadBackground({ hasOpenPopup: true });
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
	});
});

describe("CORNER_FLUSH_HANDOFF", () => {
	it("reports false when there is no parked handoff", async () => {
		const bg = await loadBackground({ sessionSeed: { "vault.vek": "SEED" } });
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
		// Handoff is consumed (cleared first) even on the locked path.
		expect(bg.state.session["cornerPrompt.handoff"]).toBeUndefined();
	});
});
