/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PasskeyVerify } from "./PasskeyVerifyRoute";

// The confirm-it's-you window the extension opens when a site needs user verification (or a PRF
// key) from an already-unlocked vault. Its answer is what the passkey's UV flag rests on.

const h = vi.hoisted(() => ({
	hasPasswordSlot: true,
	keyOk: false,
	answers: [] as [string, boolean][],
}));

vi.mock("../../hooks/useVault", () => ({
	useVault: () => ({
		hasPasswordSlot: h.hasPasswordSlot,
		verifyMasterPassword: async (p: string) => p === "right-password",
		verifyWithWebauthnKey: async () => h.keyOk,
	}),
}));

vi.mock("../../context/PlatformContext", () => ({
	usePlatform: () => ({
		shell: {
			reportPasskeyVerification: async (id: string, verified: boolean) => {
				h.answers.push([id, verified]);
			},
		},
	}),
}));

function mount() {
	return render(
		<I18nProvider i18n={i18n}>
			<PasskeyVerify id="req-1" rp="example.com" />
		</I18nProvider>,
	);
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	h.hasPasswordSlot = true;
	h.keyOk = false;
	h.answers = [];
	vi.spyOn(window, "close").mockImplementation(() => {});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("PasskeyVerify", () => {
	it("names the site and answers yes for the right master password", async () => {
		mount();
		expect(screen.getByText(/example\.com/)).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Master password"), {
			target: { value: "right-password" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		await waitFor(() => expect(h.answers).toEqual([["req-1", true]]));
	});

	it("says nothing to the site for a wrong password, and shows why", async () => {
		mount();
		fireEvent.change(screen.getByLabelText("Master password"), { target: { value: "nope" } });
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		await waitFor(() => expect(screen.getByText("Incorrect master password")).toBeTruthy());
		expect(h.answers).toEqual([]);
	});

	it("uses the security key on a vault with no master password", async () => {
		h.hasPasswordSlot = false;
		h.keyOk = true;
		mount();
		expect(screen.queryByLabelText("Master password")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Use security key" }));
		await waitFor(() => expect(h.answers).toEqual([["req-1", true]]));
	});

	it("answers no when the user cancels", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(h.answers).toEqual([["req-1", false]]));
	});
});
