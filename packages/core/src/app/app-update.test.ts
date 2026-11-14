import { describe, expect, it } from "vitest";
import {
	APP_STORE_URL,
	installedVersion,
	isCheckDue,
	isNewer,
	normalizeAppUpdateState,
	parseManifest,
	pendingUpdate,
	UPDATE_CHECK_INTERVAL_MS,
} from "./app-update";

const APK = "https://github.com/bramble-sh/bramble/releases/download/0.30.0-android/b.apk";

describe("installedVersion", () => {
	it("drops the build number", () => {
		expect(installedVersion("1.24.0 (1234)")).toBe("1.24.0");
		expect(installedVersion("0.30.0")).toBe("0.30.0");
	});

	it("is null for the dev placeholder, which would always look outdated", () => {
		expect(installedVersion("0.0.0-mobile")).toBeNull();
		expect(installedVersion("dev")).toBeNull();
	});
});

describe("isNewer", () => {
	it("compares numerically, not as strings", () => {
		expect(isNewer("1.10.0", "1.9.0")).toBe(true);
		expect(isNewer("1.9.0", "1.10.0")).toBe(false);
	});

	it("treats a missing segment as 0", () => {
		expect(isNewer("1.2", "1.2.0")).toBe(false);
		expect(isNewer("1.2.1", "1.2")).toBe(true);
	});

	it("is false for the same version and for an older one (a TestFlight build ahead of the store)", () => {
		expect(isNewer("1.24.0", "1.24.0")).toBe(false);
		expect(isNewer("1.24.0", "1.25.0")).toBe(false);
	});
});

describe("parseManifest", () => {
	it("sends iOS to the App Store whatever the manifest says", () => {
		expect(parseManifest("ios", { version: "1.25.0", url: "https://evil.example/" })).toEqual({
			version: "1.25.0",
			url: APP_STORE_URL,
		});
	});

	it("takes an APK from our own releases on Android", () => {
		expect(parseManifest("android", { version: "0.30.0", url: APK })).toEqual({
			version: "0.30.0",
			url: APK,
		});
	});

	it("refuses an APK from anywhere else", () => {
		expect(() =>
			parseManifest("android", { version: "0.30.0", url: "https://evil.example/b.apk" }),
		).toThrow();
		expect(() =>
			parseManifest("android", {
				version: "0.30.0",
				url: "https://github.com/bramble-sh/bramble/releases/download/x/page.html",
			}),
		).toThrow();
	});

	it("refuses a malformed version", () => {
		expect(() => parseManifest("ios", { version: "1.2.3.4" })).toThrow();
		expect(() => parseManifest("ios", null)).toThrow();
	});
});

describe("pendingUpdate", () => {
	const latest = { version: "0.30.0", url: APK };

	it("offers a newer version", () => {
		expect(pendingUpdate({ latest }, "0.29.0")).toEqual(latest);
	});

	it("stays quiet when current, or when that version was dismissed", () => {
		expect(pendingUpdate({ latest }, "0.30.0")).toBeNull();
		expect(pendingUpdate({ latest, dismissed: "0.30.0" }, "0.29.0")).toBeNull();
	});

	it("comes back for a version newer than the dismissed one", () => {
		expect(pendingUpdate({ latest, dismissed: "0.29.5" }, "0.29.0")).toEqual(latest);
	});
});

describe("isCheckDue", () => {
	it("checks once a day", () => {
		const now = 10 * UPDATE_CHECK_INTERVAL_MS;
		expect(isCheckDue({}, now)).toBe(true);
		expect(isCheckDue({ checkedAt: now - UPDATE_CHECK_INTERVAL_MS + 1 }, now)).toBe(false);
		expect(isCheckDue({ checkedAt: now - UPDATE_CHECK_INTERVAL_MS }, now)).toBe(true);
	});

	it("checks when the last check is in the future", () => {
		expect(isCheckDue({ checkedAt: 2_000 }, 1_000)).toBe(true);
	});
});

describe("normalizeAppUpdateState", () => {
	it("keeps only well-formed fields", () => {
		expect(normalizeAppUpdateState(undefined)).toEqual({});
		expect(
			normalizeAppUpdateState({ checkedAt: "x", latest: { version: 1 }, dismissed: "0.30.0" }),
		).toEqual({ checkedAt: undefined, latest: undefined, dismissed: "0.30.0" });
	});
});
