/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { ThemeProvider } from "../../../hooks/useTheme";
import { AppearanceSection } from "./AppearanceSection";

// #163: the UI language, chosen apart from the device's.

const h = vi.hoisted(() => ({ activated: [] as string[] }));
vi.mock("../../../../i18n", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../i18n")>()),
	activateLocale: async (locale: string) => void h.activated.push(locale),
	systemLocaleTag: () => "de-DE",
}));

const platform = { shell: {} } as unknown as Platform;

function mount() {
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<ThemeProvider>
					<AppearanceSection />
				</ThemeProvider>
			</PlatformProvider>
		</I18nProvider>,
	);
}
const language = () => screen.getByLabelText("Language") as HTMLSelectElement;

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia = (() => ({
		matches: false,
		addEventListener: () => {},
		removeEventListener: () => {},
	})) as unknown as typeof window.matchMedia;
});
afterEach(() => {
	cleanup();
	localStorage.clear();
	h.activated = [];
});

describe("AppearanceSection language", () => {
	it("follows the system until one is chosen, and lists each language by its own name", () => {
		mount();
		expect(language().value).toBe("system");
		const names = Array.from(language().options).map((o) => o.textContent);
		expect(names).toContain("Deutsch");
		expect(names).toContain("Français");
	});

	it("switches at once and keeps the choice", () => {
		mount();
		fireEvent.change(language(), { target: { value: "fr" } });
		expect(h.activated).toEqual(["fr"]);
		cleanup();
		mount();
		expect(language().value).toBe("fr");
	});

	it("goes back to the device's language for System", () => {
		localStorage.setItem("bramble-language", "fr");
		mount();
		fireEvent.change(language(), { target: { value: "system" } });
		expect(h.activated).toEqual(["de"]);
		expect(localStorage.getItem("bramble-language")).toBeNull();
	});
});
