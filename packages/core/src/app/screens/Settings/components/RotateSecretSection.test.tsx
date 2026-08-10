/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { RotateSecretSection } from "./RotateSecretSection";

// Rotation is behind a flag because the operation ends with other devices unable to read the vault
// and a recovery code the user must save in that moment. A flag that does not actually hide the
// thing is worse than no flag: it reads as a safety net while offering the action anyway.

const h = vi.hoisted(() => ({ flag: false, hasPasswordSlot: true }));

vi.mock("../../../../flags", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../flags")>()),
	get flags() {
		return { rotateVaultSecret: h.flag };
	},
}));

vi.mock("../../../../hooks/useVault", () => ({
	useVault: () => ({ hasPasswordSlot: h.hasPasswordSlot, rotateSecret: async () => "CODE" }),
}));

const platform = { target: "desktop", clipboard: { copy: async () => {} } } as unknown as Platform;

function mount() {
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<RotateSecretSection />
			</PlatformProvider>
		</I18nProvider>,
	);
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(() => {
	cleanup();
	h.flag = false;
	h.hasPasswordSlot = true;
});

describe("the rotate-secret section", () => {
	it("renders nothing while the flag is off", () => {
		mount();
		expect(screen.queryByText(/rotate/i)).toBeNull();
	});

	it("offers it when the flag is on", () => {
		h.flag = true;
		mount();
		expect(screen.getByRole("button", { name: /rotate this vault's secret/i })).toBeTruthy();
	});

	it("stays hidden for a vault with no master password, flag or not", () => {
		// Rotation re-wraps the password slot, so the password is the one credential that has to
		// survive it. Offering the action without one would promise something it cannot do.
		h.flag = true;
		h.hasPasswordSlot = false;
		mount();
		expect(screen.queryByRole("button", { name: /rotate/i })).toBeNull();
	});
});
