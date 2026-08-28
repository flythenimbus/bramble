import { beforeEach, describe, expect, it, vi } from "vitest";

// registerPlugin() runs at import time, so the native plugin, the platform and the
// auto-lock grace all have to be in place before the module under test is pulled in.
const { native, platform, armFilePickGrace, scanQrCode } = vi.hoisted(() => ({
	native: { scan: vi.fn() },
	platform: { value: "android" },
	armFilePickGrace: vi.fn(),
	scanQrCode: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
	registerPlugin: () => native,
	Capacitor: { getPlatform: () => platform.value },
}));
vi.mock("./auto-lock", () => ({ armFilePickGrace }));
vi.mock("./scan", () => ({ scanQrCode }));

const { scanQr } = await import("./qr-scanner");

beforeEach(() => {
	vi.clearAllMocks();
	platform.value = "android";
	scanQrCode.mockResolvedValue(null);
	native.scan.mockResolvedValue({ value: null });
});

describe("scanQr", () => {
	it("uses the in-webview jsQR scanner off iOS", async () => {
		scanQrCode.mockResolvedValue("otpauth://totp/a");
		expect(await scanQr()).toBe("otpauth://totp/a");
		expect(native.scan).not.toHaveBeenCalled();
	});

	it("uses the native AVFoundation scanner on iOS", async () => {
		platform.value = "ios";
		native.scan.mockResolvedValue({ value: "otpauth://totp/a" });
		expect(await scanQr()).toBe("otpauth://totp/a");
		expect(scanQrCode).not.toHaveBeenCalled();
	});

	// The plugin reports a cancel as a null value, which is not a failure.
	it("maps a cancelled native scan to null", async () => {
		platform.value = "ios";
		expect(await scanQr()).toBeNull();
	});

	// Issue #80: the camera permission prompt takes the app out of the foreground, which
	// locked the vault out from under the scan under "Immediately" (the mobile default).
	// The grace has to be armed BEFORE the scanner starts, because the prompt is the first
	// thing it does.
	describe("auto-lock grace (issue #80)", () => {
		for (const value of ["android", "ios"]) {
			it(`arms the grace before the scanner runs on ${value}`, async () => {
				platform.value = value;
				const order: string[] = [];
				armFilePickGrace.mockImplementation(() => order.push("arm"));
				scanQrCode.mockImplementation(async () => {
					order.push("scan");
					return null;
				});
				native.scan.mockImplementation(async () => {
					order.push("scan");
					return { value: null };
				});

				await scanQr();
				expect(order).toEqual(["arm", "scan"]);
			});
		}
	});
});
