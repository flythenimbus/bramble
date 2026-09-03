import { describe, expect, it, vi } from "vitest";
import type { BiometricUnlock } from "../adapters/biometric";
import type { CryptoAdapter } from "../adapters/crypto";
import {
	biometricUnlockFlow,
	effectiveAllowPasscode,
	enableBiometricUnlock,
	reconcileBiometricGate,
	StaleBiometricCacheError,
	unlockVekWithBiometric,
} from "./biometric-unlock";

/** What the native plugins reject with when the OS discarded the cached VEK. */
function invalidated(): Error {
	return Object.assign(new Error("enrolment changed"), { code: "invalidated" });
}

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
	it("gives up on a native call that never comes back, naming the step", async () => {
		// A hung plugin call used to leave the Settings toggle busy forever, which renders as
		// off AND disabled with no error: the one failure mode that looks like nothing happened.
		vi.useFakeTimers();
		try {
			const crypto = { exportVek: () => new Promise<string>(() => {}) } as unknown as CryptoAdapter;
			const biometric = { enable: async () => {} } as unknown as BiometricUnlock;
			const p = enableBiometricUnlock(crypto, biometric, VID, true);
			const assertion = expect(p).rejects.toThrow(/Reading this vault's key timed out/);
			await vi.advanceTimersByTimeAsync(11_000);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it("names the arming step when it is the gate that stalls, not the key read", async () => {
		vi.useFakeTimers();
		try {
			const crypto = { exportVek: async () => "vek" } as unknown as CryptoAdapter;
			const biometric = { enable: () => new Promise<void>(() => {}) } as unknown as BiometricUnlock;
			const p = enableBiometricUnlock(crypto, biometric, VID, true);
			const assertion = expect(p).rejects.toThrow(/Saving the key to this device timed out/);
			await vi.advanceTimersByTimeAsync(11_000);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it("exports the live VEK and hands it to the biometric cache keyed by vault id", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric();
		await enableBiometricUnlock(crypto, biometric, VID, false);
		expect(crypto.exportVek).toHaveBeenCalledTimes(1);
		expect(biometric.enable).toHaveBeenCalledWith("VEK_B64", VID, false);
	});

	it("passes the passcode-fallback choice through, since it picks the OS gate", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric();
		await enableBiometricUnlock(crypto, biometric, VID, true);
		expect(biometric.enable).toHaveBeenCalledWith("VEK_B64", VID, true);
	});

	it("does not cache anything if the VEK export fails (vault locked)", async () => {
		const crypto = fakeCrypto({
			exportVek: vi.fn(async () => {
				throw new Error("locked");
			}),
		});
		const biometric = fakeBiometric();
		await expect(enableBiometricUnlock(crypto, biometric, VID, false)).rejects.toThrow("locked");
		expect(biometric.enable).not.toHaveBeenCalled();
	});
});

describe("unlockVekWithBiometric", () => {
	it("reads the gated VEK and loads it into the crypto session", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric({ unlock: vi.fn(async () => "GATED_VEK") });
		await unlockVekWithBiometric(crypto, biometric, VID, false);
		expect(biometric.unlock).toHaveBeenCalledWith(VID, false);
		expect(crypto.unlockWithVek).toHaveBeenCalledWith("GATED_VEK");
	});

	it("propagates a biometric cancel and never touches the crypto session", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric({
			unlock: vi.fn(async () => {
				throw new Error("cancelled");
			}),
		});
		await expect(unlockVekWithBiometric(crypto, biometric, VID, true)).rejects.toThrow("cancelled");
		expect(crypto.unlockWithVek).not.toHaveBeenCalled();
	});
});

describe("biometricUnlockFlow", () => {
	it("loads the gated VEK then loads entries, with no teardown on success", async () => {
		const crypto = fakeCrypto({ lock: vi.fn(async () => {}) });
		const biometric = fakeBiometric({ unlock: vi.fn(async () => "GATED") });
		const loadEntries = vi.fn(async () => {});
		const onStaleCache = vi.fn();
		await biometricUnlockFlow({
			crypto,
			biometric,
			vaultId: VID,
			allowPasscode: false,
			loadEntries,
			onStaleCache,
		});
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
			biometricUnlockFlow({
				crypto,
				biometric,
				vaultId: VID,
				allowPasscode: false,
				loadEntries,
				onStaleCache,
			}),
		).rejects.toThrow(StaleBiometricCacheError);
		// The gate's VEK was loaded, then the bad cache was torn down.
		expect(crypto.unlockWithVek).toHaveBeenCalled();
		expect(crypto.lock).toHaveBeenCalledTimes(1);
		expect(biometric.disable).toHaveBeenCalledTimes(1);
		// The type is the contract: it is the one biometric failure the unlock screen shows for a
		// prompt the user never asked for, because the button it came from is gone with it.
		expect(onStaleCache).toHaveBeenCalledTimes(1);
	});

	it("does not surface a raw decrypt error to the unlock screen", async () => {
		const crypto = fakeCrypto({ lock: vi.fn(async () => {}) });
		const biometric = fakeBiometric();
		const loadEntries = vi.fn(async () => {
			throw new Error("zod: invalid payload internals");
		});
		await expect(
			biometricUnlockFlow({
				crypto,
				biometric,
				vaultId: VID,
				allowPasscode: false,
				loadEntries,
				onStaleCache: vi.fn(),
			}),
		).rejects.not.toThrow(/zod/i);
	});

	it("retires the gate when the OS invalidated it, and rethrows so the caller can say why", async () => {
		const crypto = fakeCrypto({ lock: vi.fn(async () => {}) });
		const biometric = fakeBiometric({
			unlock: vi.fn(async () => {
				throw invalidated();
			}),
		});
		const loadEntries = vi.fn(async () => {});
		const onStaleCache = vi.fn();
		await expect(
			biometricUnlockFlow({
				crypto,
				biometric,
				vaultId: VID,
				allowPasscode: false,
				loadEntries,
				onStaleCache,
			}),
		).rejects.toMatchObject({ code: "invalidated" });
		// The cached VEK is unreadable forever, so the toggle goes off with it.
		expect(biometric.disable).toHaveBeenCalledTimes(1);
		expect(onStaleCache).toHaveBeenCalledTimes(1);
		expect(loadEntries).not.toHaveBeenCalled();
	});

	it("leaves the gate alone when the user simply cancelled", async () => {
		const crypto = fakeCrypto({ lock: vi.fn(async () => {}) });
		const biometric = fakeBiometric({
			unlock: vi.fn(async () => {
				throw Object.assign(new Error("Cancelled"), { code: "cancelled" });
			}),
		});
		const onStaleCache = vi.fn();
		await expect(
			biometricUnlockFlow({
				crypto,
				biometric,
				vaultId: VID,
				allowPasscode: false,
				loadEntries: vi.fn(async () => {}),
				onStaleCache,
			}),
		).rejects.toThrow("Cancelled");
		expect(biometric.disable).not.toHaveBeenCalled();
		expect(onStaleCache).not.toHaveBeenCalled();
	});
});

describe("reconcileBiometricGate", () => {
	it("re-caches the VEK under the gate the setting now asks for", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric({ isEnabled: vi.fn(async () => true) });
		await reconcileBiometricGate({ crypto, biometric, vaultId: VID, allowPasscode: true });
		expect(biometric.enable).toHaveBeenCalledWith("VEK_B64", VID, true);
	});

	it("does nothing when the gate isn't set up, so an unlock never arms one by surprise", async () => {
		const crypto = fakeCrypto();
		const biometric = fakeBiometric({ isEnabled: vi.fn(async () => false) });
		await reconcileBiometricGate({ crypto, biometric, vaultId: VID, allowPasscode: false });
		expect(crypto.exportVek).not.toHaveBeenCalled();
		expect(biometric.enable).not.toHaveBeenCalled();
	});

	it("asks about THIS vault, so unlocking another never arms one it was not given", async () => {
		// The regression: the caller passed React state that still described the vault we had
		// switched away from, and re-arming on that stale `true` created a gate on a vault the
		// user never enabled it for - unlocking B by password gave B a passcode-openable cache.
		const crypto = fakeCrypto();
		const enabledVaults = new Set(["vault-a"]);
		const biometric = fakeBiometric({
			isEnabled: vi.fn(async (id: string) => enabledVaults.has(id)),
		});
		await reconcileBiometricGate({ crypto, biometric, vaultId: "vault-b", allowPasscode: true });
		expect(biometric.isEnabled).toHaveBeenCalledWith("vault-b");
		expect(biometric.enable).not.toHaveBeenCalled();
	});
});

describe("effectiveAllowPasscode", () => {
	it("follows the preference when a biometric is enrolled", () => {
		expect(effectiveAllowPasscode(true, false)).toBe(false);
		expect(effectiveAllowPasscode(true, true)).toBe(true);
	});

	// A passcode-only iPhone has no biometry-only access control to build, so asking for one
	// would neither arm nor unlock. The preference doesn't get a say there.
	it("forces the passcode on when nothing is enrolled, whatever the preference says", () => {
		expect(effectiveAllowPasscode(false, false)).toBe(true);
		expect(effectiveAllowPasscode(false, true)).toBe(true);
	});
});
