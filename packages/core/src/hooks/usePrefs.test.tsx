/** @vitest-environment happy-dom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { PrefsProvider, usePrefs } from "./usePrefs";

// The active vault drives which keys the per-vault prefs resolve to; mocked so a test can
// switch vaults without standing up the whole registry.
const reg = vi.hoisted(() => ({
	activeId: undefined as string | undefined,
	vaults: [] as { id: string }[],
	ready: true,
}));
vi.mock("./useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: reg.activeId, vaults: reg.vaults, ready: reg.ready }),
}));

afterEach(() => {
	reg.activeId = undefined;
	reg.vaults = [];
	reg.ready = true;
	cleanup();
});

// Backing meta store so getMeta returns whatever setMeta wrote; getMeta calls are counted
// to prove the provider loads once regardless of how many consumers read it.
function makePlatform() {
	const store = new Map<string, unknown>();
	const storage = {
		getMeta: vi.fn(async (k: string) => store.get(k)),
		setMeta: vi.fn(async (k: string, v: unknown) => {
			store.set(k, v);
		}),
		removeMeta: vi.fn(async (k: string) => {
			store.delete(k);
		}),
	};
	return { platform: { storage } as unknown as Platform, storage, store };
}

describe("usePrefs shared provider", () => {
	it("loads preferences once and shares them across consumers", async () => {
		const { platform, storage } = makePlatform();
		function A() {
			const { prefs } = usePrefs();
			return <div>{String(prefs.offerToSave)}</div>;
		}
		function B() {
			const { prefs } = usePrefs();
			return <div>{String(prefs.offerToSave)}</div>;
		}

		render(
			<PlatformProvider platform={platform}>
				<PrefsProvider>
					<A />
					<B />
				</PrefsProvider>
			</PlatformProvider>,
		);
		await act(async () => {});

		// One load of the whole pref set, not one load per consumer (the old plain-hook bug).
		// Asserted as "each key read exactly once" rather than a total, so adding a pref does not
		// fail a test about sharing.
		const keys = storage.getMeta.mock.calls.map(([key]) => key);
		expect(keys).toHaveLength(new Set(keys).size);
		expect(keys.length).toBeGreaterThan(1);
	});

	it("propagates an update from one consumer to another", async () => {
		const { platform } = makePlatform();
		let doUpdate = async () => {};
		function Writer() {
			const { update } = usePrefs();
			doUpdate = () => update("offerToSave", false);
			return null;
		}
		function Reader() {
			const { prefs } = usePrefs();
			return <div data-testid="offer">{String(prefs.offerToSave)}</div>;
		}

		render(
			<PlatformProvider platform={platform}>
				<PrefsProvider>
					<Writer />
					<Reader />
				</PrefsProvider>
			</PlatformProvider>,
		);
		await act(async () => {});

		expect(screen.getByTestId("offer").textContent).toBe("true"); // default
		await act(async () => {
			await doUpdate();
		});
		expect(screen.getByTestId("offer").textContent).toBe("false"); // reader saw the writer's update
	});

	it("update() persists lockOnScreenLock under its own meta key", async () => {
		const { platform, storage } = makePlatform();
		let doUpdate = async () => {};
		function Writer() {
			const { update } = usePrefs();
			doUpdate = () => update("lockOnScreenLock", false);
			return null;
		}
		render(
			<PlatformProvider platform={platform}>
				<PrefsProvider>
					<Writer />
				</PrefsProvider>
			</PlatformProvider>,
		);
		await act(async () => {});
		await act(async () => {
			await doUpdate();
		});
		expect(storage.setMeta).toHaveBeenCalledWith("pref.lockOnScreenLock", false);
	});

	it("throws when used outside a PrefsProvider", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			function C() {
				usePrefs();
				return null;
			}
			expect(() => render(<C />)).toThrow(/usePrefs called outside PrefsProvider/);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("per-vault prefs", () => {
	function mount(platform: Platform) {
		function Reader() {
			const { prefs, update } = usePrefs();
			return (
				<button
					type="button"
					onClick={() => void update("biometricPasscodeFallback", true)}
					aria-label="set"
				>
					{String(prefs.biometricPasscodeFallback)}
				</button>
			);
		}
		return render(
			<PlatformProvider platform={platform}>
				<PrefsProvider>
					<Reader />
				</PrefsProvider>
			</PlatformProvider>,
		);
	}

	it("writes the gate prefs under the active vault, not a shared key", async () => {
		const { platform, storage } = makePlatform();
		reg.activeId = "vault-a";
		mount(platform);
		await act(async () => {});
		await act(async () => {
			screen.getByLabelText("set").click();
		});
		expect(storage.setMeta).toHaveBeenCalledWith("pref.biometricPasscodeFallback:vault-a", true);
	});

	it("does not let one vault's gate settings show up in another", async () => {
		// The bug: both keys were flat, so a second vault opened already showing passcode
		// fallback switched on, having never been given it - and the re-arm honoured that.
		const { platform, storage } = makePlatform();
		reg.activeId = "vault-a";
		const first = mount(platform);
		await act(async () => {});
		await act(async () => {
			screen.getByLabelText("set").click();
		});
		expect(screen.getByLabelText("set").textContent).toBe("true");
		first.unmount();

		reg.activeId = "vault-b";
		mount(platform);
		await act(async () => {});
		expect(screen.getByLabelText("set").textContent).toBe("false");
		expect(storage.getMeta).toHaveBeenCalledWith("pref.biometricPasscodeFallback:vault-b");
	});

	it("leaves device-wide prefs unscoped, since they are not about a vault", async () => {
		const { platform, storage } = makePlatform();
		reg.activeId = "vault-a";
		mount(platform);
		await act(async () => {});
		const keys = storage.getMeta.mock.calls.map(([k]) => k);
		expect(keys).toContain("pref.autoLockMinutes");
		expect(keys).toContain("pref.biometricAutoPrompt:vault-a");
	});
});

describe("adopting the pre-scoping flat value", () => {
	function mount(platform: Platform) {
		function Reader() {
			const { prefs } = usePrefs();
			return <div data-testid="v">{String(prefs.biometricPasscodeFallback)}</div>;
		}
		return render(
			<PlatformProvider platform={platform}>
				<PrefsProvider>
					<Reader />
				</PrefsProvider>
			</PlatformProvider>,
		);
	}

	it("keeps a single-vault user's setting, where it can only have meant that vault", async () => {
		const { platform, store, storage } = makePlatform();
		store.set("pref.biometricPasscodeFallback", true);
		reg.activeId = "vault-a";
		reg.vaults = [{ id: "vault-a" }];
		mount(platform);
		await act(async () => {});
		expect(screen.getByTestId("v").textContent).toBe("true");
		// Rewritten under the vault, and the flat key retired so it cannot be adopted twice.
		expect(store.get("pref.biometricPasscodeFallback:vault-a")).toBe(true);
		expect(storage.removeMeta).toHaveBeenCalledWith("pref.biometricPasscodeFallback");
	});

	it("retires the flat value with several vaults, so no later survivor can inherit it", async () => {
		// The security review's finding: declining to adopt is not the same as being rid of it.
		// Left in place, the value is adopted by whichever vault the install is reduced to - so a
		// vault created AFTER the upgrade could be handed a gate setting nobody gave it.
		const { platform, store } = makePlatform();
		store.set("pref.biometricPasscodeFallback", true);
		store.set("pref.biometricAutoPrompt", true);
		reg.activeId = "vault-a";
		reg.vaults = [{ id: "vault-a" }, { id: "vault-b" }];
		const first = mount(platform);
		await act(async () => {});
		expect(store.has("pref.biometricPasscodeFallback")).toBe(false);
		expect(store.has("pref.biometricAutoPrompt")).toBe(false);
		first.unmount();

		// Now reduce to one vault: with the flat value gone there is nothing left to inherit.
		reg.activeId = "vault-b";
		reg.vaults = [{ id: "vault-b" }];
		mount(platform);
		await act(async () => {});
		expect(screen.getByTestId("v").textContent).toBe("false");
		expect(store.get("pref.biometricPasscodeFallback:vault-b")).toBeUndefined();
	});

	it("does not retire before the registry is ready, while the value is still attributable", async () => {
		const { platform, store } = makePlatform();
		store.set("pref.biometricPasscodeFallback", true);
		reg.ready = false;
		reg.vaults = [{ id: "vault-a" }, { id: "vault-b" }];
		mount(platform);
		await act(async () => {});
		expect(store.has("pref.biometricPasscodeFallback")).toBe(true);
	});

	it("refuses to adopt with several vaults, since it cannot know which one set it", async () => {
		// Taking it anyway would hand the setting to vaults that never had it - the bug the
		// scoping fixed. Falling back to the default is the closed position.
		const { platform, store } = makePlatform();
		store.set("pref.biometricPasscodeFallback", true);
		reg.activeId = "vault-b";
		reg.vaults = [{ id: "vault-a" }, { id: "vault-b" }];
		mount(platform);
		await act(async () => {});
		expect(screen.getByTestId("v").textContent).toBe("false");
		expect(store.get("pref.biometricPasscodeFallback:vault-b")).toBeUndefined();
	});

	it("does not adopt before the registry is ready", async () => {
		// An empty registry mid-load reads as "one vault" and would adopt on behalf of a vault
		// that has not resolved yet.
		const { platform, store } = makePlatform();
		store.set("pref.biometricPasscodeFallback", true);
		reg.ready = false;
		reg.activeId = "vault-a";
		reg.vaults = [{ id: "vault-a" }];
		mount(platform);
		await act(async () => {});
		expect(screen.getByTestId("v").textContent).toBe("false");
	});
});
