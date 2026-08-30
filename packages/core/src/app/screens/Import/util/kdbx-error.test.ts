import { describe, expect, it } from "vitest";
import { kdbxErrorMessage } from "./kdbx-error";

// Every KDBX_* code the Rust core can emit needs a case here. One was missing
// (KDBX_KDF_TOO_EXPENSIVE), so a fully diagnosable rejection reached the user as the generic
// fallback and issue #78 could not be told apart from an unrelated bug with the same symptom.
describe("kdbxErrorMessage", () => {
	it("names the parameters when the key derivation is too expensive", () => {
		const msg = kdbxErrorMessage(new Error("KDBX_KDF_TOO_EXPENSIVE:1024KiB/3000"));
		expect(msg).toContain("1024 KiB");
		expect(msg).toContain("3000 rounds");
		expect(msg).not.toBe("Couldn't open this database.");
	});

	it("still says something useful if the numbers are absent", () => {
		const msg = kdbxErrorMessage(new Error("KDBX_KDF_TOO_EXPENSIVE"));
		expect(msg).toContain("key-derivation settings");
		expect(msg).not.toBe("Couldn't open this database.");
	});

	it("maps every other code the core emits", () => {
		const cases: [string, string][] = [
			["KDBX_WRONG_CREDENTIAL", "Wrong master password"],
			["KDBX_UNSUPPORTED_VERSION:3", "KDBX4"],
			["KDBX_UNSUPPORTED_CIPHER", "unsupported cipher"],
			["KDBX_UNSUPPORTED_KDF", "key-derivation function"],
			["KDBX_UNSUPPORTED_STREAM", "inner cipher"],
			["KDBX_NOT_KEEPASS", "doesn't look like"],
			["KDBX_CORRUPT:header", "damaged"],
		];
		for (const [code, expected] of cases) {
			expect(kdbxErrorMessage(new Error(code)), code).toContain(expected);
		}
	});

	it("falls back only for something it has never seen", () => {
		expect(kdbxErrorMessage(new Error("something else"))).toBe("Couldn't open this database.");
		// Tauri rejects with a bare string rather than an Error, so both shapes must read.
		expect(kdbxErrorMessage("KDBX_WRONG_CREDENTIAL")).toContain("Wrong master password");
	});
});
