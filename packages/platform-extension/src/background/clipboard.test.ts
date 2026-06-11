import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBackground } from "../test/test-harness";

afterEach(() => {
	vi.unstubAllGlobals();
});

const CLIP_ALARM = "vault:clipboard-clear";

describe("CLIPBOARD_SCHEDULE_CLEAR", () => {
	it("arms the clear alarm using the default 30s (= 0.5 min)", async () => {
		const bg = await loadBackground();
		const { resp } = await bg.send({ type: "CLIPBOARD_SCHEDULE_CLEAR" });
		expect(resp).toEqual({ ok: true, data: null });
		expect(bg.state.alarms[CLIP_ALARM]).toEqual({ delayInMinutes: 0.5 });
	});

	it("uses the clipboard-seconds pref for the delay", async () => {
		const bg = await loadBackground({ localSeed: { "pref.clipboardClearSeconds": 120 } });
		await bg.send({ type: "CLIPBOARD_SCHEDULE_CLEAR" });
		expect(bg.state.alarms[CLIP_ALARM]).toEqual({ delayInMinutes: 2 });
	});
});

describe("clipboard clear alarm", () => {
	it("wipes the clipboard via the offscreen document", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "CLIPBOARD_SCHEDULE_CLEAR" });
		bg.fireAlarm(CLIP_ALARM);
		await bg.flush();
		const clear = bg.state.offscreenCalls.find((m) => m.type === "CLIPBOARD_CLEAR");
		expect(clear).toBeDefined();
	});
});
