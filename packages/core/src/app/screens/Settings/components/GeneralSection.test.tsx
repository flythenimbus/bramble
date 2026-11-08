/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import type { Target } from "../../../../flags";
import { GeneralSection } from "./GeneralSection";

vi.mock("../../../../hooks/usePrefs", () => ({
	usePrefs: () => ({
		prefs: { autoLockMinutes: 15, clipboardClearSeconds: 30, neverSaveSites: [] },
		loaded: true,
		update: vi.fn(),
	}),
}));
vi.mock("../../../../hooks/useVault", () => ({ useVault: () => ({ entries: [] }) }));
vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ vaults: [], activeId: null }),
}));
vi.mock("../../../../hooks/useAutostart", () => ({ useAutostart: () => ({ available: false }) }));
vi.mock("../../../hooks/useDefaultPasswordManager", () => ({
	useDefaultPasswordManager: () => null,
}));
vi.mock("../../../hooks/useVaultName", () => ({ useRenameVault: () => vi.fn() }));

function mount(target: Target) {
	const platform = { target, autofill: {}, shell: {} } as unknown as Platform;
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<GeneralSection />
			</PlatformProvider>
		</I18nProvider>,
	);
}

function timeoutOptions(): string[] {
	const select = screen.getByLabelText("Timeout") as HTMLSelectElement;
	return Array.from(select.options).map((o) => o.textContent ?? "");
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
afterEach(cleanup);

describe("GeneralSection auto-lock timeout", () => {
	it("offers no Immediate on desktop, which has no moment the app stops being used", () => {
		mount("desktop");
		expect(timeoutOptions()).not.toContain("Immediate");
		expect(timeoutOptions()).toContain("5 minutes");
	});

	it("offers Immediate in the browser and on phones", () => {
		for (const target of ["chromium", "ios"] as Target[]) {
			mount(target);
			expect(timeoutOptions()).toContain("Immediate");
			cleanup();
		}
	});
});
