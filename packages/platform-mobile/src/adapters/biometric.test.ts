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

const VID = "vault-1";

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

	// A passcode-only iPhone (no enrolled Face ID / Touch ID) still opens the .userPresence
	// gate, so the modality must survive the mapping instead of collapsing to "biometric".
	it("biometryType passes through 'passcode'", async () => {
		native.isAvailable.mockResolvedValue({ available: true, biometryType: "passcode" });
		expect(await mobileBiometric.biometryType?.()).toBe("passcode");
	});

	it("biometryEnrolled reports the native flag", async () => {
		native.isAvailable.mockResolvedValue({ available: true, biometryEnrolled: false });
		expect(await mobileBiometric.biometryEnrolled?.()).toBe(false);
		native.isAvailable.mockResolvedValue({ available: true, biometryEnrolled: true });
		expect(await mobileBiometric.biometryEnrolled?.()).toBe(true);
	});

	// Android's plugin predates the field; there, availability already implies an enrolled
	// biometric, so falling back to it keeps the biometrics-only gate offered.
	it("biometryEnrolled falls back to availability when the field is absent", async () => {
		native.isAvailable.mockResolvedValue({ available: true });
		expect(await mobileBiometric.biometryEnrolled?.()).toBe(true);
		native.isAvailable.mockRejectedValue(new Error("absent"));
		expect(await mobileBiometric.biometryEnrolled?.()).toBe(false);
	});

	it("isEnabled reflects whether a secret is cached", async () => {
		native.hasSecret.mockResolvedValue({ value: true });
		expect(await mobileBiometric.isEnabled(VID)).toBe(true);
	});

	it("isEnabled returns false when the native call rejects", async () => {
		native.hasSecret.mockRejectedValue(new Error("boom"));
		expect(await mobileBiometric.isEnabled(VID)).toBe(false);
	});
});

describe("mobileBiometric actions propagate errors", () => {
	it("enable hands the VEK to the native cache", async () => {
		native.setSecret.mockResolvedValue(undefined);
		await mobileBiometric.enable("VEK_B64", VID, false);
		expect(native.setSecret).toHaveBeenCalledWith({
			vaultId: VID,
			secret: "VEK_B64",
			allowPasscode: false,
		});
	});

	// allowPasscode picks the Keychain access control, so it has to reach the native side
	// verbatim: it is the difference between a passcode opening the vault and not.
	it("enable forwards the passcode-fallback choice", async () => {
		native.setSecret.mockResolvedValue(undefined);
		await mobileBiometric.enable("VEK_B64", VID, true);
		expect(native.setSecret).toHaveBeenCalledWith({
			vaultId: VID,
			secret: "VEK_B64",
			allowPasscode: true,
		});
	});

	it("enable surfaces a native failure rather than swallowing it", async () => {
		native.setSecret.mockRejectedValue(new Error("keychain store failed"));
		await expect(mobileBiometric.enable("VEK_B64", VID, false)).rejects.toThrow(
			"keychain store failed",
		);
	});

	it("unlock returns the gated VEK and passes a prompt reason", async () => {
		native.getSecret.mockResolvedValue({ secret: "GATED_VEK" });
		expect(await mobileBiometric.unlock(VID, false)).toBe("GATED_VEK");
		expect(native.getSecret).toHaveBeenCalledWith({
			vaultId: VID,
			reason: expect.any(String),
			allowPasscode: false,
		});
	});

	// The prompt policy has to match how the item was armed: a passcode-authenticated
	// context cannot open a biometry-only item.
	it("unlock forwards the passcode-fallback choice", async () => {
		native.getSecret.mockResolvedValue({ secret: "GATED_VEK" });
		await mobileBiometric.unlock(VID, true);
		expect(native.getSecret).toHaveBeenCalledWith(expect.objectContaining({ allowPasscode: true }));
	});

	it("unlock surfaces a cancel rather than swallowing it", async () => {
		native.getSecret.mockRejectedValue(new Error("Cancelled"));
		await expect(mobileBiometric.unlock(VID, false)).rejects.toThrow("Cancelled");
	});

	it("disable clears the native cache", async () => {
		native.deleteSecret.mockResolvedValue(undefined);
		await mobileBiometric.disable(VID);
		expect(native.deleteSecret).toHaveBeenCalledTimes(1);
	});
});
