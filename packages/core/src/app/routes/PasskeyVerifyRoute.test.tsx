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
	hasWebauthnSlot: false,
	canTap: true,
	keyOk: false,
	signInAgain: false,
	answers: [] as [string, boolean][],
}));

vi.mock("../hooks/useWebauthnUnlock", () => ({ useWebauthnUnlock: () => h.canTap }));

vi.mock("../../hooks/useVault", () => ({
	useVault: () => ({
		hasPasswordSlot: h.hasPasswordSlot,
		hasWebauthnSlot: h.hasWebauthnSlot,
		verifyMasterPassword: async (p: string) => p === "right-password",
		verifyWithWebauthnKey: async () => h.keyOk,
	}),
}));

vi.mock("../../context/PlatformContext", () => ({
	usePlatform: () => ({
		shell: {
			reportPasskeyVerification: async (id: string, verified: boolean) => {
				h.answers.push([id, verified]);
				return { signInAgain: h.signInAgain };
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
	h.hasWebauthnSlot = false;
	h.canTap = true;
	h.keyOk = false;
	h.signInAgain = false;
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

	it("uses a key on a vault with no master password", async () => {
		h.hasPasswordSlot = false;
		h.hasWebauthnSlot = true;
		h.keyOk = true;
		mount();
		expect(screen.queryByLabelText("Master password")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Tap to confirm" }));
		await waitFor(() => expect(h.answers).toEqual([["req-1", true]]));
	});

	it("offers a key next to the master password", async () => {
		h.hasWebauthnSlot = true;
		h.keyOk = true;
		mount();
		expect(screen.getByLabelText("Master password")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Tap to confirm" }));
		await waitFor(() => expect(h.answers).toEqual([["req-1", true]]));
	});

	it("doesn't offer a tap without a registered key", () => {
		mount();
		expect(screen.queryByRole("button", { name: "Tap to confirm" })).toBeNull();
	});

	it("doesn't offer a tap where this browser can't do one", () => {
		h.hasWebauthnSlot = true;
		h.canTap = false;
		mount();
		expect(screen.queryByRole("button", { name: "Tap to confirm" })).toBeNull();
	});

	it("says nothing to the site when the key fails, and shows why", async () => {
		h.hasWebauthnSlot = true;
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Tap to confirm" }));
		await waitFor(() =>
			expect(screen.getByText("Couldn't verify your key. Try again.")).toBeTruthy(),
		);
		expect(h.answers).toEqual([]);
	});

	it("stays open to send the user back when the site's request has ended", async () => {
		h.hasWebauthnSlot = true;
		h.keyOk = true;
		h.signInAgain = true;
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Tap to confirm" }));
		await waitFor(() => expect(screen.getByText(/Sign in again on example\.com/)).toBeTruthy());
		expect(window.close).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(window.close).toHaveBeenCalled();
	});

	it("answers no when the user cancels", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(h.answers).toEqual([["req-1", false]]));
	});
});
