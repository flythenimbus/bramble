import { describe, expect, it } from "vitest";
import { deviceNamer, fullStamp, shortStamp } from "./sync-log";

// Local time, so the expectations below hold in any time zone the tests run in.
const AT = new Date(2026, 10, 14, 4, 41, 23).getTime();

describe("log stamps", () => {
	it("dates a copied line in full", () => {
		expect(fullStamp(AT)).toBe("2026-11-14 04:41:23");
	});

	it("shows only the time for a line from today", () => {
		expect(shortStamp(AT, new Date(2026, 10, 14, 23, 59, 59).getTime())).toBe("04:41:23");
	});

	it("dates a line from another day", () => {
		expect(shortStamp(AT, new Date(2026, 10, 15, 0, 0, 1).getTime())).toBe("2026-11-14 04:41:23");
	});
});

describe("device names in the log", () => {
	const PHONE = "tG/Lnb18xYz+abcdefghijklmnopqrstuvwxyz012345=";
	const LAPTOP = "wW5pPXvrQ1w2e3r4t5y6u7i8o9p0asdfghjklzxcvbnm=";
	const name = deviceNamer([
		{ publicKey: PHONE, name: "Alice's iPad" },
		{ publicKey: LAPTOP, name: "Work laptop" },
	]);

	it("names the device a line refers to by its key", () => {
		expect(name("synced with tG/Lnb18 ✅")).toBe("synced with tG/Lnb18 (Alice's iPad) ✅");
		expect(name("file peer wW5pPXvr connected")).toBe("file peer wW5pPXvr (Work laptop) connected");
		expect(name("tG/Lnb18 is on the local link, not over the relay")).toBe(
			"tG/Lnb18 (Alice's iPad) is on the local link, not over the relay",
		);
		expect(name("file 0a1b2c3d from wW5pPXvr: too large")).toBe(
			"file 0a1b2c3d from wW5pPXvr (Work laptop): too large",
		);
	});

	it("leaves keys it doesn't know, and parts of words, alone", () => {
		expect(name("peer 09d03287 found — awaiting offer (webrtc)")).toBe(
			"peer 09d03287 found — awaiting offer (webrtc)",
		);
		expect(name("xtG/Lnb18 tG/Lnb18x")).toBe("xtG/Lnb18 tG/Lnb18x");
	});

	it("takes a name literally", () => {
		const odd = deviceNamer([{ publicKey: PHONE, name: "$& $1 phone" }]);
		expect(odd("synced with tG/Lnb18 ✅")).toBe("synced with tG/Lnb18 ($& $1 phone) ✅");
	});

	it("skips devices with no name, and keys too short to be a device's", () => {
		const some = deviceNamer([
			{ publicKey: PHONE, name: "" },
			{ publicKey: "peer", name: "Short" },
		]);
		expect(some("synced with tG/Lnb18 ✅")).toBe("synced with tG/Lnb18 ✅");
		expect(some("peer 09d03287 idle — dropping")).toBe("peer 09d03287 idle — dropping");
	});
});
