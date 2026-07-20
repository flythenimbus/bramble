/** @vitest-environment happy-dom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { PrefsProvider, usePrefs } from "./usePrefs";

afterEach(cleanup);

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

		// One load of the 9 pref keys total, not one load per consumer (the old plain-hook bug).
		expect(storage.getMeta).toHaveBeenCalledTimes(9);
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
