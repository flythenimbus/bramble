// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AliasConfig } from "../aliases";
import type { SyncedSettings } from "../sync";
import { SyncedSettingsContext } from "./synced-settings";

// Saving a provider, and the two things that go wrong when more than one kind exists: a provider
// that authenticates to nobody still has to be storable, and a key must never follow the user
// across a switch to a provider it does not belong to.

afterEach(cleanup);

const PLATFORM = {
	storage: {
		getMeta: vi.fn(async () => undefined),
		setMeta: vi.fn(async () => {}),
		removeMeta: vi.fn(async () => {}),
	},
	crypto: { decryptWithVek: vi.fn(async () => "") },
};
vi.mock("../context/PlatformContext", () => ({ usePlatform: () => PLATFORM }));
vi.mock("./useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "v1", vaults: [{ id: "v1" }], ready: true }),
}));
vi.mock("./useVault", () => ({ useVaultState: () => ({ entries: [] }) }));

const { PrefsProvider } = await import("./usePrefs");
const { useAliasProvider } = await import("./useAliasProvider");

const stored = (config: AliasConfig): SyncedSettings => ({
	"pref.aliasProvider": { hlc: { wall: 1, counter: 0, node: "n" }, value: config },
});

/** Renders the hook and hands its save() back, so a test can drive one write. */
function mount(settings: SyncedSettings | undefined) {
	const set = vi.fn(async () => {});
	let save: ReturnType<typeof useAliasProvider>["save"] | undefined;
	function Probe() {
		save = useAliasProvider().save;
		return null;
	}
	const wrapper = ({ children }: { children: ReactNode }) => (
		<SyncedSettingsContext.Provider value={{ settings, ready: true, set }}>
			<PrefsProvider>{children}</PrefsProvider>
		</SyncedSettingsContext.Provider>
	);
	render(<Probe />, { wrapper });
	return { set, save: () => save as NonNullable<typeof save> };
}

/** The config handed to the vault by the last write. */
const written = (set: ReturnType<typeof mount>["set"]) =>
	(set.mock.calls.at(-1) as unknown as [string, AliasConfig])?.[1];

describe("saving an alias provider", () => {
	// The reported bug. The catch-all provider has no key by design, so a guard written as "no
	// key yet, and not the stored provider" refused it forever: switching to it looked like it
	// worked until the tab was left, because only local state had changed.
	it("stores a provider that has no API key", async () => {
		const h = mount(undefined);
		await act(async () => {
			await h.save()({ provider: "catchall", options: { domain: "example.com" } });
		});
		expect(written(h.set)).toEqual({
			provider: "catchall",
			baseUrl: undefined,
			options: { domain: "example.com" },
		});
	});

	it("stores it even when another provider was configured first", async () => {
		const h = mount(stored({ provider: "simplelogin", options: {}, apiKey: "sl-key" }));
		await act(async () => {
			await h.save()({ provider: "catchall", options: { domain: "example.com" } });
		});
		expect(written(h.set).provider).toBe("catchall");
		// And the key it replaces does not come along for the ride.
		expect(written(h.set).apiKey).toBeUndefined();
	});

	// A stored key belongs to the provider that issued it. Carrying it across a switch would
	// authenticate to Addy with a SimpleLogin key, which fails as "your key is wrong" rather than
	// "that key is for something else".
	it("does not reuse a stored key for a different provider", async () => {
		const h = mount(stored({ provider: "simplelogin", options: {}, apiKey: "sl-key" }));
		const err = await h
			.save()({ provider: "addy", options: {} })
			.catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(h.set).not.toHaveBeenCalled();
	});

	it("keeps the stored key when the provider is unchanged", async () => {
		const h = mount(stored({ provider: "addy", options: {}, apiKey: "addy-key" }));
		await act(async () => {
			await h.save()({ provider: "addy", options: { domain: "anonaddy.me" } });
		});
		expect(written(h.set).apiKey).toBe("addy-key");
	});
});
