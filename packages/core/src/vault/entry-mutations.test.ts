import { describe, expect, it } from "vitest";
import type { EntryData } from "../hooks/useVault";
import { compareHlc, HybridClock } from "../sync";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import {
	decodeVaultBlob,
	encodeVaultBlob,
	LEN_IV,
	LEN_SALT,
	LEN_SLOT_ID,
	LEN_VERIFIER,
	LEN_WRAP_IV,
	LEN_WRAPPED_VEK,
	type PasswordSlot,
	SLOT_KIND_PASSWORD,
} from "../vault-format";
import { createEntryMutations, type VaultEntries } from "./entry-mutations";

const te = new TextEncoder();
const td = new TextDecoder();

function fillBytes(length: number, base = 0): Uint8Array {
	const arr = new Uint8Array(length);
	for (let i = 0; i < length; i++) arr[i] = (base + i) & 0xff;
	return arr;
}

function passwordSlot(): PasswordSlot {
	return {
		kind: SLOT_KIND_PASSWORD,
		slotId: fillBytes(LEN_SLOT_ID, 0x10),
		salt: fillBytes(LEN_SALT, 0x20),
		verifier: fillBytes(LEN_VERIFIER, 0x30),
		wrapIv: fillBytes(LEN_WRAP_IV, 0x40),
		wrappedVek: fillBytes(LEN_WRAPPED_VEK, 0x50),
	};
}

function emptyVaultBytes(): Uint8Array {
	return encodeVaultBlob({
		slots: [passwordSlot()],
		entriesIv: fillBytes(LEN_IV, 0x70),
		entriesCiphertext: new Uint8Array(0),
	});
}

const empty = (): VaultEntries => ({ entries: [], stamps: new Map(), tombstones: new Map() });
const login = (name: string): EntryData => ({
	type: "login",
	name,
	urls: [],
	username: "u",
	password: "p",
});
const note = (name: string): EntryData => ({ type: "note", name });

// Wires the module to a fake crypto/storage/autofill plus an in-memory "disk"
// that round-trips through the real encode/decode, so the persist primitive is
// exercised end to end. The clock is a real HybridClock with a frozen wall time,
// so stamps differ only by their monotonic counter.
function harness() {
	let disk = emptyVaultBytes();
	let writes = 0;
	const indexCalls: unknown[][] = [];
	const crypto = {
		encryptEntry: async (json: string) => ({
			ciphertext: `ct:${json}`,
			iv: "iv",
			wrappedDek: "wd",
			dekIv: "di",
		}),
		encryptWithVek: async (plaintext: string) => ({
			iv: bytesToBase64(fillBytes(LEN_IV)),
			ciphertext: bytesToBase64(te.encode(plaintext)),
		}),
		decryptWithVek: async (_iv: string, ciphertext: string) => td.decode(base64ToBytes(ciphertext)),
	};
	const storage = {
		writeVaultBlob: async (bytes: Uint8Array) => {
			disk = bytes;
			writes++;
		},
	};
	const autofill = {
		setIndex: async (entries: { type: string }[]) => {
			indexCalls.push(entries);
		},
	};
	const readDecodedBlob = async () => ({ blob: decodeVaultBlob(disk) });
	const c = new HybridClock("device-a", () => 1000);
	const mutations = createEntryMutations({
		crypto,
		storage,
		autofill,
		readDecodedBlob,
		clock: async () => c,
	});
	return { mutations, writes: () => writes, indexCalls };
}

describe("createEntryMutations", () => {
	it("add stamps the new entry and writes once", async () => {
		const h = harness();
		const next = await h.mutations.add(empty(), login("a"));
		expect(next.entries).toHaveLength(1);
		const id = next.entries[0]!.id;
		expect(next.stamps.has(id)).toBe(true);
		expect(h.writes()).toBe(1);
	});

	it("import is a single disk write regardless of count", async () => {
		const h = harness();
		const next = await h.mutations.importMany(empty(), [login("a"), login("b"), login("c")]);
		expect(next.entries).toHaveLength(3);
		expect(next.stamps.size).toBe(3);
		expect(h.writes()).toBe(1);
	});

	it("delete writes a tombstone that survives a reload from disk", async () => {
		const h = harness();
		const afterAdd = await h.mutations.add(empty(), login("a"));
		const id = afterAdd.entries[0]!.id;
		const afterDel = await h.mutations.remove(afterAdd, id);
		expect(afterDel.entries).toHaveLength(0);
		expect(afterDel.stamps.has(id)).toBe(false);
		expect(afterDel.tombstones.has(id)).toBe(true);

		const payload = await h.mutations.readEntriesPayload();
		expect(payload.entries).toHaveLength(0);
		expect(payload.tombstones.map((t) => t.id)).toContain(id);
	});

	it("update replaces the entry and advances its stamp", async () => {
		const h = harness();
		const afterAdd = await h.mutations.add(empty(), login("a"));
		const id = afterAdd.entries[0]!.id;
		const firstStamp = afterAdd.stamps.get(id)!;
		const afterUpd = await h.mutations.update(afterAdd, id, login("a2"));
		const secondStamp = afterUpd.stamps.get(id)!;
		expect(afterUpd.entries[0]!.name).toBe("a2");
		expect(compareHlc(secondStamp, firstStamp)).toBe(1);
	});

	it("rejects invalid entry data before writing", async () => {
		const h = harness();
		const bad = { type: "login", name: "x" } as unknown as EntryData; // missing urls/username/password
		await expect(h.mutations.add(empty(), bad)).rejects.toThrow(/validation/);
		expect(h.writes()).toBe(0);
	});

	it("projects only logins and cards into the autofill index", async () => {
		const h = harness();
		await h.mutations.add(empty(), note("just a note"));
		expect(h.indexCalls).toHaveLength(1);
		expect(h.indexCalls[0]).toHaveLength(0); // notes never reach the index
	});
});
