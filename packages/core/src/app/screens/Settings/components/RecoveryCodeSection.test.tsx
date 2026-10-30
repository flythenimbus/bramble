/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryCodeSection } from "./RecoveryCodeSection";

// After a password reset done with the recovery code, Settings suggests a new code by
// highlighting this row. Only a suggestion: the old code keeps working until the user resets it.

const h = vi.hoisted(() => ({
	highlight: undefined as string | undefined,
	highlights: [] as (string | undefined)[],
	generated: 0,
}));

vi.mock("../../../../hooks/useVault", () => ({
	useVault: () => ({
		hasPasswordSlot: true,
		hasRecoveryCode: true,
		verifyMasterPassword: async (p: string) => p === "new-password",
		verifyWithWebauthnKey: async () => false,
		generateRecoveryCode: async () => {
			h.generated++;
			return "NEWCO-DENEW-CODEN-EWCOD-ENEWC-ODENE";
		},
	}),
}));

vi.mock("../settings-search", () => ({
	useSettingsHighlight: () => [h.highlight, (next?: string) => void h.highlights.push(next)],
}));

function mount() {
	return render(
		<I18nProvider i18n={i18n}>
			<RecoveryCodeSection />
		</I18nProvider>,
	);
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	h.highlight = undefined;
	h.highlights = [];
	h.generated = 0;
});

afterEach(cleanup);

describe("RecoveryCodeSection rotation suggestion", () => {
	it("shows only when highlighted", () => {
		mount();
		expect(screen.queryByText(/you used your recovery code/i)).toBeNull();
		cleanup();
		h.highlight = "recovery-code";
		mount();
		expect(screen.getByText(/you used your recovery code/i)).toBeTruthy();
	});

	it("clears once the code is reset", async () => {
		h.highlight = "recovery-code";
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		fireEvent.change(screen.getByLabelText("Master password"), {
			target: { value: "new-password" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

		await waitFor(() => expect(h.generated).toBe(1));
		expect(h.highlights).toEqual([undefined]);
	});
});
