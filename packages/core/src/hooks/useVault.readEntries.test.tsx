/** @vitest-environment happy-dom */
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { HybridClock } from "../sync";
import { encodeEntriesPayload } from "../sync/entries-payload";
import { mountVault } from "../test/vault-harness";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import {
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
import type { Entry, LoginEntry, LoginEntryData } from "./useVault";

afterEach(cleanup);

// Between the two awaited mutations below, only microtasks have run - React's scheduler
// task has not - so no render can have advanced the entries mirror: readEntries() seeing
// the first write is commitEntries' doing. The drain in usePendingHandoffs relies on that.

const VAULT_ID = "v1";

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

/** One login entry on disk, sealed through the real VLT1/payload codecs with fake crypto,
 * so the mount-time load runs the actual unlock path. */
function makeUnlockedPlatform() {
	const te = new TextEncoder();
	const td = new TextDecoder();
	const entryData = {
		type: "login",
		name: "Example",
		urls: ["https://old.example"],
		username: "u",
		password: "p",
	};
	const seedClock = new HybridClock("seed", () => 1000);
	const payload = encodeEntriesPayload({
		entries: [
			{
				id: "e1",
				ciphertext: `ct:${JSON.stringify(entryData)}`,
				iv: "iv",
				wrappedDek: "wd",
				dekIv: "di",
				hlc: seedClock.send(),
			},
		],
		tombstones: [],
	});
	let disk = encodeVaultBlob({
		slots: [passwordSlot()],
		entriesIv: fillBytes(LEN_IV, 0x70),
		entriesCiphertext: base64ToBytes(bytesToBase64(te.encode(payload))),
	});

	const meta = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: VAULT_ID, label: "", createdAt: 1 }] }],
		["sync.deviceId:v1", "test-device"],
	]);
	const platform = {
		target: "chromium",
		storage: {
			getMeta: async (k: string) => meta.get(k),
			setMeta: async (k: string, v: unknown) => void meta.set(k, v),
			removeMeta: async (k: string) => void meta.delete(k),
			hasVaultHandle: async () => true,
			readVaultBlob: async () => disk,
			writeVaultBlob: async (bytes: Uint8Array) => {
				disk = bytes;
			},
			restoreVaultFromBackup: async () => false,
		},
		crypto: {
			isLocked: async () => false,
			onExternalLock: () => () => {},
			onExternalChange: () => () => {},
			unwrapVekPassword: async () => true,
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
			decryptWithVek: async (_iv: string, ciphertext: string) =>
				td.decode(base64ToBytes(ciphertext)),
			decryptEntries: async (arr: { ciphertext: string }[]) =>
				arr.map((a) => a.ciphertext.slice(3)),
			lock: async () => {},
		},
		autofill: {
			clearIndex: async () => {},
			beginIndexUpdate: async () => undefined,
			setIndex: async () => {},
		},
		shell: {
			setActiveVault: async () => {},
			onSyncStatus: () => () => {},
			flushPendingCornerCapture: async () => false,
		},
		clipboard: {},
	} as unknown as Platform;
	return platform;
}

describe("readEntries / commitEntries determinism", () => {
	it("a second mutation in the same task sees the first one's committed write", async () => {
		const { actions, state } = mountVault(makeUnlockedPlatform());
		await waitFor(() => expect(state().entries).toHaveLength(1));

		// Deliberately not inside act(): act flushes pending renders at await boundaries,
		// which would hide a regression. React logs its warning; that is the point.
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const loginOf = (e: Entry | undefined) => (e && e.type === "login" ? e : null);
			const dataOf = (login: LoginEntry): LoginEntryData => {
				const { id: _id, ...data } = login;
				return data;
			};

			const first = loginOf(state().entries.find((e) => e.id === "e1"));
			if (!first) throw new Error("seeded entry missing");
			await actions().updateEntry("e1", {
				...dataOf(first),
				urls: [...first.urls, "androidapp://com.a"],
			});

			const afterFirst = loginOf(
				actions()
					.readEntries()
					.find((e) => e.id === "e1"),
			);
			if (!afterFirst) throw new Error("entry vanished after first write");
			expect(afterFirst.urls).toContain("androidapp://com.a");

			await actions().updateEntry("e1", {
				...dataOf(afterFirst),
				urls: [...afterFirst.urls, "androidapp://com.b"],
			});
			const final = loginOf(
				actions()
					.readEntries()
					.find((e) => e.id === "e1"),
			);
			if (!final) throw new Error("entry vanished after second write");
			expect(final.urls).toEqual([
				"https://old.example",
				"androidapp://com.a",
				"androidapp://com.b",
			]);
		} finally {
			spy.mockRestore();
		}
	});
});
