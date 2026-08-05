import { describe, expect, it } from "vitest";
import { appIdFromUri, extractHostname, isAppUri } from "./autofill-index";

// Issue #46, second half. Bramble never writes these; importers carry them
// through verbatim (androidapp:// is Bitwarden's convention, android:// is
// Google Password Manager's). Before this, extractHostname handed back the
// reverse-DNS package name as if it were a web host, so an imported entry put
// "se.skanetrafiken.washington" into the match index and the persisted
// known-hostname registry, where registrableDomain reduced it to the nonsense
// "skanetrafiken.washington" and it could never match a page.

const REPORTED = "androidapp://se.skanetrafiken.washington";

describe("app URIs are not web hosts", () => {
	it.each([
		REPORTED,
		"androidapp://com.example.app",
		"android://sha256hash@com.example.app/",
		"iosapp://com.example.app",
		"ios://com.example.app",
		"appid://com.example.app",
		"ANDROIDAPP://com.example.app",
	])("recognises %s", (uri) => {
		expect(isAppUri(uri)).toBe(true);
		expect(extractHostname(uri)).toBe("");
	});

	it.each([
		"https://www.skanetrafiken.se/",
		"http://localhost:8000/",
		"ftp://files.example.com/",
		"skanetrafiken.se",
	])("leaves %s alone", (url) => {
		expect(isAppUri(url)).toBe(false);
		expect(extractHostname(url)).not.toBe("");
	});
});

describe("extractHostname", () => {
	it("returns the host of a web URL", () => {
		expect(extractHostname("https://www.skanetrafiken.se/mitt-konto/")).toBe(
			"www.skanetrafiken.se",
		);
	});

	it("keeps a bare hostname stored without a scheme", () => {
		// Long-standing behaviour: the URL constructor throws, and the raw string
		// is already a usable host.
		expect(extractHostname("skanetrafiken.se")).toBe("skanetrafiken.se");
	});

	it("still resolves a non-app scheme to its host", () => {
		// Only app schemes are excluded, so an odd-but-real URL keeps matching.
		expect(extractHostname("ftp://files.example.com/pub")).toBe("files.example.com");
	});

	it("drops the app URI so it never reaches the index", () => {
		expect(
			["https://www.skanetrafiken.se/", REPORTED].map(extractHostname).filter(Boolean),
		).toEqual(["www.skanetrafiken.se"]);
	});
});

describe("appIdFromUri", () => {
	it("extracts the package name", () => {
		expect(appIdFromUri(REPORTED)).toBe("se.skanetrafiken.washington");
	});

	it("extracts it from Google's cert-hash form", () => {
		expect(appIdFromUri("android://abc123hash@com.example.app/")).toBe("com.example.app");
	});

	it("is null for a website", () => {
		expect(appIdFromUri("https://www.skanetrafiken.se/")).toBeNull();
		expect(appIdFromUri("skanetrafiken.se")).toBeNull();
	});
});
