/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AliasConfig } from "../../../../aliases";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { SyncedSettingsContext } from "../../../../hooks/synced-settings";
import { PrefsProvider } from "../../../../hooks/usePrefs";
import type { SyncedSettings } from "../../../../sync";
import { AliasSection } from "./AliasSection";

// The panel is where a provider is actually configured, and it is the layer that broke: the
// client and the hook were both well covered while nothing exercised the write this screen
// makes, so the catch-all provider could never be saved and the failure looked like a UI that
// forgot. See docs/email-aliases.md.

vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "vault-a", vaults: [{ id: "vault-a" }], ready: true }),
}));
vi.mock("../../../../hooks/useVault", () => ({ useVaultState: () => ({ entries: [] }) }));

const platform = {
	storage: {
		getMeta: async () => undefined,
		setMeta: async () => {},
		removeMeta: async () => {},
	},
} as unknown as Platform;

const stored = (config: AliasConfig): SyncedSettings => ({
	"pref.aliasProvider": { hlc: { wall: 1, counter: 0, node: "n" }, value: config },
});

function mount(settings?: SyncedSettings) {
	const set = vi.fn(async () => {});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<SyncedSettingsContext.Provider value={{ settings, ready: true, set }}>
					<PrefsProvider>{children}</PrefsProvider>
				</SyncedSettingsContext.Provider>
			</PlatformProvider>
		</I18nProvider>
	);
	render(<AliasSection />, { wrapper });
	return { set };
}

/** The config the panel last handed to the vault. */
const written = (set: ReturnType<typeof mount>["set"]) =>
	(set.mock.calls.at(-1) as unknown as [string, AliasConfig])?.[1];

const providerSelect = () => screen.getAllByRole("combobox")[0] as HTMLSelectElement;
const domainBox = () => document.querySelector('input[type="text"]') as HTMLInputElement;

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(cleanup);

describe("AliasSection persistence", () => {
	// The reported bug, at the layer it happened. Switching provider is local state until a field
	// is written, so this is the whole path: choose the provider, type the domain, and the panel
	// must hand something to the vault. It never did, and the switch survived only as long as the
	// component.
	it("saves the catch-all provider once a domain is entered", async () => {
		const h = mount();
		fireEvent.change(providerSelect(), { target: { value: "catchall" } });
		await waitFor(() => expect(domainBox()).toBeTruthy());
		fireEvent.change(domainBox(), { target: { value: "example.com" } });

		await waitFor(() => expect(h.set).toHaveBeenCalled());
		expect(written(h.set)).toMatchObject({
			provider: "catchall",
			options: { domain: "example.com" },
		});
	});

	it("saves it over a provider that was already configured", async () => {
		const h = mount(stored({ provider: "simplelogin", options: {}, apiKey: "sl-key" }));
		await waitFor(() => expect(providerSelect().value).toBe("simplelogin"));

		fireEvent.change(providerSelect(), { target: { value: "catchall" } });
		await waitFor(() => expect(domainBox()).toBeTruthy());
		fireEvent.change(domainBox(), { target: { value: "example.com" } });

		await waitFor(() => expect(h.set).toHaveBeenCalled());
		expect(written(h.set).provider).toBe("catchall");
		// The key it replaced must not come along: it authenticates to somewhere else entirely.
		expect(written(h.set).apiKey).toBeUndefined();
	});

	// The guard the bug came from still has a job, though no longer the load-bearing one: save()
	// refuses a key-using provider that has no key of its own, so the write is blocked either way.
	// What the guard adds is silence. Without it the refusal surfaces as "Enter your API key" the
	// moment a field is touched, which is an error about something the user has not got to yet.
	it("holds back a key-using provider quietly, without an error about a key", async () => {
		const h = mount(stored({ provider: "simplelogin", options: {}, apiKey: "sl-key" }));
		await waitFor(() => expect(providerSelect().value).toBe("simplelogin"));

		fireEvent.change(providerSelect(), { target: { value: "addy" } });
		await waitFor(() => expect(screen.getAllByRole("combobox").length).toBeGreaterThan(1));
		// Choosing a format is a field edit, and would have triggered the write.
		const format = screen.getAllByRole("combobox").at(-1) as HTMLSelectElement;
		fireEvent.change(format, { target: { value: "uuid" } });

		await new Promise((r) => setTimeout(r, 20));
		expect(h.set).not.toHaveBeenCalled();
		expect(screen.queryByText(/enter your api key/i)).toBeNull();
	});

	// A domain that cannot work is no more configured than an empty box, and saving it would arm
	// a generate button that only ever fails.
	it("does not save a domain that is not one", async () => {
		const h = mount();
		fireEvent.change(providerSelect(), { target: { value: "catchall" } });
		await waitFor(() => expect(domainBox()).toBeTruthy());
		fireEvent.change(domainBox(), { target: { value: "me@example.com" } });

		await new Promise((r) => setTimeout(r, 20));
		expect(screen.getByText(/does not look like a domain/i)).toBeTruthy();
		// And it stays out of the vault, so no generate button appears for a provider that could
		// only fail when pressed.
		expect(h.set).not.toHaveBeenCalled();
	});
});
