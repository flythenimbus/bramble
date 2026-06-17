import { describe, expect, it } from "vitest";
import type { EncryptedEntry } from "../vault-format";
import {
	decodeEntriesPayload,
	type EntriesPayload,
	emptyEntriesPayload,
	encodeEntriesPayload,
} from "./entries-payload";

const entry = (id: string, wall: number): EncryptedEntry => ({
	id,
	wrappedDek: "wd",
	dekIv: "di",
	ciphertext: "ct",
	iv: "iv",
	hlc: { wall, counter: 0, node: "dev" },
});

describe("entries payload codec", () => {
	it("round-trips entries and tombstones", () => {
		const payload: EntriesPayload = {
			entries: [entry("a", 100), entry("b", 200)],
			tombstones: [{ id: "c", hlc: { wall: 300, counter: 1, node: "dev" } }],
		};
		expect(decodeEntriesPayload(encodeEntriesPayload(payload))).toEqual(payload);
	});

	it("round-trips an empty payload", () => {
		expect(decodeEntriesPayload(encodeEntriesPayload(emptyEntriesPayload()))).toEqual({
			entries: [],
			tombstones: [],
		});
	});

	it("rejects the legacy bare-array shape", () => {
		expect(() => decodeEntriesPayload(JSON.stringify([entry("a", 1)]))).toThrow();
	});

	it("rejects an entry missing its hlc stamp", () => {
		const bad = JSON.stringify({
			entries: [{ id: "a", wrappedDek: "w", dekIv: "d", ciphertext: "c", iv: "i" }],
			tombstones: [],
		});
		expect(() => decodeEntriesPayload(bad)).toThrow();
	});

	it("rejects a payload missing the tombstones field", () => {
		expect(() => decodeEntriesPayload(JSON.stringify({ entries: [] }))).toThrow();
	});
});
