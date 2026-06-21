import { describe, expect, it, vi } from "vitest";
import type { BiometricUnlock } from "../adapters/biometric";
import type { CryptoAdapter } from "../adapters/crypto";
import { enableBiometricUnlock, unlockVekWithBiometric } from "./biometric-unlock";

function fakeCrypto(over: Partial<CryptoAdapter> = {}): CryptoAdapter {
	return {
		exportVek: vi.fn(async () => "VEK_B64"),
		unlockWithVek: vi.fn(async () => {}),
		...over,
	} as unknown as CryptoAdapter;
}

function fakeBiometric(over: Partial<BiometricUnlock> = {}): BiometricUnlock {
	return {
		isAvailable: vi.fn(async () => true),
		isEnabled: vi.fn(async () => false),
		enable: vi.fn(async () => {}),
		unlock: vi.fn(async () => "VEK_B64"),
		disable: vi.fn(async () => {}),
		...over,
	};
}

describe("enableBiometricUnlock", () => {
	it("exports the live VEK and hands it to the biometric cache", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric();
		await enableBiometricUnlock(crypto, biometric);
		expect(crypto.exportVek).toHaveBeenCalledTimes(1);
		expect(biometric.enable).toHaveBeenCalledWith("VEK_B64");
	});

	it("does not cache anything if the VEK export fails (vault locked)", async () => {
		const crypto = fakeCrypto({
			exportVek: vi.fn(async () => {
				throw new Error("locked");
			}),
		});
		const biometric = fakeBiometric();
		await expect(enableBiometricUnlock(crypto, biometric)).rejects.toThrow("locked");
		expect(biometric.enable).not.toHaveBeenCalled();
	});
});

describe("unlockVekWithBiometric", () => {
	it("reads the gated VEK and loads it into the crypto session", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric({ unlock: vi.fn(async () => "GATED_VEK") });
		await unlockVekWithBiometric(crypto, biometric);
		expect(biometric.unlock).toHaveBeenCalledTimes(1);
		expect(crypto.unlockWithVek).toHaveBeenCalledWith("GATED_VEK");
	});

	it("propagates a biometric cancel and never touches the crypto session", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric({
			unlock: vi.fn(async () => {
				throw new Error("cancelled");
			}),
		});
		await expect(unlockVekWithBiometric(crypto, biometric)).rejects.toThrow("cancelled");
		expect(crypto.unlockWithVek).not.toHaveBeenCalled();
	});
});
