import { beforeEach, describe, expect, it, vi } from "vitest";

// Control the native BiometricVault plugin that registerPlugin() returns at import time.
const native = vi.hoisted(() => ({
	isAvailable: vi.fn(),
	hasSecret: vi.fn(),
	setSecret: vi.fn(),
	getSecret: vi.fn(),
	deleteSecret: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));

const { mobileBiometric } = await import("./biometric");

beforeEach(() => {
	vi.clearAllMocks();
});

// The load-bearing behavior: availability probes must SWALLOW errors (so a build without
// the native plugin, e.g. the browser dev build, just hides the feature), while the
// action methods must PROPAGATE errors (so a keychain failure or a user cancel surfaces).
describe("mobileBiometric availability probes swallow errors", () => {
	it("isAvailable reflects the native flag", async () => {
		native.isAvailable.mockResolvedValue({ available: true, biometryType: "faceId" });
		expect(await mobileBiometric.isAvailable()).toBe(true);
		native.isAvailable.mockResolvedValue({ available: false });
		expect(await mobileBiometric.isAvailable()).toBe(false);
	});

	it("isAvailable returns false when the native call rejects (plugin absent)", async () => {
		native.isAvailable.mockRejectedValue(new Error("not implemented on web"));
		expect(await mobileBiometric.isAvailable()).toBe(false);
	});

	it("biometryType maps the native modality, defaulting unknowns to 'biometric'", async () => {
		native.isAvailable.mockResolvedValue({ available: true, biometryType: "touchId" });
		expect(await mobileBiometric.biometryType?.()).toBe("touchId");
		native.isAvailable.mockResolvedValue({ available: true, biometryType: "unknown" });
		expect(await mobileBiometric.biometryType?.()).toBe("biometric");
		native.isAvailable.mockRejectedValue(new Error("absent"));
		expect(await mobileBiometric.biometryType?.()).toBe("biometric");
	});

	it("isEnabled reflects whether a secret is cached", async () => {
		native.hasSecret.mockResolvedValue({ value: true });
		expect(await mobileBiometric.isEnabled()).toBe(true);
	});

	it("isEnabled returns false when the native call rejects", async () => {
		native.hasSecret.mockRejectedValue(new Error("boom"));
		expect(await mobileBiometric.isEnabled()).toBe(false);
	});
});

describe("mobileBiometric actions propagate errors", () => {
	it("enable hands the VEK to the native cache", async () => {
		native.setSecret.mockResolvedValue(undefined);
		await mobileBiometric.enable("VEK_B64");
		expect(native.setSecret).toHaveBeenCalledWith({ secret: "VEK_B64" });
	});

	it("enable surfaces a native failure rather than swallowing it", async () => {
		native.setSecret.mockRejectedValue(new Error("keychain store failed"));
		await expect(mobileBiometric.enable("VEK_B64")).rejects.toThrow("keychain store failed");
	});

	it("unlock returns the gated VEK and passes a prompt reason", async () => {
		native.getSecret.mockResolvedValue({ secret: "GATED_VEK" });
		expect(await mobileBiometric.unlock()).toBe("GATED_VEK");
		expect(native.getSecret).toHaveBeenCalledWith({ reason: expect.any(String) });
	});

	it("unlock surfaces a cancel rather than swallowing it", async () => {
		native.getSecret.mockRejectedValue(new Error("Cancelled"));
		await expect(mobileBiometric.unlock()).rejects.toThrow("Cancelled");
	});

	it("disable clears the native cache", async () => {
		native.deleteSecret.mockResolvedValue(undefined);
		await mobileBiometric.disable();
		expect(native.deleteSecret).toHaveBeenCalledTimes(1);
	});
});
