/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import type { Target } from "../../flags";
import { PrefsProvider } from "../../hooks/usePrefs";
import { APP_STORE_URL, UPDATE_CHECK_INTERVAL_MS } from "../app-update";
import { UpdateCard } from "../components/UpdateCard";
import { resetAppUpdateSession, useAppUpdate } from "./useAppUpdate";

vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: undefined, vaults: [], ready: true }),
}));

const APK = "https://github.com/bramble-sh/bramble/releases/download/0.30.0-android/b.apk";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	resetAppUpdateSession();
	fetchMock = vi.fn(async (url: string) => {
		const version = url.includes("/ios/") ? "1.25.0" : "0.30.0";
		return new Response(JSON.stringify({ version, url: APK }), { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	cleanup();
});

function Notice() {
	const update = useAppUpdate();
	return update ? <UpdateCard update={update} /> : null;
}

async function mount(target: Target, version: string, store = new Map<string, unknown>()) {
	const storage = {
		getMeta: vi.fn(async (k: string) => store.get(k)),
		setMeta: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
		removeMeta: vi.fn(async (k: string) => void store.delete(k)),
	};
	const platform = { storage, target, shell: { version } } as unknown as Platform;
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<PrefsProvider>
					<Notice />
				</PrefsProvider>
			</PlatformProvider>
		</I18nProvider>,
	);
	// Prefs load, then the check, then its write.
	await act(async () => {});
	await act(async () => {});
	return store;
}

const updateLink = () => screen.queryByRole("link", { name: /update now/i });

describe("useAppUpdate", () => {
	it("offers the APK on Android when a newer version is out", async () => {
		await mount("android", "0.29.0 (99)");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://bramble.sh/android/latest.json");
		expect(screen.getByText("Version 0.30.0 is available")).toBeTruthy();
		expect(updateLink()).toHaveProperty("href", APK);
		expect(updateLink()?.getAttribute("target")).toBe("_blank");
	});

	it("sends iOS to the App Store listing", async () => {
		await mount("ios", "1.24.0 (5)");
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://bramble.sh/ios/latest.json");
		expect(updateLink()).toHaveProperty("href", APP_STORE_URL);
	});

	it("says nothing when the app is current", async () => {
		await mount("android", "0.30.0 (100)");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(updateLink()).toBeNull();
	});

	it("remembers a dismissal for that version", async () => {
		const store = await mount("android", "0.29.0");
		await act(async () => fireEvent.click(screen.getByRole("button", { name: /dismiss/i })));
		expect(updateLink()).toBeNull();
		cleanup();
		resetAppUpdateSession();
		await mount("android", "0.29.0", store);
		expect(updateLink()).toBeNull();
	});

	it("asks at most once a day, and shows the stored result meanwhile", async () => {
		const store = await mount("android", "0.29.0");
		cleanup();
		resetAppUpdateSession();
		await mount("android", "0.29.0", store);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(updateLink()).not.toBeNull();

		const state = store.get("pref.appUpdate") as { checkedAt: number };
		store.set("pref.appUpdate", { ...state, checkedAt: Date.now() - UPDATE_CHECK_INTERVAL_MS });
		cleanup();
		resetAppUpdateSession();
		await mount("android", "0.29.0", store);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("makes no request when the check is turned off", async () => {
		await mount("android", "0.29.0", new Map([["pref.updateCheck", false]]));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(updateLink()).toBeNull();
	});

	it("makes no request on the extension or the desktop", async () => {
		await mount("chromium", "1.39.0");
		await mount("desktop", "0.18.0");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stays quiet offline and tries again next launch", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("offline"));
		const store = await mount("android", "0.29.0");
		expect(updateLink()).toBeNull();
		expect(store.has("pref.appUpdate")).toBe(false);
		cleanup();
		resetAppUpdateSession();
		await mount("android", "0.29.0", store);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(updateLink()).not.toBeNull();
	});
});
