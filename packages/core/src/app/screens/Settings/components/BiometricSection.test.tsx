/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { BiometricSection } from "./BiometricSection";

// The passcode-fallback row decides which OS gate holds this device's cached VEK, and the gate
// is baked in when the VEK is written. So the row is not just a stored boolean: flipping it has
// to re-arm, and a re-arm that fails must not leave the setting claiming something the Keychain
// item does not do. These are the states that are easy to get wrong and invisible until a device.

const h = vi.hoisted(() => ({
	biometricSupported: true,
	biometricAvailable: true,
	biometricEnabled: true,
	biometryType: "faceId" as string,
	biometryEnrolled: true,
	passcodeFallback: false,
	/** Arguments enableBiometric was called with, in order. */
	enabled: [] as boolean[],
	enableThrows: null as string | null,
	/** Pref writes, in order, so a revert is distinguishable from never having written. */
	writes: [] as [string, unknown][],
}));

vi.mock("../../../../hooks/useVault", () => ({
	useVault: () => ({
		biometricSupported: h.biometricSupported,
		biometricAvailable: h.biometricAvailable,
		biometricEnabled: h.biometricEnabled,
		biometryType: h.biometryType,
		biometryEnrolled: h.biometryEnrolled,
		enableBiometric: async (allowPasscode: boolean) => {
			h.enabled.push(allowPasscode);
			if (h.enableThrows) throw new Error(h.enableThrows);
		},
		disableBiometric: async () => {},
		refreshBiometric: async () => {},
	}),
}));

vi.mock("../../../../hooks/usePrefs", () => ({
	usePrefs: () => ({
		prefs: { biometricPasscodeFallback: h.passcodeFallback, biometricAutoPrompt: false },
		update: async (key: string, value: unknown) => {
			h.writes.push([key, value]);
			if (key === "biometricPasscodeFallback") h.passcodeFallback = value as boolean;
		},
	}),
}));

function mount(target = "ios") {
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={{ target } as unknown as Platform}>
				<BiometricSection />
			</PlatformProvider>
		</I18nProvider>,
	);
}

const passcodeToggle = () =>
	screen.getByLabelText(/toggle passcode fallback/i) as HTMLButtonElement;

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	h.biometricSupported = true;
	h.biometricAvailable = true;
	h.biometricEnabled = true;
	h.biometryType = "faceId";
	h.biometryEnrolled = true;
	h.passcodeFallback = false;
	h.enabled = [];
	h.enableThrows = null;
	h.writes = [];
});

afterEach(cleanup);

describe("BiometricSection passcode fallback", () => {
	it("is iOS only", () => {
		// Android's Keystore key is biometry-only already and cannot be told to accept the
		// device credential without being regenerated, so there is no choice to offer there.
		mount("android");
		expect(screen.queryByLabelText(/toggle passcode fallback/i)).toBeNull();
	});

	it("shows on iOS, off by default, so Face ID means Face ID", () => {
		mount();
		expect(passcodeToggle().getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByText(/only face id can unlock/i)).toBeTruthy();
	});

	it("is absent while biometric unlock itself is off", () => {
		// One gate, one switch. Shown-but-disabled read as a second setting contradicting the
		// first, which is exactly how it looked on device: "Device passcode off" above
		// "Allow passcode fallback on".
		h.biometricEnabled = false;
		mount();
		expect(screen.queryByLabelText(/toggle passcode fallback/i)).toBeNull();
	});

	it("is absent when nothing is enrolled, since the passcode is then the gate itself", () => {
		// A passcode-only iPhone has no biometry to fall back FROM, so there is no choice to
		// present. The row above already says "Device passcode"; a fallback switch beside it
		// only invites the reading that the two disagree.
		h.biometryEnrolled = false;
		h.biometryType = "passcode";
		mount();
		expect(screen.queryByLabelText(/toggle passcode fallback/i)).toBeNull();
		// The top row carries the whole story on such a device.
		expect(screen.getByLabelText(/device passcode/i)).toBeTruthy();
	});

	it("re-arms the cached VEK when flipped, since the gate is fixed at write time", async () => {
		mount();
		fireEvent.click(passcodeToggle());
		await waitFor(() => expect(h.enabled).toEqual([true]));
		expect(h.writes).toEqual([["biometricPasscodeFallback", true]]);
	});

	it("puts the setting back if the re-arm fails, rather than misreport the gate", async () => {
		// The Keychain item still carries the old access control, so the row must not claim
		// otherwise: what it says is the only thing telling the user what opens their vault.
		h.enableThrows = "keychain store failed";
		mount();
		fireEvent.click(passcodeToggle());
		await waitFor(() => expect(screen.getByText(/keychain store failed/i)).toBeTruthy());
		expect(h.writes).toEqual([
			["biometricPasscodeFallback", true],
			["biometricPasscodeFallback", false],
		]);
	});

	it("arms the main toggle with the gate the setting asks for", async () => {
		// Turning biometric unlock ON has to honour the fallback setting too, or the first
		// enrolment would always land on the permissive gate.
		h.biometricEnabled = false;
		h.passcodeFallback = true;
		mount();
		fireEvent.click(screen.getByLabelText("Face ID"));
		await waitFor(() => expect(h.enabled).toEqual([true]));
	});
});
