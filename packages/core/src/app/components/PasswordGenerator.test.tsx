/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { PrefsProvider } from "../../hooks/usePrefs";
import { PasswordGenerator } from "./PasswordGenerator";

// The panel is the only place these settings can be reached, so what it refuses to do (leave
// the generator with no characters to draw from) and what it remembers are covered here rather
// than in password-gen.test.ts, which knows nothing about the controls.

vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "vault-a", vaults: [{ id: "vault-a" }], ready: true }),
}));

function makePlatform(seed: Record<string, unknown> = {}) {
	const store = new Map<string, unknown>(Object.entries(seed));
	const platform = {
		storage: {
			getMeta: async (k: string) => store.get(k),
			setMeta: async (k: string, v: unknown) => {
				store.set(k, v);
			},
			removeMeta: async (k: string) => {
				store.delete(k);
			},
		},
		clipboard: { copy: vi.fn(async () => {}) },
	} as unknown as Platform;
	return { platform, store };
}

function mount(seed?: Record<string, unknown>, onUse = vi.fn()) {
	const { platform, store } = makePlatform(seed);
	const view = render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<PrefsProvider>
					<PasswordGenerator onUse={onUse} />
				</PrefsProvider>
			</PlatformProvider>
		</I18nProvider>,
	);
	const shown = () => view.container.querySelector("p.font-mono")?.textContent ?? "";
	return { ...view, store, onUse, shown };
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(cleanup);

it("generates from the defaults and hands the shown value back", async () => {
	const { shown, onUse } = mount();
	await waitFor(() => expect(shown().length).toBe(20));

	const value = shown();
	fireEvent.click(screen.getByRole("button", { name: /use password/i }));
	expect(onUse).toHaveBeenCalledWith(value);
});

it("refuses to turn off the last character class", async () => {
	const { shown } = mount();
	await waitFor(() => expect(shown()).not.toBe(""));

	for (const name of ["A-Z", "0-9", "!@#"]) {
		fireEvent.click(screen.getByRole("checkbox", { name }));
	}
	await waitFor(() => expect(shown()).toMatch(/^[a-z]+$/));

	// a-z is now on its own: clicking it would leave nothing to generate from.
	fireEvent.click(screen.getByRole("checkbox", { name: "a-z" }));
	expect((screen.getByRole("checkbox", { name: "a-z" }) as HTMLInputElement).checked).toBe(true);
	await waitFor(() => expect(shown()).toMatch(/^[a-z]+$/));
});

it("switches to a passphrase and remembers the mode", async () => {
	const { shown, store } = mount();
	await waitFor(() => expect(shown()).not.toBe(""));

	fireEvent.click(screen.getByRole("button", { name: "Passphrase" }));
	await waitFor(() => expect(shown().split("-")).toHaveLength(5));
	for (const word of shown().split("-")) expect(word).toMatch(/^[a-z-]+$/);

	await waitFor(() =>
		expect(store.get("pref.generator")).toMatchObject({ mode: "passphrase", words: 5 }),
	);
});

it("starts from the settings the last session saved", async () => {
	const { shown } = mount({ "pref.generator": { mode: "pin", pinLength: 4 } });
	await waitFor(() => expect(shown()).toMatch(/^[0-9]{4}$/));
	expect(screen.getByRole("button", { name: "PIN" }).getAttribute("aria-pressed")).toBe("true");
});

it("copies through the platform clipboard, so the auto-clear timer applies", async () => {
	const { platform } = makePlatform();
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<PrefsProvider>
					<PasswordGenerator />
				</PrefsProvider>
			</PlatformProvider>
		</I18nProvider>,
	);
	const shown = () => document.querySelector("p.font-mono")?.textContent ?? "";
	await waitFor(() => expect(shown()).not.toBe(""));

	fireEvent.click(screen.getByRole("button", { name: /copy/i }));
	await waitFor(() => expect(platform.clipboard.copy).toHaveBeenCalledWith(shown()));
});

it("keeps a setting changed just before the panel closed", async () => {
	const { shown, store, unmount } = mount();
	await waitFor(() => expect(shown()).not.toBe(""));

	fireEvent.click(screen.getByRole("checkbox", { name: "!@#" }));
	// Inside the persist debounce: "Use" closes the panel immediately after a change.
	unmount();

	await waitFor(() => expect(store.get("pref.generator")).toMatchObject({ symbols: false }));
});
