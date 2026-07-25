import { describe, expect, it } from "vitest";
import { generatePassword } from "./password-gen";

describe("generatePassword", () => {
	it("returns a 20-character password", () => {
		expect(generatePassword()).toHaveLength(20);
	});

	it("draws only from the expected charset", () => {
		for (let i = 0; i < 50; i++) {
			expect(generatePassword()).toMatch(/^[A-Za-z0-9!@#$%^&*()_+\-=[\]{}|;:,.<>?]{20}$/);
		}
	});

	it("produces a different password each call", () => {
		expect(generatePassword()).not.toBe(generatePassword());
	});
});
