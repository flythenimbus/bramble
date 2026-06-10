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

	it("captures the visible tab as PNG and returns the decoded QR (null when none)", async () => {
		const bg = await loadBackground({ lastFocusedWindow: { id: 7 } });
		// Minimal OffscreenCanvas / image pipeline so jsQR runs on a blank frame.
		vi.stubGlobal("fetch", async () => ({ blob: async () => ({}) }));
		vi.stubGlobal("createImageBitmap", async () => ({ width: 2, height: 2, close: () => {} }));
		vi.stubGlobal(
			"OffscreenCanvas",
			class {
				width: number;
				height: number;
				constructor(w: number, h: number) {
					this.width = w;
					this.height = h;
				}
				getContext() {
					return {
						drawImage: () => {},
						getImageData: () => ({ data: new Uint8ClampedArray(2 * 2 * 4), width: 2, height: 2 }),
					};
				}
			},
		);
		const { resp } = await bg.send({ type: "CAPTURE_QR_SCAN" });
		expect(resp).toEqual({ ok: true, data: null });
		expect(bg.chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(7, { format: "png" });
	});

	it("wraps a capture failure as an error envelope", async () => {
		const bg = await loadBackground({ lastFocusedWindow: { id: 7 } });
		bg.chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error("capture denied"));
		const { resp } = await bg.send({ type: "CAPTURE_QR_SCAN" });
		expect(resp.ok).toBe(false);
		expect(resp.error).toBe("Error: capture denied");
	});
});
