import { describe, expect, it } from "vitest";
import { generateRecoveryCode, normalizeRecoveryCode } from "./recovery-code";

describe("generateRecoveryCode", () => {
	it("produces 6 groups of 5 Crockford base32 chars", () => {
		const code = generateRecoveryCode();
		expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/);
	});

	it("never emits ambiguous characters (I, L, O, U)", () => {
		for (let i = 0; i < 50; i++) {
			expect(generateRecoveryCode()).not.toMatch(/[ILOU]/);
		}
	});

	it("is overwhelmingly unique across calls", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) seen.add(generateRecoveryCode());
		expect(seen.size).toBe(200);
	});

	it("normalizes to 30 secret characters (150 bits)", () => {
		expect(normalizeRecoveryCode(generateRecoveryCode())).toHaveLength(30);
	});
});

describe("normalizeRecoveryCode", () => {
	it("strips dashes and whitespace", () => {
		expect(normalizeRecoveryCode("ABCDE-FGHJK")).toBe("ABCDEFGHJK");
		expect(normalizeRecoveryCode("  ABC DE  ")).toBe("ABCDE");
	});

	it("uppercases", () => {
		expect(normalizeRecoveryCode("abcde")).toBe("ABCDE");
	});

	it("folds Crockford look-alikes (O→0, I/L→1)", () => {
		expect(normalizeRecoveryCode("OIL")).toBe("011");
		expect(normalizeRecoveryCode("o-i-l")).toBe("011");
	});

	it("is idempotent on an already-generated code", () => {
		const norm = normalizeRecoveryCode(generateRecoveryCode());
		expect(normalizeRecoveryCode(norm)).toBe(norm);
	});

	it("matches regardless of how the user re-types the displayed code", () => {
		const displayed = generateRecoveryCode();
		const messy = displayed.toLowerCase().replace(/-/g, " ");
		expect(normalizeRecoveryCode(messy)).toBe(normalizeRecoveryCode(displayed));
	});
});
