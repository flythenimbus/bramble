import { describe, expect, it } from "vitest";
import {
	LEN_HMAC_SECRET_SALT,
	LEN_IV,
	LEN_SLOT_ID,
	LEN_VERIFIER,
	LEN_WRAP_IV,
	LEN_WRAPPED_VEK,
	MAX_SLOTS,
	type PasswordSlot,
	type RecoverySlot,
	SLOT_KIND_PASSWORD,
	SLOT_KIND_RECOVERY,
	SLOT_KIND_WEBAUTHN,
	type Slot,
	type VaultBlob,
	type WebauthnSlot,
} from "../vault-format";
import {
	addWebauthnSlot,
	matchSlotByCredentialId,
	needsSaltMismatchRetry,
	removePasswordSlot,
	removeWebauthnSlot,
	upsertPasswordSlot,
	upsertRecoverySlot,
} from "./slot-policy";

function fillBytes(length: number, base = 0): Uint8Array {
	const arr = new Uint8Array(length);
	for (let i = 0; i < length; i++) arr[i] = (base + i) & 0xff;
	return arr;
}

function makeWebauthnSlot(idBase: number, credIdLen = 64, saltBase = 0x30): WebauthnSlot {
	return {
		kind: SLOT_KIND_WEBAUTHN,
		slotId: fillBytes(LEN_SLOT_ID, idBase),
		credentialId: fillBytes(credIdLen, idBase + 0x20),
		salt: fillBytes(LEN_HMAC_SECRET_SALT, saltBase),
		verifier: fillBytes(LEN_VERIFIER, idBase + 0x40),
		wrapIv: fillBytes(LEN_WRAP_IV, idBase + 0x50),
		wrappedVek: fillBytes(LEN_WRAPPED_VEK, idBase + 0x60),
	};
}

function makePasswordSlot(idBase = 0x01): PasswordSlot {
	return {
		kind: SLOT_KIND_PASSWORD,
		slotId: fillBytes(LEN_SLOT_ID, idBase),
		salt: fillBytes(16, idBase + 0x01),
		verifier: fillBytes(LEN_VERIFIER, idBase + 0x02),
		wrapIv: fillBytes(LEN_WRAP_IV, idBase + 0x03),
		wrappedVek: fillBytes(LEN_WRAPPED_VEK, idBase + 0x04),
	};
}

function makeRecoverySlot(idBase = 0xc0): RecoverySlot {
	return {
		kind: SLOT_KIND_RECOVERY,
		slotId: fillBytes(LEN_SLOT_ID, idBase),
		salt: fillBytes(16, idBase + 0x01),
		verifier: fillBytes(LEN_VERIFIER, idBase + 0x02),
		wrapIv: fillBytes(LEN_WRAP_IV, idBase + 0x03),
		wrappedVek: fillBytes(LEN_WRAPPED_VEK, idBase + 0x04),
	};
}

function makeBlob(slots: Slot[]): VaultBlob {
	return {
		slots,
		entriesIv: fillBytes(LEN_IV, 0x70),
		entriesCiphertext: fillBytes(0, 0x80),
	};
}

describe("matchSlotByCredentialId", () => {
	it("finds the slot whose credentialId matches the raw response id", () => {
		const a = makeWebauthnSlot(0x10);
		const b = makeWebauthnSlot(0x80);
		const found = matchSlotByCredentialId([a, b], b.credentialId);
		expect(found?.slotId).toEqual(b.slotId);
	});

	it("returns null when no slot matches", () => {
		const a = makeWebauthnSlot(0x10);
		const stranger = fillBytes(64, 0xff);
		expect(matchSlotByCredentialId([a], stranger)).toBeNull();
	});

	it("returns null for an empty slot list", () => {
		expect(matchSlotByCredentialId([], fillBytes(32))).toBeNull();
	});

	it("returns the first match if credentialIds collide (defensive)", () => {
		// Two slots can't legitimately share a credentialId, but if they do
		// (e.g. data corruption) we shouldn't crash, return the first.
		const a = makeWebauthnSlot(0x10);
		const b = makeWebauthnSlot(0x80);
		b.credentialId = a.credentialId;
		const found = matchSlotByCredentialId([a, b], a.credentialId);
		expect(found?.slotId).toEqual(a.slotId);
	});
});

describe("needsSaltMismatchRetry", () => {
	it("returns false when the used slot's salt matches the salt passed", () => {
		const slot = makeWebauthnSlot(0x10, 64, 0x30);
		expect(needsSaltMismatchRetry(slot, slot.salt)).toBe(false);
	});

	it("returns true when the used slot's salt differs", () => {
		const a = makeWebauthnSlot(0x10, 64, 0x30);
		const b = makeWebauthnSlot(0x80, 64, 0xa0);
		expect(needsSaltMismatchRetry(b, a.salt)).toBe(true);
	});

	it("returns true when the salt has the same length but different bytes", () => {
		const slot = makeWebauthnSlot(0x10);
		const otherSalt = fillBytes(LEN_HMAC_SECRET_SALT, 0xff);
		expect(needsSaltMismatchRetry(slot, otherSalt)).toBe(true);
	});
});

describe("addWebauthnSlot", () => {
	it("appends the new slot to the existing slot list", () => {
		const blob = makeBlob([makePasswordSlot()]);
		const newSlot = makeWebauthnSlot(0x10);
		const next = addWebauthnSlot(blob, newSlot);
		expect(next.slots).toHaveLength(2);
		expect(next.slots[1]).toBe(newSlot);
	});

	it("returns a new blob (input is not mutated)", () => {
		const blob = makeBlob([makePasswordSlot()]);
		const before = blob.slots.length;
		addWebauthnSlot(blob, makeWebauthnSlot(0x10));
		expect(blob.slots.length).toBe(before);
	});

	it("preserves entriesIv and entriesCiphertext unchanged", () => {
		const blob = makeBlob([makePasswordSlot()]);
		const next = addWebauthnSlot(blob, makeWebauthnSlot(0x10));
		expect(next.entriesIv).toBe(blob.entriesIv);
		expect(next.entriesCiphertext).toBe(blob.entriesCiphertext);
	});

	it("refuses to add when the vault already has MAX_SLOTS", () => {
		const slots: Slot[] = Array.from({ length: MAX_SLOTS }, (_, i) =>
			makeWebauthnSlot(0x10 + i * 0x10),
		);
		const blob = makeBlob(slots);
		expect(() => addWebauthnSlot(blob, makeWebauthnSlot(0xff))).toThrow(/maximum/);
	});
});

describe("removeWebauthnSlot", () => {
	it("removes the slot matching the given slotId", () => {
		const a = makeWebauthnSlot(0x10);
		const b = makeWebauthnSlot(0x80);
		const blob = makeBlob([makePasswordSlot(), a, b]);
		const next = removeWebauthnSlot(blob, a.slotId);
		expect(next.slots).toHaveLength(2);
		expect(next.slots.find((s) => s.kind === SLOT_KIND_WEBAUTHN)).toBe(b);
	});

	it("returns a new blob (input is not mutated)", () => {
		const a = makeWebauthnSlot(0x10);
		const blob = makeBlob([makePasswordSlot(), a]);
		const before = blob.slots.length;
		removeWebauthnSlot(blob, a.slotId);
		expect(blob.slots.length).toBe(before);
	});

	it("throws when no slot has the given slotId", () => {
		const a = makeWebauthnSlot(0x10);
		const blob = makeBlob([makePasswordSlot(), a]);
		const unknown = fillBytes(LEN_SLOT_ID, 0xff);
		expect(() => removeWebauthnSlot(blob, unknown)).toThrow(/not found/);
	});

	it("refuses to remove the last unlock method (single webauthn slot)", () => {
		// A vault with ONLY one webauthn slot: if we remove it, the user
		// can never unlock the vault again. Must refuse.
		const only = makeWebauthnSlot(0x10);
		const blob = makeBlob([only]);
		expect(() => removeWebauthnSlot(blob, only.slotId)).toThrow(/last unlock/);
	});

	it("allows removal when a password slot still exists", () => {
		const wa = makeWebauthnSlot(0x10);
		const blob = makeBlob([makePasswordSlot(), wa]);
		const next = removeWebauthnSlot(blob, wa.slotId);
		expect(next.slots).toHaveLength(1);
		expect(next.slots[0]!.kind).toBe(SLOT_KIND_PASSWORD);
	});

	it("allows removal when another webauthn slot still exists", () => {
		const a = makeWebauthnSlot(0x10);
		const b = makeWebauthnSlot(0x80);
		const blob = makeBlob([a, b]);
		const next = removeWebauthnSlot(blob, a.slotId);
		expect(next.slots).toHaveLength(1);
		expect((next.slots[0] as WebauthnSlot).slotId).toEqual(b.slotId);
	});

	it("refuses when removing would leave only a recovery slot", () => {
		// A recovery code is a backup, never a primary unlock (invariant B).
		// Removing the only webauthn key would leave nothing to unlock with
		// day-to-day, so it must be refused even though a recovery slot exists.
		const only = makeWebauthnSlot(0x10);
		const blob = makeBlob([only, makeRecoverySlot()]);
		expect(() => removeWebauthnSlot(blob, only.slotId)).toThrow(/last unlock/);
	});

	it("preserves entriesIv and entriesCiphertext unchanged", () => {
		const a = makeWebauthnSlot(0x10);
		const blob = makeBlob([makePasswordSlot(), a]);
		const next = removeWebauthnSlot(blob, a.slotId);
		expect(next.entriesIv).toBe(blob.entriesIv);
		expect(next.entriesCiphertext).toBe(blob.entriesCiphertext);
	});
});

describe("upsertPasswordSlot", () => {
	it("adds a password slot to a key-only vault (first-time enable)", () => {
		const blob = makeBlob([makeWebauthnSlot(0x10)]);
		const next = upsertPasswordSlot(blob, makePasswordSlot());
		expect(next.slots).toHaveLength(2);
		expect(next.slots.filter((s) => s.kind === SLOT_KIND_PASSWORD)).toHaveLength(1);
	});

	it("replaces the existing password slot (re-wrap on change), keeping count", () => {
		const old = makePasswordSlot(0x01);
		const blob = makeBlob([old, makeWebauthnSlot(0x10)]);
		const replacement = makePasswordSlot(0x90);
		const next = upsertPasswordSlot(blob, replacement);
		const pw = next.slots.filter((s) => s.kind === SLOT_KIND_PASSWORD) as PasswordSlot[];
		expect(pw).toHaveLength(1);
		expect(pw[0]!.slotId).toEqual(replacement.slotId);
	});

	it("leaves recovery and webauthn slots untouched", () => {
		const blob = makeBlob([makeWebauthnSlot(0x10), makeRecoverySlot()]);
		const next = upsertPasswordSlot(blob, makePasswordSlot());
		expect(next.slots.some((s) => s.kind === SLOT_KIND_WEBAUTHN)).toBe(true);
		expect(next.slots.some((s) => s.kind === SLOT_KIND_RECOVERY)).toBe(true);
	});

	it("does not mutate the input blob", () => {
		const blob = makeBlob([makeWebauthnSlot(0x10)]);
		const before = blob.slots.length;
		upsertPasswordSlot(blob, makePasswordSlot());
		expect(blob.slots.length).toBe(before);
	});

	it("refuses when adding would exceed MAX_SLOTS", () => {
		const slots: Slot[] = Array.from({ length: MAX_SLOTS }, (_, i) =>
			makeWebauthnSlot(0x10 + i * 0x10),
		);
		const blob = makeBlob(slots);
		expect(() => upsertPasswordSlot(blob, makePasswordSlot())).toThrow(/maximum/);
	});
});

describe("removePasswordSlot", () => {
	it("removes the password slot when a security key remains", () => {
		const blob = makeBlob([makePasswordSlot(), makeWebauthnSlot(0x10)]);
		const next = removePasswordSlot(blob);
		expect(next.slots.some((s) => s.kind === SLOT_KIND_PASSWORD)).toBe(false);
		expect(next.slots.some((s) => s.kind === SLOT_KIND_WEBAUTHN)).toBe(true);
	});

	it("throws when there is no password slot to disable", () => {
		const blob = makeBlob([makeWebauthnSlot(0x10)]);
		expect(() => removePasswordSlot(blob)).toThrow(/no master password/);
	});

	it("refuses to disable the password when it is the only primary unlock", () => {
		const blob = makeBlob([makePasswordSlot()]);
		expect(() => removePasswordSlot(blob)).toThrow(/register a security key/i);
	});

	it("refuses when only a recovery slot would remain (invariant B)", () => {
		// Recovery is a backup, not a primary; disabling the password here
		// would leave no day-to-day unlock method.
		const blob = makeBlob([makePasswordSlot(), makeRecoverySlot()]);
		expect(() => removePasswordSlot(blob)).toThrow(/register a security key/i);
	});

	it("does not mutate the input blob", () => {
		const blob = makeBlob([makePasswordSlot(), makeWebauthnSlot(0x10)]);
		const before = blob.slots.length;
		removePasswordSlot(blob);
		expect(blob.slots.length).toBe(before);
	});
});

describe("upsertRecoverySlot", () => {
	it("adds a recovery slot when none exists", () => {
		const blob = makeBlob([makePasswordSlot()]);
		const next = upsertRecoverySlot(blob, makeRecoverySlot());
		expect(next.slots.filter((s) => s.kind === SLOT_KIND_RECOVERY)).toHaveLength(1);
	});

	it("replaces the existing recovery slot (reset), keeping a single one", () => {
		const blob = makeBlob([makePasswordSlot(), makeRecoverySlot(0xc0)]);
		const replacement = makeRecoverySlot(0xe0);
		const next = upsertRecoverySlot(blob, replacement);
		const rec = next.slots.filter((s) => s.kind === SLOT_KIND_RECOVERY) as RecoverySlot[];
		expect(rec).toHaveLength(1);
		expect(rec[0]!.slotId).toEqual(replacement.slotId);
	});

	it("does not mutate the input blob", () => {
		const blob = makeBlob([makePasswordSlot()]);
		const before = blob.slots.length;
		upsertRecoverySlot(blob, makeRecoverySlot());
		expect(blob.slots.length).toBe(before);
	});
});
