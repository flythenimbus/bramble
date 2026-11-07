// Test-only: EntryMutations wired to a fake crypto/storage/autofill and an in-memory "disk" that
// round-trips through the real vault encode/decode. Shared by entry-mutations and the sync tests.

import { HybridClock } from "../sync";
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
import { createEntryMutations, vaultEntriesFromPayload } from "./entry-mutations";

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

// Wires the module to a fake crypto/storage/autofill plus an in-memory "disk"
// that round-trips through the real encode/decode, so the persist primitive is
// exercised end to end. The clock is a real HybridClock with a frozen wall time,
// so stamps differ only by their monotonic counter.
export function harness(now: () => number = () => 1000, node = "device-a") {
	return harnessOn({ bytes: emptyVaultBytes() }, now, node);
}

/**
 * Two windows on one vault, as the extension's popup and a Settings window are: one disk and one
 * device, each with its own memory, its own record of what the disk held, and its own clock.
 */
export function twoWindows() {
	const disk = { bytes: emptyVaultBytes() };
	const open = () => {
		let reloads = 0;
		const notified = { count: 0 };
		const duringIndex: { run: (() => Promise<unknown>) | null } = { run: null };
		const win = harnessOn(disk, () => 1000, "device-a", {
			duringIndex,
			onDiskMerged: () => {
				reloads++;
			},
			notifyExternalChange: () => {
				notified.count++;
			},
		});
		return {
			...win,
			notified,
			duringIndex,
			reloads: () => reloads,
			/** What opening the vault does: memory and its record of the disk, from one read. */
			load: async () => {
				const { blob } = decodeBlob(disk.bytes);
				const payload = await win.mutations.readEntriesPayload();
				const plaintexts = await win.crypto.decryptEntries(payload.entries);
				const decrypted = payload.entries.map((enc, i) => ({
					id: enc.id,
					...JSON.parse(plaintexts[i] as string),
				}));
				return {
					...vaultEntriesFromPayload(payload, decrypted),
					diskSeen: blob.entriesCiphertext,
				};
			},
		};
	};
	return { first: open(), second: open(), disk };
}

function decodeBlob(bytes: Uint8Array) {
	return { blob: decodeVaultBlob(bytes) };
}

function harnessOn(
	disk: { bytes: Uint8Array },
	now: () => number,
	node: string,
	window?: {
		duringIndex: { run: (() => Promise<unknown>) | null };
		onDiskMerged: () => void;
		notifyExternalChange: () => void;
	},
) {
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
		decryptEntries: async (ps: { ciphertext: string }[]) =>
			ps.map((p) => (p.ciphertext.startsWith("ct:") ? p.ciphertext.slice(3) : null)),
		...(window ? { notifyExternalChange: window.notifyExternalChange } : {}),
	};
	const storage = {
		writeVaultBlob: async (bytes: Uint8Array) => {
			disk.bytes = bytes;
			writes++;
		},
	};
	const autofill = {
		setIndex: async (entries: { type: string }[]) => {
			indexCalls.push(entries);
			await window?.duringIndex.run?.();
		},
	};
	const readDecodedBlob = async () => decodeBlob(disk.bytes);
	const c = new HybridClock(node, now);
	const mutations = createEntryMutations({
		crypto,
		storage,
		autofill,
		readDecodedBlob,
		clock: async () => c,
		...(window ? { onDiskMerged: window.onDiskMerged } : {}),
	});
	return { mutations, writes: () => writes, indexCalls, crypto, clock: c };
}
