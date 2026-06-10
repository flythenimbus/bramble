import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBackground } from "../test/test-harness";

afterEach(() => {
	vi.unstubAllGlobals();
});

const CLIP_ALARM = "vault:clipboard-clear";
const EXPECTED_KEY = "clipboard.expectedHash";

describe("CLIPBOARD_SCHEDULE_CLEAR", () => {
	it("stashes the hash and arms the clear alarm (default 30s = 0.5 min)", async () => {
		const bg = await loadBackground();
		const { resp } = await bg.send({
			type: "CLIPBOARD_SCHEDULE_CLEAR",
			payload: { expectedHash: "abc" },
		});
		expect(resp).toEqual({ ok: true, data: null });
		expect(bg.state.session[EXPECTED_KEY]).toBe("abc");
		expect(bg.state.alarms[CLIP_ALARM]).toEqual({ delayInMinutes: 0.5 });
	});

	it("uses the clipboard-seconds pref for the delay", async () => {
		const bg = await loadBackground({ localSeed: { "pref.clipboardClearSeconds": 120 } });
		await bg.send({ type: "CLIPBOARD_SCHEDULE_CLEAR", payload: { expectedHash: "abc" } });
		expect(bg.state.alarms[CLIP_ALARM]).toEqual({ delayInMinutes: 2 });
	});

	it("does nothing when the hash is missing or empty", async () => {
		const bg = await loadBackground();
		const a = await bg.send({ type: "CLIPBOARD_SCHEDULE_CLEAR", payload: {} });
		const b = await bg.send({ type: "CLIPBOARD_SCHEDULE_CLEAR", payload: { expectedHash: "" } });
		expect(a.resp).toEqual({ ok: true, data: null });
		expect(b.resp).toEqual({ ok: true, data: null });
		expect(bg.state.alarms[CLIP_ALARM]).toBeUndefined();
	});
});

describe("clipboard clear alarm", () => {
	it("clears the stash and asks offscreen to clear the matching clipboard", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "CLIPBOARD_SCHEDULE_CLEAR", payload: { expectedHash: "deadbeef" } });
		bg.fireAlarm(CLIP_ALARM);
		await bg.flush();
		const clear = bg.state.offscreenCalls.find((m) => m.type === "CLIPBOARD_CLEAR");
		expect(clear?.payload).toEqual({ expectedHash: "deadbeef" });
		// One-shot: the stashed hash is consumed.
		expect(bg.state.session[EXPECTED_KEY]).toBeUndefined();
	});

	it("is a no-op when no hash is stashed", async () => {
		const bg = await loadBackground();
		bg.fireAlarm(CLIP_ALARM);
		await bg.flush();
		expect(bg.state.offscreenCalls.find((m) => m.type === "CLIPBOARD_CLEAR")).toBeUndefined();
	});
});
