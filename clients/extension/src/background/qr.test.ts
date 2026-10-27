import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBackground } from "../test/test-harness";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("CAPTURE_QR_SCAN", () => {
	it("errors when there is no focused normal browser window", async () => {
		const bg = await loadBackground({ lastFocusedWindow: { id: undefined } });
		const { resp } = await bg.send({ type: "CAPTURE_QR_SCAN" });
		expect(resp).toEqual({ ok: false, error: "No browser window to capture" });
		expect(bg.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
	});

	it("captures the visible tab as PNG and forwards the frame to the offscreen decoder", async () => {
		// Decode now runs in the offscreen host (jsqr's lazy import is unreliable in the SW),
		// so the background just captures and forwards QR_DECODE; the offscreen returns the result.
		const bg = await loadBackground({
			lastFocusedWindow: { id: 7 },
			offscreen: (msg) =>
				msg.type === "QR_DECODE"
					? { ok: true, data: "otpauth://totp/x" }
					: { ok: false, error: `unhandled ${msg.type}` },
		});
		const { resp } = await bg.send({ type: "CAPTURE_QR_SCAN" });
		expect(resp).toEqual({ ok: true, data: "otpauth://totp/x" });
		expect(bg.chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(7, { format: "png" });
		// The captured PNG data URL is what gets handed to the decoder.
		const decodeCall = bg.state.offscreenCalls.find((m) => m.type === "QR_DECODE");
		expect(decodeCall?.payload).toMatchObject({ dataUrl: expect.any(String) });
	});

	it("returns null data when the offscreen finds no QR code", async () => {
		const bg = await loadBackground({
			lastFocusedWindow: { id: 7 },
			offscreen: (msg) =>
				msg.type === "QR_DECODE" ? { ok: true, data: null } : { ok: false, error: "x" },
		});
		const { resp } = await bg.send({ type: "CAPTURE_QR_SCAN" });
		expect(resp).toEqual({ ok: true, data: null });
	});

	it("wraps a capture failure as an error envelope", async () => {
		const bg = await loadBackground({ lastFocusedWindow: { id: 7 } });
		bg.chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error("capture denied"));
		const { resp } = await bg.send({ type: "CAPTURE_QR_SCAN" });
		expect(resp.ok).toBe(false);
		expect(resp.error).toBe("Error: capture denied");
	});
});
