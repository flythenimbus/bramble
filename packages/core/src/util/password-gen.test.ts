import { describe, expect, it } from "vitest";
import {
	DEFAULT_GENERATOR_SETTINGS,
	DEFAULT_SYMBOLS,
	type GeneratorSettings,
	generatePassphrase,
	generatePassword,
	MAX_LENGTH,
	MIN_LENGTH,
	normalizeGeneratorSettings,
} from "./password-gen";

const settings = (over: Partial<GeneratorSettings> = {}): GeneratorSettings => ({
	...DEFAULT_GENERATOR_SETTINGS,
	...over,
});

// Enough draws that a class the generator only *might* include would show up missing.
const RUNS = 200;
const runs = (s: GeneratorSettings) => Array.from({ length: RUNS }, () => generatePassword(s));

describe("generatePassword", () => {
	it("honours the requested length", () => {
		for (const length of [MIN_LENGTH, 20, 64, MAX_LENGTH]) {
			expect(generatePassword(settings({ length }))).toHaveLength(length);
		}
	});

	it("clamps a length outside the allowed range", () => {
		expect(generatePassword(settings({ length: 2 }))).toHaveLength(MIN_LENGTH);
		expect(generatePassword(settings({ length: 5000 }))).toHaveLength(MAX_LENGTH);
	});

	it("always includes at least one character from every enabled class", () => {
		for (const value of runs(settings({ length: MIN_LENGTH }))) {
			expect(value).toMatch(/[a-z]/);
			expect(value).toMatch(/[A-Z]/);
			expect(value).toMatch(/[0-9]/);
			expect([...value].some((c) => DEFAULT_SYMBOLS.includes(c))).toBe(true);
		}
	});

	it("draws only from the enabled classes", () => {
		for (const value of runs(settings({ uppercase: false, symbols: false }))) {
			expect(value).toMatch(/^[a-z0-9]+$/);
		}
	});

	it("falls back to lowercase rather than generating nothing with every class off", () => {
		const value = generatePassword(
			settings({ lowercase: false, uppercase: false, digits: false, symbols: false }),
		);
		expect(value).toMatch(/^[a-z]+$/);
	});

	it("omits look-alike characters when asked", () => {
		for (const value of runs(settings({ avoidAmbiguous: true }))) {
			expect(value).not.toMatch(/[Il1|O0o]/);
		}
	});

	it("uses a narrowed symbol set for sites that reject the rest", () => {
		for (const value of runs(settings({ symbolSet: "#$", length: 12 }))) {
			expect(value).toMatch(/^[a-zA-Z0-9#$]+$/);
			expect(value).toMatch(/[#$]/);
		}
	});

	it("ignores an empty symbol set instead of dropping the class silently", () => {
		const value = generatePassword(settings({ symbolSet: "   " }));
		expect([...value].some((c) => DEFAULT_SYMBOLS.includes(c))).toBe(true);
	});

	it("generates digit-only PINs, keeping 0 and 1 even under avoid-ambiguous", () => {
		const values = runs(settings({ mode: "pin", pinLength: 8, avoidAmbiguous: true }));
		for (const value of values) expect(value).toMatch(/^[0-9]{8}$/);
		expect(values.join("")).toMatch(/[01]/);
	});

	it("does not repeat itself", () => {
		expect(new Set(runs(settings())).size).toBe(RUNS);
	});

	it("spreads the guaranteed characters rather than front-loading them", () => {
		// Without the shuffle every password would open with its lowercase pick.
		const firsts = new Set(runs(settings({ length: 16 })).map((v) => v.charAt(0)));
		expect(firsts.size).toBeGreaterThan(4);
	});
});

describe("generatePassphrase", () => {
	const list = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];

	it("joins the requested number of words with the separator", () => {
		const value = generatePassphrase(settings({ words: 5, separator: "-" }), list);
		const parts = value.split("-");
		expect(parts).toHaveLength(5);
		for (const p of parts) expect(list).toContain(p);
	});

	it("supports an empty separator", () => {
		const value = generatePassphrase(settings({ words: 4, separator: "" }), list);
		expect(value).toMatch(/^[a-z]+$/);
	});

	it("capitalizes each word when asked", () => {
		const value = generatePassphrase(settings({ capitalize: true, separator: "." }), list);
		for (const word of value.split(".")) expect(word).toMatch(/^[A-Z][a-z]+$/);
	});

	it("appends a digit to exactly one word", () => {
		for (let i = 0; i < RUNS; i++) {
			const value = generatePassphrase(settings({ words: 4, wordNumber: true }), list);
			const numbered = value.split("-").filter((w) => /[0-9]$/.test(w));
			expect(numbered).toHaveLength(1);
		}
	});

	it("puts that digit on a different word each time", () => {
		const positions = new Set(
			Array.from({ length: RUNS }, () =>
				generatePassphrase(settings({ words: 4, wordNumber: true }), list)
					.split("-")
					.findIndex((w) => /[0-9]$/.test(w)),
			),
		);
		expect(positions.size).toBe(4);
	});
});

describe("normalizeGeneratorSettings", () => {
	it("returns the defaults for anything that isn't an object", () => {
		expect(normalizeGeneratorSettings(undefined)).toEqual(DEFAULT_GENERATOR_SETTINGS);
		expect(normalizeGeneratorSettings("password")).toEqual(DEFAULT_GENERATOR_SETTINGS);
		expect(normalizeGeneratorSettings(null)).toEqual(DEFAULT_GENERATOR_SETTINGS);
	});

	it("keeps the fields it recognises and defaults the rest", () => {
		const s = normalizeGeneratorSettings({ mode: "passphrase", words: 7, bogus: 1 });
		expect(s.mode).toBe("passphrase");
		expect(s.words).toBe(7);
		expect(s.length).toBe(DEFAULT_GENERATOR_SETTINGS.length);
	});

	it("clamps out-of-range numbers and rejects wrong types", () => {
		const s = normalizeGeneratorSettings({
			length: 999,
			words: 1,
			pinLength: "8",
			lowercase: "yes",
			mode: "novel",
		});
		expect(s.length).toBe(MAX_LENGTH);
		expect(s.words).toBe(3);
		expect(s.pinLength).toBe(DEFAULT_GENERATOR_SETTINGS.pinLength);
		expect(s.lowercase).toBe(true);
		expect(s.mode).toBe("password");
	});

	it("trims a separator down to a joiner and keeps an empty one", () => {
		expect(normalizeGeneratorSettings({ separator: "  spaced  " }).separator).toBe("  s");
		expect(normalizeGeneratorSettings({ separator: "" }).separator).toBe("");
	});

	it("re-enables lowercase when every class was stored off", () => {
		const s = normalizeGeneratorSettings({
			lowercase: false,
			uppercase: false,
			digits: false,
			symbols: false,
		});
		expect(s.lowercase).toBe(true);
	});
});
