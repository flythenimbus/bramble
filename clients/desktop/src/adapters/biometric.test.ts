import { isBiometricCancel } from "@core/adapters/biometric";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The gate holds the key in Rust: the adapter passes a vault id and a verdict, never a VEK, and
// still reports the unlock the way ./crypto.ts does when it loads one.

const h = vi.hoisted(() => ({
	calls: [] as { cmd: string; args: unknown }[],
	replies: {} as Record<string, unknown>,
	rejects: {} as Record<string, unknown>,
	unlocked: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (cmd: string, args: unknown) => {
		h.calls.push({ cmd, args });
		if (cmd in h.rejects) throw h.rejects[cmd];
		return h.replies[cmd];
	},
}));
vi.mock("./vault-session", () => ({
	markUnlocked: () => {
		h.unlocked++;
	},
}));

const { desktopBiometric } = await import("./biometric");

beforeEach(() => {
	h.calls = [];
	h.replies = {};
	h.rejects = {};
	h.unlocked = 0;
});

describe("desktopBiometric", () => {
	it("holds the key natively, so the core never exports or loads it", () => {
		expect(desktopBiometric.holdsKeyNatively).toBe(true);
	});

	it("arms with the vault id and the gate, never a key", async () => {
		await desktopBiometric.enable(null, "v1", true);
		expect(h.calls).toEqual([
			{ cmd: "biometric_enable", args: { vaultId: "v1", allowPasscode: true } },
		]);
	});

	it("unlocks in Rust, returns no key, and reports the vault open", async () => {
		expect(await desktopBiometric.unlock("v1", false)).toBeNull();
		expect(h.calls).toEqual([
			{ cmd: "biometric_unlock", args: { vaultId: "v1", allowPasscode: false } },
		]);
		expect(h.unlocked).toBe(1);
	});

	it("passes a dismissed prompt through as a cancel, and reports nothing open", async () => {
		h.rejects.biometric_unlock = { code: "cancelled", message: "Cancelled" };
		const err = await desktopBiometric.unlock("v1", false).catch((e: unknown) => e);
		expect(isBiometricCancel(err)).toBe(true);
		expect(h.unlocked).toBe(0);
	});

	it("names the modality Rust reports, and hides the feature when it can't be reached", async () => {
		h.replies.biometric_status = {
			available: true,
			biometryType: "touchId",
			biometryEnrolled: true,
		};
		expect(await desktopBiometric.biometryType?.()).toBe("touchId");
		expect(await desktopBiometric.isAvailable()).toBe(true);
		h.rejects.biometric_status = new Error("no such command");
		expect(await desktopBiometric.isAvailable()).toBe(false);
		expect(await desktopBiometric.biometryType?.()).toBe("biometric");
	});
});
