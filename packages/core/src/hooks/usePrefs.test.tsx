/** @vitest-environment happy-dom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { PrefsProvider, usePrefs } from "./usePrefs";

// The active vault drives which keys the per-vault prefs resolve to; mocked so a test can
// switch vaults without standing up the whole registry.
const reg = vi.hoisted(() => ({ activeId: undefined as string | undefined }));
vi.mock("./useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: reg.activeId, vaults: [] }),
}));

afterEach(() => {
	reg.activeId = undefined;
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
	};
	return { platform: { storage } as unknown as Platform, storage };
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
