import { describe, expect, it } from "vitest";
import {
	isBiometricCancel,
	isBiometricInterrupted,
	isBiometricInvalidated,
	isBiometricLockout,
} from "./biometric";

// These predicates are a contract with two native plugins that reject with bare strings
// (BiometricVault.swift, BiometricVaultPlugin.java). Nothing type-checks that agreement, and
// getting it wrong is silent: a mistyped "interrupted" would stop the iOS auto-prompt retrying,
// and a mistyped "invalidated" would leave a dead gate advertising itself forever.
const CODES = {
	cancelled: isBiometricCancel,
	interrupted: isBiometricInterrupted,
	invalidated: isBiometricInvalidated,
	lockout: isBiometricLockout,
} as const;

describe("biometric error codes", () => {
	it("each predicate matches its own code and no other", () => {
		for (const [code, matches] of Object.entries(CODES)) {
			expect(matches({ code })).toBe(true);
			for (const [other, otherMatches] of Object.entries(CODES)) {
				if (other !== code) expect(otherMatches({ code })).toBe(false);
			}
		}
	});

	it("treats anything that is not a coded rejection as no match", () => {
		// A thrown Error, a rejection from the bridge itself, or a nullish value must not be read
		// as one of these: the retry loop and the tear-down paths both branch on them.
		for (const matches of Object.values(CODES)) {
			expect(matches(new Error("interrupted"))).toBe(false);
			expect(matches({ code: "auth-failed" })).toBe(false);
			expect(matches({ message: "cancelled" })).toBe(false);
			expect(matches(undefined)).toBe(false);
			expect(matches(null)).toBe(false);
			expect(matches("cancelled")).toBe(false);
		}
	});

	it("does not treat a plain auth failure as retryable", () => {
		// The one that shipped: retrying on "anything but a cancel" meant a gate whose ciphertext
		// no longer decrypts was asked four times, taking a touch each time and failing the same
		// way. Only an interruption is worth asking again for.
		expect(isBiometricInterrupted({ code: "auth-failed" })).toBe(false);
		expect(isBiometricInterrupted({ code: "invalidated" })).toBe(false);
	});
});
