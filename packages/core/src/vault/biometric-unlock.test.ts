import { describe, expect, it, vi } from "vitest";
import type { BiometricUnlock } from "../adapters/biometric";
import type { CryptoAdapter } from "../adapters/crypto";
import {
	biometricUnlockFlow,
	enableBiometricUnlock,
	unlockVekWithBiometric,
} from "./biometric-unlock";

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

const VID = "vault-1";

describe("enableBiometricUnlock", () => {
	it("exports the live VEK and hands it to the biometric cache keyed by vault id", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric();
		await enableBiometricUnlock(crypto, biometric, VID);
		expect(crypto.exportVek).toHaveBeenCalledTimes(1);
		expect(biometric.enable).toHaveBeenCalledWith("VEK_B64", VID);
	});

	it("does not cache anything if the VEK export fails (vault locked)", async () => {
		const crypto = fakeCrypto({
			exportVek: vi.fn(async () => {
				throw new Error("locked");
			}),
		});
		const biometric = fakeBiometric();
		await expect(enableBiometricUnlock(crypto, biometric, VID)).rejects.toThrow("locked");
		expect(biometric.enable).not.toHaveBeenCalled();
	});
});

describe("unlockVekWithBiometric", () => {
	it("reads the gated VEK and loads it into the crypto session", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric({ unlock: vi.fn(async () => "GATED_VEK") });
		await unlockVekWithBiometric(crypto, biometric, VID);
		expect(biometric.unlock).toHaveBeenCalledWith(VID);
		expect(crypto.unlockWithVek).toHaveBeenCalledWith("GATED_VEK");
	});

	it("propagates a biometric cancel and never touches the crypto session", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric({
			unlock: vi.fn(async () => {
				throw new Error("cancelled");
			}),
		});
		await expect(unlockVekWithBiometric(crypto, biometric, VID)).rejects.toThrow("cancelled");
		expect(crypto.unlockWithVek).not.toHaveBeenCalled();
	});
});

describe("biometricUnlockFlow", () => {
	it("loads the gated VEK then loads entries, with no teardown on success", async () => {
		const crypto = fakeCrypto({ lock: vi.fn(async () => {}) });
		const biometric = fakeBiometric({ unlock: vi.fn(async () => "GATED") });
		const loadEntries = vi.fn(async () => {});
		const onStaleCache = vi.fn();
		await biometricUnlockFlow({ crypto, biometric, vaultId: VID, loadEntries, onStaleCache });
		expect(crypto.unlockWithVek).toHaveBeenCalledWith("GATED");
		expect(loadEntries).toHaveBeenCalledTimes(1);
		expect(onStaleCache).not.toHaveBeenCalled();
		expect(crypto.lock).not.toHaveBeenCalled();
		expect(biometric.disable).not.toHaveBeenCalled();
	});

	it("tears down (lock + disable + signal) and throws a friendly error on a stale cache", async () => {
		const crypto = fakeCrypto({ lock: vi.fn(async () => {}) });
		const biometric = fakeBiometric();
		const loadEntries = vi.fn(async () => {
			throw new Error("entries did not decrypt");
		});
		const onStaleCache = vi.fn();
		await expect(
			biometricUnlockFlow({ crypto, biometric, vaultId: VID, loadEntries, onStaleCache }),
		).rejects.toThrow(/out of date/i);
		// The gate's VEK was loaded, then the bad cache was torn down.
		expect(crypto.unlockWithVek).toHaveBeenCalled();
		expect(crypto.lock).toHaveBeenCalledTimes(1);
		expect(biometric.disable).toHaveBeenCalledTimes(1);
		expect(onStaleCache).toHaveBeenCalledTimes(1);
	});

	it("does not surface a raw decrypt error to the unlock screen", async () => {
		const crypto = fakeCrypto({ lock: vi.fn(async () => {}) });
		const biometric = fakeBiometric();
		const loadEntries = vi.fn(async () => {
			throw new Error("zod: invalid payload internals");
		});
		await expect(
			biometricUnlockFlow({ crypto, biometric, vaultId: VID, loadEntries, onStaleCache: vi.fn() }),
		).rejects.not.toThrow(/zod/i);
	});
});
