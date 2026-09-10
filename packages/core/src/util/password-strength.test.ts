import { describe, expect, it } from "vitest";
import {
	masterPasswordHardError,
	masterPasswordWarning,
	passwordStrength,
} from "./password-strength";

const STRONG = "kX7#pQz!2vLm9wRt";

describe("passwordStrength", () => {
	it("puts a dictionary password at the bottom and a random one at the top", async () => {
		expect(await passwordStrength("password1")).toBeLessThan(3);
		expect(await passwordStrength(STRONG)).toBe(4);
	});

	it("scores only the first 100 characters", async () => {
		const filler = "a".repeat(100);
		expect(await passwordStrength(filler + STRONG)).toBe(await passwordStrength(filler));
	});
});

describe("master password policy", () => {
	it("blocks on the length floor and nothing else", () => {
		expect(masterPasswordHardError("short")).toBeDefined();
		expect(masterPasswordHardError("password")).toBeUndefined();
		expect(masterPasswordHardError("")).toBeUndefined();
	});

	it("warns about a weak password that clears the floor", async () => {
		const weak = "password1";
		expect(masterPasswordWarning(weak, await passwordStrength(weak))).toBeDefined();
	});

	it("stays quiet for strong, too-short, and not-yet-scored passwords", async () => {
		expect(masterPasswordWarning(STRONG, await passwordStrength(STRONG))).toBeUndefined();
		expect(masterPasswordWarning("abc", 0)).toBeUndefined();
		expect(masterPasswordWarning("password1", null)).toBeUndefined();
	});
});
