/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MasterPasswordSection } from "./MasterPasswordSection";

// Someone who unlocked with the recovery code has usually forgotten the master password, so the
// change form must accept the recovery code as the current credential, and then suggest (not
// force) rotating the code that was just used.

const h = vi.hoisted(() => ({
	unlockedWithRecoveryCode: false,
	highlight: undefined as string | undefined,
	/** setHighlight calls, in order. */
	highlights: [] as (string | undefined)[],
	verifiedPasswords: [] as string[],
	verifiedCodes: [] as string[],
	changed: [] as string[],
}));

vi.mock("../../../../hooks/useVault", () => ({
	useVault: () => ({
		hasPasswordSlot: true,
		hasRecoveryCode: true,
		unlockedWithRecoveryCode: h.unlockedWithRecoveryCode,
		webauthnKeys: [],
		verifyMasterPassword: async (p: string) => {
			h.verifiedPasswords.push(p);
			return p === "old-password";
		},
		verifyRecoveryCode: async (c: string) => {
			h.verifiedCodes.push(c);
			return c === "RECOVERY";
		},
		changeMasterPassword: async (p: string) => void h.changed.push(p),
		setMasterPassword: async () => {},
		disableMasterPassword: async () => {},
	}),
}));

vi.mock("../settings-search", () => ({
	useSettingsHighlight: () => [h.highlight, (next?: string) => void h.highlights.push(next)],
}));

const NEW_PASSWORD = "plover-quintet-marmalade-71";

function mount() {
	return render(
		<I18nProvider i18n={i18n}>
			<MasterPasswordSection />
		</I18nProvider>,
	);
}

async function submitChange(current: string) {
	fireEvent.change(screen.getByLabelText(/^current/i), { target: { value: current } });
	fireEvent.change(screen.getByLabelText("New password"), { target: { value: NEW_PASSWORD } });
	fireEvent.change(screen.getByLabelText("Confirm new password"), {
		target: { value: NEW_PASSWORD },
	});
	const submit = screen.getByRole("button", { name: "Update password" }) as HTMLButtonElement;
	await waitFor(() => expect(submit.disabled).toBe(false));
	fireEvent.click(submit);
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	h.unlockedWithRecoveryCode = false;
	h.highlight = undefined;
	h.highlights = [];
	h.verifiedPasswords = [];
	h.verifiedCodes = [];
	h.changed = [];
});

afterEach(cleanup);

describe("MasterPasswordSection after a recovery-code unlock", () => {
	beforeEach(() => {
		h.unlockedWithRecoveryCode = true;
	});

	it("asks for the recovery code, changes the password, then suggests a new code", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Change" }));
		expect(screen.getByLabelText("Current recovery code")).toBeTruthy();

		await submitChange("RECOVERY");

		await waitFor(() => expect(h.changed).toEqual([NEW_PASSWORD]));
		expect(h.verifiedCodes).toEqual(["RECOVERY"]);
		expect(h.verifiedPasswords).toEqual([]);
		expect(h.highlights).toEqual(["recovery-code"]);
	});

	it("refuses a wrong recovery code", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Change" }));
		await submitChange("WRONG");

		await screen.findByText("Recovery code is incorrect");
		expect(h.changed).toEqual([]);
		expect(h.highlights).toEqual([]);
	});

	it("explains the highlight it lands on", () => {
		h.highlight = "master-password";
		mount();
		expect(screen.getByText(/you unlocked with your recovery code/i)).toBeTruthy();
	});
});

describe("MasterPasswordSection in a password session", () => {
	it("asks for the current password and does not suggest a new recovery code", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Change" }));
		expect(screen.getByLabelText("Current password")).toBeTruthy();

		await submitChange("old-password");

		await waitFor(() => expect(h.changed).toEqual([NEW_PASSWORD]));
		expect(h.verifiedCodes).toEqual([]);
		expect(h.highlights).toEqual([]);
	});

	// A closed extension popup forgets how the session was unlocked, so the switch must stay
	// reachable or a user who forgot the password is stuck again.
	it("can switch to the recovery code, which then suggests rotating it", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Change" }));
		fireEvent.click(screen.getByRole("button", { name: "Use your recovery code instead" }));
		expect(screen.getByLabelText("Current recovery code")).toBeTruthy();

		await submitChange("RECOVERY");

		await waitFor(() => expect(h.changed).toEqual([NEW_PASSWORD]));
		expect(h.verifiedPasswords).toEqual([]);
		expect(h.highlights).toEqual(["recovery-code"]);
	});
});
