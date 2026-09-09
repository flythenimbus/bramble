// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncedSettings } from "../sync";
import { SyncedSettingsContext } from "./synced-settings";

// Step 3 of docs/synced-settings.md: PREF_SCOPE gains "synced", and usePrefs routes reads and
// writes through the vault's settings map for anything marked that way.
//
// aliasProvider is the first pref marked "synced", so it is what proves the routing: it must read
// from the vault's map and write back through it, while a device-scoped pref beside it keeps
// going to storage and never touches the vault.

// Not automatic here: this package runs vitest without globals, so nothing tears the container
// down between renders and the second test would find two of every button.
afterEach(cleanup);

const PLATFORM = {
	storage: {
		getMeta: vi.fn(async () => undefined),
		setMeta: vi.fn(async () => {}),
		removeMeta: vi.fn(async () => {}),
	},
};
vi.mock("../context/PlatformContext", () => ({ usePlatform: () => PLATFORM }));
vi.mock("./useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "v1", vaults: [{ id: "v1" }], ready: true }),
}));

const { PrefsProvider, usePrefs } = await import("./usePrefs");

function Harness({ prefKey }: { prefKey: "statsCollapsed" }) {
	const { prefs, update } = usePrefs();
	return (
		<button type="button" onClick={() => void update(prefKey, !prefs[prefKey])}>
			{String(prefs[prefKey])}
		</button>
	);
}

const CONFIG = { provider: "addy" as const, options: {}, apiKey: "sk-from-the-vault" };

/** Reads the synced pref and can write one, so both directions are observable. */
function AliasHarness() {
	const { prefs, update } = usePrefs();
	return (
		<button
			type="button"
			onClick={() => void update("aliasProvider", { ...CONFIG, apiKey: "sk-typed-here" })}
		>
			{prefs.aliasProvider?.apiKey ?? "none"}
		</button>
	);
}

function mount(settings: SyncedSettings | undefined, set = vi.fn(async () => {})) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<SyncedSettingsContext.Provider value={{ settings, ready: true, set }}>
			<PrefsProvider>{children}</PrefsProvider>
		</SyncedSettingsContext.Provider>
	);
	render(<Harness prefKey="statsCollapsed" />, { wrapper });
	return { set };
}

describe("usePrefs routing by scope", () => {
	// The default table has no synced prefs yet, so a device-scoped pref must be completely
	// unaffected by the machinery: it still writes to storage and ignores the vault entirely.
	it("leaves a device-scoped pref writing to storage", async () => {
		PLATFORM.storage.setMeta.mockClear();
		const { set } = mount(undefined);
		await act(async () => {
			screen.getByRole("button").click();
		});
		expect(PLATFORM.storage.setMeta).toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
	});

	it("reads a synced pref out of the vault's settings map", async () => {
		const wrapper = ({ children }: { children: ReactNode }) => (
			<SyncedSettingsContext.Provider
				value={{
					settings: {
						"pref.aliasProvider": { hlc: { wall: 1, counter: 0, node: "n" }, value: CONFIG },
					},
					ready: true,
					set: vi.fn(async () => {}),
				}}
			>
				<PrefsProvider>{children}</PrefsProvider>
			</SyncedSettingsContext.Provider>
		);
		render(<AliasHarness />, { wrapper });
		expect(await screen.findByText("sk-from-the-vault")).toBeTruthy();
	});

	it("writes a synced pref to the vault, not to storage", async () => {
		PLATFORM.storage.setMeta.mockClear();
		const set = vi.fn(async () => {});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<SyncedSettingsContext.Provider value={{ settings: undefined, ready: true, set }}>
				<PrefsProvider>{children}</PrefsProvider>
			</SyncedSettingsContext.Provider>
		);
		render(<AliasHarness />, { wrapper });
		await act(async () => {
			screen.getByRole("button").click();
		});
		expect(set).toHaveBeenCalledWith("pref.aliasProvider", {
			...CONFIG,
			apiKey: "sk-typed-here",
		});
		// The value that belongs in the vault must not also be written to plaintext meta storage.
		expect(PLATFORM.storage.setMeta).not.toHaveBeenCalled();
	});

	// A peer on another build can write anything into the map, so a value that no longer parses
	// as a config reads as "none" rather than reaching a caller that expects a provider.
	it("falls back to null when the synced value is malformed", async () => {
		const wrapper = ({ children }: { children: ReactNode }) => (
			<SyncedSettingsContext.Provider
				value={{
					settings: {
						"pref.aliasProvider": { hlc: { wall: 1, counter: 0, node: "n" }, value: { junk: 1 } },
					},
					ready: true,
					set: vi.fn(async () => {}),
				}}
			>
				<PrefsProvider>{children}</PrefsProvider>
			</SyncedSettingsContext.Provider>
		);
		render(<AliasHarness />, { wrapper });
		expect(await screen.findByText("none")).toBeTruthy();
	});

	// A missing vault must not break prefs. usePrefs is mounted in hosts and tests that have no
	// vault at all, so the context falls back to a not-ready value rather than throwing.
	it("works with no synced-settings provider at all", async () => {
		PLATFORM.storage.setMeta.mockClear();
		render(
			<PrefsProvider>
				<Harness prefKey="statsCollapsed" />
			</PrefsProvider>,
		);
		await act(async () => {
			screen.getAllByRole("button")[0]?.click();
		});
		expect(PLATFORM.storage.setMeta).toHaveBeenCalled();
	});
});
