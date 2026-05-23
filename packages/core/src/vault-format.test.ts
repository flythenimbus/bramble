import { describe, expect, it } from "vitest";
import {
	decodeVaultBlob,
	encodeVaultBlob,
	findPasswordSlot,
	LEN_IV,
	LEN_SALT,
	LEN_SLOT_ID,
	LEN_VERIFIER,
	LEN_WRAP_IV,
	LEN_WRAPPED_VEK,
	MAGIC,
	MAX_SLOTS,
	type PasswordSlot,
	SLOT_KIND_PASSWORD,
	SLOT_KIND_RECOVERY,
	SLOT_KIND_WEBAUTHN,
	type Slot,
	type VaultBlob,
	VERSION,
	verifierPrefix,
} from "./vault-format";

function fillBytes(length: number, base = 0): Uint8Array {
	const arr = new Uint8Array(length);
	for (let i = 0; i < length; i++) arr[i] = (base + i) & 0xff;
	return arr;
}

function makePasswordSlot(base = 0): PasswordSlot {
	return {
		kind: SLOT_KIND_PASSWORD,
		slotId: fillBytes(LEN_SLOT_ID, base + 0x10),
		salt: fillBytes(LEN_SALT, base + 0x20),
		verifier: fillBytes(LEN_VERIFIER, base + 0x30),
		wrapIv: fillBytes(LEN_WRAP_IV, base + 0x40),
		wrappedVek: fillBytes(LEN_WRAPPED_VEK, base + 0x50),
	};
}

function makeBlob(entriesLen = 32, slots: Slot[] = [makePasswordSlot()]): VaultBlob {
	return {
		slots,
		entriesIv: fillBytes(LEN_IV, 0x70),
		entriesCiphertext: fillBytes(entriesLen, 0x80),
	};
}

describe("encodeVaultBlob", () => {
	it("starts with magic + version", () => {
		const out = encodeVaultBlob(makeBlob());
		expect(out.subarray(0, 4)).toEqual(MAGIC);
		expect(out[MAGIC.length]).toBe(VERSION);
	});

	it("writes slotCount immediately after version", () => {
		const out = encodeVaultBlob(makeBlob());
		expect(out[MAGIC.length + 1]).toBe(1);
	});

	it("rejects an empty slot list", () => {
		expect(() => encodeVaultBlob(makeBlob(0, []))).toThrow(/at least one slot/);
	});

	it("rejects more than MAX_SLOTS slots", () => {
		const slots = Array.from({ length: MAX_SLOTS + 1 }, (_, i) => makePasswordSlot(i));
		expect(() => encodeVaultBlob(makeBlob(0, slots))).toThrow(/max/);
	});

	it("rejects wrong-length entriesIv", () => {
		const blob = { ...makeBlob(), entriesIv: new Uint8Array(LEN_IV - 1) };
		expect(() => encodeVaultBlob(blob)).toThrow(/entriesIv/);
	});

	it("rejects wrong-length password slot fields", () => {
		const slot = { ...makePasswordSlot(), salt: new Uint8Array(LEN_SALT - 1) };
		expect(() => encodeVaultBlob(makeBlob(0, [slot]))).toThrow(/salt/);
	});
});

describe("decodeVaultBlob", () => {
	it("roundtrips a populated blob with one password slot", () => {
		const blob = makeBlob(42);
		const decoded = decodeVaultBlob(encodeVaultBlob(blob));
		expect(decoded.slots).toHaveLength(1);
		const slot = decoded.slots[0]! as PasswordSlot;
		const original = blob.slots[0]! as PasswordSlot;
		expect(slot.kind).toBe(SLOT_KIND_PASSWORD);
		expect(slot.slotId).toEqual(original.slotId);
		expect(slot.salt).toEqual(original.salt);
		expect(slot.verifier).toEqual(original.verifier);
		expect(slot.wrapIv).toEqual(original.wrapIv);
		expect(slot.wrappedVek).toEqual(original.wrappedVek);
		expect(decoded.entriesIv).toEqual(blob.entriesIv);
		expect(decoded.entriesCiphertext).toEqual(blob.entriesCiphertext);
	});

	it("roundtrips an empty entries blob", () => {
		const decoded = decodeVaultBlob(encodeVaultBlob(makeBlob(0)));
		expect(decoded.entriesCiphertext.length).toBe(0);
	});

	it("preserves unknown slot kinds verbatim across a round-trip", () => {
		const opaque = { kind: SLOT_KIND_WEBAUTHN, payload: fillBytes(96, 0xa0) };
		const recovery = { kind: SLOT_KIND_RECOVERY, payload: fillBytes(124, 0xb0) };
		const blob = makeBlob(0, [makePasswordSlot(), opaque, recovery]);
		const decoded = decodeVaultBlob(encodeVaultBlob(blob));
		expect(decoded.slots).toHaveLength(3);
		expect(decoded.slots[0]!.kind).toBe(SLOT_KIND_PASSWORD);
		expect(decoded.slots[1]!.kind).toBe(SLOT_KIND_WEBAUTHN);
		expect((decoded.slots[1] as { payload: Uint8Array }).payload).toEqual(opaque.payload);
		expect(decoded.slots[2]!.kind).toBe(SLOT_KIND_RECOVERY);
		expect((decoded.slots[2] as { payload: Uint8Array }).payload).toEqual(recovery.payload);
	});

	it("rejects too-short input", () => {
		expect(() => decodeVaultBlob(new Uint8Array(2))).toThrow(/short/);
	});

	it("rejects wrong magic", () => {
		const out = encodeVaultBlob(makeBlob());
		out[0] = 0x00;
		expect(() => decodeVaultBlob(out)).toThrow(/magic/);
	});

	it("rejects unknown version", () => {
		const out = encodeVaultBlob(makeBlob());
		out[MAGIC.length] = 0xff;
		expect(() => decodeVaultBlob(out)).toThrow(/version/);
	});

	it("rejects zero slot count", () => {
		const out = encodeVaultBlob(makeBlob());
		out[MAGIC.length + 1] = 0;
		expect(() => decodeVaultBlob(out)).toThrow(/no slots/);
	});

	it("returns copies, not views into the input buffer", () => {
		const out = encodeVaultBlob(makeBlob());
		const decoded = decodeVaultBlob(out);
		const slot = decoded.slots[0]! as PasswordSlot;
		const before = slot.salt[0]!;
		// Mutate a salt byte inside the encoded buffer.
		const saltOffset = MAGIC.length + 1 + 1 + 1 + 2 + LEN_SLOT_ID;
		out[saltOffset] = before ^ 0xff;
		expect(slot.salt[0]).toBe(before);
	});
});

describe("findPasswordSlot", () => {
	it("returns the first password slot", () => {
		const pw = makePasswordSlot();
		const blob = makeBlob(0, [pw]);
		expect(findPasswordSlot(blob)).toBe(pw);
	});

	it("returns null when no password slot is present", () => {
		const blob = makeBlob(0, [{ kind: SLOT_KIND_WEBAUTHN, payload: fillBytes(96, 0xa0) }]);
		expect(findPasswordSlot(blob)).toBeNull();
	});
});

describe("verifierPrefix", () => {
	it("returns magic + version", () => {
		const prefix = verifierPrefix();
		expect(prefix.length).toBe(MAGIC.length + 1);
		expect(prefix.subarray(0, MAGIC.length)).toEqual(MAGIC);
		expect(prefix[MAGIC.length]).toBe(VERSION);
	});
});
