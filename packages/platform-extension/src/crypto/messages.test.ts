import { describe, expect, it } from "vitest";
import {
	CryptoDecryptSchema,
	CryptoOpenKdbxSchema,
	CryptoUnlockWithVekSchema,
	CryptoUnwrapPasswordSlotSchema,
	CryptoUnwrapWebauthnSlotSchema,
	CryptoWrapPasswordSlotSchema,
	CryptoWrapWebauthnSlotSchema,
} from "./messages";

const magicVersion = [86, 76, 84, 49, 2]; // VLT1 || 0x02

describe("password-slot schemas", () => {
	const base = { password: "pw", saltB64: "s", slotIdB64: "id", magicVersion };

	it("accepts a wrap payload", () => {
		expect(CryptoWrapPasswordSlotSchema.parse(base)).toEqual(base);
	});

	it("rejects a non-array magicVersion", () => {
		expect(CryptoWrapPasswordSlotSchema.safeParse({ ...base, magicVersion: "nope" }).success).toBe(
			false,
		);
	});

	it("unwrap requires the wrapped fields", () => {
		expect(CryptoUnwrapPasswordSlotSchema.safeParse(base).success).toBe(false);
		const ok = { ...base, verifierB64: "v", wrapIvB64: "w", wrappedVekB64: "k" };
		expect(CryptoUnwrapPasswordSlotSchema.parse(ok)).toEqual(ok);
	});
});

describe("webauthn-slot schemas", () => {
	const base = { hmacSecretB64: "h", slotIdB64: "id", magicVersion };

	it("accepts a wrap payload", () => {
		expect(CryptoWrapWebauthnSlotSchema.parse(base)).toEqual(base);
	});

	it("unwrap requires the wrapped fields", () => {
		expect(CryptoUnwrapWebauthnSlotSchema.safeParse(base).success).toBe(false);
		const ok = { ...base, verifierB64: "v", wrapIvB64: "w", wrappedVekB64: "k" };
		expect(CryptoUnwrapWebauthnSlotSchema.parse(ok)).toEqual(ok);
	});
});

describe("entry + misc schemas", () => {
	it("decrypt requires all four envelope fields", () => {
		expect(CryptoDecryptSchema.safeParse({ ciphertext: "c", iv: "i" }).success).toBe(false);
		const ok = { ciphertext: "c", iv: "i", wrappedDek: "w", dekIv: "d" };
		expect(CryptoDecryptSchema.parse(ok)).toEqual(ok);
	});

	it("unlock-with-vek requires vekB64", () => {
		expect(CryptoUnlockWithVekSchema.parse({ vekB64: "v" })).toEqual({ vekB64: "v" });
		expect(CryptoUnlockWithVekSchema.safeParse({}).success).toBe(false);
	});

	it("open-kdbx keyfile is optional", () => {
		const min = { fileB64: "f", password: "pw" };
		expect(CryptoOpenKdbxSchema.parse(min)).toEqual(min);
		expect(CryptoOpenKdbxSchema.safeParse({ fileB64: "f" }).success).toBe(false);
	});
});
